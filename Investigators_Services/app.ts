import { join } from "node:path";
import { query, transaction } from "../IdentityAcess_Services/Config/db.ts";
import { withAuth, withPermission } from "../IdentityAcess_Services/MIddlewares/auth.middleware.ts";
import { PERMISSIONS } from "../IdentityAcess_Services/Services/rbac.service.ts";
import { ApiError, ok, readJson, type RequestContext } from "../IdentityAcess_Services/Utils/http.ts";
import { Router } from "../IdentityAcess_Services/Utils/router.ts";
import { optionalNumber, optionalText, requiredText, startService } from "../Shared/service.ts";

const LEVELS = ["governorate", "district", "local_unit", "main_village", "sub_village"] as const;
type Level = (typeof LEVELS)[number];

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

async function seedLocations(): Promise<void> {
  const existing = await query("SELECT 1 FROM geo_locations WHERE level = 1 LIMIT 1");
  if (existing.length) return;
  const governorates = (await Bun.file(join(import.meta.dir, "Seeds", "egypt.json")).json()) as {
    name: string;
    name_en: string;
    districts: { name: string; name_en: string }[];
  }[];
  for (const governorate of governorates) {
    const [row] = await query(
      "INSERT INTO geo_locations(level,name,name_en,name_key) VALUES(1,$1,$2,$3) RETURNING location_id",
      [governorate.name, governorate.name_en, nameKey(governorate.name)],
    );
    for (const district of governorate.districts) {
      await query(
        `INSERT INTO geo_locations(parent_id,level,name,name_en,name_key) VALUES($1,2,$2,$3,$4)
         ON CONFLICT DO NOTHING`,
        [row?.location_id, district.name, district.name_en, nameKey(district.name)],
      );
    }
  }
}

/** Adds any names the investigator typed so the tree grows with real use. */
async function rememberPath(names: Record<Level, string | null>, userId: string): Promise<void> {
  let parent: string | null = null;
  for (const [index, level] of LEVELS.entries()) {
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

async function listLocations(context: RequestContext): Promise<Response> {
  const parent = context.url.searchParams.get("parent");
  const search = context.url.searchParams.get("q")?.trim();
  const rows = await query(
    `SELECT location_id, parent_id, level, name, name_en FROM geo_locations
     WHERE ${parent ? "parent_id = $1" : "level = 1 AND $1::text IS NULL"}
       AND ($2::text IS NULL OR name_key LIKE '%' || $2 || '%')
     ORDER BY source, name LIMIT 300`,
    [parent || null, search ? nameKey(search) : null],
  );
  return ok({ locations: rows });
}

function publicProfile(row: Record<string, unknown> | undefined) {
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

async function saveLocation(body: Record<string, unknown>, userId: string) {
  const names = Object.fromEntries(
    LEVELS.map((level) => [level, optionalText(body[level], 120)]),
  ) as Record<Level, string | null>;
  names.governorate = requiredText(body.governorate, "governorate", 120);
  const lat = optionalNumber(body.lat, "lat");
  const lng = optionalNumber(body.lng, "lng");
  if ((lat === null) !== (lng === null)) throw ApiError.badRequest("lat and lng must be sent together");

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
        ...LEVELS.map((level) => names[level]),
        optionalText(body.street, 300),
        ...LEVELS.map((level) => (names[level] ? nameKey(names[level] as string) : null)),
        lat,
        lng,
      ],
    );
  });
  return publicProfile(rows[0]);
}

const distanceKm = (lat1: number, lng1: number, lat2: number, lng2: number) => {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
};

function insidePolygon(lat: number, lng: number, points: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [latA, lngA] = points[i] as [number, number];
    const [latB, lngB] = points[j] as [number, number];
    if (lngA > lng !== lngB > lng && lat < ((latB - latA) * (lng - lngA)) / (lngB - lngA) + latA) {
      inside = !inside;
    }
  }
  return inside;
}

const CANDIDATE_COLUMNS = `u.user_id, u.full_name, u.employee_number, u.phone, p.governorate, p.district,
  p.local_unit, p.main_village, p.sub_village, p.street, p.lat, p.lng, p.available, p.location_set_at`;

