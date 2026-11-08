/**
 * Head Office template management: upload client templates, classify them, map their
 * fields, review and approve versions, and activate the one new cases use. Versions are
 * immutable once submitted (enforced by a database trigger), and every step is logged.
 */
import { extname, join } from "node:path";
import { query, transaction } from "../IdentityAcess_Services/Config/db.ts";
import { env } from "../IdentityAcess_Services/Config/env.ts";
import { withPermission, type AuthContext } from "../IdentityAcess_Services/MIddlewares/auth.middleware.ts";
import { recordAudit } from "../IdentityAcess_Services/Services/audit.service.ts";
import { hasPermission, PERMISSIONS } from "../IdentityAcess_Services/Services/rbac.service.ts";
import { getStoredFile, putStoredFile } from "../IdentityAcess_Services/Utils/files.ts";
import { ApiError, created, ok, readJson, type RequestContext } from "../IdentityAcess_Services/Utils/http.ts";
import type { Router } from "../IdentityAcess_Services/Utils/router.ts";
import { optionalText, requiredText } from "../Shared/service.ts";
import { availableEngine, ConverterUnavailable, docToDocx, docxToPdf, pdfToDocx } from "../Shared/templates/convert.ts";
import {
  allFields,
  BLOCKS,
  defaultEvidence,
  DefinitionError,
  evidenceKindFor,
  parseDefinition,
  type FieldDef,
  type TemplateDefinition,
} from "../Shared/templates/definition.ts";
import { DocxPackage, sha256 } from "../Shared/templates/docx.ts";
import { insertPlace, PlaceError, type PlaceTarget, placeHasContent, removePlace, renamePlace, wrapPlace } from "../Shared/templates/edit.ts";
import { inventoryDocx, INVESTIGATION_TYPES, type ClientProfile, type InventoryRecord } from "../Shared/templates/inventory.ts";
import { layoutHtml } from "../Shared/templates/preview.ts";
import { renderDocxReport, SAMPLE_CONTEXT, sampleAnswers, samplePhotoBytes } from "../Shared/templates/report.ts";
import { type Binding, CASE_SOURCES, scanTemplate, type Slot } from "../Shared/templates/scan.ts";

type Row = Record<string, unknown>;
const MANAGE = PERMISSIONS.TEMPLATES_MANAGE;
const APPROVE = PERMISSIONS.TEMPLATES_APPROVE;
const MAX_UPLOAD = 25 * 1024 * 1024;
const ACTIONS = ["text", "check", "choose", "image", "rows", "statement", "clear"] as const;

/** Points the mapper may drag: values, statements and single checkboxes. */
const MOVABLE_KINDS: Slot["kind"][] = ["cell", "inline", "statement", "checkbox"];

/** First free anchor with a prefix (gp_u001, gp_r001…). */
function nextAnchor(slots: Slot[], prefix: string): string {
  const taken = new Set(slots.map((slot) => slot.anchor));
  let n = 1;
  while (taken.has(`${prefix}${String(n).padStart(3, "0")}`)) n += 1;
  return `${prefix}${String(n).padStart(3, "0")}`;
}

// ───────────── storage ─────────────

export async function storeFile(relative: string, bytes: Uint8Array): Promise<string> {
  return putStoredFile(relative, bytes);
}

export async function loadFile(relative: string): Promise<Uint8Array> {
  try {
    return await getStoredFile(relative);
  } catch {
    throw ApiError.notFound("The stored template file is missing");
  }
}

void env;

// ───────────── shared helpers ─────────────

export async function logTemplateEvent(event: {
  type: string;
  template_id?: string | null;
  version_id?: string | null;
  file_id?: string | null;
  actor_id?: string | null;
  note?: string | null;
  metadata?: unknown;
}): Promise<void> {
  await query(
    `INSERT INTO template_events(template_id,version_id,file_id,type,actor_id,note,metadata)
     VALUES($1,$2,$3,$4,$5,$6,$7::text::jsonb)`,
    [
      event.template_id ?? null,
      event.version_id ?? null,
      event.file_id ?? null,
      event.type,
      event.actor_id ?? null,
      event.note ?? null,
      event.metadata === undefined ? null : JSON.stringify(event.metadata),
    ],
  );
}

export async function clientProfiles(): Promise<ClientProfile[]> {
  const rows = await query("SELECT client_id, name, name_en, client_type, aliases, logo_hashes FROM form_clients WHERE active");
  return rows.map((row) => ({
    client_id: row.client_id as string,
    name: row.name as string,
    name_en: (row.name_en as string) ?? undefined,
    client_type: row.client_type as "bank" | "company",
    aliases: (row.aliases as string[]) ?? [],
    logo_hashes: (row.logo_hashes as string[]) ?? [],
  }));
}

