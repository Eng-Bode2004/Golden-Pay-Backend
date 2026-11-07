import { query } from "../IdentityAcess_Services/Config/db.ts";
import { withAuth, withPermission } from "../IdentityAcess_Services/MIddlewares/auth.middleware.ts";
import { recordAudit } from "../IdentityAcess_Services/Services/audit.service.ts";
import { PERMISSIONS } from "../IdentityAcess_Services/Services/rbac.service.ts";
import { ApiError, ok, readJson, type RequestContext } from "../IdentityAcess_Services/Utils/http.ts";
import type { Router } from "../IdentityAcess_Services/Utils/router.ts";
import { optionalNumber, optionalText } from "../Shared/service.ts";

/** Default investigation types. Prices start at zero until finance sets them. */
const DEFAULT_LEVELS = [
  { code: "normal", name_ar: "استعلام عادي", name_en: "Normal / Standard", delivery_label: "48–72 ساعة", delivery_hours: 72, accept_minutes: 120 },
  { code: "urgent", name_ar: "استعلام سريع", name_en: "Urgent", delivery_label: "خلال 24 ساعة", delivery_hours: 24, accept_minutes: 30 },
  { code: "express", name_ar: "استعلام عاجل جدًا", name_en: "Express", delivery_label: "خلال 6–12 ساعة", delivery_hours: 12, accept_minutes: 15 },
  { code: "same_day", name_ar: "استعلام فوري", name_en: "Same-Day / Priority", delivery_label: "خلال 2–6 ساعات", delivery_hours: 6, accept_minutes: 10 },
  { code: "scheduled", name_ar: "استعلام مجدول", name_en: "Scheduled", delivery_label: "في موعد محدد", delivery_hours: null, accept_minutes: 240 },
];

export async function seedServiceLevels(): Promise<void> {
  // Types created before acceptance windows existed got the column default;
  // give them their proper defaults once, never touching later admin edits.
  const migrated = await query(
    `INSERT INTO counters("_id",value) VALUES('accept_window_defaults',1) ON CONFLICT ("_id") DO NOTHING RETURNING value`,
  );
  if (migrated.length) {
    for (const level of DEFAULT_LEVELS) {
      await query("UPDATE service_levels SET accept_minutes=$2 WHERE code=$1", [level.code, level.accept_minutes]);
    }
  }
  for (const [index, level] of DEFAULT_LEVELS.entries()) {
    await query(
      `INSERT INTO service_levels(code,name_ar,name_en,delivery_label,delivery_hours,sort,accept_minutes)
       VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (code) DO NOTHING`,
      [level.code, level.name_ar, level.name_en, level.delivery_label, level.delivery_hours, index, level.accept_minutes],
    );
  }
}

const LEVEL_COLUMNS = `code, name_ar, name_en, delivery_label, delivery_hours, client_price::float8 AS client_price,
  investigator_price::float8 AS investigator_price, accept_minutes, active, sort, updated_at`;

export async function findServiceLevel(code: string): Promise<Record<string, unknown>> {
  const rows = await query(`SELECT ${LEVEL_COLUMNS} FROM service_levels WHERE code=$1 AND active`, [code]);
  if (!rows[0]) throw ApiError.badRequest("Choose an investigation type", { field: "service_level" });
  return rows[0];
}

/** "YYYY-MM-01" for the requested month, or the current month in Cairo. */
function monthStart(context: RequestContext): string {
  const requested = context.url.searchParams.get("month");
  if (requested && /^\d{4}-(0[1-9]|1[0-2])$/.test(requested)) return `${requested}-01`;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit" }).format(new Date());
  return `${today}-01`;
}

// Money is earned when a report is approved, in the Cairo month of approval.
const local = (column: string) => `(${column} AT TIME ZONE 'Africa/Cairo')`;
const inMonth = (column: string, param = "$1") =>
  `${local(column)} >= ${param}::date AND ${local(column)} < ${param}::date + interval '1 month'`;

