import { join } from "node:path";
import { query, transaction } from "../IdentityAcess_Services/Config/db.ts";
import { withAuth, type AuthContext } from "../IdentityAcess_Services/MIddlewares/auth.middleware.ts";
import type { AuditEvent } from "../IdentityAcess_Services/Models/AuditLogSchema.ts";
import { recordAudit } from "../IdentityAcess_Services/Services/audit.service.ts";
import { PERMISSIONS } from "../IdentityAcess_Services/Services/rbac.service.ts";
import { ApiError, created, ok, readJson, type RequestContext } from "../IdentityAcess_Services/Utils/http.ts";
import { logger } from "../IdentityAcess_Services/Utils/logger.ts";
import { Router } from "../IdentityAcess_Services/Utils/router.ts";
import { optionalNumber, optionalText, requiredText, startService } from "../Shared/service.ts";
import { EXPENSE_CATEGORIES, expensesFor, monthResult, staffMonth } from "./money.ts";
import { registerReleaseRoutes } from "./releases.ts";
import {
  cairo,
  groupOf,
  loadSettings,
  meanings,
  monthStart,
  pointCounts,
  REASONS,
  recordPresence,
  shiftMonth,
  STAFF_SQL,
  sweepAbsences,
  tally,
  toMinutes,
  weekdayOf,
  type PointRules,
  type Schedule,
  type StaffGroup,
} from "./rules.ts";

export const router = new Router();
registerReleaseRoutes(router);
const MANAGE = PERMISSIONS.HEADOFFICE_MANAGE;

/**
 * Head office only. The shared permission check lets the admin role through every
 * permission, and head office oversees admins, so the permission must be held explicitly.
 */
function withPermission(
  _permission: typeof MANAGE,
  handler: (context: RequestContext, auth: AuthContext) => Promise<Response> | Response,
) {
  return withAuth((context, auth) => {
    if (!auth.access.permissions.includes(MANAGE)) throw ApiError.forbidden("Head office access only");
    return handler(context, auth);
  });
}

export const COMPLAINT_CATEGORIES = [
  "الرواتب والمستحقات",
  "الحضور والنقاط",
  "العمل والاستعلامات",
  "التطبيق ومشاكل فنية",
  "المعاملة والسلوك",
  "أخرى",
];
const COMPLAINT_STATUS = ["open", "in_review", "resolved"] as const;
/** Topics for administrators writing to head office. */
export const MESSAGE_TOPICS = ["متابعة العمل", "طلب أو موافقة", "اقتراح", "مشكلة في العمل", "الرواتب والحضور", "أخرى"];
const kindOf = (value: unknown) => (value === "message" ? "message" : "complaint");
const topicsOf = (kind: string) => (kind === "message" ? MESSAGE_TOPICS : COMPLAINT_CATEGORIES);

type Row = Record<string, unknown>;
const monthOf = (context: RequestContext) => monthStart(context.url.searchParams.get("month"));
const audit = (context: RequestContext, auth: AuthContext, event: AuditEvent, userId: string | null, metadata: Row) =>
  recordAudit({ event, userId, actorId: auth.user.user_id, success: true, context, metadata });

async function staffMember(userId: string): Promise<Row> {
  const [person] = await query(`SELECT * FROM (${STAFF_SQL}) s WHERE s.user_id = $1`, [userId]);
  if (!person) throw ApiError.notFound("Staff member not found");
  return person;
}

const POINT_COLUMNS = `point_id, color, reason, minutes, note, to_char(day,'YYYY-MM-DD') AS day, created_at,
  revoked_at, revoke_note, (SELECT full_name FROM users WHERE user_id = p.awarded_by) AS awarded_by_name`;

/* ---------- Everyone: presence and own points ---------- */

router.post(
  "/attendance/ping",
  withAuth(async (context, auth) => {
    const group = groupOf(auth.access.roles);
    if (!group) return ok({ tracked: false });
    const body = await readJson(context.req).catch(() => ({}) as Row);
    const platform = optionalText(body.platform, 20);
    return ok({ tracked: true, ...(await recordPresence(auth.user.user_id, group, platform)) });
  }),
);

