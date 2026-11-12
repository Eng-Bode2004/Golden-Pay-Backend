/**
 * Builds a report from a template version: fills the client's Word layout with the case
 * and converts it to PDF. Used for real cases (Investigations service) and for previews
 * with sample data (Head Office template screens).
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { docxToPdf } from "./convert.ts";
import { allFields, type Answers, type EvidenceContext, type FieldDef, type TemplateDefinition } from "./definition.ts";
import { renderTemplate, type RenderIssue, type RenderImage } from "./render.ts";
import type { Binding } from "./scan.ts";

/**
 * A short code for the report-building code itself (this folder's sources). Cached previews
 * carry it, so after a deploy that changes how reports are drawn, previews are built afresh.
 */
export const RENDERER_VERSION: string = (() => {
  const hash = createHash("sha256");
  for (const name of readdirSync(import.meta.dir).filter((file) => /\.(ts|ps1)$/.test(file)).sort()) {
    hash.update(name).update("|").update(readFileSync(join(import.meta.dir, name))).update("|");
  }
  // The server's font stand-ins change how client layouts are drawn too.
  try {
    hash.update(readFileSync(join(import.meta.dir, "..", "..", "fonts", "30-office-substitutes.conf")));
  } catch {
    // Not in every checkout (tests run without it).
  }
  return hash.digest("hex").slice(0, 16);
})();

export interface CaseContext {
  reference?: string | null;
  subject_name?: string | null;
  subject_phone?: string | null;
  address?: string | null;
  governorate?: string | null;
  district?: string | null;
  local_unit?: string | null;
  main_village?: string | null;
  sub_village?: string | null;
  landmark?: string | null;
  client_reference?: string | null;
  client_name?: string | null;
  form_title?: string | null;
  investigator_name?: string | null;
  employee_number?: string | null;
  reviewer_name?: string | null;
  submitted_at?: Date | string | null;
  approved_at?: Date | string | null;
  submit_lat?: number | null;
  submit_lng?: number | null;
}

const CAIRO = "Africa/Cairo";
const date = (value: Date | string | null | undefined) => {
  if (!value) return null;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: CAIRO, day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(value));
  return parts;
};
const time = (value: Date | string | null | undefined) =>
  value ? new Intl.DateTimeFormat("en-GB", { timeZone: CAIRO, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)) : null;

/** Values a template may print through `case.*` bindings. Unknown values stay empty. */
export function caseValues(context: CaseContext): Record<string, string | null> {
  return {
    reference: context.reference ?? null,
    subject_name: context.subject_name ?? null,
    subject_phone: context.subject_phone ?? null,
    address: context.address ?? null,
    governorate: context.governorate ?? null,
    district: context.district ?? null,
    landmark: context.landmark ?? null,
    client_reference: context.client_reference ?? null,
    client_name: context.client_name ?? null,
    form_title: context.form_title ?? null,
    investigator_name: context.investigator_name ?? null,
    employee_number: context.employee_number ?? null,
    reviewer_name: context.reviewer_name ?? null,
    // The investigation date is when the report was sent from the field, never "today".
    report_date: date(context.submitted_at),
    report_time: time(context.submitted_at),
    approved_date: date(context.approved_at),
    gps:
      context.submit_lat !== null && context.submit_lat !== undefined && context.submit_lng !== null && context.submit_lng !== undefined
        ? `${context.submit_lat.toFixed(5)}, ${context.submit_lng.toFixed(5)}`
        : null,
  };
}

let stampBytes: Uint8Array | null = null;
/** Golden Pay's office stamp, printed only on approved reports. */
export async function goldenPayStamp(): Promise<Uint8Array> {
  stampBytes ??= new Uint8Array(await readFile(join(import.meta.dir, "assets", "golden-pay-stamp.png")));
  return stampBytes;
}

export interface DocxReport {
  docx: Uint8Array;
  pdf: Uint8Array;
  pages: number | null;
  engine: string;
  issues: RenderIssue[];
}

