// End-to-end check of the head office system through the public API on port 4001:
// access control, attendance points (green / black / blue), clearing black with blue,
// salaries, adjustments, payment, expenses, monthly profit, absences and complaints.
// Run from IdentityAcess_Services (for its .env). Creates temporary accounts, restores
// the head office settings it changes and removes everything it made.
import { connectDatabase, database, query, transaction } from "../../IdentityAcess_Services/Config/db.ts";
import { newId, randomToken } from "../../IdentityAcess_Services/Utils/crypto.ts";
import { cairo, sweepAbsences } from "../rules.ts";

const base = "http://127.0.0.1:4001/api/v1";
const password = `Flow-${randomToken(10)}-9aA`;
const officeId = newId();
const adminId = newId();
const workerX = newId();
const workerY = newId();
const ids = [officeId, adminId, workerX, workerY];
const suffix = String(Date.now()).slice(-7);
const expenses: string[] = [];

async function call<T>(token: string | null, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (typeof init.body === "string") headers.set("Content-Type", "application/json");
  const response = await fetch(`${base}${path}`, { ...init, headers });
  const body = (await response.json()) as { data?: T; error?: unknown };
  if (!response.ok) throw new Error(`${path} -> ${response.status} ${JSON.stringify(body)}`);
  return body.data as T;
}
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
const patch = (body: unknown): RequestInit => ({ method: "PATCH", body: JSON.stringify(body) });
const pass = (message: string) => console.log(`PASS ${message}`);
async function expectError(token: string, path: string, init: RequestInit, code: string) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const body = (await response.json()) as { error?: { code?: string } };
  if (response.ok || body.error?.code !== code) throw new Error(`${path}: expected ${code}, got ${response.status} ${JSON.stringify(body)}`);
}
async function makeUser(id: string, name: string, role: string, email: string | null, number: string | null) {
  const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
  await query(
    `INSERT INTO users(user_id,full_name,email,employee_number,phone,national_id_encrypted,national_id_hash,national_id_last4,password_hash,account_type,status)
     VALUES($1,$2,$3,$4,$5,'',$6,'',$7,'existing_employee','active')`,
    [id, name, email, number, `flow:${id}`, randomToken(), hash],
  );
  await query("INSERT INTO user_roles(user_id,role_id) SELECT $1,role_id FROM roles WHERE name=$2", [id, role]);
}
const hhmm = (minutes: number) => {
  const value = Math.min(Math.max(minutes, 0), 23 * 60 + 59);
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
};

interface Tally { green: number; black: number; blue: number; cleared: number; net_black: number; bonus: number; deduction: number }
interface Person { user_id: string; points: Tally; pay: { base: number; bonus: number; deduction: number; adjustments: number; total: number; paid: unknown }; score: number }