router.get(
  "/points/me",
  withAuth(async (context, auth) => {
    const group = groupOf(auth.access.roles);
    const settings = await loadSettings();
    const month = monthOf(context);
    if (!group) return ok({ tracked: false, meanings: meanings(settings.points) });
    const [counts, points, today, days] = await Promise.all([
      pointCounts(month, auth.user.user_id),
      query(
        `SELECT ${POINT_COLUMNS} FROM staff_points p WHERE user_id = $1
           AND day >= $2::date AND day < $2::date + interval '1 month' ORDER BY day DESC, created_at DESC`,
        [auth.user.user_id, month],
      ),
      query("SELECT first_seen, last_seen, late_minutes, work_day FROM attendance WHERE user_id = $1 AND day = $2", [
        auth.user.user_id,
        cairo().day,
      ]),
      query(
        `SELECT to_char(day,'YYYY-MM-DD') AS day, first_seen, last_seen, late_minutes, work_day FROM attendance
         WHERE user_id = $1 AND day >= $2::date AND day < $2::date + interval '1 month' ORDER BY day`,
        [auth.user.user_id, month],
      ),
    ]);
    return ok({
      tracked: true,
      group,
      month: month.slice(0, 7),
      schedule: settings.schedules[group],
      rules: settings.points,
      meanings: meanings(settings.points),
      reasons: Object.fromEntries(Object.entries(REASONS).map(([key, value]) => [key, value.label])),
      summary: tally(counts.get(auth.user.user_id) ?? {}, settings.points),
      today: today[0] ?? null,
      days,
      points,
    });
  }),
);

/* ---------- Everyone: complaints to head office ---------- */

async function complaintThread(complaintId: string) {
  return query(
    `SELECT m.message_id, m.body, m.from_office, m.created_at, u.full_name AS author
     FROM complaint_messages m JOIN users u ON u.user_id = m.author_id
     WHERE m.complaint_id = $1 ORDER BY m.created_at`,
    [complaintId],
  );
}

router.get(
  "/complaints/mine",
  withAuth(async (context, auth) => {
    const kind = kindOf(context.url.searchParams.get("kind"));
    const rows = await query(
      `SELECT c.*, (c.last_reply_at IS NOT NULL AND (c.seen_by_user_at IS NULL OR c.seen_by_user_at < c.last_reply_at)) AS unread
       FROM complaints c WHERE user_id = $1 AND kind = $2 ORDER BY created_at DESC LIMIT 100`,
      [auth.user.user_id, kind],
    );
    return ok({
      categories: topicsOf(kind),
      unread: rows.filter((row) => row.unread).length,
      complaints: rows,
    });
  }),
);