function trend(month: string, assignee: string | null) {
  return query(
    `SELECT to_char(m, 'YYYY-MM') AS month,
       COALESCE(sum(i.client_price), 0)::float8 AS revenue,
       COALESCE(sum(i.investigator_price), 0)::float8 AS payouts,
       count(i.investigation_id)::int AS approved
     FROM generate_series($1::date - interval '5 months', $1::date, interval '1 month') AS m
     LEFT JOIN investigations i ON i.status = 'approved'
       AND ${local("i.reviewed_at")} >= m AND ${local("i.reviewed_at")} < m + interval '1 month'
       AND ($2::text IS NULL OR i.assignee_id = $2)
     GROUP BY m ORDER BY m`,
    [month, assignee],
  );
}

/** Per-investigator performance. `$1` is the month, `$2` an optional user. */
const PERFORMANCE_SQL = `
  SELECT i.assignee_id AS user_id,
    count(*)::int AS total,
    count(*) FILTER (WHERE status IN ('assigned','in_progress','returned'))::int AS active,
    count(*) FILTER (WHERE status = 'submitted')::int AS awaiting_review,
    count(*) FILTER (WHERE status = 'approved')::int AS approved,
    count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
    count(*) FILTER (WHERE outcome = 'negative' AND submitted_at IS NOT NULL)::int AS negative,
    COALESCE(sum(return_count), 0)::int AS returns,
    count(*) FILTER (WHERE status = 'approved' AND due_at IS NOT NULL AND submitted_at <= due_at)::int AS on_time,
    count(*) FILTER (WHERE status = 'approved' AND due_at IS NOT NULL)::int AS with_deadline,
    count(*) FILTER (WHERE status IN ('assigned','in_progress','returned') AND due_at < now())::int AS overdue,
    (avg(extract(epoch FROM submitted_at - COALESCE(claimed_at, created_at)) / 3600)
      FILTER (WHERE submitted_at IS NOT NULL))::float8 AS avg_hours,
    count(*) FILTER (WHERE status = 'approved' AND ${inMonth("reviewed_at")})::int AS approved_month,
    COALESCE(sum(investigator_price) FILTER (WHERE status = 'approved' AND ${inMonth("reviewed_at")}), 0)::float8 AS earned_month,
    COALESCE(sum(investigator_price) FILTER (WHERE status = 'approved'), 0)::float8 AS earned_total,
    COALESCE(sum(investigator_price) FILTER (WHERE status = 'submitted'), 0)::float8 AS pending_earnings,
    COALESCE(sum(client_price) FILTER (WHERE status = 'approved'), 0)::float8 AS revenue_total,
    max(submitted_at) AS last_submitted_at
  FROM investigations i
  WHERE assignee_id IS NOT NULL AND ($2::text IS NULL OR assignee_id = $2)
  GROUP BY assignee_id`;

/** How quickly each investigator sees and answers offers. `$1` month, `$2` user. */
const RESPONSE_SQL = `
  SELECT o.user_id,
    count(*)::int AS offers,
    count(*) FILTER (WHERE response = 'accepted')::int AS accepted,
    count(*) FILTER (WHERE response IS NOT NULL)::int AS answered,
    count(*) FILTER (WHERE response IS NOT NULL AND ${inMonth("offered_at")})::int AS answered_month,
    count(*) FILTER (WHERE response = 'declined')::int AS declined,
    count(*) FILTER (WHERE response = 'expired')::int AS expired,
    count(*) FILTER (WHERE ${inMonth("offered_at")})::int AS offers_month,
    count(*) FILTER (WHERE response = 'accepted' AND ${inMonth("offered_at")})::int AS accepted_month,
    (avg(extract(epoch FROM seen_at - offered_at) / 60) FILTER (WHERE seen_at IS NOT NULL))::float8 AS avg_seen_minutes,
    (avg(extract(epoch FROM responded_at - offered_at) / 60)
      FILTER (WHERE response IN ('accepted','declined')))::float8 AS avg_response_minutes
  FROM investigation_offers o
  WHERE ($2::text IS NULL OR o.user_id = $2) AND o.response IS DISTINCT FROM 'cancelled'
  GROUP BY o.user_id`;

