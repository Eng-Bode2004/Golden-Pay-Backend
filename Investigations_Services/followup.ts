import { query } from "../IdentityAcess_Services/Config/db.ts";
import { withPermission } from "../IdentityAcess_Services/MIddlewares/auth.middleware.ts";
import { PERMISSIONS } from "../IdentityAcess_Services/Services/rbac.service.ts";
import { ok } from "../IdentityAcess_Services/Utils/http.ts";
import type { Router } from "../IdentityAcess_Services/Utils/router.ts";
import { nameKey } from "../Shared/work-area.ts";

/**
 * Follow-up: every case not finished yet, with why, and the governorates and districts no
 * investigator covers. Resending uses the existing assign / redispatch routes.
 */
type Row = Record<string, unknown>;

/** Why a case is still open, in Arabic, from its status, deadline and dispatch history. */
export function whyOpen(row: {
  status: string;
  due_at: string | Date | null;
  assignee_name: string | null;
  pool_size: number | null;
  offers: number;
  declined: number;
  excuses: number;
  created_at: string | Date;
}): { reason: string; level: "late" | "stuck" | "waiting" | "working" } {
  const late = row.due_at ? new Date(row.due_at).getTime() < Date.now() : false;
  const ageHours = (Date.now() - new Date(row.created_at).getTime()) / 3_600_000;
  const excused = row.excuses ? ` (اعتذر ${row.excuses})` : "";
  switch (row.status) {
    case "unassigned":
      if (row.pool_size === 0) return { reason: `لا يوجد مستعلم متاح في المنطقة لهذه الجهة${excused}`, level: "stuck" };
      return {
        reason: `لم يقبلها أحد: عُرضت على ${row.offers} ورفضها ${row.declined}${excused}`,
        level: "stuck",
      };
    case "open":
      if (row.offers === 0) return { reason: `لم تُعرض على أحد بعد${excused}`, level: ageHours > 1 ? "stuck" : "waiting" };
      return { reason: `معروضة، في انتظار القبول (عُرضت على ${row.offers})${excused}`, level: late ? "late" : "waiting" };
    case "returned":
      return { reason: `أعيدت إلى ${row.assignee_name ?? "المستعلم"} للتعديل`, level: late ? "late" : "working" };
    case "submitted":
      return { reason: "أنهاها المستعلم، في انتظار مراجعة الإدارة", level: late ? "late" : "waiting" };
    default:
      return late
        ? { reason: `متأخرة عند ${row.assignee_name ?? "المستعلم"}`, level: "late" }
        : { reason: `قيد التنفيذ عند ${row.assignee_name ?? "المستعلم"}`, level: "working" };
  }
}

