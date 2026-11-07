// End-to-end check of the field workflow through the public API on port 4001:
// location setup -> area and personal assignment -> claim -> form + photos -> PDF -> review
// -> prices, earnings and performance; plus phone sign-in.
// Creates temporary accounts and removes everything it made.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { connectDatabase, database, query, transaction } from "../../IdentityAcess_Services/Config/db.ts";
import { env } from "../../IdentityAcess_Services/Config/env.ts";
import { newId, randomToken } from "../../IdentityAcess_Services/Utils/crypto.ts";

const base = "http://127.0.0.1:4001/api/v1";
const password = `Flow-${randomToken(10)}-9aA`;
const adminId = newId();
const workerA = newId();
const workerB = newId();
const adminEmail = `flow-${adminId}@example.test`;
const suffix = String(Date.now()).slice(-7);
const png = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (char) => char.charCodeAt(0),
);

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
  if (response.ok || body.error?.code !== code) {
    throw new Error(`${path}: expected ${code}, got ${response.status} ${JSON.stringify(body)}`);
  }
}

async function makeUser(id: string, name: string, role: string, email: string | null, number: string | null, phone = `flow:${id}`) {
  const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
  await query(
    `INSERT INTO users(user_id,full_name,email,employee_number,phone,national_id_encrypted,national_id_hash,national_id_last4,password_hash,account_type,status)
     VALUES($1,$2,$3,$4,$5,'',$6,'',$7,'existing_employee','active')`,
    [id, name, email, number, phone, randomToken(), hash],
  );
  await query("INSERT INTO user_roles(user_id,role_id) SELECT $1,role_id FROM roles WHERE name=$2", [id, role]);
}

