// Place names typed by people ("القاهرة", "القاهره", "القاهر", "محافظة القاهرة") must be one
// place, or automatic dispatch, prices and area filters miss investigators. Three layers:
//   1. nameKey (work-area.ts) treats spelling variants as the same name,
//   2. canonicalNames snaps a typed name to the existing place under the same parent when it
//      is one small slip away (a missing or extra letter), so new typos are not created,
//   3. mergeDuplicatePlaces combines the duplicates already saved and rewrites every area,
//      case and price rule to the surviving name. It runs when the investigators service
//      starts and does nothing once everything is clean.
import { query, transaction } from "../IdentityAcess_Services/Config/db.ts";
import { ApiError } from "../IdentityAcess_Services/Utils/http.ts";
import { logger } from "../IdentityAcess_Services/Utils/logger.ts";
import { AREA_LEVELS, type AreaLevel, nameKey } from "./work-area.ts";

type Names = Record<AreaLevel, string | null>;
interface Place {
  location_id: string;
  parent_id: string | null;
  level: number;
  name: string;
  source: string;
}

/** Edit distance between two keys, stopping early past `limit`. */
export function distance(a: string, b: string, limit = 3): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      current.push(value);
      best = Math.min(best, value);
    }
    if (best > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length]!;
}

/** How many letters may differ for two names to count as one place. */
const allowed = (a: string, b: string) => {
  const longest = Math.max(a.length, b.length);
  return longest >= 9 ? 2 : longest >= 5 ? 1 : 0;
};

/** The place among `options` this name means: the same key, or the single closest within reach. */
export function closestPlace<T extends { name: string }>(name: string, options: T[]): T | null {
  const key = nameKey(name);
  const exact = options.find((option) => nameKey(option.name) === key);
  if (exact) return exact;
  let best: T | null = null;
  let bestDistance = Infinity;
  let tie = false;
  for (const option of options) {
    const other = nameKey(option.name);
    const reach = allowed(key, other);
    if (!reach) continue;
    const d = distance(key, other, reach);
    if (d > reach) continue;
    if (d < bestDistance) {
      best = option;
      bestDistance = d;
      tie = false;
    } else if (d === bestDistance) tie = true;
  }
  // Two equally close places: do not guess.
  return tie ? null : best;
}

/**
 * The typed names with each level replaced by the existing place it means. A name that is
 * not close to any existing place is kept as typed (and so is everything below it); with
 * strictGovernorate, an unknown governorate is refused instead.
 */
export async function canonicalNames(names: Names, options: { strictGovernorate?: boolean } = {}): Promise<Names> {
  const out = { ...names };
  let parent: string | null = null;
  for (const [index, level] of AREA_LEVELS.entries()) {
    const name = out[level]?.trim();
    if (!name) break;
    const siblings: Place[] = await query(
      "SELECT location_id, parent_id, level, name, source FROM geo_locations WHERE COALESCE(parent_id,'') = $1 AND level = $2",
      [parent ?? "", index + 1],
    ) as unknown as Place[];
    const match = closestPlace(name, siblings);
    if (!match) {
      if (level === "governorate" && options.strictGovernorate === true && siblings.length) {
        throw ApiError.badRequest("Choose the governorate from the list", { field: "governorate" });
      }
      break;
    }
    out[level] = match.name;
    parent = match.location_id;
  }
  return out;
}

// ───────────── combining what is already saved ─────────────

