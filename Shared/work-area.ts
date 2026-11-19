// An investigator's work area: governorate down to sub-village, an optional street and an
// optional GPS point. Chosen at signup (so the admin sees it before activating the account)
// and changed later from the app's profile. Used by the investigators and identity services.
import { query, transaction } from "../IdentityAcess_Services/Config/db.ts";
import { ApiError } from "../IdentityAcess_Services/Utils/http.ts";
import { canonicalNames } from "./places.ts";
import { optionalNumber, optionalText, requiredText } from "./service.ts";

export const AREA_LEVELS = ["governorate", "district", "local_unit", "main_village", "sub_village"] as const;
export type AreaLevel = (typeof AREA_LEVELS)[number];

/** Words that name the kind of place, not the place: «محافظة القاهرة» is «القاهرة». */
const PLACE_WORDS = /^(?:محافظه|مركز|قسم|مدينه|حي|الوحده المحليه(?: ل| ب)?|وحده محليه(?: ل| ب)?|قريه|ناحيه)\s+(?=\S)/;

/**
 * The comparison key of a place name: spelling variants of the same Arabic name are equal
 * («القاهرة», «القاهره», «قاهرة», «محافظة القاهرة», «القاهرة.»). Typos beyond that are
 * caught by Shared/places.ts, which snaps a name to the existing place.
 */
export function nameKey(value: string): string {
  let key = value
    .trim()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "") // diacritics and tatweel
    .replace(/[أإآٱا]/g, "ا")
    .replace(/[ىی]/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ک/g, "ك")
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[-_.,،؛;:()\[\]{}"'«»/\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  key = key.replace(PLACE_WORDS, "");
  // A leading «ال» and the spaces between words never change the place
  // («قاهرة» = «القاهرة», «كفرالشيخ» = «كفر الشيخ»).
  key = key.replace(/\s+/g, "");
  return key.length > 4 && key.startsWith("ال") ? key.slice(2) : key;
}

export interface WorkArea {
  names: Record<AreaLevel, string | null>;
  street: string | null;
  lat: number | null;
  lng: number | null;
}

/** Reads and checks a work area from a request body. The governorate is required. */
export function parseWorkArea(body: Record<string, unknown>): WorkArea {
  const names = Object.fromEntries(
    AREA_LEVELS.map((level) => [level, optionalText(body[level], 120)]),
  ) as Record<AreaLevel, string | null>;
  names.governorate = requiredText(body.governorate, "governorate", 120);
  const lat = optionalNumber(body.lat, "lat");
  const lng = optionalNumber(body.lng, "lng");
  if ((lat === null) !== (lng === null)) throw ApiError.badRequest("lat and lng must be sent together");
  if (lat !== null && (Math.abs(lat) > 90 || Math.abs(lng as number) > 180)) {
    throw ApiError.badRequest("The map point is not valid");
  }
  return { names, street: optionalText(body.street, 300), lat, lng };
}

/** True when the body carries any part of a work area (older app versions send none). */
export function hasWorkArea(body: Record<string, unknown>): boolean {
  return AREA_LEVELS.some((level) => typeof body[level] === "string" && (body[level] as string).trim() !== "");
}

/** Adds any names the investigator typed so the place list grows with real use. */
async function rememberPath(names: Record<AreaLevel, string | null>, userId: string): Promise<void> {
  let parent: string | null = null;
  for (const [index, level] of AREA_LEVELS.entries()) {
    const name = names[level];
    if (!name) return;
    const key = nameKey(name);
    const found: Record<string, unknown>[] = await query(
      "SELECT location_id FROM geo_locations WHERE COALESCE(parent_id,'') = $1 AND name_key = $2",
      [parent ?? "", key],
    );
    if (found[0]) {
      parent = found[0].location_id as string;
      continue;
    }
    const created: Record<string, unknown>[] = await query(
      `INSERT INTO geo_locations(parent_id,level,name,name_key,source,created_by)
       VALUES($1,$2,$3,$4,'investigator',$5) RETURNING location_id`,
      [parent, index + 1, name, key, userId],
    );
    parent = created[0]?.location_id as string;
  }
}

export function publicWorkProfile(row: Record<string, unknown> | undefined) {
  if (!row) return { location_set: false, available: true };
  return {
    location_set: Boolean(row.location_set_at),
    available: row.available,
    governorate: row.governorate,
    district: row.district,
    local_unit: row.local_unit,
    main_village: row.main_village,
    sub_village: row.sub_village,
    street: row.street,
    lat: row.lat,
    lng: row.lng,
    location_set_at: row.location_set_at,
  };
}

