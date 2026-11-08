// End-to-end check of client report templates through the public API on port 4001:
// upload → classification → draft → validation → approval → activation →
// immutability → a case pinned to the exact version → evidence rules → client-layout
// report → stamp on approval → audit trail. Creates temporary accounts and a temporary
// template family, and removes everything it made.
//
//   bun --env-file=../IdentityAcess_Services/.env scripts/test-templates.ts
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { connectDatabase, database, query, transaction } from "../../IdentityAcess_Services/Config/db.ts";
import { env } from "../../IdentityAcess_Services/Config/env.ts";
import { newId, randomToken } from "../../IdentityAcess_Services/Utils/crypto.ts";

const base = "http://127.0.0.1:4001/api/v1";
const password = `Tpl-${randomToken(10)}-9aA`;
const suffix = String(Date.now()).slice(-7);
const ids = { office1: newId(), office2: newId(), admin: newId(), worker: newId() };
const archive = join(import.meta.dir, "..", "..", "..", "Investigation Forms");
const sample = join(archive, "Bedayty Company", "استعلام سكن", "بدايتي س.docx");
const photo = new Uint8Array(readFileSync(join(import.meta.dir, "..", "..", "Shared", "templates", "assets", "sample-photo.png")));

type Json = Record<string, any>;
async function call<T = Json>(token: string | null, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (typeof init.body === "string") headers.set("Content-Type", "application/json");
  const response = await fetch(`${base}${path}`, { ...init, headers });
  const body = (await response.json()) as { data?: T; error?: unknown };
  if (!response.ok) throw new Error(`${path} -> ${response.status} ${JSON.stringify(body)}`);
  return body.data as T;
}
async function expectError(token: string, path: string, init: RequestInit, code: string): Promise<Json> {
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  if (typeof init.body === "string") headers.set("Content-Type", "application/json");
  const response = await fetch(`${base}${path}`, { ...init, headers });
  const body = (await response.json()) as { error?: { code?: string } };
  if (response.ok || body.error?.code !== code) {
    throw new Error(`${path}: expected ${code}, got ${response.status} ${JSON.stringify(body).slice(0, 400)}`);
  }
  return body.error as Json;
}
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
const patch = (body: unknown): RequestInit => ({ method: "PATCH", body: JSON.stringify(body) });
const pass = (message: string) => console.log(`PASS ${message}`);
const fail = (message: string) => {
  throw new Error(message);
};

async function makeUser(id: string, name: string, role: string, email: string | null, number: string | null) {
  const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
  await query(
    `INSERT INTO users(user_id,full_name,email,employee_number,phone,national_id_encrypted,national_id_hash,national_id_last4,password_hash,account_type,status)
     VALUES($1,$2,$3,$4,$5,'',$6,'',$7,'existing_employee','active')`,
    [id, name, email, number, `tpl:${id}`, randomToken(), hash],
  );
  await query("INSERT INTO user_roles(user_id,role_id) SELECT $1,role_id FROM roles WHERE name=$2", [id, role]);
}