/** Combines duplicate places and rewrites every saved area to the surviving names. */
export async function mergeDuplicatePlaces(): Promise<{ merged: number; rewritten: number }> {
  const rows: (Place & { name_key: string })[] = await query(
    `SELECT location_id, parent_id, level, name, name_key, source FROM geo_locations
     ORDER BY level, (source = 'seed') DESC, created_at, location_id`,
  ) as unknown as (Place & { name_key: string })[];
  // Among typed places, the spelling most areas use survives (not simply the oldest, which may be the typo).
  const used = new Map<string, number>();
  const areas = await query(`SELECT ${AREA_LEVELS.join(", ")} FROM investigator_service_areas`).catch(
    () => [] as Record<string, unknown>[],
  );
  for (const area of areas) {
    for (const [index, level] of AREA_LEVELS.entries()) {
      const name = area[level] as string | null;
      if (name) used.set(`${index + 1}:${name.trim()}`, (used.get(`${index + 1}:${name.trim()}`) ?? 0) + 1);
    }
  }
  rows.sort(
    (a, b) =>
      a.level - b.level ||
      Number(b.source === "seed") - Number(a.source === "seed") ||
      (used.get(`${b.level}:${b.name.trim()}`) ?? 0) - (used.get(`${a.level}:${a.name.trim()}`) ?? 0),
  );
  const alias = new Map<string, string>();
  const resolve = (id: string | null): string | null => {
    let current = id;
    while (current && alias.has(current)) current = alias.get(current)!;
    return current;
  };
  const survivors = new Map<string, Place[]>(); // parent ('' = top) -> places kept
  const updates: { id: string; parent: string | null; key: string }[] = [];
  const merges: { from: Place; into: Place }[] = [];

  for (const row of rows) {
    const parent = resolve(row.parent_id);
    const siblings = survivors.get(parent ?? "") ?? [];
    const key = nameKey(row.name);
    // A seeded place is never folded into another one, only exact spellings combine with it.
    const target =
      siblings.find((place) => nameKey(place.name) === key) ??
      (row.source === "seed" ? null : closestPlace(row.name, siblings.filter((place) => place.level === row.level)));
    if (target) {
      alias.set(row.location_id, target.location_id);
      merges.push({ from: row, into: target });
      continue;
    }
    siblings.push({ ...row, parent_id: parent });
    survivors.set(parent ?? "", siblings);
    if (parent !== row.parent_id || key !== row.name_key) updates.push({ id: row.location_id, parent, key });
  }

  if (merges.length || updates.length) {
    await transaction(async () => {
      await query("DROP INDEX IF EXISTS uq_geo_location");
      for (const update of updates) {
        await query("UPDATE geo_locations SET parent_id = $2, name_key = $3 WHERE location_id = $1", [update.id, update.parent, update.key]);
      }
      // Children of merged places now hang under the survivors; the merged ones go, deepest first.
      for (const { from } of [...merges].sort((a, b) => b.from.level - a.from.level)) {
        await query("UPDATE geo_locations SET parent_id = $2 WHERE parent_id = $1", [from.location_id, resolve(from.location_id)]);
        await query("DELETE FROM geo_locations WHERE location_id = $1", [from.location_id]);
        await query(
          "INSERT INTO place_merges (level, from_name, into_name, into_id) VALUES ($1,$2,$3,$4)",
          [from.level, from.name, merges.find((m) => m.from === from)!.into.name, resolve(from.location_id)],
        );
      }
      await query("CREATE UNIQUE INDEX IF NOT EXISTS uq_geo_location ON geo_locations (COALESCE(parent_id, ''), name_key)");
    });
  }

  // Every saved area now uses the surviving spelling (and the new keys).
  const tree = new Map<string, Place[]>();
  for (const [parent, places] of survivors) tree.set(parent, places);
  const snap = (names: Names): Names => {
    const out = { ...names };
    let parent = "";
    for (const level of AREA_LEVELS) {
      const name = out[level];
      if (!name) break;
      const match = closestPlace(name, tree.get(parent) ?? []);
      if (!match) break;
      out[level] = match.name;
      parent = match.location_id;
    }
    return out;
  };
  const namesOf = (row: Record<string, unknown>) =>
    Object.fromEntries(AREA_LEVELS.map((level) => [level, (row[level] as string | null) ?? null])) as Names;
  const changed = (row: Record<string, unknown>, names: Names, withKeys: boolean) =>
    AREA_LEVELS.some(
      (level) =>
        names[level] !== row[level] ||
        (withKeys && (names[level] ? nameKey(names[level]!) : null) !== (row[`${level}_key`] ?? null)),
    );

  let rewritten = 0;
  for (const table of ["investigator_service_areas", "investigator_profiles"] as const) {
    const id = table === "investigator_profiles" ? "user_id" : "area_id";
    const items = await query(`SELECT * FROM ${table} WHERE governorate IS NOT NULL`);
    for (const row of items) {
      const names = snap(namesOf(row));
      if (!changed(row, names, true)) continue;
      await query(
        `UPDATE ${table} SET governorate=$2, district=$3, local_unit=$4, main_village=$5, sub_village=$6,
           governorate_key=$7, district_key=$8, local_unit_key=$9, main_village_key=$10, sub_village_key=$11
         WHERE ${id} = $1`,
        [row[id], ...AREA_LEVELS.map((level) => names[level]), ...AREA_LEVELS.map((level) => (names[level] ? nameKey(names[level]!) : null))],
      );
      rewritten += 1;
    }
  }
  const cases = await query(
    `SELECT investigation_id, ${AREA_LEVELS.join(", ")} FROM investigations WHERE governorate IS NOT NULL`,
  ).catch(() => [] as Record<string, unknown>[]);
  for (const row of cases) {
    const names = snap(namesOf(row));
    if (!changed(row, names, false)) continue;
    await query(
      "UPDATE investigations SET governorate=$2, district=$3, local_unit=$4, main_village=$5, sub_village=$6 WHERE investigation_id=$1",
      [row.investigation_id, ...AREA_LEVELS.map((level) => names[level])],
    );
    rewritten += 1;
  }
  const rules = await query("SELECT rule_id, governorate, governorate_key, district, district_key FROM price_rules").catch(
    () => [] as Record<string, unknown>[],
  );
  for (const rule of rules) {
    const names = snap({ governorate: rule.governorate as string | null, district: rule.district as string | null } as Names);
    const governorateKey = names.governorate ? nameKey(names.governorate) : null;
    const districtKey = names.district ? nameKey(names.district) : null;
    if (
      names.governorate === rule.governorate &&
      names.district === rule.district &&
      governorateKey === rule.governorate_key &&
      districtKey === rule.district_key
    ) {
      continue;
    }
    try {
      await query(
        "UPDATE price_rules SET governorate=$2, governorate_key=$3, district=$4, district_key=$5 WHERE rule_id=$1",
        [rule.rule_id, names.governorate, governorateKey, names.district, districtKey],
      );
      rewritten += 1;
    } catch {
      // Two rules became the same rule: head office keeps the older one; this one is turned off.
      await query("UPDATE price_rules SET active=false, note=concat_ws(' — ', note, 'مكرر بعد توحيد أسماء المناطق') WHERE rule_id=$1", [
        rule.rule_id,
      ]);
    }
  }
  if (merges.length || rewritten) logger.info("places.merged", { merged: merges.length, rewritten });
  return { merged: merges.length, rewritten };
}