export function registerFollowUpRoutes(router: Router): void {
  router.get(
    "/investigations/follow-up",
    withPermission(PERMISSIONS.INVESTIGATIONS_MANAGE, async () => {
      const rows = await query(
        `SELECT i.investigation_id, i.reference, i.status, i.subject_name, i.client_name, i.governorate, i.district,
           i.service_name, i.due_at, i.created_at, i.source, u.full_name AS assignee_name,
           (SELECT pool_size FROM dispatch_attempts a WHERE a.investigation_id = i.investigation_id AND NOT a.shadow
             ORDER BY a.created_at DESC LIMIT 1) AS pool_size,
           (SELECT count(*)::int FROM investigation_offers o WHERE o.investigation_id = i.investigation_id) AS offers,
           (SELECT count(*)::int FROM investigation_offers o WHERE o.investigation_id = i.investigation_id AND o.response = 'declined') AS declined,
           (SELECT count(*)::int FROM investigation_excuses e WHERE e.investigation_id = i.investigation_id) AS excuses
         FROM investigations i LEFT JOIN users u ON u.user_id = i.assignee_id
         WHERE i.status IN ('open','unassigned','assigned','in_progress','returned','submitted')
         ORDER BY i.due_at NULLS LAST LIMIT 500`,
      );
      const cases = rows.map((row) => ({ ...row, ...whyOpen(row as never) }));
      // Emails that did not become cases yet (they never reached an investigator).
      const mail = await query(
        `SELECT x.case_id, x.status, x.reason, x.fields->>'subject_name' AS subject_name, x.fields->>'governorate' AS governorate,
           x.fields->>'district' AS district, x.release_at, c.name AS client_name, m.received_at, m.subject
         FROM mail_cases x JOIN mail_messages m ON m.message_id = x.message_id LEFT JOIN form_clients c ON c.client_id = x.client_id
         WHERE x.status IN ('review','failed','ready') ORDER BY m.received_at LIMIT 300`,
      );
      return ok({
        cases,
        mail_cases: mail,
        counts: {
          late: cases.filter((c) => c.level === "late").length,
          stuck: cases.filter((c) => c.level === "stuck").length,
          waiting: cases.filter((c) => c.level === "waiting").length,
          working: cases.filter((c) => c.level === "working").length,
          mail: mail.length,
        },
      });
    }),
  );

  router.get(
    "/investigations/coverage",
    withPermission(PERMISSIONS.INVESTIGATIONS_MANAGE, async () => {
      const [places, areas, demand] = await Promise.all([
        query(
          `SELECT d.name, d.level, g.name AS governorate FROM geo_locations d
           LEFT JOIN geo_locations g ON g.location_id = d.parent_id WHERE d.level IN (1, 2)`,
        ),
        query(
          `SELECT a.user_id, a.governorate_key, a.district_key FROM investigator_service_areas a
           JOIN users u ON u.user_id = a.user_id WHERE a.active AND u.status = 'active' AND u.deleted_at IS NULL`,
        ),
        query(
          `SELECT governorate, district, count(*)::int AS cases,
             count(*) FILTER (WHERE status = 'unassigned')::int AS unassigned
           FROM investigations WHERE created_at > now() - interval '90 days' AND governorate IS NOT NULL
           GROUP BY governorate, district`,
        ),
      ]);
      // Whom each governorate / district has: a governorate-wide area covers all its districts.
      const wholeGov = new Map<string, Set<string>>();
      const byDistrict = new Map<string, Set<string>>();
      for (const area of areas) {
        const gov = area.governorate_key as string;
        if (!area.district_key) (wholeGov.get(gov) ?? wholeGov.set(gov, new Set()).get(gov)!).add(area.user_id as string);
        else {
          const key = `${gov}|${area.district_key}`;
          (byDistrict.get(key) ?? byDistrict.set(key, new Set()).get(key)!).add(area.user_id as string);
        }
      }
      const inGovernorate = (gov: string) => {
        const people = new Set(wholeGov.get(gov) ?? []);
        for (const [key, users] of byDistrict) if (key.startsWith(`${gov}|`)) users.forEach((u) => people.add(u));
        return people.size;
      };
      const demandOf = (gov: string, district?: string): { cases: number; unassigned: number } =>
        demand
          .filter((d) => nameKey(d.governorate as string) === gov && (!district || nameKey((d.district as string) ?? "") === district))
          .reduce<{ cases: number; unassigned: number }>((sum, d) => ({ cases: sum.cases + (d.cases as number), unassigned: sum.unassigned + (d.unassigned as number) }), {
            cases: 0,
            unassigned: 0,
          });
      const governorates = places
        .filter((p) => p.level === 1)
        .map((p) => {
          const key = nameKey(p.name as string);
          return { name: p.name, investigators: inGovernorate(key), whole: wholeGov.get(key)?.size ?? 0, ...demandOf(key) };
        })
        .sort((a, b) => a.investigators - b.investigators || b.cases - a.cases);
      const districts: Row[] = [];
      for (const p of places.filter((p) => p.level === 2 && p.governorate)) {
        const gov = nameKey(p.governorate as string);
        const key = nameKey(p.name as string);
        const covering = new Set([...(wholeGov.get(gov) ?? []), ...(byDistrict.get(`${gov}|${key}`) ?? [])]).size;
        if (covering) continue;
        districts.push({ governorate: p.governorate, district: p.name, ...demandOf(gov, key) });
      }
      districts.sort((a, b) => (b.cases as number) - (a.cases as number));
      return ok({
        governorates,
        uncovered_governorates: governorates.filter((g) => !g.investigators).length,
        // Districts nobody covers; the ones with cases first.
        uncovered_districts: districts,
      });
    }),
  );
}