/** Saves (or replaces) the investigator's work area and returns the public profile. */
export async function saveWorkArea(area: WorkArea, userId: string) {
  // A typed name that is one slip away from an existing place becomes that place.
  const names = await canonicalNames(area.names);
  const rows = await transaction(async () => {
    await rememberPath(names, userId);
    // The work area is also the investigator's primary service area for dispatch.
    await query(
      `INSERT INTO investigator_service_areas (user_id, is_primary, governorate, district, local_unit, main_village,
         sub_village, governorate_key, district_key, local_unit_key, main_village_key, sub_village_key)
       VALUES ($1, true, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (user_id) WHERE is_primary DO UPDATE SET governorate=$2, district=$3, local_unit=$4,
         main_village=$5, sub_village=$6, governorate_key=$7, district_key=$8, local_unit_key=$9,
         main_village_key=$10, sub_village_key=$11, active=true, updated_at=now()`,
      [
        userId,
        ...AREA_LEVELS.map((level) => names[level]),
        ...AREA_LEVELS.map((level) => (names[level] ? nameKey(names[level] as string) : null)),
      ],
    );
    return query(
      `INSERT INTO investigator_profiles(user_id,governorate,district,local_unit,main_village,sub_village,street,
         governorate_key,district_key,local_unit_key,main_village_key,sub_village_key,lat,lng,location_set_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
       ON CONFLICT (user_id) DO UPDATE SET governorate=$2,district=$3,local_unit=$4,main_village=$5,sub_village=$6,
         street=$7,governorate_key=$8,district_key=$9,local_unit_key=$10,main_village_key=$11,sub_village_key=$12,
         lat=$13,lng=$14,location_set_at=now(),updated_at=now()
       RETURNING *`,
      [
        userId,
        ...AREA_LEVELS.map((level) => names[level]),
        area.street,
        ...AREA_LEVELS.map((level) => (names[level] ? nameKey(names[level] as string) : null)),
        area.lat,
        area.lng,
      ],
    );
  });
  return publicWorkProfile(rows[0]);
}

/** The work area for the admin's review of an application, or null when none was chosen. */
export async function readWorkArea(userId: string) {
  try {
    const rows = await query("SELECT * FROM investigator_profiles WHERE user_id = $1", [userId]);
    const profile = publicWorkProfile(rows[0]);
    return profile.location_set ? profile : null;
  } catch {
    // The investigators service creates the table; before it first runs there is no area.
    return null;
  }
}

// ───────────── several areas per investigator ─────────────

/** How many extra areas one investigator may serve (besides the primary one). */
export const MAX_EXTRA_AREAS = 10;

const SERVICE_AREA_COLUMNS = `area_id, is_primary, governorate, district, local_unit, main_village, sub_village, note,
  created_at`;

/** Every active area the investigator serves, the primary one first. */
export async function listServiceAreas(userId: string): Promise<Record<string, unknown>[]> {
  try {
    return await query(
      `SELECT ${SERVICE_AREA_COLUMNS} FROM investigator_service_areas
       WHERE user_id = $1 AND active ORDER BY is_primary DESC, created_at`,
      [userId],
    );
  } catch {
    // The investigators service creates the table; before it first runs there are none.
    return [];
  }
}

/**
 * Adds an extra area the investigator serves (signup, the app, or an admin). The same area
 * twice is ignored, so overlapping choices never produce duplicate offers.
 */
export async function addServiceArea(area: WorkArea, userId: string, addedBy: string | null, note: string | null = null) {
  const names = await canonicalNames(area.names);
  const keys = AREA_LEVELS.map((level) => (names[level] ? nameKey(names[level] as string) : null));
  const existing = await query(
    `SELECT area_id FROM investigator_service_areas
     WHERE user_id = $1 AND active AND governorate_key = $2 AND district_key IS NOT DISTINCT FROM $3
       AND local_unit_key IS NOT DISTINCT FROM $4 AND main_village_key IS NOT DISTINCT FROM $5
       AND sub_village_key IS NOT DISTINCT FROM $6`,
    [userId, ...keys],
  );
  if (existing[0]) return listServiceAreas(userId);
  const [count] = await query(
    "SELECT count(*)::int AS n FROM investigator_service_areas WHERE user_id = $1 AND active AND NOT is_primary",
    [userId],
  );
  if (Number(count?.n ?? 0) >= MAX_EXTRA_AREAS) {
    throw ApiError.badRequest(`You can serve at most ${MAX_EXTRA_AREAS} extra areas`);
  }
  await transaction(async () => {
    await rememberPath(names, userId);
    await query(
      `INSERT INTO investigator_service_areas (user_id, is_primary, governorate, district, local_unit, main_village,
         sub_village, governorate_key, district_key, local_unit_key, main_village_key, sub_village_key, added_by, note)
       VALUES ($1, false, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [userId, ...AREA_LEVELS.map((level) => names[level]), ...keys, addedBy, note],
    );
  });
  return listServiceAreas(userId);
}

/** Stops serving an extra area. The primary area is changed, never removed. */
export async function removeServiceArea(userId: string, areaId: string): Promise<boolean> {
  const rows = await query(
    `UPDATE investigator_service_areas SET active = false, updated_at = now()
     WHERE area_id = $1 AND user_id = $2 AND NOT is_primary AND active RETURNING area_id`,
    [areaId, userId],
  );
  return rows.length > 0;
}

/** Extra areas sent with a signup (a JSON list), checked before anything is stored. */
export function parseExtraAreas(value: unknown): WorkArea[] {
  if (value === undefined || value === null || value === "") return [];
  let list: unknown;
  try {
    list = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    throw ApiError.badRequest("extra_areas must be a list of areas");
  }
  if (!Array.isArray(list)) throw ApiError.badRequest("extra_areas must be a list of areas");
  if (list.length > MAX_EXTRA_AREAS) throw ApiError.badRequest(`You can serve at most ${MAX_EXTRA_AREAS} extra areas`);
  return list.map((item) => parseWorkArea((item ?? {}) as Record<string, unknown>));
}