/** JSON with object keys sorted, so the same content always gives the same text (PostgreSQL reorders jsonb keys). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export async function contentHash(definition: unknown, bindings: unknown, layoutSha: string | null): Promise<string> {
  return sha256(`${canonicalJson(definition)}\n${canonicalJson(bindings)}\n${layoutSha ?? "standard"}`);
}

async function findVersion(id: string | undefined): Promise<Row> {
  const rows = await query(
    `SELECT v.*, t.title, t.client_id, t.investigation_type, t.active AS template_active, t.active_version_id,
            c.name AS client_name, u1.full_name AS created_by_name, u2.full_name AS submitted_by_name,
            u3.full_name AS reviewed_by_name, u4.full_name AS activated_by_name
     FROM template_versions v JOIN form_templates t ON t.template_id = v.template_id
     JOIN form_clients c ON c.client_id = t.client_id
     LEFT JOIN users u1 ON u1.user_id = v.created_by LEFT JOIN users u2 ON u2.user_id = v.submitted_by
     LEFT JOIN users u3 ON u3.user_id = v.reviewed_by LEFT JOIN users u4 ON u4.user_id = v.activated_by
     WHERE v.version_id = $1`,
    [id],
  );
  if (!rows[0]) throw ApiError.notFound("Template version not found");
  return rows[0];
}

function assertDraft(version: Row): void {
  if (version.status !== "draft") {
    throw new ApiError(409, "TEMPLATE_VERSION_LOCKED", "Only a draft can be changed. Create a new version to edit it.");
  }
}

function parseBindings(raw: unknown, definition: TemplateDefinition, slots: Slot[]): Binding[] {
  if (!Array.isArray(raw)) throw ApiError.badRequest("bindings must be a list");
  // Repeating rows bind every row of the layout, not only the first one.
  const anchors = new Set(slots.flatMap((slot) => [slot.anchor, ...(slot.rows?.anchors ?? [])]));
  const fields = new Map(allFields(definition).map((field) => [field.key, field]));
  const seen = new Set<string>();
  return raw.map((item, index) => {
    if (typeof item !== "object" || !item) throw ApiError.badRequest(`Binding ${index + 1} is invalid`);
    const binding = item as Record<string, unknown>;
    const anchor = String(binding.anchor ?? "");
    const action = binding.action as Binding["action"];
    if (!anchors.has(anchor)) throw ApiError.badRequest(`Binding ${index + 1} points at an unknown place in the layout`);
    if (seen.has(anchor)) throw ApiError.badRequest(`The place ${anchor} has two bindings`);
    seen.add(anchor);
    if (!ACTIONS.includes(action)) throw ApiError.badRequest(`Binding ${anchor} has an unknown action`);
    const out: Binding = { anchor, action };
    const source = optionalText(binding.source, 120);
    if (action !== "clear") {
      if (!source) throw ApiError.badRequest(`Binding ${anchor} needs a source`);
      if (source.startsWith("answers.")) {
        const field = fields.get(source.slice(8));
        if (!field) throw ApiError.badRequest(`Binding ${anchor} uses an unknown field: ${source.slice(8)}`);
        const fits: Record<string, string[]> = {
          check: ["choice", "multichoice", "yesno"],
          choose: ["choice", "yesno", "multichoice"],
          image: ["photos", "signature"],
          rows: ["table"],
          statement: ["attestation"],
          text: ["text", "textarea", "number", "date", "time", "phone", "national_id", "choice", "multichoice", "yesno", "table"],
        };
        if (!fits[action]?.includes(field.type)) {
          throw ApiError.badRequest(`«${field.label}» (${field.type}) cannot be placed as ${action}`);
        }
        if (action === "check") {
          const option = optionalText(binding.option, 200);
          const options = field.type === "yesno" ? ["نعم", "لا"] : (field.options ?? []);
          if (!option || !options.includes(option)) {
            throw ApiError.badRequest(`The checkbox ${anchor} needs one of the options of «${field.label}»`);
          }
          out.option = option;
        }
        if (action === "rows") {
          const columns = Array.isArray(binding.columns) ? binding.columns.map((key) => (key ? String(key) : null)) : [];
          for (const key of columns) {
            if (key && !field.columns?.some((column) => column.key === key)) {
              throw ApiError.badRequest(`«${field.label}» has no column ${key}`);
            }
          }
          out.columns = columns;
        }
      } else if (source === "approval.stamp") {
        if (action !== "image") throw ApiError.badRequest("The stamp can only be placed as a picture");
      } else if (source.startsWith("case.")) {
        if (!(source in CASE_SOURCES)) throw ApiError.badRequest(`Unknown case value: ${source}`);
        if (action !== "text") throw ApiError.badRequest("Case values are placed as text");
      } else throw ApiError.badRequest(`Unknown source: ${source}`);
      out.source = source;
    }
    return out;
  });
}

/** Everything that stops a version from going to review, and what only deserves a look. */
export async function checkVersion(version: Row): Promise<{
  errors: { code: string; message: string }[];
  warnings: { code: string; message: string }[];
  unplaced: string[];
}> {
  const errors: { code: string; message: string }[] = [];
  const warnings: { code: string; message: string }[] = [];
  let definition: TemplateDefinition;
  try {
    definition = parseDefinition(version.definition);
  } catch (error) {
    const issues = error instanceof DefinitionError ? error.issues : [{ path: "", message: String(error) }];
    return { errors: issues.map((issue) => ({ code: "definition", message: issue.message })), warnings, unplaced: [] };
  }
  const bindings = (version.bindings as Binding[]) ?? [];
  const slots = (version.slots as Slot[]) ?? [];
  if (version.layout_mode === "docx") {
    try {
      parseBindings(bindings, definition, slots);
    } catch (error) {
      errors.push({ code: "binding", message: error instanceof Error ? error.message : String(error) });
    }
    const placed = new Set(bindings.map((binding) => binding.source?.slice(8)).filter(Boolean));
    const unplaced = allFields(definition).filter((field) => !placed.has(field.key));
    for (const field of unplaced) {
      warnings.push({ code: "unplaced", message: `«${field.label}» ليس له مكان في التصميم؛ سيُطبع في ملحق التقرير` });
    }
    const unmappedSlots = slots.filter((slot) => !bindings.some((binding) => binding.anchor === slot.anchor) && slot.kind !== "image");
    if (unmappedSlots.length) {
      warnings.push({ code: "unmapped_slots", message: `${unmappedSlots.length} مكانًا في التصميم بلا ربط؛ سيبقى كما هو في الأصل` });
    }
    const sampleSlots = slots.filter((slot) => slot.sample && !bindings.some((binding) => binding.anchor === slot.anchor));
    for (const slot of sampleSlots) {
      errors.push({ code: "sample_unbound", message: `نص من تقرير سابق «${slot.text}» في «${slot.label}» لم يُربط ولم يُحذف` });
    }
    const unknownImages = slots.filter((slot) => slot.kind === "image" && slot.image?.role === "unknown" && slot.image.md5 &&
      !bindings.some((binding) => binding.anchor === slot.anchor));
    for (const slot of unknownImages) {
      errors.push({ code: "image_unresolved", message: `صورة مضمّنة في «${slot.label}» بلا قرار: احذفها أو حدد دورها` });
    }
    const acknowledged = new Set((version.acknowledged as string[]) ?? []);
    for (const warning of (version.warnings as { code: string; message: string; severity?: string }[]) ?? []) {
      const id = `${warning.code}:${warning.message}`;
      if (warning.severity === "block" && !acknowledged.has(id)) {
        errors.push({ code: warning.code, message: `يجب مراجعة التحذير: ${warning.message}` });
      } else if (warning.severity === "review" && !acknowledged.has(id)) {
        warnings.push({ code: warning.code, message: warning.message });
      }
    }
    return { errors, warnings, unplaced: unplaced.map((field) => field.key) };
  }
  return { errors, warnings, unplaced: [] };
}

/** Keeps field keys, types and rules from the previous version when labels match. */
export function carryOver(scan: { definition: TemplateDefinition; bindings: Binding[] }, previous: TemplateDefinition | null): void {
  if (!previous) return;
  const old = new Map(allFields(previous).map((field) => [field.label.replace(/\s+/g, " ").trim(), field]));
  const taken = new Set<string>();
  const renames = new Map<string, string>();
  for (const section of scan.definition.sections) {
    section.fields = section.fields.map((field) => {
      const match = old.get(field.label.replace(/\s+/g, " ").trim());
      if (!match || taken.has(match.key) || match.type !== field.type) return field;
      taken.add(match.key);
      renames.set(field.key, match.key);
      return { ...match, options: field.options ?? match.options };
    });
  }
  for (const binding of scan.bindings) {
    const key = binding.source?.startsWith("answers.") ? binding.source.slice(8) : null;
    if (key && renames.has(key)) binding.source = `answers.${renames.get(key)}`;
  }
  // Conditions may point at renamed keys too.
  const json = JSON.stringify(scan.definition);
  let updated = json;
  for (const [from, to] of renames) updated = updated.replaceAll(`"field":"${from}"`, `"field":"${to}"`);
  if (updated !== json) Object.assign(scan.definition, JSON.parse(updated));
}

// ───────────── file intake ─────────────

/** Stores an upload once (by hash), converts it to .docx if needed and classifies it. */
export async function intakeFile(input: {
  bytes: Uint8Array;
  fileName: string;
  sourcePath?: string | null;
  uploadedBy?: string | null;
  docxBytes?: Uint8Array | null;
}): Promise<{ file: Row; inventory: InventoryRecord; created: boolean }> {
  const digest = await sha256(input.bytes);
  const existing = await query("SELECT * FROM template_files WHERE sha256 = $1", [digest]);
  if (existing[0]) return { file: existing[0], inventory: existing[0].inventory as InventoryRecord, created: false };

  const extension = extname(input.fileName).toLowerCase().replace(".", "");
  const format = extension === "doc" ? "doc" : extension === "pdf" ? "pdf" : "docx";
  if (!["docx", "doc", "pdf"].includes(extension)) throw ApiError.badRequest("Upload a Word (.docx, .doc) or PDF file");
  const isZip = input.bytes[0] === 0x50 && input.bytes[1] === 0x4b;
  const isOle = input.bytes[0] === 0xd0 && input.bytes[1] === 0xcf;
  const isPdf = String.fromCharCode(...input.bytes.slice(0, 5)) === "%PDF-";
  if ((format === "docx" && !isZip) || (format === "doc" && !isOle && !isZip) || (format === "pdf" && !isPdf)) {
    throw ApiError.badRequest("The file content does not match its extension");
  }

  let docx = input.docxBytes ?? (format === "docx" || (format === "doc" && isZip) ? input.bytes : null);
  if (!docx) {
    try {
      docx = (format === "pdf" ? await pdfToDocx(input.bytes) : await docToDocx(input.bytes)).bytes;
    } catch (error) {
      if (error instanceof ConverterUnavailable) {
        throw new ApiError(422, "CONVERTER_UNAVAILABLE", `${format.toUpperCase()} files need Word or LibreOffice on the server to be converted. Save it as .docx and upload again.`);
      }
      throw new ApiError(422, "CONVERSION_FAILED", `The ${format.toUpperCase()} file could not be converted: ${(error as Error).message.slice(0, 200)}`);
    }
  }
  const inventory = await inventoryDocx(docx, {
    fileName: input.fileName,
    sourcePath: input.sourcePath ?? null,
    format,
    originalSize: input.bytes.length,
    originalSha: digest,
    clients: await clientProfiles(),
  });
  const path = await storeFile(`templates/files/${digest}.${format}`, input.bytes);
  const docxPath = format === "docx" ? path : await storeFile(`templates/files/${digest}.converted.docx`, docx);
  const rows = await query(
    `INSERT INTO template_files(sha256,file_name,format,size,path,docx_path,source_path,inventory,uploaded_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8::text::jsonb,$9)
     ON CONFLICT (sha256) DO UPDATE SET sha256 = EXCLUDED.sha256 RETURNING *`,
    [digest, input.fileName, format, input.bytes.length, path, docxPath, input.sourcePath ?? null, JSON.stringify(inventory), input.uploadedBy ?? null],
  );
  await logTemplateEvent({
    type: "file.uploaded",
    file_id: rows[0]!.file_id as string,
    actor_id: input.uploadedBy ?? null,
    note: input.fileName,
    metadata: { client: inventory.client.client_id, type: inventory.investigation_type.code, warnings: inventory.warnings.length },
  });
  return { file: rows[0]!, inventory, created: true };
}