router.post(
  "/complaints",
  withAuth(async (context, auth) => {
    const body = await readJson(context.req);
    const kind = kindOf(body.kind);
    // Messages are how administrators reach head office; investigators send complaints.
    if (kind === "message" && groupOf(auth.access.roles) !== "admin") {
      throw ApiError.forbidden("Only administrators can message head office");
    }
    const category = String(body.category ?? "");
    if (!topicsOf(kind).includes(category)) throw ApiError.badRequest("Choose a category", { field: "category" });
    const subject = requiredText(body.subject, "subject", 120);
    const text = requiredText(body.body, "body", 4000);
    if (text.length < 10) throw ApiError.badRequest("Write at least 10 characters", { field: "body" });
    const complaint = await transaction(async () => {
      const [counter] = await query(
        `INSERT INTO counters("_id",value) VALUES($1,1)
         ON CONFLICT ("_id") DO UPDATE SET value = counters.value + 1 RETURNING value`,
        [kind],
      );
      const reference = `${kind === "message" ? "MSG" : "CMP"}-${String(counter!.value).padStart(5, "0")}`;
      const [row] = await query(
        `INSERT INTO complaints(reference,user_id,category,subject,body,kind) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
        [reference, auth.user.user_id, category, subject, text, kind],
      );
      return row!;
    });
    return created({ complaint });
  }),
);

router.get(
  "/complaints/:id",
  withAuth(async (context, auth) => {
    const [complaint] = await query("SELECT * FROM complaints WHERE complaint_id = $1", [context.params.id]);
    const office = auth.access.permissions.includes(MANAGE);
    if (!complaint || (!office && complaint.user_id !== auth.user.user_id)) throw ApiError.notFound("Complaint not found");
    if (complaint.user_id === auth.user.user_id) {
      await query("UPDATE complaints SET seen_by_user_at = now() WHERE complaint_id = $1", [complaint.complaint_id]);
    }
    return ok({ complaint, messages: await complaintThread(complaint.complaint_id as string) });
  }),
);

router.post(
  "/complaints/:id/messages",
  withAuth(async (context, auth) => {
    const [complaint] = await query("SELECT * FROM complaints WHERE complaint_id = $1", [context.params.id]);
    const office = auth.access.permissions.includes(MANAGE);
    const own = complaint?.user_id === auth.user.user_id;
    if (!complaint || (!office && !own)) throw ApiError.notFound("Complaint not found");
    const body = await readJson(context.req);
    const text = requiredText(body.body, "body", 4000);
    const status = body.status === undefined ? null : String(body.status);
    if (status !== null && (!office || !(COMPLAINT_STATUS as readonly string[]).includes(status))) {
      throw ApiError.badRequest("Unknown status", { field: "status" });
    }
    const fromOffice = office && !own;
    await query("INSERT INTO complaint_messages(complaint_id,author_id,from_office,body) VALUES($1,$2,$3,$4)", [
      complaint.complaint_id,
      auth.user.user_id,
      fromOffice,
      text,
    ]);
    await query(
      `UPDATE complaints SET updated_at = now(),
         status = COALESCE($2, CASE WHEN $3 AND status = 'open' THEN 'in_review' WHEN NOT $3 AND status = 'resolved' THEN 'open' ELSE status END),
         last_reply_at = CASE WHEN $3 THEN now() ELSE last_reply_at END
       WHERE complaint_id = $1`,
      [complaint.complaint_id, status, fromOffice],
    );
    return created({ messages: await complaintThread(complaint.complaint_id as string) });
  }),
);

/* ---------- Head office ---------- */

router.get(
  "/headoffice/overview",
  withPermission(MANAGE, async (context) => {
    const month = monthOf(context);
    const settings = await loadSettings();
    const people = await staffMonth(month, settings);
    const months = [5, 4, 3, 2, 1].map((back) => shiftMonth(month, -back));
    const [current, ...history] = await Promise.all([
      monthResult(month, settings, people),
      ...months.map((value) => monthResult(value, settings)),
    ]);
    const now = cairo();
    const today = await query("SELECT user_id, late_minutes FROM attendance WHERE day = $1", [now.day]);
    const attendanceToday = { present: 0, late: 0, absent: 0, off: 0, waiting: 0 };
    for (const person of people) {
      const schedule = settings.schedules[person.staff_group];
      const row = today.find((item) => item.user_id === person.user_id);
      if (row) {
        attendanceToday.present += 1;
        if (Number(row.late_minutes) > 0) attendanceToday.late += 1;
      } else if (schedule.off_days.includes(now.weekday)) attendanceToday.off += 1;
      else if (now.minutes > toMinutes(schedule.start) + schedule.grace_minutes) attendanceToday.absent += 1;
      else attendanceToday.waiting += 1;
    }
    const [cases] = await query(
      `SELECT count(*) FILTER (WHERE (created_at AT TIME ZONE 'Africa/Cairo') >= $1::date
           AND (created_at AT TIME ZONE 'Africa/Cairo') < $1::date + interval '1 month')::int AS created,
         count(*) FILTER (WHERE status IN ('open','unassigned'))::int AS waiting,
         count(*) FILTER (WHERE status IN ('assigned','in_progress','returned'))::int AS working,
         count(*) FILTER (WHERE status = 'submitted')::int AS review
       FROM investigations`,
      [month],
    );
    const [complaints] = await query(
      "SELECT count(*) FILTER (WHERE status <> 'resolved')::int AS open, count(*)::int AS total FROM complaints",
    );
    const rank = (group: StaffGroup) =>
      people
        .filter((person) => person.staff_group === group)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
    const totals = people.reduce(
      (sum, person) => ({
        green: sum.green + person.points.green,
        black: sum.black + person.points.black,
        blue: sum.blue + person.points.blue,
        cleared: sum.cleared + person.points.cleared,
      }),
      { green: 0, black: 0, blue: 0, cleared: 0 },
    );
    return ok({
      month: month.slice(0, 7),
      result: current,
      trend: [...history, current],
      staff: {
        admins: people.filter((person) => person.staff_group === "admin").length,
        investigators: people.filter((person) => person.staff_group === "investigator").length,
      },
      attendance_today: attendanceToday,
      points: totals,
      cases,
      complaints,
      top_investigators: rank("investigator"),
      top_admins: rank("admin"),
    });
  }),
);

router.get(
  "/headoffice/staff",
  withPermission(MANAGE, async (context) => {
    const group = context.url.searchParams.get("group");
    const people = await staffMonth(monthOf(context));
    return ok({ staff: people.filter((person) => !group || person.staff_group === group) });
  }),
);

router.get(
  "/headoffice/staff/:id",
  withPermission(MANAGE, async (context) => {
    const month = monthOf(context);
    const settings = await loadSettings();
    const [person] = await staffMonth(month, settings, context.params.id ?? "");
    if (!person) throw ApiError.notFound("Staff member not found");
    const [points, days, complaints, adjustments, salary] = await Promise.all([
      query(
        `SELECT ${POINT_COLUMNS} FROM staff_points p WHERE user_id = $1
           AND day >= $2::date AND day < $2::date + interval '1 month' ORDER BY day DESC, created_at DESC`,
        [person.user_id, month],
      ),
      query(
        `SELECT to_char(day,'YYYY-MM-DD') AS day, first_seen, last_seen, late_minutes, work_day FROM attendance
         WHERE user_id = $1 AND day >= $2::date AND day < $2::date + interval '1 month' ORDER BY day`,
        [person.user_id, month],
      ),
      query("SELECT complaint_id, reference, subject, status, created_at FROM complaints WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20", [
        person.user_id,
      ]),
      query(
        `SELECT a.adjustment_id, a.amount::float8 AS amount, a.note, a.created_at, u.full_name AS created_by_name
         FROM payroll_adjustments a LEFT JOIN users u ON u.user_id = a.created_by
         WHERE a.user_id = $1 AND a.month = $2::date ORDER BY a.created_at`,
        [person.user_id, month],
      ),
      query("SELECT base_salary::float8 AS base_salary, updated_at FROM staff_salaries WHERE user_id = $1", [person.user_id]),
    ]);
    return ok({
      person,
      month: month.slice(0, 7),
      schedule: settings.schedules[person.staff_group],
      rules: settings.points,
      points,
      days,
      complaints,
      adjustments,
      salary: salary[0] ?? null,
    });
  }),
);

router.get(
  "/headoffice/attendance",
  withPermission(MANAGE, async (context) => {
    const requested = context.url.searchParams.get("date");
    const day = requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : cairo().day;
    const settings = await loadSettings();
    const now = cairo();
    const rows = await query(
      `SELECT s.user_id, s.full_name, s.employee_number, s.staff_group, a.first_seen, a.last_seen, a.late_minutes, a.platform,
         (SELECT json_agg(json_build_object('point_id', p.point_id, 'color', p.color, 'reason', p.reason, 'minutes', p.minutes, 'revoked', p.revoked_at IS NOT NULL))
            FROM staff_points p WHERE p.user_id = s.user_id AND p.day = $1::date) AS points
       FROM (${STAFF_SQL}) s LEFT JOIN attendance a ON a.user_id = s.user_id AND a.day = $1::date
       ORDER BY s.staff_group, a.first_seen NULLS LAST, s.full_name`,
      [day],
    );
    const weekday = weekdayOf(day);
    const people = rows.map((row) => {
      const schedule = settings.schedules[row.staff_group as StaffGroup];
      const off = schedule.off_days.includes(weekday);
      let status: string;
      if (row.first_seen) status = off ? "off_day_work" : Number(row.late_minutes) > 0 ? "late" : "present";
      else if (off) status = "off";
      else if (day === now.day && now.minutes <= toMinutes(schedule.start) + schedule.grace_minutes) status = "waiting";
      else status = "absent";
      return { ...row, status };
    });
    return ok({ date: day, schedules: settings.schedules, people });
  }),
);

router.get(
  "/headoffice/settings",
  withPermission(MANAGE, async () => ok({ settings: await loadSettings() })),
);

function readSchedule(value: unknown, field: string): Schedule {
  const input = (value ?? {}) as Row;
  const time = (key: string) => {
    const text = String(input[key] ?? "");
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) throw ApiError.badRequest(`${field}.${key} must be HH:MM`, { field: `${field}.${key}` });
    return text;
  };
  const whole = (key: string, max: number) => {
    const number = optionalNumber(input[key], `${field}.${key}`);
    if (number === null || number < 0 || number > max || !Number.isInteger(number)) {
      throw ApiError.badRequest(`${field}.${key} must be a whole number from 0 to ${max}`, { field: `${field}.${key}` });
    }
    return number;
  };
  const start = time("start");
  const end = time("end");
  if (toMinutes(end) <= toMinutes(start)) throw ApiError.badRequest("The work day must end after it starts", { field: `${field}.end` });
  const offDays = Array.isArray(input.off_days) ? [...new Set(input.off_days.map(Number))] : [];
  if (offDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6) || offDays.length > 6) {
    throw ApiError.badRequest("Choose valid days off", { field: `${field}.off_days` });
  }
  return {
    start,
    end,
    grace_minutes: whole("grace_minutes", 180),
    off_days: offDays.sort(),
    overtime_minutes: whole("overtime_minutes", 600),
    offday_min_minutes: whole("offday_min_minutes", 720),
  };
}

router.patch(
  "/headoffice/settings",
  withPermission(MANAGE, async (context, auth) => {
    const body = await readJson(context.req);
    const schedules = { admin: readSchedule((body.schedules as Row)?.admin, "admin"), investigator: readSchedule((body.schedules as Row)?.investigator, "investigator") };
    const input = (body.points ?? {}) as Row;
    const amount = (key: string, max: number) => {
      const value = optionalNumber(input[key], key);
      if (value === null || value < 0 || value > max) throw ApiError.badRequest(`${key} is out of range`, { field: key });
      return value;
    };
    const points: PointRules = {
      blue_per_black: Math.round(amount("blue_per_black", 50)),
      blue_bonus: amount("blue_bonus", 1_000_000),
      black_deduction: amount("black_deduction", 1_000_000),
      absence_black: input.absence_black !== false,
    };
    for (const [key, value] of [
      ["schedules", schedules],
      ["points", points],
    ] as const) {
      await query(
        `INSERT INTO ho_settings(key,value,updated_by) VALUES($1,($2::text)::jsonb,$3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [key, JSON.stringify(value), auth.user.user_id],
      );
    }
    await audit(context, auth, "headoffice.settings.updated", null, { schedules, points });
    return ok({ settings: await loadSettings() });
  }),
);

router.post(
  "/headoffice/points",
  withPermission(MANAGE, async (context, auth) => {
    const body = await readJson(context.req);
    const person = await staffMember(String(body.user_id ?? ""));
    const color = String(body.color ?? "");
    if (color !== "blue" && color !== "black") throw ApiError.badRequest("Choose a blue or black point", { field: "color" });
    const note = requiredText(body.note, "note", 300);
    const count = Math.round(optionalNumber(body.count, "count") ?? 1);
    if (count < 1 || count > 10) throw ApiError.badRequest("Give between 1 and 10 points at once", { field: "count" });
    const day = cairo().day;
    for (let i = 0; i < count; i += 1) {
      await query("INSERT INTO staff_points(user_id,color,reason,note,day,awarded_by) VALUES($1,$2,'manual',$3,$4,$5)", [
        person.user_id,
        color,
        note,
        day,
        auth.user.user_id,
      ]);
    }
    await audit(context, auth, "headoffice.points.given", person.user_id as string, { color, count, note });
    return created({ given: count });
  }),
);

router.post(
  "/headoffice/points/:id/revoke",
  withPermission(MANAGE, async (context, auth) => {
    const body = await readJson(context.req);
    const note = requiredText(body.note, "note", 300);
    const [row] = await query(
      `UPDATE staff_points SET revoked_at = now(), revoked_by = $2, revoke_note = $3
       WHERE point_id = $1 AND revoked_at IS NULL RETURNING user_id, color, reason`,
      [context.params.id, auth.user.user_id, note],
    );
    if (!row) throw ApiError.notFound("Point not found or already removed");
    await audit(context, auth, "headoffice.points.revoked", row.user_id as string, { ...row, note });
    return ok({ revoked: true });
  }),
);

router.patch(
  "/headoffice/salaries/:id",
  withPermission(MANAGE, async (context, auth) => {
    const person = await staffMember(context.params.id ?? "");
    const body = await readJson(context.req);
    const base = optionalNumber(body.base_salary, "base_salary");
    if (base === null || base < 0 || base > 10_000_000) throw ApiError.badRequest("Enter a valid salary", { field: "base_salary" });
    await query(
      `INSERT INTO staff_salaries(user_id,base_salary,updated_by) VALUES($1,$2,$3)
       ON CONFLICT (user_id) DO UPDATE SET base_salary = EXCLUDED.base_salary, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [person.user_id, base, auth.user.user_id],
    );
    await audit(context, auth, "headoffice.salary.updated", person.user_id as string, { base_salary: base });
    return ok({ base_salary: base });
  }),
);

router.get(
  "/headoffice/payroll",
  withPermission(MANAGE, async (context) => {
    const month = monthOf(context);
    const people = await staffMonth(month);
    return ok({ month: month.slice(0, 7), people, result: await monthResult(month, undefined, people) });
  }),
);

router.post(
  "/headoffice/payroll/adjustments",
  withPermission(MANAGE, async (context, auth) => {
    const body = await readJson(context.req);
    const person = await staffMember(String(body.user_id ?? ""));
    const month = monthStart(String(body.month ?? ""));
    const amount = optionalNumber(body.amount, "amount");
    if (amount === null || amount === 0 || Math.abs(amount) > 10_000_000) throw ApiError.badRequest("Enter an amount", { field: "amount" });
    const note = requiredText(body.note, "note", 300);
    await assertUnpaid(person.user_id as string, month);
    await query("INSERT INTO payroll_adjustments(user_id,month,amount,note,created_by) VALUES($1,$2,$3,$4,$5)", [
      person.user_id,
      month,
      amount,
      note,
      auth.user.user_id,
    ]);
    await audit(context, auth, "headoffice.payroll.adjusted", person.user_id as string, { month, amount, note });
    return created({ saved: true });
  }),
);

router.delete(
  "/headoffice/payroll/adjustments/:id",
  withPermission(MANAGE, async (context, auth) => {
    const [row] = await query("SELECT user_id, to_char(month,'YYYY-MM-DD') AS month FROM payroll_adjustments WHERE adjustment_id = $1", [
      context.params.id,
    ]);
    if (!row) throw ApiError.notFound("Adjustment not found");
    await assertUnpaid(row.user_id as string, row.month as string);
    await query("DELETE FROM payroll_adjustments WHERE adjustment_id = $1", [context.params.id]);
    await audit(context, auth, "headoffice.payroll.adjustment_removed", row.user_id as string, row);
    return ok({ deleted: true });
  }),
);

async function assertUnpaid(userId: string, month: string) {
  const paid = await query("SELECT 1 FROM payroll_payments WHERE user_id = $1 AND month = $2::date", [userId, month]);
  if (paid.length) throw new ApiError(409, "MONTH_PAID", "This month is already paid for this person");
}

router.post(
  "/headoffice/payroll/pay",
  withPermission(MANAGE, async (context, auth) => {
    const body = await readJson(context.req);
    const month = monthStart(String(body.month ?? ""));
    if (month > monthStart(null)) throw ApiError.badRequest("A future month cannot be paid", { field: "month" });
    const ids = Array.isArray(body.user_ids) ? body.user_ids.map(String) : null;
    const people = (await staffMonth(month)).filter((person) => !person.pay.paid && (!ids || ids.includes(person.user_id)));
    for (const person of people) {
      await query(
        `INSERT INTO payroll_payments(user_id,month,amount,breakdown,paid_by) VALUES($1,$2,$3,($4::text)::jsonb,$5)
         ON CONFLICT (user_id, month) DO NOTHING`,
        [person.user_id, month, person.pay.total, JSON.stringify({ ...person.pay, points: person.points }), auth.user.user_id],
      );
    }
    await audit(context, auth, "headoffice.payroll.paid", null, { month, people: people.length });
    return ok({ paid: people.length });
  }),
);

router.delete(
  "/headoffice/payroll/pay/:id",
  withPermission(MANAGE, async (context, auth) => {
    const month = monthStart(context.url.searchParams.get("month"));
    const rows = await query("DELETE FROM payroll_payments WHERE user_id = $1 AND month = $2::date RETURNING amount", [
      context.params.id,
      month,
    ]);
    if (!rows.length) throw ApiError.notFound("Payment not found");
    await audit(context, auth, "headoffice.payroll.payment_undone", context.params.id ?? null, { month });
    return ok({ undone: true });
  }),
);

router.get(
  "/headoffice/expenses",
  withPermission(MANAGE, async (context) => {
    const month = monthOf(context);
    return ok({ month: month.slice(0, 7), categories: EXPENSE_CATEGORIES, expenses: await expensesFor(month) });
  }),
);

router.post(
  "/headoffice/expenses",
  withPermission(MANAGE, async (context, auth) => {
    const body = await readJson(context.req);
    const title = requiredText(body.title, "title", 120);
    const category = String(body.category ?? "");
    if (!EXPENSE_CATEGORIES.includes(category)) throw ApiError.badRequest("Choose a category", { field: "category" });
    const amount = optionalNumber(body.amount, "amount");
    if (amount === null || amount <= 0 || amount > 100_000_000) throw ApiError.badRequest("Enter an amount", { field: "amount" });
    const month = monthStart(String(body.month ?? ""));
    const [row] = await query(
      `INSERT INTO business_expenses(title,category,amount,month,recurring,note,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING expense_id`,
      [title, category, amount, month, body.recurring === true, optionalText(body.note, 500), auth.user.user_id],
    );
    await audit(context, auth, "headoffice.expense.created", null, { title, category, amount, month, recurring: body.recurring === true });
    return created({ expense_id: row!.expense_id });
  }),
);

router.delete(
  "/headoffice/expenses/:id",
  withPermission(MANAGE, async (context, auth) => {
    // A recurring expense stops from the chosen month; earlier months keep it.
    const [row] = await query("SELECT * FROM business_expenses WHERE expense_id = $1 AND deleted_at IS NULL", [context.params.id]);
    if (!row) throw ApiError.notFound("Expense not found");
    const from = monthStart(context.url.searchParams.get("month"));
    const startedEarlier = row.recurring && new Date(row.month as string).toISOString().slice(0, 10) < from;
    if (startedEarlier) {
      await query("UPDATE business_expenses SET end_month = ($2::date - interval '1 month')::date WHERE expense_id = $1", [row.expense_id, from]);
    } else {
      await query("UPDATE business_expenses SET deleted_at = now() WHERE expense_id = $1", [row.expense_id]);
    }
    await audit(context, auth, "headoffice.expense.removed", null, { title: row.title, amount: row.amount, from });
    return ok({ deleted: true });
  }),
);

router.get(
  "/headoffice/complaints",
  withPermission(MANAGE, async (context) => {
    const status = context.url.searchParams.get("status");
    const requested = context.url.searchParams.get("kind");
    const kind = requested ? kindOf(requested) : null;
    const rows = await query(
      `SELECT c.*, u.full_name, u.employee_number,
         (SELECT count(*)::int FROM complaint_messages m WHERE m.complaint_id = c.complaint_id) AS replies
       FROM complaints c JOIN users u ON u.user_id = c.user_id
       WHERE ($1::text IS NULL OR c.status = $1) AND ($2::text IS NULL OR c.kind = $2)
       ORDER BY (c.status = 'resolved'), c.updated_at DESC LIMIT 300`,
      [status && (COMPLAINT_STATUS as readonly string[]).includes(status) ? status : null, kind],
    );
    const [open] = await query(
      `SELECT count(*) FILTER (WHERE kind = 'complaint' AND status = 'open')::int AS complaints,
         count(*) FILTER (WHERE kind = 'message' AND status = 'open')::int AS messages FROM complaints`,
    );
    return ok({ complaints: rows, categories: topicsOf(kind ?? "complaint"), open });
  }),
);

router.patch(
  "/headoffice/complaints/:id",
  withPermission(MANAGE, async (context, auth) => {
    const body = await readJson(context.req);
    const status = String(body.status ?? "");
    if (!(COMPLAINT_STATUS as readonly string[]).includes(status)) throw ApiError.badRequest("Unknown status", { field: "status" });
    const rows = await query("UPDATE complaints SET status = $2, updated_at = now() WHERE complaint_id = $1 RETURNING user_id", [
      context.params.id,
      status,
    ]);
    if (!rows.length) throw ApiError.notFound("Complaint not found");
    await audit(context, auth, "headoffice.complaint.status", rows[0]!.user_id as string, { status });
    return ok({ status });
  }),
);

if (import.meta.main) {
  await startService({
    name: "golden-pay-head-office",
    port: Number(process.env.HEADOFFICE_PORT ?? 4005),
    router,
    schema: join(import.meta.dir, "schema.sql"),
    healthPrefix: "/headoffice",
    seed: async () => {
      await loadSettings();
      const sweep = () =>
        sweepAbsences().catch((error) =>
          logger.error("headoffice.sweep_failed", { error: error instanceof Error ? error.message : String(error) }),
        );
      void sweep();
      setInterval(() => void sweep(), 30 * 60_000);
    },
  });
}
