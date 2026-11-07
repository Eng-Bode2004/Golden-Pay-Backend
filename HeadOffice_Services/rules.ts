import { query } from "../IdentityAcess_Services/Config/db.ts";
import { logger } from "../IdentityAcess_Services/Utils/logger.ts";

/**
 * Attendance and points. Everyone's working day is read in Cairo time.
 *
 * - green: arrived by the start time (plus grace) and was still active at the end time
 * - black: arrived late, was absent on a working day, or a violation recorded by head office
 * - blue:  stayed past the end time, worked on a day off, or was recognised by head office
 *
 * Each `blue_per_black` blue points in a month wipe out one black point; the blue
 * points left over earn a bonus and the black points left over cost a deduction.
 */

export type StaffGroup = "admin" | "investigator";

export interface Schedule {
  start: string; // "HH:MM"
  end: string;
  grace_minutes: number;
  off_days: number[]; // 0 Sunday … 6 Saturday
  overtime_minutes: number; // minutes past the end time that earn a blue point
  offday_min_minutes: number; // minutes of activity on a day off that earn a blue point
}

export interface PointRules {
  blue_per_black: number;
  blue_bonus: number;
  black_deduction: number;
  absence_black: boolean;
}

export interface Settings {
  schedules: Record<StaffGroup, Schedule>;
  points: PointRules;
  tracking_since: string; // first day absences are counted
}

const DEFAULT_SCHEDULE: Schedule = {
  start: "09:00",
  end: "17:00",
  grace_minutes: 15,
  off_days: [5],
  overtime_minutes: 60,
  offday_min_minutes: 120,
};
const DEFAULT_POINTS: PointRules = { blue_per_black: 3, blue_bonus: 50, black_deduction: 100, absence_black: true };

export const REASONS: Record<string, { color: "green" | "black" | "blue"; label: string }> = {
  on_time: { color: "green", label: "حضور وانصراف في الموعد" },
  late: { color: "black", label: "تأخير عن بدء العمل" },
  absent: { color: "black", label: "غياب في يوم عمل" },
  overtime: { color: "blue", label: "عمل ساعات إضافية" },
  off_day: { color: "blue", label: "عمل في يوم إجازة" },
  manual: { color: "blue", label: "من الإدارة العليا" },
};

export function meanings(rules: PointRules) {
  return {
    green: "حضرت في موعد بدء العمل وبقيت حتى نهايته.",
    black: "تأخرت عن موعد بدء العمل، أو تغيبت في يوم عمل، أو سجّلت الإدارة العليا مخالفة.",
    blue: "عملت ساعات إضافية أو في يوم إجازة، أو منحتك الإدارة العليا تقديرًا لعمل مميز.",
    clearing:
      rules.blue_per_black > 0
        ? `كل ${rules.blue_per_black} نقاط زرقاء تمحو نقطة سوداء واحدة في نفس الشهر.`
        : "النقاط الزرقاء لا تمحو النقاط السوداء حاليًا.",
  };
}

/* ---------- Cairo time ---------- */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function cairo(at = new Date()): { day: string; minutes: number; weekday: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Cairo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: WEEKDAYS.indexOf(parts.weekday!),
  };
}