/** A new draft version built from a stored file: scanned, proposed and waiting for review. */
export async function draftFromFile(input: {
  file: Row;
  templateId: string;
  actorId: string;
  note?: string | null;
}): Promise<Row> {
  const docx = await loadFile((input.file.docx_path ?? input.file.path) as string);
  const inventory = input.file.inventory as InventoryRecord;
  const clientLogos = (await clientProfiles()).flatMap((client) => client.logo_hashes);
  const scan = scanTemplate(docx, clientLogos);
  const [previous] = await query(
    `SELECT definition FROM template_versions WHERE template_id = $1
     ORDER BY (status = 'active') DESC, version_no DESC LIMIT 1`,
    [input.templateId],
  );
  carryOver(scan, previous ? (previous.definition as TemplateDefinition) : null);
  const definition = parseDefinition(scan.definition);
  const layoutSha = await sha256(scan.docx);
  const warnings = [
    ...inventory.warnings,
    ...[...new Set(scan.warnings)].map((message) => ({ code: "scan", message, severity: "info" })),
  ];
  return transaction(async () => {
    const [{ next }] = (await query(
      "SELECT COALESCE(MAX(version_no), 0) + 1 AS next FROM template_versions WHERE template_id = $1",
      [input.templateId],
    )) as [{ next: number }];
    const versionId = crypto.randomUUID();
    const layoutPath = await storeFile(`templates/layouts/${versionId}.docx`, scan.docx);
    const rows = await query(
      `INSERT INTO template_versions(version_id,template_id,version_no,status,layout_mode,definition,bindings,slots,source_file_id,
         layout_path,layout_sha256,warnings,change_note,created_by,based_on_version_id)
       VALUES($1,$2,$3,'draft','docx',$4::text::jsonb,$5::text::jsonb,$6::text::jsonb,$7,$8,$9,$10::text::jsonb,$11,$12,
         (SELECT active_version_id FROM form_templates WHERE template_id = $2))
       RETURNING *`,
      [
        versionId,
        input.templateId,
        Number(next),
        JSON.stringify(definition),
        JSON.stringify(scan.bindings),
        JSON.stringify(scan.slots),
        input.file.file_id,
        layoutPath,
        layoutSha,
        JSON.stringify(warnings),
        input.note ?? "مسودة من الملف الأصلي، مقترحة آليًا وتحتاج مراجعة",
        input.actorId,
      ],
    );
    await logTemplateEvent({
      type: "version.drafted",
      template_id: input.templateId,
      version_id: versionId,
      file_id: input.file.file_id as string,
      actor_id: input.actorId,
      metadata: { version_no: Number(next), fields: allFields(definition).length, slots: scan.slots.length },
    });
    return rows[0]!;
  });
}

async function setFamilySnapshot(templateId: string, versionId: string, definition: TemplateDefinition): Promise<void> {
  // `sections` mirrors the active version for older clients of /forms/templates.
  await query(
    `UPDATE form_templates SET active_version_id = $2, sections = $3::text::jsonb, version = (SELECT version_no FROM template_versions WHERE version_id = $2),
       updated_at = now() WHERE template_id = $1`,
    [templateId, versionId, JSON.stringify(definition.sections)],
  );
}

/** Makes an approved version the one new cases use; the previous one is retired. */
async function activate(version: Row, auth: AuthContext, context: RequestContext): Promise<void> {
  await transaction(async () => {
    await query(
      `UPDATE template_versions SET status = 'retired', retired_at = now(), updated_at = now()
       WHERE template_id = $1 AND status = 'active'`,
      [version.template_id],
    );
    await query(
      `UPDATE template_versions SET status = 'active', activated_by = $2, activated_at = now(), updated_at = now()
       WHERE version_id = $1 AND status = 'approved'`,
      [version.version_id, auth.user.user_id],
    );
    await setFamilySnapshot(version.template_id as string, version.version_id as string, version.definition as TemplateDefinition);
    await logTemplateEvent({
      type: "version.activated",
      template_id: version.template_id as string,
      version_id: version.version_id as string,
      actor_id: auth.user.user_id,
      metadata: { version_no: version.version_no },
    });
  });
  await recordAudit({
    event: "template.activated",
    actorId: auth.user.user_id,
    success: true,
    context,
    metadata: { template_id: version.template_id, version_no: version.version_no },
  });
}

function versionSummary(row: Row) {
  return {
    version_id: row.version_id,
    version_no: row.version_no,
    status: row.status,
    layout_mode: row.layout_mode,
    change_note: row.change_note,
    created_at: row.created_at,
    submitted_at: row.submitted_at,
    reviewed_at: row.reviewed_at,
    activated_at: row.activated_at,
    retired_at: row.retired_at,
    content_hash: row.content_hash,
  };
}

// ───────────── previews ─────────────

async function standardPreview(version: Row, answers: Record<string, unknown>, photos: Uint8Array | null): Promise<Uint8Array> {
  const { renderStandardPdf } = await import("../Investigations_Services/pdf.ts");
  const definition = version.definition as TemplateDefinition;
  return renderStandardPdf({
    reference: SAMPLE_CONTEXT.reference!,
    subject_name: SAMPLE_CONTEXT.subject_name!,
    subject_phone: SAMPLE_CONTEXT.subject_phone ?? null,
    client_reference: SAMPLE_CONTEXT.client_reference ?? null,
    client_name: version.client_name as string,
    form_title: version.title as string,
    address: SAMPLE_CONTEXT.address!,
    location: "الجيزة - الدقي",
    landmark: SAMPLE_CONTEXT.landmark ?? null,
    admin_notes: null,
    investigator: SAMPLE_CONTEXT.investigator_name!,
    employee_number: SAMPLE_CONTEXT.employee_number ?? null,
    submitted_at: new Date(SAMPLE_CONTEXT.submitted_at as string),
    submit_lat: SAMPLE_CONTEXT.submit_lat ?? null,
    submit_lng: SAMPLE_CONTEXT.submit_lng ?? null,
    definition,
    answers,
    images: [],
    imageBytes: photos ? Object.fromEntries(allFields(definition).filter((f) => f.type === "photos").map((f) => [f.key, [photos]])) : {},
    outcome: "positive",
    negative_reasons: [],
    negative_note: null,
    trail: [],
    evidence: { photos: Object.fromEntries(allFields(definition).filter((f) => f.type === "photos").map((f) => [f.key, photos ? 1 : 0])), locations: [{ kind: "submitted", lat: 30.0384, lng: 31.2113 }] },
    approved: true,
  });
}

// Identical previews requested at the same time share one build.
const building = new Map<string, Promise<{ bytes: Uint8Array; pages: number | null; engine: string; issues: unknown[] }>>();

