import { join } from "node:path";
import { query } from "../IdentityAcess_Services/Config/db.ts";
import { withAnyPermission, withAuth, withPermission } from "../IdentityAcess_Services/MIddlewares/auth.middleware.ts";
import { PERMISSIONS } from "../IdentityAcess_Services/Services/rbac.service.ts";
import { ApiError, ok, readJson, type RequestContext } from "../IdentityAcess_Services/Utils/http.ts";
import { Router } from "../IdentityAcess_Services/Utils/router.ts";
import { offerNext } from "../Investigations_Services/dispatch.ts";
import { allClients, clientsOf, parseClientIds, setClientsOf, WORKS_FOR_CLIENT_SQL } from "../Shared/investigator-clients.ts";
import { optionalNumber, optionalText, startService } from "../Shared/service.ts";
import {
  addServiceArea,
  AREA_LEVELS,
  type AreaLevel,
  listServiceAreas,
  nameKey,
  parseWorkArea,
  publicWorkProfile,
  removeServiceArea,
  saveWorkArea,
} from "../Shared/work-area.ts";

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

/**
 * Active investigators inside a named area or a shape drawn on the map. Availability is not
 * a filter here: it is checked at every dispatch step, so someone who switches back on later
 * still gets the case (the dispatch log shows why anyone was skipped).
 */
