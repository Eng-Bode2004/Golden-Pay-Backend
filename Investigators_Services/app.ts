import { join } from "node:path";
import { query } from "../IdentityAcess_Services/Config/db.ts";
import { withAuth, withPermission } from "../IdentityAcess_Services/MIddlewares/auth.middleware.ts";
import { PERMISSIONS } from "../IdentityAcess_Services/Services/rbac.service.ts";
import { ApiError, ok, readJson, type RequestContext } from "../IdentityAcess_Services/Utils/http.ts";
import { Router } from "../IdentityAcess_Services/Utils/router.ts";
import { optionalNumber, optionalText, startService } from "../Shared/service.ts";
import { AREA_LEVELS, type AreaLevel, nameKey, parseWorkArea, publicWorkProfile, saveWorkArea } from "../Shared/work-area.ts";

export { nameKey };

const LEVELS = AREA_LEVELS;
type Level = AreaLevel;

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

const publicProfile = publicWorkProfile;

async function saveLocation(body: Record<string, unknown>, userId: string) {
  return saveWorkArea(parseWorkArea(body), userId);
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
// Public: the signup screen lists places before the investigator has an account.
router.get("/locations", listLocations);

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