/** A PDF preview of a version: field names, sample data or an empty form. Cached by content. */
async function preview(version: Row, mode: "labels" | "sample" | "blank") {
  const key = `${version.version_id}:${mode}:${version.updated_at}`;
  let task = building.get(key);
  if (!task) {
    task = buildPreview(version, mode).finally(() => building.delete(key));
    building.set(key, task);
  }
  return task;
}

async function buildPreview(version: Row, mode: "labels" | "sample" | "blank"): Promise<{ bytes: Uint8Array; pages: number | null; engine: string; issues: unknown[] }> {
  const definition = version.definition as TemplateDefinition;
  const key = await sha256(
    `${mode}\n${version.layout_mode}\n${version.layout_sha256 ?? ""}\n${JSON.stringify(definition)}\n${JSON.stringify(version.bindings)}\n${String(version.client_name)}`,
  );
  const [cached] = await query("SELECT path, pages, engine FROM template_previews WHERE cache_key = $1", [key]);
  if (cached) {
    try {
      return { bytes: await loadFile(cached.path as string), pages: cached.pages as number | null, engine: cached.engine as string, issues: [] };
    } catch {
      // The file was cleaned up; build it again.
    }
  }
  const answers = mode === "sample" ? sampleAnswers(definition) : {};
  const photo = mode === "sample" ? await samplePhotoBytes() : null;
  let bytes: Uint8Array;
  let pages: number | null = null;
  let engine = "chrome";
  let issues: unknown[] = [];
  if (version.layout_mode === "docx") {
    const report = await renderDocxReport({
      layout: await loadFile(version.layout_path as string),
      bindings: version.bindings as Binding[],
      slots: (version.slots as Slot[] | null) ?? null,
      definition,
      answers,
      context: mode === "blank" ? {} : SAMPLE_CONTEXT,
      images: photo
        ? Object.fromEntries(allFields(definition).filter((field) => ["photos", "signature"].includes(field.type)).map((field) => [field.key, [{ bytes: photo }]]))
        : {},
      evidence: {
        photos: Object.fromEntries(allFields(definition).map((field) => [field.key, photo ? 1 : 0])),
        locations: mode === "sample" ? [{ kind: "submitted", lat: 30.0384, lng: 31.2113 }] : [],
      },
      approved: mode === "sample",
      preview: mode === "labels" ? "labels" : null,
    });
    bytes = report.pdf;
    pages = report.pages;
    engine = report.engine;
    issues = report.issues;
  } else {
    bytes = await standardPreview(version, answers, photo);
  }
  const path = await storeFile(`templates/previews/${key}.pdf`, bytes);
  await query(
    `INSERT INTO template_previews(cache_key, version_id, path, pages, engine) VALUES($1,$2,$3,$4,$5)
     ON CONFLICT (cache_key) DO UPDATE SET path = EXCLUDED.path`,
    [key, version.version_id, path, pages, engine],
  );
  return { bytes, pages, engine, issues };
}

// ───────────── routes ─────────────

async function readUpload(context: RequestContext): Promise<{ file: File; form: FormData }> {
  const declared = Number(context.req.headers.get("content-length") ?? 0);
  if (declared > MAX_UPLOAD) throw ApiError.payloadTooLarge("Template files must be at most 25 MB");
  let form: FormData;
  try {
    form = (await context.req.formData()) as unknown as FormData;
  } catch {
    throw ApiError.badRequest("Send the template as multipart/form-data with a `file` field");
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) throw ApiError.badRequest("Choose a template file to upload");
  if (file.size > MAX_UPLOAD) throw ApiError.payloadTooLarge("Template files must be at most 25 MB");
  return { file, form };
}

function canApprove(auth: AuthContext): boolean {
  return hasPermission(auth.access, APPROVE);
}