export async function matchInvestigators(filter: Record<string, unknown>) {
  // With a client, only investigators who work for that company or bank.
  const clientId = optionalText(filter.client_id, 64);
  const rows = await query(
    `SELECT ${CANDIDATE_COLUMNS} FROM investigator_profiles p JOIN users u ON u.user_id = p.user_id
     WHERE u.status = 'active' AND u.deleted_at IS NULL AND p.location_set_at IS NOT NULL
       AND ($1::text IS NULL OR ${WORKS_FOR_CLIENT_SQL("u.user_id", "$1")})
     ORDER BY u.full_name`,
    [clientId],
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
  // Any of the investigator's service areas may match (registered coverage, never live GPS).
  const keyed = await query(
    `SELECT user_id, ${LEVELS.map((level) => `${level}_key`).join(",")} FROM investigator_service_areas
     WHERE active AND governorate_key = $1`,
    [nameKey(wanted.find(([level]) => level === "governorate")?.[1] ?? wanted[0]![1])],
  );
  const matching = new Set(
    keyed
      .filter((area) => wanted.every(([level, value]) => area[`${level}_key`] === nameKey(value)))
      .map((area) => area.user_id as string),
  );
  return rows.filter((row) => matching.has(row.user_id as string));
}

const AREA_COLUMNS = `area_id, user_id, is_primary, governorate, district, local_unit, main_village, sub_village,
  active, note, added_by, created_at`;

// Admins and head office (which manages investigators) see investigators and their areas.
const STAFF_VIEW = [PERMISSIONS.INVESTIGATIONS_MANAGE, PERMISSIONS.HEADOFFICE_MANAGE];

const router = new Router();
// Public: the signup screen lists places before the investigator has an account.
router.get("/locations", listLocations);

router.get(
  "/investigators/me",
  withAuth(async (_context, auth) => {
    const rows = await query("SELECT * FROM investigator_profiles WHERE user_id = $1", [auth.user.user_id]);
    return ok({ profile: { ...publicProfile(rows[0]), areas: await listServiceAreas(auth.user.user_id) } });
  }),
);

/** The areas the signed-in investigator serves: the primary one plus any extra ones. */
router.get(
  "/investigators/me/areas",
  withAuth(async (_context, auth) => ok({ areas: await listServiceAreas(auth.user.user_id) })),
);
router.post(
  "/investigators/me/areas",
  withAuth(async (context, auth) => {
    const [profile] = await query(
      "SELECT 1 FROM investigator_profiles WHERE user_id = $1 AND location_set_at IS NOT NULL",
      [auth.user.user_id],
    );
    if (!profile) throw ApiError.badRequest("Set your main work area first");
    const areas = await addServiceArea(parseWorkArea(await readJson(context.req)), auth.user.user_id, auth.user.user_id);
    return ok({ areas });
  }),
);
router.delete(
  "/investigators/me/areas/:area_id",
  withAuth(async (context, auth) => {
    if (!(await removeServiceArea(auth.user.user_id, context.params.area_id ?? ""))) {
      throw ApiError.badRequest("Only extra areas can be removed; change your main area instead");
    }
    return ok({ areas: await listServiceAreas(auth.user.user_id) });
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
    // Switched off: offers waiting for them go to someone else straight away.
    let released = 0;
    if (!body.available) {
      const closed = await query(
        `UPDATE investigation_offers SET response='cancelled', responded_at=now(), reason='unavailable'
         WHERE user_id=$1 AND response IS NULL RETURNING investigation_id, round`,
        [auth.user.user_id],
      );
      released = closed.length;
      for (const offer of closed) {
        await query(
          `INSERT INTO dispatch_outbox(user_id, investigation_id, kind, round) VALUES($1,$2,'offer_closed',$3)
           ON CONFLICT DO NOTHING`,
          [auth.user.user_id, offer.investigation_id, offer.round],
        );
        await offerNext(offer.investigation_id as string);
      }
    }
    return ok({ profile: publicProfile(rows[0]), released });
  }),
);

/** The companies and banks an investigator works for (none chosen = all), set by head office. */
const CLIENTS_ACCESS = [PERMISSIONS.USERS_APPROVE, PERMISSIONS.HEADOFFICE_MANAGE];
router.get(
  "/investigators/:user_id/clients",
  withAnyPermission(CLIENTS_ACCESS, async (context) => {
    const userId = context.params.user_id ?? "";
    const [profile] = await query("SELECT available FROM investigator_profiles WHERE user_id = $1", [userId]);
    return ok({
      clients: await allClients(),
      client_ids: await clientsOf(userId),
      available: profile ? profile.available !== false : null,
    });
  }),
);
router.patch(
  "/investigators/:user_id/clients",
  withAnyPermission(CLIENTS_ACCESS, async (context, auth) => {
    const userId = context.params.user_id ?? "";
    const [user] = await query("SELECT 1 FROM users WHERE user_id = $1 AND deleted_at IS NULL", [userId]);
    if (!user) throw ApiError.notFound("Investigator not found");
    const ids = parseClientIds((await readJson(context.req)).client_ids) ?? [];
    return ok({ client_ids: await setClientsOf(userId, ids, auth.user.user_id) });
  }),
);

router.get(
  "/investigators",
  withAnyPermission(STAFF_VIEW, async (context) => {
    const search = context.url.searchParams.get("search")?.trim();
    const rows = await query(
      `SELECT ${CANDIDATE_COLUMNS},
         (SELECT count(*)::int FROM investigator_service_areas a WHERE a.user_id = u.user_id AND a.active) AS areas_count,
         (SELECT string_agg(concat_ws(' - ', a.governorate, a.district, a.local_unit, a.main_village, a.sub_village), ' | '
            ORDER BY a.is_primary DESC, a.created_at)
          FROM investigator_service_areas a WHERE a.user_id = u.user_id AND a.active) AS areas_label
       FROM users u
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
  withAnyPermission(STAFF_VIEW, async (context) => {
    const rows = await query("SELECT * FROM investigator_profiles WHERE user_id = $1", [context.params.user_id]);
    return ok({ profile: { ...publicProfile(rows[0]), areas: await listServiceAreas(context.params.user_id ?? "") } });
  }),
);
/** The areas an investigator serves; admins add extra ones (the primary follows the app). */
router.get(
  "/investigators/:user_id/areas",
  withAnyPermission(STAFF_VIEW, async (context) => {
    const areas = await query(
      `SELECT ${AREA_COLUMNS} FROM investigator_service_areas WHERE user_id = $1 ORDER BY is_primary DESC, created_at`,
      [context.params.user_id],
    );
    return ok({ areas });
  }),
);
router.post(
  "/investigators/:user_id/areas",
  withAnyPermission(STAFF_VIEW, async (context, auth) => {
    const body = await readJson(context.req);
    const [user] = await query("SELECT 1 FROM users WHERE user_id = $1 AND deleted_at IS NULL", [context.params.user_id]);
    if (!user) throw ApiError.notFound("Investigator not found");
    const areas = await addServiceArea(parseWorkArea(body), context.params.user_id ?? "", auth.user.user_id, optionalText(body.note, 300));
    return ok({ areas });
  }),
);
router.delete(
  "/investigators/:user_id/areas/:area_id",
  withAnyPermission(STAFF_VIEW, async (context) => {
    if (!(await removeServiceArea(context.params.user_id ?? "", context.params.area_id ?? ""))) {
      throw ApiError.badRequest("Only extra areas can be removed; the investigator changes the primary one from the app");
    }
    return ok({ removed: true });
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