export async function renderDocxReport(options: {
  layout: Uint8Array;
  bindings: Binding[];
  definition: TemplateDefinition;
  answers: Answers;
  context: CaseContext;
  images: Record<string, RenderImage[]>;
  evidence: EvidenceContext;
  approved: boolean;
  preview?: "labels" | null;
  slots?: { anchor: string; kind: string }[] | null;
  /** Skips the conversion if the request that wanted it went away before its turn. */
  signal?: AbortSignal;
}): Promise<DocxReport> {
  const rendered = renderTemplate(options.layout, options.bindings, {
    definition: options.definition,
    answers: options.answers,
    caseValues: caseValues(options.context),
    images: options.images,
    stamp: options.approved ? await goldenPayStamp() : null,
    evidence: options.evidence,
    preview: options.preview ?? null,
    slots: options.slots ?? null,
  });
  const pdf = await docxToPdf(rendered.docx, options.signal);
  return { docx: rendered.docx, pdf: pdf.bytes, pages: pdf.pages, engine: pdf.engine, issues: rendered.issues };
}

// ───────────── sample data for previews ─────────────

const SAMPLE_TEXT: [RegExp, string][] = [
  [/اسم|الاسم/, "محمد أحمد عبد الله"],
  [/عنوان|العنوان/, "١٢ شارع التحرير، الدقي، الجيزة"],
  [/وظيف|المهنة/, "محاسب"],
  [/شركة|المنشأة|جهة العمل/, "شركة النيل للتجارة"],
  [/نشاط/, "تجارة أدوات منزلية"],
  [/محافظ/, "الجيزة"],
  [/ملاحظ|رأي|وصف|تفاصيل/, "نص تجريبي للمعاينة فقط."],
];

function sampleFor(field: FieldDef, index: number): unknown {
  switch (field.type) {
    case "choice":
      return field.options?.[index % Math.max(1, field.options.length)];
    case "multichoice":
      return field.options?.slice(0, 1);
    case "yesno":
      return index % 2 ? "لا" : "نعم";
    case "date":
      return "2026-01-15";
    case "time":
      return "11:30";
    case "number":
      return String((index % 9) + 1);
    case "phone":
      return "01000000000";
    case "national_id":
      return "29001010000000";
    case "attestation":
      return true;
    case "table":
      return [0, 1].map((row) =>
        Object.fromEntries((field.columns ?? []).map((column, c) => [column.key, sampleFor(column, row + c) ?? `مثال ${row + 1}`])),
      );
    case "photos":
    case "signature":
      return undefined;
    default:
      return SAMPLE_TEXT.find(([test]) => test.test(field.label))?.[1] ?? "مثال";
  }
}

/** Clearly fake answers for a preview. Never used for a real case. */
export function sampleAnswers(definition: TemplateDefinition): Answers {
  const answers: Answers = {};
  allFields(definition).forEach((field, index) => {
    const value = sampleFor(field, index);
    if (value !== undefined) answers[field.key] = value;
  });
  return answers;
}

export const SAMPLE_CONTEXT: CaseContext = {
  reference: "INV-2026-000000",
  subject_name: "محمد أحمد عبد الله (مثال)",
  subject_phone: "01000000000",
  address: "١٢ شارع التحرير، الدقي، الجيزة",
  governorate: "الجيزة",
  district: "الدقي",
  landmark: "بجوار محطة المترو",
  client_reference: "CL-0000",
  investigator_name: "مستعلم تجريبي",
  employee_number: "GP-0000",
  reviewer_name: "مراجع تجريبي",
  submitted_at: "2026-01-15T09:30:00Z",
  approved_at: "2026-01-15T12:00:00Z",
  submit_lat: 30.0384,
  submit_lng: 31.2113,
};

let samplePhoto: Uint8Array | null = null;
/** A grey placeholder picture for previews. */
export async function samplePhotoBytes(): Promise<Uint8Array> {
  samplePhoto ??= new Uint8Array(await readFile(join(import.meta.dir, "assets", "sample-photo.png")));
  return samplePhoto;
}