export function registerTemplateRoutes(router: Router): void {
  router.get(
    "/forms/admin/engine",
    withPermission(MANAGE, async () => ok({ engine: await availableEngine() })),
  );

  router.get(
    "/forms/admin/blocks",
    withPermission(MANAGE, async () =>
      ok({ blocks: Object.entries(BLOCKS).map(([id, block]) => ({ id, label: block.label, field: block.field })), case_sources: CASE_SOURCES }),
    ),
  );

  router.get(
    "/forms/admin/library",
    withPermission(MANAGE, async (context) => {
      const rows = await query(
        `SELECT t.template_id, t.code, t.title, t.category, t.client_id, t.investigation_type, t.active, t.active_version_id,
                t.updated_at, c.name AS client_name, c.client_type, it.name AS type_name,
                av.version_no AS active_version_no, av.layout_mode AS active_layout, av.activated_at,
                (SELECT count(*)::int FROM template_versions v WHERE v.template_id = t.template_id) AS versions,
                (SELECT json_agg(json_build_object('version_id', v.version_id, 'version_no', v.version_no, 'status', v.status,
                    'layout_mode', v.layout_mode, 'updated_at', v.updated_at,
                    'warnings', jsonb_array_length(v.warnings)) ORDER BY v.version_no DESC)
                 FROM template_versions v WHERE v.template_id = t.template_id AND v.status IN ('draft','in_review','approved')) AS pending,
                (SELECT f.inventory -> 'client' ->> 'confidence' FROM template_versions v JOIN template_files f ON f.file_id = v.source_file_id
                 WHERE v.template_id = t.template_id ORDER BY v.version_no DESC LIMIT 1) AS client_confidence
         FROM form_templates t JOIN form_clients c ON c.client_id = t.client_id
         LEFT JOIN investigation_types it ON it.code = t.investigation_type
         LEFT JOIN template_versions av ON av.version_id = t.active_version_id
         WHERE ($1::text IS NULL OR t.client_id = $1)
         ORDER BY c.client_type, c.name, it.sort NULLS LAST, t.title`,
        [context.url.searchParams.get("client") || null],
      );
      const [counts] = await query(
        `SELECT count(*) FILTER (WHERE status = 'in_review')::int AS in_review,
                count(*) FILTER (WHERE status = 'draft')::int AS drafts,
                count(*) FILTER (WHERE status = 'active')::int AS active,
                count(*) FILTER (WHERE status = 'active' AND layout_mode = 'docx')::int AS active_docx
         FROM template_versions`,
      );
      return ok({ templates: rows, counts, types: await query("SELECT code, name FROM investigation_types WHERE active ORDER BY sort") });
    }),
  );

  router.get(
    "/forms/admin/files",
    withPermission(MANAGE, async () => {
      const rows = await query(
        `SELECT f.file_id, f.sha256, f.file_name, f.format, f.size, f.source_path, f.inventory, f.created_at,
                (SELECT json_agg(json_build_object('version_id', v.version_id, 'template_id', v.template_id, 'version_no', v.version_no,
                    'status', v.status, 'title', t.title))
                 FROM template_versions v JOIN form_templates t ON t.template_id = v.template_id WHERE v.source_file_id = f.file_id) AS versions
         FROM template_files f ORDER BY f.source_path NULLS LAST, f.file_name`,
      );
      return ok({ files: rows });
    }),
  );

  router.get(
    "/forms/admin/files/:file_id",
    withPermission(MANAGE, async (context) => {
      const [file] = await query("SELECT * FROM template_files WHERE file_id = $1", [context.params.file_id]);
      if (!file) throw ApiError.notFound("File not found");
      const bytes = await loadFile(file.path as string);
      const type = file.format === "pdf" ? "application/pdf" : file.format === "doc" ? "application/msword" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      return new Response(bytes as unknown as BodyInit, {
        headers: {
          "Content-Type": type,
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.file_name as string)}`,
          "Cache-Control": "no-store",
        },
      });
    }),
  );

  router.post(
    "/forms/admin/files",
    withPermission(MANAGE, async (context, auth) => {
      const { file } = await readUpload(context);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await intakeFile({ bytes, fileName: file.name || "template.docx", uploadedBy: auth.user.user_id });
      const inventory = result.inventory;
      const matches = await query(
        `SELECT t.template_id, t.title, t.client_id, t.investigation_type, c.name AS client_name, av.version_no AS active_version_no
         FROM form_templates t JOIN form_clients c ON c.client_id = t.client_id
         LEFT JOIN template_versions av ON av.version_id = t.active_version_id
         WHERE t.client_id = $1 AND ($2::text IS NULL OR t.investigation_type = $2)`,
        [inventory.client.client_id ?? inventory.client.suggested, inventory.investigation_type.code],
      );
      await recordAudit({
        event: "template.file_uploaded",
        actorId: auth.user.user_id,
        success: true,
        context,
        metadata: { file_id: result.file.file_id, name: file.name },
      });
      return created({ file: { ...result.file, inventory }, duplicate: !result.created, matches });
    }),
  );

  /** Creates a draft from a stored file, for an existing family or a new one. */
  router.post(
    "/forms/admin/versions",
    withPermission(MANAGE, async (context, auth) => {
      const body = await readJson(context.req);
      const [file] = await query("SELECT * FROM template_files WHERE file_id = $1", [requiredText(body.file_id, "file_id", 64)]);
      if (!file) throw ApiError.notFound("File not found");
      let templateId = optionalText(body.template_id, 64);
      if (templateId) {
        const [family] = await query("SELECT template_id FROM form_templates WHERE template_id = $1", [templateId]);
        if (!family) throw ApiError.notFound("Template not found");
      } else {
        const clientId = requiredText(body.client_id, "client_id", 64);
        const type = requiredText(body.investigation_type, "investigation_type", 40);
        const [client] = await query("SELECT client_id FROM form_clients WHERE client_id = $1", [clientId]);
        if (!client) throw ApiError.badRequest("Choose an existing client", { field: "client_id" });
        const [known] = await query("SELECT name FROM investigation_types WHERE code = $1", [type]);
        if (!known) throw ApiError.badRequest("Choose an investigation type", { field: "investigation_type" });
        const title = requiredText(body.title, "title", 200);
        const rows = await query(
          `INSERT INTO form_templates(code,client_id,title,category,sections,source_file,active,investigation_type,updated_by)
           VALUES($1,$2,$3,$4,'[]'::jsonb,$5,false,$6,$7) RETURNING template_id`,
          [`${clientId}-${crypto.randomUUID().slice(0, 8)}`, clientId, title, known.name, file.file_name, type, auth.user.user_id],
        );
        templateId = rows[0]!.template_id as string;
        await logTemplateEvent({ type: "template.created", template_id: templateId, actor_id: auth.user.user_id, note: title });
      }
      const version = await draftFromFile({ file, templateId, actorId: auth.user.user_id, note: optionalText(body.change_note, 500) });
      await recordAudit({
        event: "template.version_drafted",
        actorId: auth.user.user_id,
        success: true,
        context,
        metadata: { template_id: templateId, version_no: version.version_no },
      });
      return created({ version: versionSummary(version), template_id: templateId });
    }),
  );

  router.get(
    "/forms/admin/templates/:template_id",
    withPermission(MANAGE, async (context) => {
      const [template] = await query(
        `SELECT t.*, c.name AS client_name, it.name AS type_name FROM form_templates t
         JOIN form_clients c ON c.client_id = t.client_id LEFT JOIN investigation_types it ON it.code = t.investigation_type
         WHERE t.template_id = $1`,
        [context.params.template_id],
      );
      if (!template) throw ApiError.notFound("Template not found");
      const versions = await query(
        `SELECT v.version_id, v.version_no, v.status, v.layout_mode, v.change_note, v.created_at, v.submitted_at, v.reviewed_at,
                v.activated_at, v.retired_at, v.content_hash, v.review_note, jsonb_array_length(v.warnings) AS warnings,
                u.full_name AS created_by_name, r.full_name AS reviewed_by_name,
                (SELECT count(*)::int FROM investigations i WHERE i.template_version_id = v.version_id) AS cases
         FROM template_versions v LEFT JOIN users u ON u.user_id = v.created_by LEFT JOIN users r ON r.user_id = v.reviewed_by
         WHERE v.template_id = $1 ORDER BY v.version_no DESC`,
        [context.params.template_id],
      );
      const { sections: _sections, ...rest } = template;
      return ok({ template: rest, versions });
    }),
  );

  router.patch(
    "/forms/admin/templates/:template_id",
    withPermission(MANAGE, async (context, auth) => {
      const body = await readJson(context.req);
      const type = optionalText(body.investigation_type, 40);
      if (type) {
        const [known] = await query("SELECT 1 FROM investigation_types WHERE code = $1", [type]);
        if (!known) throw ApiError.badRequest("Unknown investigation type");
      }
      const active = typeof body.active === "boolean" ? body.active : null;
      if (active) {
        const [family] = await query("SELECT active_version_id FROM form_templates WHERE template_id = $1", [context.params.template_id]);
        if (!family?.active_version_id) {
          throw new ApiError(409, "NO_ACTIVE_VERSION", "Approve and activate a version before turning the template on");
        }
      }
      const rows = await query(
        `UPDATE form_templates SET title = COALESCE($2, title), investigation_type = COALESCE($3, investigation_type),
           active = COALESCE($4, active), updated_by = $5, updated_at = now() WHERE template_id = $1
         RETURNING template_id, title, investigation_type, active`,
        [context.params.template_id, optionalText(body.title, 200), type, active, auth.user.user_id],
      );
      if (!rows[0]) throw ApiError.notFound("Template not found");
      await logTemplateEvent({
        type: active === null ? "template.updated" : active ? "template.enabled" : "template.disabled",
        template_id: context.params.template_id,
        actor_id: auth.user.user_id,
        metadata: { title: body.title, investigation_type: type, active },
      });
      await recordAudit({ event: "template.updated", actorId: auth.user.user_id, success: true, context, metadata: { template_id: context.params.template_id, active } });
      return ok({ template: rows[0] });
    }),
  );

  router.get(
    "/forms/admin/versions/:version_id",
    withPermission(MANAGE, async (context) => {
      const version = await findVersion(context.params.version_id);
      const [file] = version.source_file_id
        ? await query("SELECT file_id, file_name, format, size, sha256, source_path, inventory FROM template_files WHERE file_id = $1", [version.source_file_id])
        : [];
      const check = await checkVersion(version);
      return ok({ version, file: file ?? null, check });
    }),
  );

  router.get(
    "/forms/admin/versions/:version_id/layout",
    withPermission(MANAGE, async (context) => {
      const version = await findVersion(context.params.version_id);
      if (version.layout_mode !== "docx" || !version.layout_path) {
        return ok({ html: null, slots: [], bindings: [] });
      }
      return ok({ html: layoutHtml(await loadFile(version.layout_path as string)), slots: version.slots, bindings: version.bindings });
    }),
  );

  /**
   * Drag and drop in the visual mapper: move a point, add a new one, or remove one that was
   * added by hand. Drafts only. The client's text and formatting stay exactly as they are.
   */
  router.post(
    "/forms/admin/versions/:version_id/places",
    withPermission(MANAGE, async (context, auth) => {
      const version = await findVersion(context.params.version_id);
      assertDraft(version);
      if (version.layout_mode !== "docx" || !version.layout_path) throw ApiError.badRequest("This version has no client layout");
      const body = await readJson(context.req);
      const op = String(body.op ?? "");
      if (!["move", "create", "remove"].includes(op)) throw ApiError.badRequest("op must be move, create or remove");
      let slots = [...((version.slots as Slot[]) ?? [])];
      let bindings = [...((version.bindings as Binding[]) ?? [])];
      let definition = version.definition as TemplateDefinition;
      const pkg = DocxPackage.open(await loadFile(version.layout_path as string));
      const target = (): PlaceTarget => {
        const paragraph = Number(body.paragraph);
        const offset = Number(body.offset);
        if (!Number.isInteger(paragraph) || paragraph < 0 || !Number.isInteger(offset) || offset < 0) {
          throw ApiError.badRequest("Drop the point on the page");
        }
        return { part: requiredText(body.part, "part", 80), paragraph, offset };
      };
      let anchor = optionalText(body.anchor, 40) ?? "";
      try {
        if (op === "remove") {
          if (!anchor.startsWith("gp_u")) throw new PlaceError("Only points added by hand can be removed; unbind the others instead");
          removePlace(pkg, anchor);
          slots = slots.filter((slot) => slot.anchor !== anchor);
          bindings = bindings.filter((binding) => binding.anchor !== anchor);
        } else if (op === "move") {
          const slot = slots.find((item) => item.anchor === anchor);
          if (!slot) throw ApiError.notFound("Point not found");
          if (!MOVABLE_KINDS.includes(slot.kind)) {
            throw new PlaceError("Pictures, list choices and table rows stay where the client's form puts them");
          }
          const where = target();
          const keepsKind = slot.kind === "statement" || slot.kind === "checkbox";
          let leftBehind: Slot | null = null;
          if (keepsKind && placeHasContent(pkg, anchor)) {
            // The client's own sentence or box stays in the file but is hidden, so it never
            // prints on its own (an unproven claim, or an empty box) once the point moves.
            const rest = nextAnchor(slots, "gp_r");
            renamePlace(pkg, anchor, rest);
            leftBehind = {
              anchor: rest,
              kind: "inline",
              part: slot.part,
              label: `${slot.label} — مكانه الأصلي`,
              text: slot.text,
              section: slot.section,
            };
          } else {
            removePlace(pkg, anchor);
          }
          const placed = insertPlace(pkg, anchor, where);
          slots = slots.map((item) =>
            item.anchor === anchor
              ? {
                  ...item,
                  part: where.part,
                  kind: keepsKind ? item.kind : placed.inCell ? "cell" : "inline",
                  text: "",
                  sample: false,
                  ...(anchor.startsWith("gp_u") ? { label: placed.label } : {}),
                }
              : item,
          );
          if (leftBehind) {
            slots.push(leftBehind);
            bindings.push({ anchor: leftBehind.anchor, action: "clear" });
          }
        } else {
          anchor = nextAnchor(slots, "gp_u");
          const where = target();
          const kind = String(body.kind ?? "text");
          if (!["text", "statement", "checkbox"].includes(kind)) throw ApiError.badRequest("kind must be text, statement or checkbox");
          const end = body.end === undefined || body.end === null ? null : Number(body.end);
          if (end !== null && (kind !== "statement" || !Number.isInteger(end) || end <= where.offset)) {
            throw ApiError.badRequest("Only a statement can wrap selected text, and the selection must not be empty");
          }
          if (end !== null) {
            // The selected client sentence becomes the statement: it prints as written only when
            // the investigator confirms it with the evidence its wording calls for.
            const sentence = wrapPlace(pkg, anchor, where, end).replace(/\s+/g, " ").trim();
            if (!sentence) throw new PlaceError("Select the sentence's text first");
            const label = sentence.length > 60 ? `${sentence.slice(0, 57).trim()}…` : sentence;
            const taken = new Set(allFields(definition).map((field) => field.key));
            let n = 1;
            while (taken.has(`statement_${n}`)) n += 1;
            const field: FieldDef = {
              key: `statement_${n}`,
              label,
              type: "attestation",
              statement: sentence,
              evidence: defaultEvidence(evidenceKindFor(sentence)),
            };
            const sections = definition.sections.some((section) => section.id === "manual_points")
              ? definition.sections
              : [...definition.sections, { id: "manual_points", title: "نقاط مضافة يدويًا", fields: [] }];
            definition = parseDefinition({
              ...definition,
              sections: sections.map((section) => (section.id === "manual_points" ? { ...section, fields: [...section.fields, field] } : section)),
            });
            slots.push({ anchor, kind: "statement", part: where.part, label, text: sentence, section: "نقاط مضافة يدويًا" });
            bindings.push({ anchor, action: "statement", source: `answers.${field.key}` });
          }
          const placed = end === null ? insertPlace(pkg, anchor, where) : { inCell: false, label: "" };
          const source = optionalText(body.source, 120);
          if (end !== null) {
            // Added above, with its own field.
          } else if (kind === "statement") {
            slots.push({ anchor, kind: "statement", part: where.part, label: placed.label === "نقطة جديدة" ? "عبارة إقرار" : placed.label, text: "", section: "نقاط مضافة يدويًا" });
            if (source) bindings.push({ anchor, action: "statement", source });
          } else if (kind === "checkbox") {
            const option = optionalText(body.option, 200);
            slots.push({ anchor, kind: "checkbox", part: where.part, label: option || "مربع اختيار", text: "", option: option ?? "", group: "", section: "نقاط مضافة يدويًا" });
            if (source && option) bindings.push({ anchor, action: "check", source, option });
          } else {
            slots.push({ anchor, kind: placed.inCell ? "cell" : "inline", part: where.part, label: placed.label, text: "", section: "نقاط مضافة يدويًا" });
            if (source) bindings.push({ anchor, action: "text", source });
          }
        }
      } catch (error) {
        if (error instanceof PlaceError) throw new ApiError(400, "PLACE_NOT_ALLOWED", error.message);
        if (error instanceof DefinitionError) throw new ApiError(400, "INVALID_DEFINITION", error.message, { details: error.issues });
        throw error;
      }
      bindings = parseBindings(bindings, definition, slots);
      const bytes = pkg.save();
      const layoutPath = await storeFile(`templates/layouts/${version.version_id}-${Date.now()}.docx`, bytes);
      const rows = await query(
        `UPDATE template_versions SET layout_path = $2, layout_sha256 = $3, slots = $4::text::jsonb, bindings = $5::text::jsonb,
           definition = $6::text::jsonb, updated_at = now() WHERE version_id = $1 AND status = 'draft' RETURNING version_id`,
        [version.version_id, layoutPath, await sha256(bytes), JSON.stringify(slots), JSON.stringify(bindings), JSON.stringify(definition)],
      );
      if (!rows[0]) throw new ApiError(409, "TEMPLATE_VERSION_LOCKED", "This version is no longer a draft");
      await logTemplateEvent({
        type: "version.edited",
        template_id: version.template_id as string,
        version_id: version.version_id as string,
        actor_id: auth.user.user_id,
        note: op === "create" ? (body.end !== undefined && body.end !== null ? "حُوّلت جملة إلى عبارة إقرار" : "أُضيفت نقطة") : op === "move" ? "نُقلت نقطة" : "حُذفت نقطة",
        metadata: { op, anchor },
      });
      return ok({ anchor, html: layoutHtml(bytes), slots, bindings });
    }),
  );

  router.get(
    "/forms/admin/versions/:version_id/layout.docx",
    withPermission(MANAGE, async (context) => {
      const version = await findVersion(context.params.version_id);
      if (!version.layout_path) throw ApiError.notFound("This version uses the standard layout");
      return new Response((await loadFile(version.layout_path as string)) as unknown as BodyInit, {
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "Content-Disposition": `attachment; filename="template-v${version.version_no}.docx"`,
          "Cache-Control": "no-store",
        },
      });
    }),
  );

  router.get(
    "/forms/admin/versions/:version_id/preview",
    withPermission(MANAGE, async (context) => {
      const version = await findVersion(context.params.version_id);
      const raw = context.url.searchParams.get("mode");
      const mode = raw === "labels" || raw === "blank" ? raw : "sample";
      try {
        const result = await preview(version, mode);
        return new Response(result.bytes as unknown as BodyInit, {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `inline; filename="preview-v${version.version_no}-${mode}.pdf"`,
            "Cache-Control": "no-store",
            "X-Report-Pages": String(result.pages ?? ""),
            "X-Report-Engine": result.engine,
          },
        });
      } catch (error) {
        if (error instanceof ConverterUnavailable) throw new ApiError(503, "CONVERTER_UNAVAILABLE", error.message);
        throw error;
      }
    }),
  );

  router.patch(
    "/forms/admin/versions/:version_id",
    withPermission(MANAGE, async (context, auth) => {
      const version = await findVersion(context.params.version_id);
      assertDraft(version);
      const body = await readJson(context.req);
      let definition = version.definition as TemplateDefinition;
      if (body.definition !== undefined) {
        try {
          definition = parseDefinition(body.definition);
        } catch (error) {
          if (error instanceof DefinitionError) {
            throw new ApiError(400, "INVALID_DEFINITION", error.message, { details: error.issues });
          }
          throw error;
        }
      }
      let bindings = version.bindings as Binding[];
      if (body.bindings !== undefined) bindings = parseBindings(body.bindings, definition, version.slots as Slot[]);
      else if (body.definition !== undefined && version.layout_mode === "docx") {
        // Drop bindings to fields that no longer exist.
        const keys = new Set(allFields(definition).map((field) => field.key));
        bindings = bindings.filter((binding) => !binding.source?.startsWith("answers.") || keys.has(binding.source.slice(8)));
      }
      const acknowledged = Array.isArray(body.acknowledged) ? [...new Set(body.acknowledged.map(String))].slice(0, 500) : version.acknowledged;
      const rows = await query(
        `UPDATE template_versions SET definition = $2::text::jsonb, bindings = $3::text::jsonb, acknowledged = $4::text::jsonb,
           change_note = COALESCE($5, change_note), updated_at = now() WHERE version_id = $1 AND status = 'draft' RETURNING updated_at`,
        [version.version_id, JSON.stringify(definition), JSON.stringify(bindings), JSON.stringify(acknowledged), optionalText(body.change_note, 500)],
      );
      if (!rows[0]) throw new ApiError(409, "TEMPLATE_VERSION_LOCKED", "This version is no longer a draft");
      await logTemplateEvent({
        type: "version.edited",
        template_id: version.template_id as string,
        version_id: version.version_id as string,
        actor_id: auth.user.user_id,
        metadata: {
          fields: allFields(definition).length,
          bindings: bindings.length,
          changed: [body.definition !== undefined && "definition", body.bindings !== undefined && "bindings", Array.isArray(body.acknowledged) && "acknowledged"].filter(Boolean),
        },
      });
      const updated = await findVersion(version.version_id as string);
      return ok({ version: updated, check: await checkVersion(updated) });
    }),
  );

  router.post(
    "/forms/admin/versions/:version_id/clone",
    withPermission(MANAGE, async (context, auth) => {
      const version = await findVersion(context.params.version_id);
      const body = await readJson(context.req).catch(() => ({}) as Row);
      const rows = await transaction(async () => {
        const [{ next }] = (await query(
          "SELECT COALESCE(MAX(version_no), 0) + 1 AS next FROM template_versions WHERE template_id = $1",
          [version.template_id],
        )) as [{ next: number }];
        return query(
          `INSERT INTO template_versions(template_id,version_no,status,layout_mode,definition,bindings,slots,source_file_id,layout_path,
             layout_sha256,warnings,acknowledged,change_note,created_by,based_on_version_id)
           SELECT template_id,$2,'draft',layout_mode,definition,bindings,slots,source_file_id,layout_path,layout_sha256,warnings,acknowledged,
             $3,$4,version_id FROM template_versions WHERE version_id = $1 RETURNING *`,
          [version.version_id, Number(next), optionalText(body.change_note, 500) ?? `نسخة معدّلة من الإصدار ${version.version_no}`, auth.user.user_id],
        );
      });
      await logTemplateEvent({
        type: "version.cloned",
        template_id: version.template_id as string,
        version_id: rows[0]!.version_id as string,
        actor_id: auth.user.user_id,
        metadata: { from_version: version.version_no },
      });
      return created({ version: versionSummary(rows[0]!) });
    }),
  );

  router.delete(
    "/forms/admin/versions/:version_id",
    withPermission(MANAGE, async (context, auth) => {
      const version = await findVersion(context.params.version_id);
      assertDraft(version);
      await query("DELETE FROM template_versions WHERE version_id = $1 AND status = 'draft'", [version.version_id]);
      await logTemplateEvent({
        type: "version.discarded",
        template_id: version.template_id as string,
        version_id: version.version_id as string,
        actor_id: auth.user.user_id,
        metadata: { version_no: version.version_no },
      });
      return ok({ deleted: true });
    }),
  );

  router.post(
    "/forms/admin/versions/:version_id/submit",
    withPermission(MANAGE, async (context, auth) => {
      const version = await findVersion(context.params.version_id);
      assertDraft(version);
      const check = await checkVersion(version);
      if (check.errors.length) {
        throw new ApiError(400, "TEMPLATE_NOT_READY", "Fix the problems before sending this version for review", {
          details: check.errors,
        });
      }
      const body = await readJson(context.req).catch(() => ({}) as Row);
      const hash = await contentHash(version.definition, version.bindings, (version.layout_sha256 as string) ?? null);
      // The hash is written while still a draft; after this the trigger freezes the row.
      await query("UPDATE template_versions SET content_hash = $2 WHERE version_id = $1 AND status = 'draft'", [version.version_id, hash]);
      const rows = await query(
        `UPDATE template_versions SET status = 'in_review', submitted_by = $2, submitted_at = now(), review_note = NULL,
           change_note = COALESCE($3, change_note), updated_at = now() WHERE version_id = $1 AND status = 'draft' RETURNING version_id`,
        [version.version_id, auth.user.user_id, optionalText(body.change_note, 500)],
      );
      if (!rows[0]) throw new ApiError(409, "TEMPLATE_VERSION_LOCKED", "This version is no longer a draft");
      await logTemplateEvent({
        type: "version.submitted",
        template_id: version.template_id as string,
        version_id: version.version_id as string,
        actor_id: auth.user.user_id,
        metadata: { content_hash: hash, warnings: check.warnings.length },
      });
      return ok({ status: "in_review", content_hash: hash });
    }),
  );

  router.post(
    "/forms/admin/versions/:version_id/withdraw",
    withPermission(MANAGE, async (context, auth) => {
      const rows = await query(
        `UPDATE template_versions SET status = 'draft', content_hash = content_hash, updated_at = now()
         WHERE version_id = $1 AND status = 'in_review' AND submitted_by = $2 RETURNING template_id, version_no`,
        [context.params.version_id, auth.user.user_id],
      );
      if (!rows[0]) throw new ApiError(409, "INVALID_STATUS_TRANSITION", "Only the person who sent it can withdraw a version under review");
      await logTemplateEvent({ type: "version.withdrawn", template_id: rows[0].template_id as string, version_id: context.params.version_id, actor_id: auth.user.user_id });
      return ok({ status: "draft" });
    }),
  );

  router.post(
    "/forms/admin/versions/:version_id/return",
    withPermission(MANAGE, async (context, auth) => {
      if (!canApprove(auth)) throw ApiError.forbidden("You cannot review templates");
      const body = await readJson(context.req);
      const note = requiredText(body.note, "note", 1000);
      const rows = await query(
        `UPDATE template_versions SET status = 'draft', reviewed_by = $2, reviewed_at = now(), review_note = $3, updated_at = now()
         WHERE version_id = $1 AND status = 'in_review' RETURNING template_id`,
        [context.params.version_id, auth.user.user_id, note],
      );
      if (!rows[0]) throw new ApiError(409, "INVALID_STATUS_TRANSITION", "This version is not waiting for review");
      await logTemplateEvent({ type: "version.returned", template_id: rows[0].template_id as string, version_id: context.params.version_id, actor_id: auth.user.user_id, note });
      await recordAudit({ event: "template.returned", actorId: auth.user.user_id, success: true, context, metadata: { version_id: context.params.version_id } });
      return ok({ status: "draft" });
    }),
  );

  router.post(
    "/forms/admin/versions/:version_id/approve",
    withPermission(MANAGE, async (context, auth) => {
      if (!canApprove(auth)) throw ApiError.forbidden("You cannot approve templates");
      const version = await findVersion(context.params.version_id);
      if (version.status !== "in_review") throw new ApiError(409, "INVALID_STATUS_TRANSITION", "This version is not waiting for review");
      const selfApproval = process.env.TEMPLATE_ALLOW_SELF_APPROVAL === "true";
      if (!selfApproval && (version.submitted_by === auth.user.user_id || version.created_by === auth.user.user_id)) {
        throw new ApiError(403, "FOUR_EYES_REQUIRED", "Another Head Office member must approve a version you prepared");
      }
      // What is approved must be exactly what was reviewed.
      const hash = await contentHash(version.definition, version.bindings, (version.layout_sha256 as string) ?? null);
      if (hash !== version.content_hash) throw new ApiError(409, "TEMPLATE_CHANGED", "This version changed after it was sent for review");
      const check = await checkVersion(version);
      if (check.errors.length) {
        throw new ApiError(400, "TEMPLATE_NOT_READY", "This version still has problems", { details: check.errors });
      }
      const body = await readJson(context.req).catch(() => ({}) as Row);
      await query(
        `UPDATE template_versions SET status = 'approved', reviewed_by = $2, reviewed_at = now(), review_note = $3, updated_at = now()
         WHERE version_id = $1 AND status = 'in_review'`,
        [version.version_id, auth.user.user_id, optionalText(body.note, 1000)],
      );
      await logTemplateEvent({
        type: "version.approved",
        template_id: version.template_id as string,
        version_id: version.version_id as string,
        actor_id: auth.user.user_id,
        note: optionalText(body.note, 1000),
        metadata: { content_hash: hash },
      });
      await recordAudit({ event: "template.approved", actorId: auth.user.user_id, success: true, context, metadata: { version_id: version.version_id } });
      if (body.activate === true) await activate({ ...version, status: "approved" }, auth, context);
      return ok({ status: body.activate === true ? "active" : "approved" });
    }),
  );

  router.post(
    "/forms/admin/versions/:version_id/activate",
    withPermission(MANAGE, async (context, auth) => {
      if (!canApprove(auth)) throw ApiError.forbidden("You cannot activate templates");
      const version = await findVersion(context.params.version_id);
      if (version.status !== "approved") throw new ApiError(409, "INVALID_STATUS_TRANSITION", "Only an approved version can be activated");
      await activate(version, auth, context);
      return ok({ status: "active" });
    }),
  );

  router.get(
    "/forms/admin/versions/:version_id/diff",
    withPermission(MANAGE, async (context) => {
      const version = await findVersion(context.params.version_id);
      const againstId = context.url.searchParams.get("against") || version.based_on_version_id || version.active_version_id;
      if (!againstId || againstId === version.version_id) return ok({ against: null, changes: [] });
      const against = await findVersion(againstId as string);
      return ok({ against: versionSummary(against), changes: diffDefinitions(against, version) });
    }),
  );

  router.get(
    "/forms/admin/events",
    withPermission(MANAGE, async (context) => {
      const templateId = context.url.searchParams.get("template_id");
      const versionId = context.url.searchParams.get("version_id");
      const rows = await query(
        `SELECT e.*, u.full_name AS actor_name, t.title AS template_title, v.version_no
         FROM template_events e LEFT JOIN users u ON u.user_id = e.actor_id
         LEFT JOIN form_templates t ON t.template_id = e.template_id LEFT JOIN template_versions v ON v.version_id = e.version_id
         WHERE ($1::text IS NULL OR e.template_id = $1) AND ($2::text IS NULL OR e.version_id = $2)
         ORDER BY e.created_at DESC LIMIT 200`,
        [templateId || null, versionId || null],
      );
      return ok({ events: rows });
    }),
  );

  router.post(
    "/forms/admin/clients",
    withPermission(MANAGE, async (context, auth) => {
      const body = await readJson(context.req);
      const name = requiredText(body.name, "name", 160);
      const id = (optionalText(body.client_id, 60) ?? (optionalText(body.name_en, 80) ?? name))
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || `client-${crypto.randomUUID().slice(0, 6)}`;
      const type = body.client_type === "bank" ? "bank" : "company";
      const aliases = Array.isArray(body.aliases) ? body.aliases.map(String).filter(Boolean).slice(0, 20) : [name];
      for (const alias of aliases) {
        try {
          new RegExp(alias, "i");
        } catch {
          throw ApiError.badRequest(`Invalid name pattern: ${alias}`);
        }
      }
      const rows = await query(
        `INSERT INTO form_clients(client_id,name,name_en,client_type,aliases) VALUES($1,$2,$3,$4,$5::text::jsonb) RETURNING *`,
        [id, name, optionalText(body.name_en, 160), type, JSON.stringify(aliases)],
      );
      await logTemplateEvent({ type: "client.created", actor_id: auth.user.user_id, note: name, metadata: { client_id: id } });
      return created({ client: rows[0] });
    }),
  );

  router.patch(
    "/forms/admin/clients/:client_id",
    withPermission(MANAGE, async (context, auth) => {
      const body = await readJson(context.req);
      const aliases = Array.isArray(body.aliases) ? body.aliases.map(String).filter(Boolean).slice(0, 20) : null;
      for (const alias of aliases ?? []) {
        try {
          new RegExp(alias, "i");
        } catch {
          throw ApiError.badRequest(`Invalid name pattern: ${alias}`);
        }
      }
      const logos = Array.isArray(body.logo_hashes)
        ? body.logo_hashes.map(String).filter((hash: string) => /^[0-9a-f]{8}$/.test(hash)).slice(0, 20)
        : null;
      const rows = await query(
        `UPDATE form_clients SET name = COALESCE($2, name), name_en = COALESCE($3, name_en),
           aliases = COALESCE($4::text::jsonb, aliases), logo_hashes = COALESCE($5::text::jsonb, logo_hashes)
         WHERE client_id = $1 RETURNING *`,
        [context.params.client_id, optionalText(body.name, 160), optionalText(body.name_en, 160), aliases ? JSON.stringify(aliases) : null, logos ? JSON.stringify(logos) : null],
      );
      if (!rows[0]) throw ApiError.notFound("Client not found");
      await logTemplateEvent({ type: "client.updated", actor_id: auth.user.user_id, metadata: { client_id: context.params.client_id } });
      return ok({ client: rows[0] });
    }),
  );
}

/** Field-level differences between two versions, for the reviewer. */
export function diffDefinitions(before: Row, after: Row) {
  const a = new Map(allFields(before.definition as TemplateDefinition).map((field) => [field.key, field]));
  const b = new Map(allFields(after.definition as TemplateDefinition).map((field) => [field.key, field]));
  const changes: { kind: "added" | "removed" | "changed"; key: string; label: string; details?: string[] }[] = [];
  for (const [key, field] of b) {
    const old = a.get(key);
    if (!old) {
      changes.push({ kind: "added", key, label: field.label });
      continue;
    }
    const details: string[] = [];
    const props: (keyof FieldDef)[] = ["label", "type", "required", "options", "required_if", "visible_if", "validation", "columns", "statement", "evidence", "prefill", "min_items"];
    for (const prop of props) {
      if (JSON.stringify(old[prop] ?? null) !== JSON.stringify(field[prop] ?? null)) details.push(prop);
    }
    if (details.length) changes.push({ kind: "changed", key, label: field.label, details });
  }
  for (const [key, field] of a) if (!b.has(key)) changes.push({ kind: "removed", key, label: field.label });
  const bindingsBefore = JSON.stringify(before.bindings ?? []);
  const bindingsAfter = JSON.stringify(after.bindings ?? []);
  if (bindingsBefore !== bindingsAfter || before.layout_sha256 !== after.layout_sha256) {
    changes.push({ kind: "changed", key: "__layout__", label: "التصميم والربط", details: [before.layout_sha256 !== after.layout_sha256 ? "layout" : "bindings"] });
  }
  return changes;
}

export { INVESTIGATION_TYPES };
