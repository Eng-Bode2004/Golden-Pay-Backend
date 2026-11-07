import { query } from "../IdentityAcess_Services/Config/db.ts";
import { loadSettings, pointCounts, STAFF_SQL, tally, type Settings, type Tally } from "./rules.ts";

/**
 * Monthly money. Revenue and investigator case pay follow the Investigations
 * service: they count in the Cairo month a report is approved. A person's pay is
 * base salary + case pay + blue bonus − black deduction + adjustments. Net profit
 * is revenue − all pay − business expenses.
 */

const local = (column: string) => `(${column} AT TIME ZONE 'Africa/Cairo')`;
export const inMonth = (column: string, param = "$1") =>
  `${local(column)} >= ${param}::date AND ${local(column)} < ${param}::date + interval '1 month'`;

type Row = Record<string, unknown>;

export const EXPENSE_CATEGORIES = [
  "إيجار",
  "كهرباء ومياه وإنترنت",
  "مواصلات ووقود",
  "اتصالات",
  "تسويق وإعلان",
  "صيانة",
  "ضرائب ورسوم",
  "مستلزمات مكتبية",
  "أخرى",
];

export interface StaffMonth {
  user_id: string;
  full_name: string;
  employee_number: string | null;
  email: string | null;
  phone: string | null;
  staff_group: "admin" | "investigator";
  roles: string[];
  last_login_at: string | null;
  points: Tally;
  attendance: { days: number; late_days: number; late_minutes: number; hours: number; absent: number };
  cases: {
    approved: number;
    negative: number;
    on_time: number;
    with_deadline: number;
    active: number;
    pay: number;
    revenue: number;
    created: number;
    reviewed: number;
    returned: number;
    avg_review_hours: number | null;
  };
  pay: {
    base: number;
    case_pay: number;
    bonus: number;
    deduction: number;
    adjustments: number;
    total: number;
    paid: { amount: number; paid_at: string } | null;
  };
  score: number;
}

/** Everything head office needs about every person for one month. */
export async function staffMonth(month: string, settings?: Settings, onlyUser: string | null = null): Promise<StaffMonth[]> {
  const loaded = settings ?? (await loadSettings());
  const rules = loaded.points;
  // Salaries count from the month head office started using the system, and from the month a person joined.
  const firstMonth = `${loaded.tracking_since.slice(0, 7)}-01`;
  const [staff, counts, attendance, absences, worked, created, reviews, reviewSpeed, salaries, adjustments, payments] =
    await Promise.all([
      query(`SELECT * FROM (${STAFF_SQL}) s WHERE $1::text IS NULL OR s.user_id = $1 ORDER BY full_name`, [onlyUser]),
      pointCounts(month, onlyUser),
      query(
        `SELECT user_id, count(*)::int AS days, count(*) FILTER (WHERE late_minutes > 0)::int AS late_days,
           COALESCE(sum(late_minutes), 0)::int AS late_minutes,
           COALESCE(sum(EXTRACT(epoch FROM last_seen - first_seen)) / 3600, 0)::float8 AS hours
         FROM attendance WHERE day >= $1::date AND day < $1::date + interval '1 month' GROUP BY user_id`,
        [month],
      ),
      query(
        `SELECT user_id, count(*)::int AS n FROM staff_points WHERE reason = 'absent' AND revoked_at IS NULL
           AND day >= $1::date AND day < $1::date + interval '1 month' GROUP BY user_id`,
        [month],
      ),
      query(
        `SELECT assignee_id AS user_id,
           count(*) FILTER (WHERE status = 'approved' AND ${inMonth("reviewed_at")})::int AS approved,
           count(*) FILTER (WHERE status = 'approved' AND outcome = 'negative' AND ${inMonth("reviewed_at")})::int AS negative,
           count(*) FILTER (WHERE status = 'approved' AND due_at IS NOT NULL AND submitted_at <= due_at AND ${inMonth("reviewed_at")})::int AS on_time,
           count(*) FILTER (WHERE status = 'approved' AND due_at IS NOT NULL AND ${inMonth("reviewed_at")})::int AS with_deadline,
           count(*) FILTER (WHERE status IN ('assigned','in_progress','returned'))::int AS active,
           COALESCE(sum(investigator_price) FILTER (WHERE status = 'approved' AND ${inMonth("reviewed_at")}), 0)::float8 AS pay,
           COALESCE(sum(client_price) FILTER (WHERE status = 'approved' AND ${inMonth("reviewed_at")}), 0)::float8 AS revenue
         FROM investigations WHERE assignee_id IS NOT NULL GROUP BY assignee_id`,
        [month],
      ),
      query(
        `SELECT created_by AS user_id, count(*)::int AS created FROM investigations WHERE ${inMonth("created_at")} GROUP BY created_by`,
        [month],
      ),
      query(
        `SELECT actor_id AS user_id, count(*)::int AS reviewed, count(*) FILTER (WHERE type = 'returned')::int AS returned
         FROM investigation_events WHERE type IN ('approved','returned') AND actor_id IS NOT NULL AND ${inMonth("created_at")}
         GROUP BY actor_id`,
        [month],
      ),
      query(
        `SELECT reviewed_by AS user_id, avg(EXTRACT(epoch FROM reviewed_at - submitted_at) / 3600)::float8 AS hours
         FROM investigations WHERE reviewed_by IS NOT NULL AND submitted_at IS NOT NULL AND ${inMonth("reviewed_at")}
         GROUP BY reviewed_by`,
        [month],
      ),
      query("SELECT user_id, base_salary::float8 AS base FROM staff_salaries"),
      query(
        "SELECT user_id, COALESCE(sum(amount), 0)::float8 AS total FROM payroll_adjustments WHERE month = $1::date GROUP BY user_id",
        [month],
      ),
      query("SELECT user_id, amount::float8 AS amount, paid_at FROM payroll_payments WHERE month = $1::date", [month]),
    ]);

  const index = (rows: Row[]) => new Map(rows.map((row) => [row.user_id as string, row]));
  const [att, abs, work, made, rev, speed, sal, adj, paid] = [
    attendance,
    absences,
    worked,
    created,
    reviews,
    reviewSpeed,
    salaries,
    adjustments,
    payments,
  ].map(index);

  return staff.map((person) => {
    const id = person.user_id as string;
    const points = tally(counts.get(id) ?? {}, rules);
    const w = work!.get(id) ?? {};
    const r = rev!.get(id) ?? {};
    const a = att!.get(id) ?? {};
    const cases = {
      approved: Number(w.approved ?? 0),
      negative: Number(w.negative ?? 0),
      on_time: Number(w.on_time ?? 0),
      with_deadline: Number(w.with_deadline ?? 0),
      active: Number(w.active ?? 0),
      pay: Number(w.pay ?? 0),
      revenue: Number(w.revenue ?? 0),
      created: Number(made!.get(id)?.created ?? 0),
      reviewed: Number(r.reviewed ?? 0),
      returned: Number(r.returned ?? 0),
      avg_review_hours: speed!.get(id)?.hours === undefined ? null : Number(speed!.get(id)!.hours),
    };
    const joined = `${new Date(person.created_at as string).toISOString().slice(0, 7)}-01`;
    const base = month >= firstMonth && month >= joined ? Number(sal!.get(id)?.base ?? 0) : 0;
    const adjustmentsTotal = Number(adj!.get(id)?.total ?? 0);
    const payment = paid!.get(id);
    const group = person.staff_group as "admin" | "investigator";
    // The efficiency score explained on the dashboard: output first, then discipline.
    const output =
      group === "investigator" ? cases.approved * 10 + cases.on_time * 2 : cases.created * 2 + cases.reviewed * 3;
    return {
      user_id: id,
      full_name: person.full_name as string,
      employee_number: (person.employee_number as string | null) ?? null,
      email: (person.email as string | null) ?? null,
      phone: (person.phone as string | null) ?? null,
      staff_group: group,
      roles: person.roles as string[],
      last_login_at: (person.last_login_at as string | null) ?? null,
      points,
      attendance: {
        days: Number(a.days ?? 0),
        late_days: Number(a.late_days ?? 0),
        late_minutes: Number(a.late_minutes ?? 0),
        hours: Math.round(Number(a.hours ?? 0) * 10) / 10,
        absent: Number(abs!.get(id)?.n ?? 0),
      },
      cases,
      pay: {
        base,
        case_pay: cases.pay,
        bonus: points.bonus,
        deduction: points.deduction,
        adjustments: adjustmentsTotal,
        total: base + cases.pay + points.bonus - points.deduction + adjustmentsTotal,
        paid: payment ? { amount: Number(payment.amount), paid_at: String(payment.paid_at) } : null,
      },
      score: output + points.green + points.blue * 3 - points.net_black * 5,
    };
  });
}