/** Active investigators inside a named area or a shape drawn on the map. */
export async function matchInvestigators(filter: Record<string, unknown>) {
  const rows = await query(
    `SELECT ${CANDIDATE_COLUMNS} FROM investigator_profiles p JOIN users u ON u.user_id = p.user_id
     WHERE u.status = 'active' AND u.deleted_at IS NULL AND p.available AND p.location_set_at IS NOT NULL
     ORDER BY u.full_name`,
  );
  const mode = filter.mode;

  if (mode === "circle") {
    const lat = optionalNumber(filter.lat, "lat");
    const lng = optionalNumber(filter.lng, "lng");
    const radius = optionalNumber(filter.radius_km, "radius_km");
    if (lat === null || lng === null || !radius) throw ApiError.badRequest("Choose a point and a radius");
    return rows.filter(
      (row) =>
        row.lat !== null &&
        distanceKm(lat, lng, row.lat as number, row.lng as number) <= radius,
    );
  }

  if (mode === "polygon") {
    const points = filter.points;
    if (!Array.isArray(points) || points.length < 3) throw ApiError.badRequest("Draw at least three points");
    return rows.filter(
      (row) => row.lat !== null && insidePolygon(row.lat as number, row.lng as number, points),
    );
  }

  const wanted = LEVELS.map((level) => [level, optionalText(filter[level], 120)] as const).filter(
    (entry): entry is readonly [Level, string] => Boolean(entry[1]),
  );
  if (!wanted.length) throw ApiError.badRequest("Choose at least a governorate");
  const keyed = await query(
    `SELECT user_id, ${LEVELS.map((level) => `${level}_key`).join(",")} FROM investigator_profiles`,
  );
  const keys = new Map(keyed.map((row) => [row.user_id, row]));
  return rows.filter((row) =>
    wanted.every(([level, value]) => keys.get(row.user_id)?.[`${level}_key`] === nameKey(value)),
  );
}

const router = new Router();
router.get("/locations", withAuth(listLocations));

router.get(
  "/investigators/me",
  withAuth(async (_context, auth) => {
    const rows = await query("SELECT * FROM investigator_profiles WHERE user_id = $1", [auth.user.user_id]);
    return ok({ profile: publicProfile(rows[0]) });
  }),
);
router.patch(
  "/investigators/me/location",
  withAuth(async (context, auth) =>
    ok({ profile: await saveLocation(await readJson(context.req), auth.user.user_id) }),
  ),
);
router.patch(
  "/investigators/me/availability",
  withAuth(async (context, auth) => {
    const body = await readJson(context.req);
    if (typeof body.available !== "boolean") throw ApiError.badRequest("available must be true or false");
    const rows = await query(
      "UPDATE investigator_profiles SET available=$2, updated_at=now() WHERE user_id=$1 RETURNING *",
      [auth.user.user_id, body.available],
    );
    if (!rows[0]) throw ApiError.badRequest("Set your work location first");
    return ok({ profile: publicProfile(rows[0]) });
  }),
);

router.get(
  "/investigators",
  withPermission(PERMISSIONS.INVESTIGATIONS_MANAGE, async (context) => {
    const search = context.url.searchParams.get("search")?.trim();
    const rows = await query(
      `SELECT ${CANDIDATE_COLUMNS} FROM users u
       LEFT JOIN investigator_profiles p ON p.user_id = u.user_id
       WHERE u.status = 'active' AND u.deleted_at IS NULL AND u.phone NOT LIKE 'admin:%'
         AND ($1::text IS NULL OR u.full_name ILIKE '%' || $1 || '%' OR u.employee_number ILIKE '%' || $1 || '%')
       ORDER BY p.location_set_at IS NULL, u.full_name LIMIT 200`,
      [search || null],
    );
    return ok({ investigators: rows });
  }),
);
router.get(
  "/investigators/:user_id",
  withPermission(PERMISSIONS.INVESTIGATIONS_MANAGE, async (context) => {
    const rows = await query("SELECT * FROM investigator_profiles WHERE user_id = $1", [context.params.user_id]);
    return ok({ profile: publicProfile(rows[0]) });
  }),
);
router.post(
  "/investigators/match",
  withPermission(PERMISSIONS.INVESTIGATIONS_MANAGE, async (context) => {
    const investigators = await matchInvestigators(await readJson(context.req));
    return ok({ investigators, count: investigators.length });
  }),
);

if (import.meta.main) {
  await startService({
    name: "golden-pay-investigators",
    port: Number(process.env.INVESTIGATORS_PORT ?? 4003),
    router,
    schema: join(import.meta.dir, "schema.sql"),
    healthPrefix: "/investigators",
    seed: seedLocations,
  });
}