export const weekdayOf = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay();
export const toMinutes = (time: string) => {
  const [hours, minutes] = time.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
};
const addDays = (day: string, days: number) => {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

/** "YYYY-MM-01" for a "YYYY-MM" value, or the current Cairo month. */
export function monthStart(value: string | null | undefined): string {
  if (value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return `${value}-01`;
  return `${cairo().day.slice(0, 7)}-01`;
}

export function shiftMonth(month: string, by: number): string {
  const date = new Date(`${month}T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + by, 1);
  return date.toISOString().slice(0, 10);
}

/* ---------- Settings ---------- */

/** jsonb values may arrive as text; decode until they are real values. */
const decode = (value: unknown): unknown =>
  typeof value === "string" && /^["{[]/.test(value) ? decode(JSON.parse(value)) : value;

export async function loadSettings(): Promise<Settings> {
  const rows = await query("SELECT key, value FROM ho_settings");
  const stored = Object.fromEntries(rows.map((row) => [row.key as string, decode(row.value)]));
  let since = stored.tracking_since as string | undefined;
  if (!since) {
    // Absences are counted only from the day head office started using the system.
    since = cairo().day;
    await query(
      `INSERT INTO ho_settings(key,value) VALUES('tracking_since',to_jsonb($1::text)) ON CONFLICT (key) DO NOTHING`,
      [since],
    );
  }
  const schedules = (stored.schedules ?? {}) as Partial<Record<StaffGroup, Partial<Schedule>>>;
  return {
    schedules: {
      admin: { ...DEFAULT_SCHEDULE, ...schedules.admin },
      investigator: { ...DEFAULT_SCHEDULE, ...schedules.investigator },
    },
    points: { ...DEFAULT_POINTS, ...(stored.points as Partial<PointRules> | undefined) },
    tracking_since: since,
  };
}

/* ---------- Staff ---------- */

/** Everyone head office tracks: administrators and investigators (not head office itself). */
export const STAFF_SQL = `
  SELECT u.user_id, u.full_name, u.employee_number, u.email, u.phone, u.created_at, u.last_login_at,
    CASE WHEN bool_or(r.name IN ('admin','hr')) THEN 'admin' ELSE 'investigator' END AS staff_group,
    array_agg(DISTINCT r.name) AS roles
  FROM users u
  JOIN user_roles ur ON ur.user_id = u.user_id
  JOIN roles r ON r.role_id = ur.role_id
  WHERE u.status = 'active' AND u.deleted_at IS NULL
  GROUP BY u.user_id, u.full_name, u.employee_number, u.email, u.phone, u.created_at, u.last_login_at
  HAVING NOT bool_or(r.name = 'head_office') AND bool_or(r.name IN ('admin','hr','employee'))`;

export function groupOf(roles: string[]): StaffGroup | null {
  if (roles.includes("head_office")) return null;
  if (roles.includes("admin") || roles.includes("hr")) return "admin";
  if (roles.includes("employee")) return "investigator";
  return null;
}

/* ---------- Points ---------- */

export async function award(
  userId: string,
  day: string,
  reason: keyof typeof REASONS,
  minutes: number | null = null,
): Promise<boolean> {
  const rows = await query(
    `INSERT INTO staff_points(user_id,color,reason,minutes,day) VALUES($1,$2,$3,$4,$5)
     ON CONFLICT (user_id, day, reason) WHERE reason <> 'manual' DO NOTHING RETURNING point_id`,
    [userId, REASONS[reason]!.color, reason, minutes, day],
  );
  return rows.length > 0;
}

/**
 * Records that the person is active now and gives any points the moment earns.
 * Apps and dashboards call this when opened and every few minutes while open.
 */
export async function recordPresence(userId: string, group: StaffGroup, platform: string | null) {
  const settings = await loadSettings();
  const schedule = settings.schedules[group];
  const now = cairo();
  const workDay = !schedule.off_days.includes(now.weekday);
  const start = toMinutes(schedule.start);
  const end = toMinutes(schedule.end);
  const sinceStart = now.minutes - start;
  const late = workDay && sinceStart > schedule.grace_minutes ? sinceStart : 0;

  const [row] = await query(
    `INSERT INTO attendance(user_id,day,first_seen,last_seen,late_minutes,work_day,platform)
     VALUES($1,$2,now(),now(),$3,$4,$5)
     ON CONFLICT (user_id, day) DO UPDATE SET last_seen = now(), pings = attendance.pings + 1,
       platform = COALESCE(EXCLUDED.platform, attendance.platform)
     RETURNING first_seen, last_seen, late_minutes, work_day, (xmax = 0) AS inserted,
       EXTRACT(epoch FROM last_seen - first_seen)::int / 60 AS active_minutes`,
    [userId, now.day, late, workDay, platform],
  );
  const awarded: string[] = [];
  if (row!.work_day) {
    if (row!.inserted && Number(row!.late_minutes) > 0 && (await award(userId, now.day, "late", Number(row!.late_minutes)))) {
      awarded.push("late");
    }
    // Five minutes of tolerance: the app reports every few minutes, not every second.
    if (Number(row!.late_minutes) === 0 && now.minutes >= end - 5 && (await award(userId, now.day, "on_time"))) {
      awarded.push("on_time");
    }
    const extra = now.minutes - end;
    if (extra >= schedule.overtime_minutes && (await award(userId, now.day, "overtime", extra))) awarded.push("overtime");
  } else if (
    Number(row!.active_minutes) >= schedule.offday_min_minutes &&
    (await award(userId, now.day, "off_day", Number(row!.active_minutes)))
  ) {
    awarded.push("off_day");
  }
  return { day: now.day, work_day: Boolean(row!.work_day), late_minutes: Number(row!.late_minutes), awarded };
}

/**
 * Gives a black point for each working day without any activity (last 14 days).
 * `only` limits the sweep to some people and may start it earlier (used by tests).
 */
export async function sweepAbsences(only?: { users: string[]; since: string }): Promise<number> {
  const settings = await loadSettings();
  if (!settings.points.absence_black) return 0;
  const today = cairo().day;
  let first = addDays(today, -14);
  const since = only?.since ?? settings.tracking_since;
  if (first < since) first = since;
  const staff = (await query(STAFF_SQL)).filter((person) => !only || only.users.includes(person.user_id as string));
  let given = 0;
  for (let day = first; day < today; day = addDays(day, 1)) {
    const weekday = weekdayOf(day);
    const present = new Set(
      (await query("SELECT user_id FROM attendance WHERE day = $1", [day])).map((row) => row.user_id as string),
    );
    for (const person of staff) {
      const schedule = settings.schedules[person.staff_group as StaffGroup];
      if (schedule.off_days.includes(weekday) || present.has(person.user_id as string)) continue;
      // Nobody is absent before their account existed.
      if (cairo(new Date(person.created_at as string)).day >= day) continue;
      if (await award(person.user_id as string, day, "absent")) given += 1;
    }
  }
  if (given) logger.info("headoffice.absences_recorded", { given });
  return given;
}

export interface Tally {
  green: number;
  black: number;
  blue: number;
  cleared: number;
  net_black: number;
  bonus_blue: number;
  bonus: number;
  deduction: number;
}

export function tally(counts: { green?: number; black?: number; blue?: number }, rules: PointRules): Tally {
  const green = counts.green ?? 0;
  const black = counts.black ?? 0;
  const blue = counts.blue ?? 0;
  const cleared = rules.blue_per_black > 0 ? Math.min(black, Math.floor(blue / rules.blue_per_black)) : 0;
  const bonusBlue = blue - cleared * rules.blue_per_black;
  const netBlack = black - cleared;
  return {
    green,
    black,
    blue,
    cleared,
    net_black: netBlack,
    bonus_blue: bonusBlue,
    bonus: bonusBlue * rules.blue_bonus,
    deduction: netBlack * rules.black_deduction,
  };
}

/** Point counts by person and colour for one month, revoked points excluded. */
export async function pointCounts(month: string, userId: string | null = null) {
  const rows = await query(
    `SELECT user_id, color, count(*)::int AS n FROM staff_points
     WHERE revoked_at IS NULL AND day >= $1::date AND day < $1::date + interval '1 month'
       AND ($2::text IS NULL OR user_id = $2)
     GROUP BY user_id, color`,
    [month, userId],
  );
  const byUser = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const entry = byUser.get(row.user_id as string) ?? {};
    entry[row.color as string] = row.n as number;
    byUser.set(row.user_id as string, entry);
  }
  return byUser;
}