await connectDatabase();
let templateId: string | null = null;
let caseId: string | null = null;
try {
  await transaction(async () => {
    await makeUser(ids.office1, "إدارة عليا (معدّ)", "head_office", `tpl-o1-${suffix}@example.test`, null);
    await makeUser(ids.office2, "إدارة عليا (مراجع)", "head_office", `tpl-o2-${suffix}@example.test`, null);
    await makeUser(ids.admin, "مدير تجربة القوالب", "admin", `tpl-ad-${suffix}@example.test`, null);
    await makeUser(ids.worker, "مستعلم تجربة القوالب", "employee", null, `TPL-${suffix}`);
    for (const id of [ids.office1, ids.office2, ids.admin]) {
      await query("INSERT INTO admin_security(user_id,mfa_required) VALUES($1,false)", [id]);
    }
  });
  const login = async (identifier: object, platform = "web") =>
    (await call<{ access_token: string }>(null, "/auth/login", post({ ...identifier, password, platform }))).access_token;
  const o1 = await login({ email: `tpl-o1-${suffix}@example.test` });
  const o2 = await login({ email: `tpl-o2-${suffix}@example.test` });
  const admin = await login({ email: `tpl-ad-${suffix}@example.test` });
  const worker = await login({ employee_number: `TPL-${suffix}` }, "android");

  // ── access ──
  await expectError(admin, "/forms/admin/library", {}, "FORBIDDEN");
  const library = await call(o1, "/forms/admin/library");
  if (!library.templates.length || library.counts.active < 1) fail("Library is empty");
  pass(`library lists ${library.templates.length} templates; administrators cannot open template management`);

  // ── upload and classification ──
  const form = new FormData();
  form.append("file", new File([readFileSync(sample)], "بدايتي س.docx"));
  const upload = await call(o1, "/forms/admin/files", { method: "POST", body: form });
  const inventory = upload.file.inventory;
  if (inventory.investigation_type.code !== "residence") fail(`Type: ${inventory.investigation_type.code}`);
  if (inventory.client.client_id !== null) fail("Bedayty has no name or logo in the file; it must not be auto-assigned");
  if (inventory.client.suggested !== "bedayty") fail(`Suggestion: ${inventory.client.suggested}`);
  if (!inventory.warnings.some((w: Json) => w.code === "client_uncertain" && w.severity === "block")) fail("Missing client warning");
  if (!inventory.warnings.some((w: Json) => w.code === "sample_text")) fail("Sample text not flagged");
  pass("upload is classified from content: type residence, client only suggested (no name or logo inside), sample data flagged");

  const bad = new FormData();
  bad.append("file", new File([new TextEncoder().encode("not a word file")], "fake.docx"));
  await expectError(o1, "/forms/admin/files", { method: "POST", body: bad }, "BAD_REQUEST");
  pass("a file whose content is not Word is refused");

  // ── draft ──
  const drafted = await call(o1, "/forms/admin/versions", post({
    file_id: upload.file.file_id,
    client_id: "bedayty",
    investigation_type: "residence",
    title: `قالب تجريبي ${suffix}`,
  }));
  templateId = drafted.template_id;
  const versionId = drafted.version.version_id as string;
  let detail = await call(o1, `/forms/admin/versions/${versionId}`);
  const definition = detail.version.definition;
  const fields = definition.sections.flatMap((s: Json) => s.fields);
  const statements = fields.filter((f: Json) => f.type === "attestation");
  const photos = fields.find((f: Json) => f.type === "photos");
  const checkboxGroup = fields.find((f: Json) => f.type === "choice" || f.type === "multichoice");
  if (!statements.length || !photos || !checkboxGroup) fail("Scan did not find statements, photos and checkbox groups");
  if (!detail.version.bindings.some((b: Json) => b.source === "approval.stamp")) fail("Stamp cell not bound to approval");
  if (!fields.some((f: Json) => f.key === "subject_name" && f.prefill === "subject_name")) fail("Client name does not reuse case data");
  pass(`draft proposes ${fields.length} fields (${statements.length} evidence statements), checkboxes, photo slot, stamp on approval, case data reuse`);

  await expectError(o1, `/forms/admin/versions/${versionId}/submit`, post({}), "TEMPLATE_NOT_READY");
  pass("a draft with unresolved blocking warnings cannot go to review");

  await expectError(o1, `/forms/admin/versions/${versionId}`, patch({
    definition: { ...definition, sections: [{ ...definition.sections[0], fields: [{ key: "x1", label: "س", type: "text", visible_if: { field: "nope", op: "filled" } }] }] },
  }), "INVALID_DEFINITION");
  await expectError(o1, `/forms/admin/versions/${versionId}`, patch({
    bindings: [{ anchor: detail.version.bindings[0].anchor, action: "text", source: "answers.not_a_field" }],
  }), "BAD_REQUEST");
  await expectError(o1, `/forms/admin/versions/${versionId}`, patch({
    definition: { ...definition, sections: [...definition.sections, { title: "قسم", fields: [{ key: "claim", label: "عبارة", type: "text", default: "تمت زيارة العميل بمقر سكنه" }] }] },
  }), "INVALID_DEFINITION");
  pass("invalid conditions, unknown binding fields and default texts claiming a visit are refused");

  // Head Office adds a partners table (repeating rows) and a conditional field, then
  // acknowledges the blocking warnings.
  const extended = {
    ...definition,
    sections: [
      ...definition.sections,
      {
        id: "partners",
        title: "الشركاء",
        fields: [
          { key: "has_partners", label: "هل للعميل شركاء؟", type: "yesno", required: true },
          {
            key: "partners",
            label: "الشركاء",
            type: "table",
            block: "partners",
            visible_if: { field: "has_partners", op: "eq", value: "نعم" },
            required_if: { field: "has_partners", op: "eq", value: "نعم" },
            columns: [
              { key: "name", label: "اسم الشريك", type: "text", required: true },
              { key: "share", label: "النسبة %", type: "number", validation: { min: 0, max: 100 } },
            ],
          },
        ],
      },
    ],
  };
  const acknowledged = detail.version.warnings.map((w: Json) => `${w.code}:${w.message}`);
  const saved = await call(o1, `/forms/admin/versions/${versionId}`, patch({ definition: extended, acknowledged }));
  if (saved.check.errors.length) fail(`Still not ready: ${JSON.stringify(saved.check.errors).slice(0, 300)}`);
  if (!saved.check.unplaced.includes("partners")) fail("The new table has no place in the layout; it must be reported");
  pass("conditional repeating table added; fields without a place in the layout are reported (they print in an appendix)");

  const layout = await call(o1, `/forms/admin/versions/${versionId}/layout`);
  if (!String(layout.html).includes('data-anchor="gp_')) fail("Layout preview has no clickable slots");
  pass("the visual mapper receives the layout with clickable slots");

  const engine = (await call(o1, "/forms/admin/engine")).engine as string | null;
  if (engine) {
    const response = await fetch(`${base}/forms/admin/versions/${versionId}/preview?mode=labels`, { headers: { Authorization: `Bearer ${o1}` } });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!response.ok || String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") fail(`Preview failed: ${response.status}`);
    pass(`PDF preview of the client layout built with ${engine} (${response.headers.get("x-report-pages")} pages)`);
  } else console.log("SKIP PDF preview: no Word engine installed");

  // ── review ──
  const submitted = await call(o1, `/forms/admin/versions/${versionId}/submit`, post({ change_note: "اختبار" }));
  await expectError(o1, `/forms/admin/versions/${versionId}`, patch({ change_note: "x" }), "TEMPLATE_VERSION_LOCKED");
  pass("submitted version is locked");

  // The member who prepared it approves it; no second member is needed.
  await call(o1, `/forms/admin/versions/${versionId}/approve`, post({ activate: true, note: "تمت المراجعة" }));
  await call(o2, `/forms/admin/templates/${templateId}`, patch({ active: true }));
  detail = await call(o1, `/forms/admin/versions/${versionId}`);
  if (detail.version.status !== "active" || detail.version.content_hash !== submitted.content_hash) fail("Activation failed");
  pass("its author approves and activates it; the approved content hash is the reviewed one");

  // The database itself refuses to change an approved version.
  for (const sql of [
    "UPDATE template_versions SET definition = '{}'::jsonb WHERE version_id = $1",
    "DELETE FROM template_versions WHERE version_id = $1",
    "UPDATE template_versions SET status = 'draft' WHERE version_id = $1",
  ]) {
    let blocked = false;
    try {
      await query(sql, [versionId]);
    } catch (error) {
      blocked = String((error as Error).message).includes("TEMPLATE_VERSION_IMMUTABLE");
    }
    if (!blocked) fail(`Not blocked: ${sql}`);
  }
  pass("the database trigger blocks editing, deleting or reopening an approved version");

  // ── a case uses the exact version ──
  const resolved = await call(admin, `/forms/resolve?client=bedayty&type=residence`);
  if (!resolved.templates.some((t: Json) => t.template_id === templateId && t.version_id === versionId)) fail("Resolve did not find the template");
  const createdCase = await call(admin, "/investigations", post({
    target_mode: "person",
    assignee_id: ids.worker,
    template_id: templateId,
    service_level: "normal",
    subject_name: "عميل اختبار القوالب",
    subject_phone: "01000000000",
    address: "١٢ شارع التحرير، الدقي",
    governorate: "الجيزة",
    district: "الدقي",
    lat: 30.0384,
    lng: 31.2113,
  }));
  caseId = createdCase.investigation_id;
  const [stored] = await query("SELECT template_version_id, template_version_no, template_hash, investigation_type FROM investigations WHERE investigation_id=$1", [caseId]);
  if (stored?.template_version_id !== versionId || stored.template_hash !== submitted.content_hash || stored.investigation_type !== "residence") {
    fail(`Case is not pinned: ${JSON.stringify(stored)}`);
  }
  pass("the new case records the template version, its number and content hash");

  await call(worker, `/investigations/${caseId}/claim`, post({ lat: 30.0385, lng: 31.2114 }));
  const view = await call(worker, `/investigations/${caseId}`);
  const caseFields = view.investigation.definition.sections.flatMap((s: Json) => s.fields);
  if (!caseFields.some((f: Json) => f.key === "partners" && f.type === "table")) fail("Investigator does not see the client form");
  pass("the investigator receives this client's form, with the repeating table and conditions");

  // Answers: everything filled, every statement confirmed, but no photos yet.
  const answers: Json = { has_partners: "نعم", partners: [{ name: "شريك أول", share: "60" }, { name: "شريك ثان", share: "40" }] };
  for (const field of caseFields) {
    if (field.key in answers) continue;
    if (field.type === "attestation") answers[field.key] = true;
    else if (field.type === "choice") answers[field.key] = field.options[0];
    else if (field.type === "multichoice") answers[field.key] = [field.options[0]];
    else if (field.type === "yesno") answers[field.key] = "نعم";
    else if (field.type === "date") answers[field.key] = "2026-11-05";
    else if (field.type === "time") answers[field.key] = "10:30";
    else if (field.type === "number") answers[field.key] = "3";
    else if (field.type === "phone") answers[field.key] = "01000000000";
    else if (field.type === "national_id") answers[field.key] = "29001010000000";
    else if (!["photos", "signature", "table"].includes(field.type)) answers[field.key] = `قيمة ${field.label}`.slice(0, 60);
  }
  await call(worker, `/investigations/${caseId}/answers`, patch({ answers }));
  const refused = await expectError(worker, `/investigations/${caseId}/submit`, post({ answers, lat: 30.0384, lng: 31.2113 }), "FORM_INCOMPLETE");
  const messages = JSON.stringify(refused.details);
  if (!messages.includes("لا يمكن تأكيد")) fail(`Statements were not checked for evidence: ${messages.slice(0, 300)}`);
  pass("confirming a visit or document check without photos is refused (no statement without evidence)");

  const badShare = { ...answers, partners: [{ name: "شريك", share: "150" }] };
  const tableError = await expectError(worker, `/investigations/${caseId}/submit`, post({ answers: badShare, lat: 30.0384, lng: 31.2113 }), "FORM_INCOMPLETE");
  if (!JSON.stringify(tableError.details).includes("أكبر من 100")) fail("Table column validation not applied");
  pass("repeating table columns are validated row by row");

  const upload2 = new FormData();
  upload2.append("field_key", photos.key);
  upload2.append("image", new File([photo], "visit.png", { type: "image/png" }));
  await call(worker, `/investigations/${caseId}/images`, { method: "POST", body: upload2 });
  await call(worker, `/investigations/${caseId}/submit`, post({ answers, lat: 30.0384, lng: 31.2113 }));
  pass("with photos and an on-site location, the report is accepted");

  const waitReport = async (after: string | null) => {
    for (let i = 0; i < 120; i += 1) {
      await Bun.sleep(1000);
      const [row] = await query(
        "SELECT pdf_status, report_layout, report_issues, report_error, report_built_at FROM investigations WHERE investigation_id=$1",
        [caseId],
      );
      if (row?.pdf_status === "failed") fail(`Report failed: ${row.report_error}`);
      if (row?.pdf_status === "ready" && (!after || String(row.report_built_at) !== after)) return row;
    }
    fail("Report timed out");
  };
  const report = await waitReport(null);
  if (engine && report!.report_layout !== "docx") fail(`Expected the client layout, got ${report!.report_layout}: ${report!.report_error}`);
  const unplaced = (report!.report_issues as Json[]).filter((issue) => issue.kind === "unplaced").map((issue) => issue.key);
  if (engine && !unplaced.includes("has_partners")) fail(`Appendix not reported: ${JSON.stringify(report!.report_issues).slice(0, 300)}`);
  pass(`report built in the ${report!.report_layout === "docx" ? "client's own Word layout" : "standard layout"}; extra fields go to an appendix`);

  const check = await call(admin, `/investigations/${caseId}/check`);
  if (check.issues.length || !check.template.matches || check.template.version_no !== stored.template_version_no) {
    fail(`Review check: ${JSON.stringify(check).slice(0, 300)}`);
  }
  if (engine) {
    const docx = await fetch(`${base}/investigations/${caseId}/report.docx`, { headers: { Authorization: `Bearer ${admin}` } });
    if (!docx.ok) fail("Word report not downloadable");
  }
  pass("the reviewer sees no missing data, the matching template version, and can download the Word report");

  // A newer draft never changes a running case.
  const clone = await call(o1, `/forms/admin/versions/${versionId}/clone`, post({ change_note: "تعديل لاحق" }));
  await call(o1, `/forms/admin/versions/${clone.version.version_id}`, patch({
    definition: { ...extended, sections: extended.sections.slice(0, 1) },
  }));
  const again = await call(worker, `/investigations/${caseId}`);
  if (JSON.stringify(again.investigation.definition) !== JSON.stringify(view.investigation.definition)) fail("A draft changed a running case");
  await call(o1, `/forms/admin/versions/${clone.version.version_id}`, { method: "DELETE" });
  pass("editing a new draft leaves existing cases on their own version; drafts can be discarded");

  const before = String(report!.report_built_at);
  await call(admin, `/investigations/${caseId}/approve`, post({ note: "معتمد" }));
  await waitReport(before);
  pass("approval rebuilds the report with the reviewer and the Golden Pay stamp");

  const events = await call(o1, `/forms/admin/events?template_id=${templateId}`);
  const types = new Set(events.events.map((event: Json) => event.type));
  for (const type of ["template.created", "version.drafted", "version.edited", "version.submitted", "version.approved", "version.activated", "template.enabled", "version.cloned", "version.discarded"]) {
    if (!types.has(type)) fail(`Audit trail is missing ${type}`);
  }
  pass("every step is in the template audit trail");
} finally {
  await transaction(async () => {
    if (caseId) {
      for (const table of ["investigation_events", "investigation_offers", "investigation_images", "investigation_locations", "investigation_recipients"]) {
        await query(`DELETE FROM ${table} WHERE investigation_id=$1`, [caseId]);
      }
      await query("DELETE FROM investigations WHERE investigation_id=$1", [caseId]);
    }
    if (templateId) {
      // Test data only: approved versions are immutable, so the guard is lifted briefly.
      await query("ALTER TABLE template_versions DISABLE TRIGGER trg_template_version_guard");
      await query("DELETE FROM template_previews WHERE version_id IN (SELECT version_id FROM template_versions WHERE template_id=$1)", [templateId]);
      await query("DELETE FROM template_events WHERE template_id=$1", [templateId]);
      await query("UPDATE form_templates SET active_version_id = NULL WHERE template_id=$1", [templateId]);
      await query("DELETE FROM template_versions WHERE template_id=$1", [templateId]);
      await query("DELETE FROM form_templates WHERE template_id=$1", [templateId]);
      await query("ALTER TABLE template_versions ENABLE TRIGGER trg_template_version_guard");
    }
    for (const id of Object.values(ids)) {
      await query("DELETE FROM template_events WHERE actor_id=$1", [id]);
      await query("DELETE FROM audit_logs WHERE user_id=$1 OR actor_id=$1", [id]);
      // Head office tables (attendance, points, salaries…) cascade with the user.
      for (const table of ["investigator_profiles", "admin_mfa_challenges", "admin_security", "refresh_sessions", "user_roles", "users"]) {
        await query(`DELETE FROM ${table} WHERE user_id=$1`, [id]);
      }
    }
  });
  if (caseId) await rm(join(env.uploadDir, "investigations", caseId), { recursive: true, force: true });
  await database.end();
}