await connectDatabase();
const savedSettings = await query("SELECT key, value FROM ho_settings WHERE key IN ('schedules','points')");
try {
  const now = cairo();
  if (now.minutes < 90 || now.minutes > 22 * 60) {
    console.log("SKIP time-of-day checks need Cairo time between 01:30 and 22:00");
    process.exit(0);
  }
  await transaction(async () => {
    await makeUser(officeId, "الإدارة العليا للتجربة", "head_office", `flow-office-${suffix}@example.test`, null);
    await makeUser(adminId, "مدير التجربة", "admin", `flow-admin-${suffix}@example.test`, null);
    for (const id of [officeId, adminId]) await query("INSERT INTO admin_security(user_id,mfa_required) VALUES($1,false)", [id]);
    await makeUser(workerX, "مستعلم ملتزم", "employee", null, `FLX-${suffix}`);
    await makeUser(workerY, "مستعلم متأخر", "employee", null, `FLY-${suffix}`);
  });
  const login = async (identifier: object, platform = "web") =>
    (await call<{ access_token: string }>(null, "/auth/login", post({ ...identifier, password, platform }))).access_token;
  const office = await login({ email: `flow-office-${suffix}@example.test` });
  const admin = await login({ email: `flow-admin-${suffix}@example.test` });
  const x = await login({ employee_number: `FLX-${suffix}` }, "android");
  const y = await login({ employee_number: `FLY-${suffix}` }, "android");

  await expectError(admin, "/headoffice/overview", {}, "FORBIDDEN");
  await expectError(admin, `/admin/users/${workerX}/roles`, post({ role: "head_office" }), "FORBIDDEN");
  await call(office, "/headoffice/overview");
  const officePing = await call<{ tracked: boolean }>(office, "/attendance/ping", post({ platform: "web" }));
  if (officePing.tracked) throw new Error("Head office itself must not be tracked");
  pass("only head office opens the head office system; admins cannot grant it; head office is not tracked");

  const schedule = (start: number, end: number, offToday = false) => ({
    start: hhmm(start),
    end: hhmm(end),
    grace_minutes: 15,
    off_days: offToday ? [now.weekday] : [],
    overtime_minutes: 0,
    offday_min_minutes: 0,
  });
  const points = { blue_per_black: 3, blue_bonus: 50, black_deduction: 100, absence_black: true };
  await call(office, "/headoffice/settings", patch({
    schedules: { admin: schedule(8 * 60, 16 * 60, true), investigator: schedule(now.minutes - 5, now.minutes) },
    points,
  }));
  await expectError(office, "/headoffice/settings", patch({ schedules: { admin: schedule(600, 500), investigator: schedule(1, 2) }, points }), "BAD_REQUEST");
  const onTime = await call<{ awarded: string[] }>(x, "/attendance/ping", post({ platform: "android" }));
  if (onTime.awarded.sort().join() !== "on_time,overtime") throw new Error(`On time: ${JSON.stringify(onTime)}`);
  const offDay = await call<{ awarded: string[] }>(admin, "/attendance/ping", post({ platform: "web" }));
  if (offDay.awarded.join() !== "off_day") throw new Error(`Off day: ${JSON.stringify(offDay)}`);
  pass("green point for arriving on time and staying to the end; blue for overtime and for working on a day off");

  await call(office, "/headoffice/settings", patch({
    schedules: { admin: schedule(8 * 60, 16 * 60, true), investigator: { ...schedule(now.minutes - 60, now.minutes + 60), overtime_minutes: 60 } },
    points,
  }));
  const late = await call<{ awarded: string[]; late_minutes: number }>(y, "/attendance/ping", post({ platform: "android" }));
  const again = await call<{ awarded: string[] }>(y, "/attendance/ping", post({ platform: "android" }));
  if (late.awarded.join() !== "late" || late.late_minutes < 59 || again.awarded.length) throw new Error(`Late: ${JSON.stringify([late, again])}`);
  pass(`black point for arriving ${late.late_minutes} minutes late, given once`);

  await call(office, "/headoffice/points", post({ user_id: workerY, color: "blue", count: 3, note: "تغطية منطقة زميل غائب" }));
  await call(office, "/headoffice/points", post({ user_id: workerX, color: "blue", count: 2, note: "تقرير ممتاز" }));
  await expectError(office, "/headoffice/points", post({ user_id: workerX, color: "green", note: "x" }), "BAD_REQUEST");
  const mineY = await call<{ summary: Tally; meanings: Record<string, string>; points: unknown[] }>(y, "/points/me");
  if (mineY.summary.black !== 1 || mineY.summary.cleared !== 1 || mineY.summary.net_black !== 0 || mineY.summary.bonus !== 0 || !mineY.meanings.clearing) {
    throw new Error(`Clearing: ${JSON.stringify(mineY.summary)}`);
  }
  const mineX = await call<{ summary: Tally; points: { point_id: string; reason: string }[] }>(x, "/points/me");
  if (mineX.summary.green !== 1 || mineX.summary.blue !== 3 || mineX.summary.bonus !== 150) throw new Error(`X points: ${JSON.stringify(mineX.summary)}`);
  const manual = mineX.points.find((point) => point.reason === "manual")!;
  await call(office, `/headoffice/points/${manual.point_id}/revoke`, post({ note: "أُعطيت بالخطأ" }));
  pass("head office gives blue points; 3 blue wipe out 1 black; each person sees their own points and their meanings; points can be removed");

  await call(office, `/headoffice/salaries/${workerX}`, patch({ base_salary: 5000 }));
  await call(office, `/headoffice/salaries/${workerY}`, patch({ base_salary: 4000 }));
  const month = now.day.slice(0, 7);
  await call(office, "/headoffice/payroll/adjustments", post({ user_id: workerX, month, amount: 250, note: "بدل انتقال" }));
  let payroll = await call<{ people: Person[]; result: { revenue: number; payroll: number; expenses: number; net: number } }>(office, `/headoffice/payroll?month=${month}`);
  const px = payroll.people.find((person) => person.user_id === workerX)!;
  const py = payroll.people.find((person) => person.user_id === workerY)!;
  if (px.pay.total !== 5000 + 100 + 250 || py.pay.total !== 4000) throw new Error(`Payroll: ${JSON.stringify([px.pay, py.pay])}`);
  pass("salary = base + case pay + blue bonus − black deduction + adjustments (5,350 and 4,000)");

  const before = payroll.result;
  const one = await call<{ expense_id: string }>(office, "/headoffice/expenses", post({ title: `إيجار تجربة ${suffix}`, category: "إيجار", amount: 1000, month }));
  const lastMonth = new Date(`${month}-15T12:00:00Z`);
  lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
  const monthly = await call<{ expense_id: string }>(office, "/headoffice/expenses", post({
    title: `إنترنت تجربة ${suffix}`, category: "كهرباء ومياه وإنترنت", amount: 500, month: lastMonth.toISOString().slice(0, 7), recurring: true,
  }));
  expenses.push(one.expense_id, monthly.expense_id);
  payroll = await call(office, `/headoffice/payroll?month=${month}`);
  const result = payroll.result;
  if (result.expenses - before.expenses !== 1500 || Math.abs(result.net - (result.revenue - result.payroll - result.expenses)) > 0.01) {
    throw new Error(`Profit: ${JSON.stringify([before, result])}`);
  }
  pass("expenses (one-time and recurring) reduce the month: net = revenue − salaries − expenses");

  await call(office, "/headoffice/payroll/pay", post({ month, user_ids: [workerX] }));
  await expectError(office, "/headoffice/payroll/adjustments", post({ user_id: workerX, month, amount: 10, note: "x" }), "MONTH_PAID");
  payroll = await call(office, `/headoffice/payroll?month=${month}`);
  if (!payroll.people.find((person) => person.user_id === workerX)!.pay.paid) throw new Error("Payment not recorded");
  await call(office, `/headoffice/payroll/pay/${workerX}?month=${month}`, { method: "DELETE" });
  pass("a paid month is locked; payment can be undone");

  await expectError(y, "/complaints", post({ category: "غير موجود", subject: "x", body: "شكوى طويلة بما يكفي" }), "BAD_REQUEST");
  const { complaint } = await call<{ complaint: { complaint_id: string; reference: string } }>(y, "/complaints", post({
    category: "الرواتب والمستحقات", subject: "تأخر صرف بدل الانتقال", body: "لم يُصرف بدل الانتقال عن الشهر الماضي حتى الآن.",
  }));
  await expectError(x, `/complaints/${complaint.complaint_id}`, {}, "NOT_FOUND");
  const inbox = await call<{ complaints: { complaint_id: string }[] }>(office, "/headoffice/complaints");
  if (!inbox.complaints.some((item) => item.complaint_id === complaint.complaint_id)) throw new Error("Head office cannot see the complaint");
  await call(office, `/complaints/${complaint.complaint_id}/messages`, post({ body: "تمت مراجعة الأمر وسيُصرف مع الراتب." }));
  let mine = await call<{ unread: number; complaints: { status: string }[] }>(y, "/complaints/mine");
  if (mine.unread !== 1 || mine.complaints[0]!.status !== "in_review") throw new Error(`Reply: ${JSON.stringify(mine)}`);
  const thread = await call<{ messages: { from_office: boolean }[] }>(y, `/complaints/${complaint.complaint_id}`);
  mine = await call(y, "/complaints/mine");
  await call(office, `/headoffice/complaints/${complaint.complaint_id}`, patch({ status: "resolved" }));
  if (mine.unread !== 0 || !thread.messages[0]!.from_office) throw new Error("Unread state");
  pass(`investigator complains straight to head office (${complaint.reference}); others cannot read it; replies show as unread`);

  await expectError(y, "/complaints", post({ kind: "message", category: "اقتراح", subject: "x", body: "رسالة طويلة بما يكفي" }), "FORBIDDEN");
  const { complaint: note } = await call<{ complaint: { complaint_id: string; reference: string } }>(admin, "/complaints", post({
    kind: "message", category: "طلب أو موافقة", subject: "اعتماد مستعلم جديد للجيزة", body: "نحتاج مستعلمًا إضافيًا في الجيزة بسبب زيادة الطلبات هذا الأسبوع.",
  }));
  const officeView = await call<{ complaints: { complaint_id: string; kind: string }[]; open: { messages: number } }>(office, "/headoffice/complaints?kind=message");
  if (!officeView.complaints.some((item) => item.complaint_id === note.complaint_id) || officeView.complaints.some((item) => item.kind !== "message")) {
    throw new Error("Head office message inbox");
  }
  await call(office, `/complaints/${note.complaint_id}/messages`, post({ body: "موافق، سنضيف مستعلمًا من الأسبوع القادم." }));
  const adminMine = await call<{ unread: number; complaints: unknown[] }>(admin, "/complaints/mine?kind=message");
  const adminComplaints = await call<{ complaints: unknown[] }>(admin, "/complaints/mine");
  if (adminMine.unread !== 1 || adminComplaints.complaints.length !== 0 || !note.reference.startsWith("MSG-")) throw new Error(`Admin messages: ${JSON.stringify(adminMine)}`);
  pass(`admins message head office (${note.reference}) and see the reply as unread; investigators cannot use messages`);

  const overview = await call<{ top_investigators: { user_id: string }[]; result: { net: number }; trend: unknown[]; attendance_today: { present: number } }>(
    office,
    `/headoffice/overview?month=${month}`,
  );
  if (overview.trend.length !== 6 || overview.attendance_today.present < 3) throw new Error(`Overview: ${JSON.stringify(overview.attendance_today)}`);
  const day = await call<{ people: { user_id: string; status: string }[] }>(office, "/headoffice/attendance");
  const statuses = Object.fromEntries(day.people.map((person) => [person.user_id, person.status]));
  if (statuses[workerX] !== "present" || statuses[workerY] !== "late" || statuses[adminId] !== "off_day_work") {
    throw new Error(`Attendance: ${JSON.stringify([statuses[workerX], statuses[workerY], statuses[adminId]])}`);
  }
  const detail = await call<{ person: Person; days: unknown[]; points: unknown[] }>(office, `/headoffice/staff/${workerY}?month=${month}`);
  if (detail.days.length !== 1 || detail.points.length !== 4) throw new Error(`Staff detail: ${detail.days.length} ${detail.points.length}`);
  pass("overview with six-month trend, today's attendance board and each person's full profile");

  await query("UPDATE users SET created_at = now() - interval '10 days' WHERE user_id = $1", [workerY]);
  const since = new Date(Date.now() - 4 * 86_400_000);
  const sinceDay = cairo(since).day;
  const given = await sweepAbsences({ users: [workerY], since: sinceDay });
  const again2 = await sweepAbsences({ users: [workerY], since: sinceDay });
  if (given !== 4 || again2 !== 0) throw new Error(`Absences: ${given} then ${again2}`);
  pass("a black point for each working day with no activity, given once");
} finally {
  await transaction(async () => {
    await query("DELETE FROM ho_settings WHERE key IN ('schedules','points')");
    for (const row of savedSettings) await query("INSERT INTO ho_settings(key,value) VALUES($1,($2::text)::jsonb)", [row.key, JSON.stringify(row.value)]);
    await query(`DELETE FROM complaints WHERE user_id = ANY($1::text[])`, [`{${ids.join(",")}}`]);
    // Keep complaint numbers starting at CMP-00001 when only test complaints existed.
    await query(`DELETE FROM counters WHERE "_id" = 'complaint' AND NOT EXISTS (SELECT 1 FROM complaints WHERE kind = 'complaint')`);
    await query(`DELETE FROM counters WHERE "_id" = 'message' AND NOT EXISTS (SELECT 1 FROM complaints WHERE kind = 'message')`);
    for (const id of expenses) await query("DELETE FROM business_expenses WHERE expense_id = $1", [id]);
    await query("DELETE FROM audit_logs WHERE actor_id = ANY($1::text[]) OR user_id = ANY($1::text[])", [`{${ids.join(",")}}`]);
    for (const id of ids) {
      for (const table of ["admin_mfa_challenges", "admin_security", "refresh_sessions", "user_roles", "users"]) {
        await query(`DELETE FROM ${table} WHERE user_id=$1`, [id]);
      }
    }
  });
  await database.end();
}