/** From first seeing an offer to submitting the report, per investigator. */
const LIFECYCLE_SQL = `
  SELECT i.assignee_id AS user_id,
    (avg(extract(epoch FROM i.submitted_at - COALESCE(o.seen_at, o.offered_at)) / 3600)
      FILTER (WHERE i.submitted_at IS NOT NULL))::float8 AS avg_seen_to_submit_hours,
    (avg(extract(epoch FROM i.reviewed_at - o.offered_at) / 3600)
      FILTER (WHERE i.status = 'approved'))::float8 AS avg_offer_to_approval_hours
  FROM investigations i
  JOIN investigation_offers o ON o.investigation_id = i.investigation_id AND o.user_id = i.assignee_id
    AND o.response = 'accepted'
  WHERE ($1::text IS NULL OR i.assignee_id = $1)
  GROUP BY i.assignee_id`;

export function registerFinanceRoutes(router: Router): void {
  router.get(
    "/investigations/leaderboard",
    withPermission(PERMISSIONS.INVESTIGATIONS_MANAGE, async (context) => {
      const month = monthStart(context);
      const [people, performance, responses, lifecycle, previous] = await Promise.all([
        query(
          `SELECT u.user_id, u.full_name, u.employee_number, p.governorate, p.district
           FROM users u JOIN investigator_profiles p ON p.user_id = u.user_id
           WHERE u.status = 'active' AND u.deleted_at IS NULL`,
        ),
        query(PERFORMANCE_SQL, [month, null]),
        query(RESPONSE_SQL, [month, null]),
        query(LIFECYCLE_SQL, [null]),
        query(
          `SELECT assignee_id AS user_id, count(*)::int AS approved_prev,
             COALESCE(sum(investigator_price), 0)::float8 AS earned_prev
           FROM investigations WHERE status = 'approved' AND ${inMonth("reviewed_at", "($1::date - interval '1 month')")}
           GROUP BY assignee_id`,
          [month],
        ),
      ]);
      const by = (rows: Record<string, unknown>[]) => new Map(rows.map((row) => [row.user_id, row]));
      const [perf, resp, life, prev] = [by(performance), by(responses), by(lifecycle), by(previous)];
      const rows = people.map((person) => {
        const p = (perf.get(person.user_id) ?? {}) as Record<string, number>;
        const r = (resp.get(person.user_id) ?? {}) as Record<string, number>;
        const l = (life.get(person.user_id) ?? {}) as Record<string, number>;
        const before = (prev.get(person.user_id) ?? {}) as Record<string, number>;
        const approved = p.approved_month ?? 0;
        // Offers still waiting for a reply do not count against the investigator.
        const acceptRate = r.answered_month ? r.accepted_month / r.answered_month : null;
        const onTime = p.with_deadline ? p.on_time / p.with_deadline : null;
        return {
          ...person,
          approved_month: approved,
          approved_prev: before.approved_prev ?? 0,
          growth: approved - (before.approved_prev ?? 0),
          earned_month: p.earned_month ?? 0,
          earned_prev: before.earned_prev ?? 0,
          active: p.active ?? 0,
          offers_month: r.offers_month ?? 0,
          accept_rate: acceptRate,
          avg_response_minutes: r.avg_response_minutes ?? null,
          avg_seen_to_submit_hours: l.avg_seen_to_submit_hours ?? null,
          on_time_rate: onTime,
          returns: p.returns ?? 0,
          // Activity rewards finished work most, then accepting offers and punctuality.
          score: Math.round(approved * 10 + (r.accepted_month ?? 0) * 3 + (acceptRate ?? 0) * 10 + (onTime ?? 0) * 10),
        };
      });
      return ok({ month: month.slice(0, 7), investigators: rows.sort((a, b) => b.score - a.score) });
    }),
  );

  router.get(
    "/investigations/service-levels",
    withPermission(PERMISSIONS.INVESTIGATIONS_MANAGE, async () =>
      ok({ levels: await query(`SELECT ${LEVEL_COLUMNS} FROM service_levels ORDER BY sort`) }),
    ),
  );

  router.patch(
    "/investigations/service-levels/:code",
    withPermission(PERMISSIONS.FINANCE_MANAGE, async (context, auth) => {
      const body = await readJson(context.req);
      const price = (field: string) => {
        const value = optionalNumber(body[field], field);
        if (value !== null && (value < 0 || value > 1_000_000)) {
          throw ApiError.badRequest(`${field} must be between 0 and 1,000,000`, { field });
        }
        return value;
      };
      const hours = optionalNumber(body.delivery_hours, "delivery_hours");
      const acceptMinutes = optionalNumber(body.accept_minutes, "accept_minutes");
      if (acceptMinutes !== null && (acceptMinutes < 1 || acceptMinutes > 7 * 24 * 60)) {
        throw ApiError.badRequest("accept_minutes must be between 1 minute and 7 days", { field: "accept_minutes" });
      }
      if (hours !== null && (hours < 1 || hours > 24 * 60)) {
        throw ApiError.badRequest("delivery_hours must be between 1 and 1440", { field: "delivery_hours" });
      }
      const rows = await query(
        `UPDATE service_levels SET
           name_ar = COALESCE($2, name_ar),
           delivery_label = COALESCE($3, delivery_label),
           delivery_hours = CASE WHEN $4::boolean THEN $5::int ELSE delivery_hours END,
           client_price = COALESCE($6, client_price),
           investigator_price = COALESCE($7, investigator_price),
           active = COALESCE($8, active),
           accept_minutes = COALESCE($10::int, accept_minutes),
           updated_by = $9, updated_at = now()
         WHERE code = $1 RETURNING ${LEVEL_COLUMNS}`,
        [
          context.params.code,
          optionalText(body.name_ar, 80),
          optionalText(body.delivery_label, 80),
          "delivery_hours" in body && context.params.code !== "scheduled",
          hours === null ? null : Math.round(hours),
          price("client_price"),
          price("investigator_price"),
          typeof body.active === "boolean" ? body.active : null,
          auth.user.user_id,
          acceptMinutes === null ? null : Math.round(acceptMinutes),
        ],
      );
      if (!rows[0]) throw ApiError.notFound("Investigation type not found");
      await recordAudit({
        event: "pricing.updated",
        actorId: auth.user.user_id,
        success: true,
        context,
        metadata: { code: context.params.code },
      });
      return ok({ level: rows[0] });
    }),
  );

  router.get(
    "/investigations/finance",
    withPermission(PERMISSIONS.FINANCE_MANAGE, async (context) => {
      const month = monthStart(context);
      const [totals, pending, byClient, byLevel, months] = await Promise.all([
        query(
          `SELECT COALESCE(sum(client_price),0)::float8 AS revenue, COALESCE(sum(investigator_price),0)::float8 AS payouts,
             count(*)::int AS approved
           FROM investigations WHERE status='approved' AND ${inMonth("reviewed_at")}`,
          [month],
        ),
        query(
          `SELECT COALESCE(sum(client_price),0)::float8 AS revenue, COALESCE(sum(investigator_price),0)::float8 AS payouts,
             count(*)::int AS cases
           FROM investigations WHERE status IN ('submitted','assigned','in_progress','returned','open')`,
        ),
        query(
          `SELECT client_name AS name, count(*)::int AS approved, sum(client_price)::float8 AS revenue,
             sum(client_price - investigator_price)::float8 AS profit
           FROM investigations WHERE status='approved' AND ${inMonth("reviewed_at")}
           GROUP BY client_name ORDER BY revenue DESC`,
          [month],
        ),
        query(
          `SELECT COALESCE(service_name,'—') AS name, count(*)::int AS approved, sum(client_price)::float8 AS revenue
           FROM investigations WHERE status='approved' AND ${inMonth("reviewed_at")}
           GROUP BY service_name ORDER BY revenue DESC`,
          [month],
        ),
        trend(month, null),
      ]);
      const total = totals[0] as { revenue: number; payouts: number; approved: number };
      return ok({
        month: month.slice(0, 7),
        revenue: total.revenue,
        payouts: total.payouts,
        profit: total.revenue - total.payouts,
        approved: total.approved,
        pipeline: pending[0],
        by_client: byClient,
        by_level: byLevel,
        trend: months,
      });
    }),
  );

  router.get(
    "/investigations/performance",
    withPermission(PERMISSIONS.INVESTIGATIONS_MANAGE, async (context) => {
      const month = monthStart(context);
      return ok({ month: month.slice(0, 7), investigators: await query(PERFORMANCE_SQL, [month, null]) });
    }),
  );

  router.get(
    "/investigations/performance/:user_id",
    withPermission(PERMISSIONS.INVESTIGATIONS_MANAGE, async (context) => {
      const month = monthStart(context);
      const user = context.params.user_id ?? "";
      const [stats, months, levels, clients, recent, responses, lifecycle] = await Promise.all([
        query(PERFORMANCE_SQL, [month, user]),
        trend(month, user),
        query(
          `SELECT COALESCE(service_name,'—') AS name, count(*)::int AS total FROM investigations
           WHERE assignee_id=$1 GROUP BY service_name ORDER BY total DESC`,
          [user],
        ),
        query(
          `SELECT client_name AS name, count(*)::int AS total FROM investigations
           WHERE assignee_id=$1 GROUP BY client_name ORDER BY total DESC LIMIT 6`,
          [user],
        ),
        query(
          `SELECT i.investigation_id, i.reference, i.status, i.subject_name, i.client_name, i.form_title, i.service_name,
             i.investigator_price::float8 AS investigator_price, i.due_at, i.submitted_at, i.reviewed_at, i.created_at,
             o.offered_at, o.seen_at, o.responded_at, o.response, o.reason
           FROM investigation_offers o JOIN investigations i ON i.investigation_id = o.investigation_id
           WHERE o.user_id = $1 AND o.response IS DISTINCT FROM 'cancelled'
           ORDER BY o.offered_at DESC LIMIT 30`,
          [user],
        ),
        query(RESPONSE_SQL, [month, user]),
        query(LIFECYCLE_SQL, [user]),
      ]);
      return ok({
        month: month.slice(0, 7),
        stats: stats[0] ?? null,
        responses: responses[0] ?? null,
        lifecycle: lifecycle[0] ?? null,
        trend: months,
        by_level: levels,
        by_client: clients,
        recent,
      });
    }),
  );

  router.get(
    "/investigations/mine/earnings",
    withAuth(async (context, auth) => {
      const month = monthStart(context);
      const [stats, months] = await Promise.all([
        query(PERFORMANCE_SQL, [month, auth.user.user_id]),
        trend(month, auth.user.user_id),
      ]);
      const row = (stats[0] ?? {}) as Record<string, number>;
      return ok({
        month: month.slice(0, 7),
        earned: row.earned_month ?? 0,
        approved: row.approved_month ?? 0,
        pending: row.pending_earnings ?? 0,
        awaiting_review: row.awaiting_review ?? 0,
        earned_total: row.earned_total ?? 0,
        // Investigators see their own earnings, never what the client pays.
        trend: months.map((item) => ({ month: item.month, earned: item.payouts, approved: item.approved })),
      });
    }),
  );
}