await connectDatabase();
const created: string[] = [];
try {
  await transaction(async () => {
    await makeUser(adminId, "مدير التجربة", "admin", adminEmail, null);
    await query("INSERT INTO admin_security(user_id,mfa_required) VALUES($1,false)", [adminId]);
    await makeUser(workerA, "مستعلم الدقي", "employee", null, `FLA-${suffix}`);
    await makeUser(workerB, "مستعلم الدقي الثاني", "employee", null, `FLB-${suffix}`, `+20112${suffix}`);
  });
  const login = (identifier: object) =>
    call<{ access_token: string }>(null, "/auth/login", post({ ...identifier, password, platform: "android" }));
  const admin = (await login({ email: adminEmail })).access_token;
  const a = (await login({ employee_number: `FLA-${suffix}` })).access_token;
  const b = (await login({ phone: `0112${suffix}` })).access_token;
  pass("investigator signs in with a phone number and password");

  const before = await call<{ profile: { location_set: boolean } }>(a, "/investigators/me");
  if (before.profile.location_set) throw new Error("New investigator must have no location");
  pass("new investigator is asked to choose a location");

  const { locations: governorates } = await call<{ locations: { location_id: string; name: string }[] }>(a, "/locations");
  const giza = governorates.find((item) => item.name === "الجيزة");
  if (governorates.length !== 27 || !giza) throw new Error(`Expected 27 governorates, got ${governorates.length}`);
  const { locations: districts } = await call<{ locations: unknown[] }>(a, `/locations?parent=${giza.location_id}`);
  if (!districts.length) throw new Error("Districts are missing");
  pass(`location lists work (27 governorates, ${districts.length} districts in Giza)`);

  // A governorate name no real investigator uses keeps test offers away from real people.
  const gov = `محافظة الاختبار ${suffix}`;
  const sub = `عزبة الاختبار ${suffix}`;
  await call(a, "/investigators/me/location", patch({
    governorate: gov, district: "الدقي", local_unit: `وحدة ${suffix}`, main_village: `كفر التجربة ${suffix}`, sub_village: sub,
    street: "شارع التحرير", lat: 30.0385, lng: 31.2123,
  }));
  await call(b, "/investigators/me/location", patch({ governorate: gov, district: "الدقى", lat: 30.04, lng: 31.21 }));
  const parent = (await call<{ locations: { location_id: string; name: string }[] }>(a, `/locations?parent=${giza.location_id}&q=الدقي`)).locations[0];
  if (!parent) throw new Error("District search failed");
  pass("investigator saves a location, and typed names join the shared list");

  const hierarchy = await call<{ count: number }>(admin, "/investigators/match", post({ mode: "hierarchy", governorate: gov, district: "الدقي" }));
  if (hierarchy.count !== 2) throw new Error(`Spelling variants should match, got ${hierarchy.count}`);
  const circle = await call<{ investigators: { user_id: string }[] }>(admin, "/investigators/match", post({ mode: "circle", lat: 30.04, lng: 31.21, radius_km: 2 }));
  const polygon = await call<{ investigators: { user_id: string }[] }>(admin, "/investigators/match", post({ mode: "polygon", points: [[30, 31.1], [30.1, 31.1], [30.1, 31.3], [30, 31.3]] }));
  const far = await call<{ investigators: { user_id: string }[] }>(admin, "/investigators/match", post({ mode: "circle", lat: 31.2, lng: 29.9, radius_km: 5 }));
  if (![circle, polygon].every((list) => list.investigators.some((item) => item.user_id === workerA))) throw new Error("Map match failed");
  if (far.investigators.some((item) => item.user_id === workerA)) throw new Error("Far circle should not match");
  pass("area matching works by names, circle and polygon");

  const { clients } = await call<{ clients: { client_id: string; form_count: number }[] }>(admin, "/forms/clients");
  const total = clients.reduce((sum, client) => sum + client.form_count, 0);
  if (clients.length !== 15 || total !== 51) throw new Error(`Expected 15 clients and 51 forms, got ${clients.length}/${total}`);
  pass("all 15 clients and 51 forms are available");

  const { templates } = await call<{ templates: { template_id: string; category: string }[] }>(admin, "/forms/templates?client=global");
  const template = templates.find((item) => item.category === "سكن");
  if (!template) throw new Error("Global housing form is missing");

  const subject = (name: string) => ({
    subject_name: name, subject_phone: "01012345678", address: "12 شارع التحرير", governorate: gov, district: "الدقي",
    local_unit: `وحدة ${suffix}`, main_village: `كفر التجربة ${suffix}`, sub_village: sub,
    landmark: "بجوار المترو", client_reference: `CL-${suffix}`, template_id: template.template_id,
    service_level: "urgent", client_price: 350, investigator_price: 140,
  });
  type Offer = { tier: number; tier_label: string; response: string | null; seen_at: string | null; full_name: string };
  type Admin = { investigation: { status: string; offers: Offer[]; events: { type: string }[] } };
  const caseView = (id: string) => call<Admin>(admin, `/investigations/${id}`);

  const areaCase = await call<{ investigation_id: string; reference: string; recipients: number }>(admin, "/investigations", post({
    ...subject("عميل المنطقة"), target_mode: "area", area: { mode: "hierarchy", governorate: gov, district: "الدقي" },
  }));
  created.push(areaCase.investigation_id);
  await expectError(admin, "/investigations", post({ ...subject("بلا مستعلم"), target_mode: "area", area: { mode: "circle", lat: 22, lng: 25, radius_km: 1 } }), "NO_INVESTIGATORS_IN_AREA");
  const first = (await caseView(areaCase.investigation_id)).investigation.offers;
  if (first.length !== 1 || first[0]!.tier !== 5 || first[0]!.full_name !== "مستعلم الدقي") {
    throw new Error(`Nearest (same sub village) must be offered first: ${JSON.stringify(first)}`);
  }
  pass(`an area case of ${areaCase.recipients} candidates goes to ONE investigator first: the one in the same sub village`);

  type Mine = { available: { investigation_id: string; offer_expires_at: string }[]; active: { investigation_id: string }[]; done: { investigation_id: string }[] };
  const minesA = await call<Mine>(a, "/investigations/mine");
  const minesB = await call<Mine>(b, "/investigations/mine");
  const offered = minesA.available.find((item) => item.investigation_id === areaCase.investigation_id);
  const window = offered ? (new Date(offered.offer_expires_at).getTime() - Date.now()) / 60000 : 0;
  if (!offered || window > 30 || window < 28) throw new Error(`Offer window should be ~30 minutes, got ${window}`);
  if (minesB.available.length) throw new Error("Only the offered investigator may see the case");
  await expectError(b, `/investigations/${areaCase.investigation_id}`, { method: "GET" }, "FORBIDDEN");
  await expectError(b, `/investigations/${areaCase.investigation_id}/claim`, { method: "POST" }, "INVESTIGATION_TAKEN");
  pass("only the offered investigator sees it, with a 30-minute window to accept; others cannot take it");

  await call(a, `/investigations/${areaCase.investigation_id}`);
  await call(a, `/investigations/${areaCase.investigation_id}/seen`, { method: "POST" });
  await call(a, `/investigations/${areaCase.investigation_id}/claim`, { method: "POST" });
  const accepted = await caseView(areaCase.investigation_id);
  if (accepted.investigation.status !== "assigned" || !accepted.investigation.offers[0]!.seen_at) throw new Error("Accept failed");
  pass("investigator opens (seen time recorded) and accepts");

  // A is now working on the area case, so A is busy for everything except personal cases.
  const sendCase = async (name: string, extra: object) => {
    const sent = await call<{ investigation_id: string }>(admin, "/investigations", post({ ...subject(name), ...extra }));
    created.push(sent.investigation_id);
    return sent.investigation_id;
  };
  const personal = await sendCase("عميل مباشر", { target_mode: "person", assignee_id: workerB });
  await call(b, `/investigations/${personal}/seen`, { method: "POST" });
  await call(b, `/investigations/${personal}/decline`, post({ reason: "خارج منطقتي اليوم" }));
  let routed = await caseView(personal);
  if (routed.investigation.offers.length !== 1 || routed.investigation.events.at(-1)!.type !== "waiting" || routed.investigation.status !== "open") {
    throw new Error(`A refused case must wait while the nearest investigator is busy: ${JSON.stringify(routed.investigation)}`);
  }
  pass("a refused case is not pushed onto a busy investigator; it waits for someone free");

  const second = await sendCase("عميل ثانٍ", { target_mode: "area", area: { mode: "hierarchy", governorate: gov } });
  const secondOffers = (await caseView(second)).investigation.offers;
  if (secondOffers[0]?.full_name !== "مستعلم الدقي الثاني") throw new Error(`Free investigator must get the case: ${JSON.stringify(secondOffers)}`);
  const third = await sendCase("عميل ثالث", { target_mode: "area", area: { mode: "hierarchy", governorate: gov } });
  if ((await caseView(third)).investigation.offers.length) throw new Error("Nobody is free, so nobody should be offered the third case");
  pass("work spreads: the next case skips the busy (nearer) investigator, and a third waits while everyone is busy");

  const stacked = await sendCase("عميل محدد", { target_mode: "person", assignee_id: workerA });
  await call(a, `/investigations/${stacked}/claim`, post({ lat: 30.0386, lng: 31.2124 }));
  await call(b, `/investigations/${second}/claim`, post({}));
  await expectError(a, `/investigations/${third}/claim`, { method: "POST" }, "INVESTIGATION_TAKEN");
  await call(admin, `/investigations/${stacked}/cancel`, post({}));
  await call(admin, `/investigations/${second}/cancel`, post({}));
  pass("a personal case can be accepted on top of current work; area cases cannot");

  const lonely = await sendCase("عميل بعيد", { target_mode: "person", assignee_id: workerB, governorate: `مكان آخر ${suffix}` });
  await query("UPDATE investigation_offers SET expires_at = now() - interval '1 second' WHERE investigation_id=$1 AND response IS NULL", [lonely]);
  routed = await caseView(lonely);
  for (let i = 0; i < 30 && routed.investigation.status !== "unassigned"; i += 1) {
    await Bun.sleep(1000);
    routed = await caseView(lonely);
  }
  if (routed.investigation.status !== "unassigned" || routed.investigation.offers[0]!.response !== "expired") {
    throw new Error(`An expired offer with nobody else nearby must end unassigned: ${routed.investigation.status}`);
  }
  await call(admin, `/investigations/${lonely}/redispatch`, { method: "POST" });
  routed = await caseView(lonely);
  if (routed.investigation.status !== "open" || routed.investigation.offers.at(-1)!.full_name !== "مستعلم الدقي الثاني") throw new Error("Redispatch failed");
  await call(admin, `/investigations/${lonely}/cancel`, post({}));
  const types = routed.investigation.events.map((event) => event.type).join(",");
  if (types !== "created,offered,expired,unassigned,redispatched,offered") throw new Error(`Timeline: ${types}`);
  pass("an unanswered offer expires on its own; with nobody left the admin is told and can re-send");

  const { investigation } = await call<{ investigation: { sections: { fields: { key: string; type: string; options?: string[]; label: string }[] }[] } }>(a, `/investigations/${areaCase.investigation_id}`);
  const fields = investigation.sections.flatMap((section) => section.fields);
  const answers: Record<string, string> = {};
  // Answers of the right type: the server validates numbers, dates and choices.
  for (const field of fields) {
    if (field.type === "choice") answers[field.key] = field.options?.[0] ?? "";
    else if (field.type === "yesno") answers[field.key] = "نعم";
    else if (field.type === "number") answers[field.key] = "3";
    else if (field.type === "date") answers[field.key] = "2026-01-15";
    else if (field.type !== "photos") answers[field.key] = `إجابة ${field.label}`;
  }
  await call(a, `/investigations/${areaCase.investigation_id}/answers`, patch({ answers }));
  const photoField = fields.find((field) => field.type === "photos");
  if (!photoField) throw new Error("Form has no photo field");
  const form = new FormData();
  form.set("field_key", photoField.key);
  form.set("image", new File([png], "visit.png", { type: "image/png" }));
  await call(a, `/investigations/${areaCase.investigation_id}/images`, { method: "POST", body: form });
  await expectError(a, `/investigations/${areaCase.investigation_id}/submit`, post({ answers }), "LOCATION_REQUIRED");
  await call(a, `/investigations/${areaCase.investigation_id}/submit`, post({ answers, lat: 30.0385, lng: 31.2123 }));
  let freed = await caseView(personal);
  for (let i = 0; i < 20 && freed.investigation.offers.length < 2; i += 1) {
    await Bun.sleep(500);
    freed = await caseView(personal);
  }
  if (freed.investigation.offers.at(-1)?.full_name !== "مستعلم الدقي") throw new Error("A waiting case must go to the investigator who just became free");
  await call(admin, `/investigations/${personal}/cancel`, post({}));
  await call(admin, `/investigations/${third}/cancel`, post({}));
  pass("submitting requires a location; the moment an investigator is free, the waiting case is offered to them");
  await expectError(a, `/investigations/${areaCase.investigation_id}/answers`, patch({ answers }), "INVESTIGATION_LOCKED");
  pass("investigator saves a draft, uploads a photo and submits; the case then locks");

  let pdfStatus = "";
  for (let i = 0; i < 40 && pdfStatus !== "ready" && pdfStatus !== "failed"; i += 1) {
    await Bun.sleep(500);
    const view = await call<{ investigation: { pdf_status: string } }>(admin, `/investigations/${areaCase.investigation_id}`);
    pdfStatus = view.investigation.pdf_status;
  }
  if (pdfStatus !== "ready") throw new Error(`PDF status: ${pdfStatus}`);
  const pdf = await fetch(`${base}/investigations/${areaCase.investigation_id}/pdf`, { headers: { Authorization: `Bearer ${admin}` } });
  const bytes = new Uint8Array(await pdf.arrayBuffer());
  if (pdf.headers.get("content-type") !== "application/pdf" || new TextDecoder().decode(bytes.slice(0, 4)) !== "%PDF") throw new Error("Not a PDF");
  await Bun.write(join(import.meta.dir, "..", "..", "..", ".runtime", "sample-report.pdf"), bytes);
  await expectError(a, `/investigations/${areaCase.investigation_id}/pdf`, { method: "GET" }, "FORBIDDEN");
  pass(`PDF generated automatically (${Math.round(bytes.length / 1024)} KB) and is admin-only`);

  await call(admin, `/investigations/${areaCase.investigation_id}/return`, post({ note: "صورة الواجهة غير واضحة" }));
  const returned = await call<Mine>(a, "/investigations/mine");
  if (!returned.active.some((item) => item.investigation_id === areaCase.investigation_id)) throw new Error("Returned case missing");
  await call(a, `/investigations/${areaCase.investigation_id}/submit`, post({ answers, lat: 30.0387, lng: 31.2125 }));
  await call(admin, `/investigations/${areaCase.investigation_id}/approve`, post({}));
  const finished = await call<Mine>(a, "/investigations/mine");
  if (!finished.done.some((item) => item.investigation_id === areaCase.investigation_id)) throw new Error("Finished case missing");
  pass("admin returns a case for correction, then approves it");

  const { levels } = await call<{ levels: { code: string; delivery_hours: number | null; client_price: number; investigator_price: number }[] }>(admin, "/investigations/service-levels");
  if (levels.map((level) => level.code).join() !== "normal,urgent,express,same_day,scheduled") throw new Error("Service levels missing");
  const normal = levels[0]!;
  const edited = await call<{ level: { client_price: number; delivery_hours: number } }>(admin, "/investigations/service-levels/normal", patch({ client_price: 777, delivery_hours: 60 }));
  await call(admin, "/investigations/service-levels/normal", patch({ client_price: normal.client_price, delivery_hours: normal.delivery_hours }));
  if (edited.level.client_price !== 777 || edited.level.delivery_hours !== 60) throw new Error("Price edit failed");
  await expectError(admin, "/investigations", post({ ...subject("بلا موعد"), service_level: "scheduled", target_mode: "person", assignee_id: workerB }), "BAD_REQUEST");
  pass("five investigation types with editable prices; scheduled cases need an appointment");

  const view = await call<{ investigation: { due_at: string; investigator_price: number; client_price?: number; service_name: string } }>(a, `/investigations/${areaCase.investigation_id}`);
  const hours = (new Date(view.investigation.due_at).getTime() - Date.now()) / 3_600_000;
  if (view.investigation.client_price !== undefined || view.investigation.investigator_price !== 140) throw new Error("Investigator must not see the client price");
  if (hours > 24 || hours < 22) throw new Error(`Urgent deadline should be ~24h, got ${hours}`);
  pass(`case keeps type "${view.investigation.service_name}", a 24-hour deadline, and hides the client price from the investigator`);

  const earnings = await call<{ earned: number; approved: number; trend: { earned: number }[] }>(a, "/investigations/mine/earnings");
  if (earnings.earned !== 140 || earnings.approved !== 1 || earnings.trend.length !== 6) throw new Error(`Earnings: ${JSON.stringify(earnings)}`);
  const finance = await call<{ revenue: number; payouts: number; profit: number; by_client: { name: string }[] }>(admin, "/investigations/finance");
  if (finance.revenue < 350 || finance.profit !== finance.revenue - finance.payouts) throw new Error(`Finance: ${JSON.stringify(finance)}`);
  const perf = await call<{ stats: { approved: number; returns: number; earned_month: number } }>(admin, `/investigations/performance/${workerA}`);
  if (perf.stats.approved !== 1 || perf.stats.returns !== 1 || perf.stats.earned_month !== 140) throw new Error(`Performance: ${JSON.stringify(perf.stats)}`);
  await expectError(a, "/investigations/finance", { method: "GET" }, "FORBIDDEN");
  const board = await call<{ investigators: { user_id: string; approved_month: number; accept_rate: number; avg_response_minutes: number }[] }>(admin, "/investigations/leaderboard");
  const me = board.investigators.find((row) => row.user_id === workerA);
  if (!me || me.approved_month !== 1 || me.accept_rate !== 1 || me.avg_response_minutes === null) throw new Error(`Leaderboard: ${JSON.stringify(me)}`);
  const timing = await call<{ responses: { offers: number; accepted: number }; lifecycle: { avg_seen_to_submit_hours: number } }>(admin, `/investigations/performance/${workerA}`);
  if (timing.responses.accepted !== 2 || timing.lifecycle.avg_seen_to_submit_hours === null) throw new Error(`Timing: ${JSON.stringify(timing)}`);
  pass("leaderboard and timing: acceptance rate ignores cancelled offers; reply time and seeing-to-finishing time are measured");

  const negative = await sendCase("شخص غير موجود", { target_mode: "person", assignee_id: workerA });
  await call(a, `/investigations/${negative}/claim`, post({ lat: 30.04, lng: 31.21 }));
  await call(a, `/investigations/${negative}/location`, post({ kind: "started", lat: 30.041, lng: 31.211, accuracy: 8 }));
  await expectError(a, `/investigations/${negative}/submit`, post({ answers: {}, outcome: "negative", negative_reasons: [], negative_note: "لا أحد يعرفه في المنطقة", lat: 30.042, lng: 31.212 }), "BAD_REQUEST");
  await expectError(a, `/investigations/${negative}/submit`, post({ answers: {}, outcome: "negative", negative_reasons: ["سبب مخترع"], negative_note: "لا أحد يعرفه في المنطقة", lat: 30.042, lng: 31.212 }), "BAD_REQUEST");
  await expectError(a, `/investigations/${negative}/submit`, post({ answers: {}, outcome: "negative", negative_reasons: ["الشخص غير مقيم بالعنوان"], negative_note: "قصير", lat: 30.042, lng: 31.212 }), "BAD_REQUEST");
  await call(a, `/investigations/${negative}/submit`, post({
    answers: {}, outcome: "negative", negative_reasons: ["الشخص غير مقيم بالعنوان", "لم يتعرف عليه الجيران أو المصادر"],
    negative_note: "سألت حارس العقار وصاحب المحل المجاور ولم يتعرف أحد على الاسم.", lat: 30.042, lng: 31.212,
  }));
  const report = await call<{ investigation: { outcome: string; negative_reasons: string[]; locations: { kind: string }[] } }>(admin, `/investigations/${negative}`);
  if (report.investigation.outcome !== "negative" || report.investigation.negative_reasons.length !== 2) throw new Error("Negative report not stored");
  if (report.investigation.locations.map((point) => point.kind).join() !== "accepted,started,submitted") throw new Error(`Trail: ${JSON.stringify(report.investigation.locations)}`);
  let negativePdf = "";
  for (let i = 0; i < 40 && negativePdf !== "ready" && negativePdf !== "failed"; i += 1) {
    await Bun.sleep(500);
    negativePdf = (await call<{ investigation: { pdf_status: string } }>(admin, `/investigations/${negative}`)).investigation.pdf_status;
  }
  if (negativePdf !== "ready") throw new Error(`Negative PDF: ${negativePdf}`);
  pass("negative report: needs reasons from the list and an explanation, skips the form, records the GPS trail, and gets a PDF");
  pass("monthly earnings for the investigator (140), company revenue and profit, and per-investigator performance");
} finally {
  await transaction(async () => {
    for (const id of created) {
      await query("DELETE FROM audit_logs WHERE metadata->>'investigation_id' = $1", [id]);
      await query("DELETE FROM investigations WHERE investigation_id=$1", [id]);
    }
    await query("DELETE FROM audit_logs WHERE event LIKE 'investigation.%' AND actor_id=$1", [adminId]);
    for (const level of [5, 4, 3, 2, 1]) {
      await query("DELETE FROM geo_locations WHERE created_by = ANY($1::text[]) AND level = $2", [
        `{${workerA},${workerB}}`,
        level,
      ]);
    }
    for (const id of [workerA, workerB, adminId]) {
      for (const table of ["investigator_profiles", "admin_mfa_challenges", "admin_security", "refresh_sessions", "user_roles", "audit_logs", "users"]) {
        await query(`DELETE FROM ${table} WHERE user_id=$1`, [id]);
      }
    }
  });
  for (const id of created) {
    await rm(join(env.uploadDir, "investigations", id), { recursive: true, force: true });
  }
  await database.end();
}