export async function expensesFor(month: string) {
  return query(
    `SELECT expense_id, title, category, amount::float8 AS amount, to_char(month,'YYYY-MM') AS month, recurring,
       to_char(end_month,'YYYY-MM') AS end_month, note, created_at
     FROM business_expenses
     WHERE deleted_at IS NULL AND (month = $1::date OR (recurring AND month <= $1::date AND (end_month IS NULL OR end_month >= $1::date)))
     ORDER BY recurring DESC, amount DESC`,
    [month],
  );
}

export async function revenueFor(month: string) {
  const [row] = await query(
    `SELECT COALESCE(sum(client_price), 0)::float8 AS revenue, COALESCE(sum(investigator_price), 0)::float8 AS case_pay,
       count(*)::int AS approved
     FROM investigations WHERE status = 'approved' AND ${inMonth("reviewed_at")}`,
    [month],
  );
  return { revenue: Number(row!.revenue), case_pay: Number(row!.case_pay), approved: Number(row!.approved) };
}

/** Revenue, every cost and the resulting net profit for one month. */
export async function monthResult(month: string, settings?: Settings, people?: StaffMonth[]) {
  const staff = people ?? (await staffMonth(month, settings));
  const [income, expenses] = await Promise.all([revenueFor(month), expensesFor(month)]);
  const sum = (pick: (person: StaffMonth) => number) => staff.reduce((total, person) => total + pick(person), 0);
  // A month already paid uses what was actually paid. Case pay of people no longer
  // on the staff list still counts, so the month always balances.
  const otherCasePay = Math.max(0, income.case_pay - sum((person) => person.cases.pay));
  const payroll = sum((person) => person.pay.paid?.amount ?? person.pay.total) + otherCasePay;
  const expenseTotal = expenses.reduce((total, row) => total + Number(row.amount), 0);
  return {
    month: month.slice(0, 7),
    revenue: income.revenue,
    approved_cases: income.approved,
    salaries: sum((person) => person.pay.base),
    case_pay: income.case_pay,
    bonuses: sum((person) => person.pay.bonus),
    deductions: sum((person) => person.pay.deduction),
    adjustments: sum((person) => person.pay.adjustments),
    payroll,
    expenses: expenseTotal,
    net: income.revenue - payroll - expenseTotal,
  };
}
