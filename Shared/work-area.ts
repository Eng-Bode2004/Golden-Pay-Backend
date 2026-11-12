// An investigator's work area: governorate down to sub-village, an optional street and an
// optional GPS point. Chosen at signup (so the admin sees it before activating the account)
// and changed later from the app's profile. Used by the investigators and identity services.
import { query, transaction } from "../IdentityAcess_Services/Config/db.ts";
import { ApiError } from "../IdentityAcess_Services/Utils/http.ts";
import { optionalNumber, optionalText, requiredText } from "./service.ts";

export const AREA_LEVELS = ["governorate", "district", "local_unit", "main_village", "sub_village"] as const;
export type AreaLevel = (typeof AREA_LEVELS)[number];

/** Spelling variants of the same Arabic place name compare as equal. */
export function nameKey(value: string): string {
  return value
    .trim()
    .replace(/[ً-ْـ]/g, "")
    .replace(/[أإآا]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/\s+/g, " ")
    .toLowerCase();
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
  const { names } = area;
  const rows = await transaction(async () => {
    await rememberPath(names, userId);
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
