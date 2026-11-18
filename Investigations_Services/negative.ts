import { allFields, type FieldDef, type TemplateDefinition } from "../Shared/templates/definition.ts";

/**
 * A negative investigation ("استعلام سلبي") prints on the client's own form, like any other
 * report: the case's known details stay (name, address…), every other box reads
 * «لم يتم التعرف عليه» or stays unticked, and the notes say whom the investigator asked and
 * what they found. Photos of the place go in the form's first photo box.
 */

export const NOT_IDENTIFIED = "لم يتم التعرف عليه";
/** The photos of the place an investigator must take for a negative report. */
export const NEGATIVE_PHOTOS_KEY = "negative_place";

const TEXT_TYPES = new Set(["text", "textarea", "phone", "national_id"]);
const NOTES_LABEL = /ملاحظ|رأي|توصي|تعليق|notes?|remarks?|comment/i;
const UNKNOWN_OPTION = /لم يتم التعرف|غير معروف|لم يتعرف|unknown|not identified/i;

type Row = Record<string, unknown>;

/** The sentence written in the form's notes box. */
export function negativeSummary(row: Row): string {
  const asked = String(row.negative_asked ?? "").trim();
  const reasons = Array.isArray(row.negative_reasons) ? (row.negative_reasons as string[]) : [];
  const note = String(row.negative_note ?? "").trim();
  return [
    asked ? `بناءً على استعلامنا، تم سؤال: ${asked}، ولم يتم التعرف على الشخص.` : "بناءً على استعلامنا لم يتم التعرف على الشخص.",
    reasons.length ? `الأسباب: ${reasons.join("، ")}.` : "",
    note,
  ]
    .filter(Boolean)
    .join(" ");
}

/** Where the notes go: a notes-like long text box, else the last long text box. */
function notesField(fields: FieldDef[]): FieldDef | undefined {
  const long = fields.filter((field) => field.type === "textarea");
  return long.find((field) => NOTES_LABEL.test(`${field.label} ${field.key}`)) ?? long.at(-1) ??
    fields.filter((field) => field.type === "text").find((field) => NOTES_LABEL.test(`${field.label} ${field.key}`));
}

/** The case's own value for a field that starts from case data. */
function caseValue(field: FieldDef, row: Row): string | null {
  const source: Record<string, string> = {
    subject_name: "subject_name",
    phone: "subject_phone",
    address: "address",
    landmark: "landmark",
    governorate: "governorate",
    district: "district",
    local_unit: "local_unit",
    main_village: "main_village",
    sub_village: "sub_village",
    client_reference: "client_reference",
  };
  const column = field.prefill ? source[field.prefill] : undefined;
  const value = column ? row[column] : null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The answers a negative report prints on the client's form. */
export function negativeAnswers(definition: TemplateDefinition, row: Row): Record<string, unknown> {
  const fields = allFields(definition);
  const given = (row.answers ?? {}) as Record<string, unknown>;
  const notes = notesField(fields);
  const answers: Record<string, unknown> = {};
  for (const field of fields) {
    if (field === notes) {
      answers[field.key] = negativeSummary(row);
      continue;
    }
    if (field.prefill) {
      const known = (typeof given[field.key] === "string" && (given[field.key] as string).trim()) || caseValue(field, row);
      if (known) {
        answers[field.key] = known;
        continue;
      }
    }
    if (TEXT_TYPES.has(field.type)) answers[field.key] = NOT_IDENTIFIED;
    else if (field.type === "choice") {
      const unknown = field.options?.find((option) => UNKNOWN_OPTION.test(option));
      if (unknown) answers[field.key] = unknown;
    } else if (field.type === "multichoice") {
      const unknown = field.options?.find((option) => UNKNOWN_OPTION.test(option));
      if (unknown) answers[field.key] = [unknown];
    }
    // Numbers, dates, yes/no, tables and statements stay empty: nothing was confirmed.
  }
  return answers;
}

/** The form's first photo box, where the photos of the place print. */
export function firstPhotosKey(definition: TemplateDefinition): string | null {
  return allFields(definition).find((field) => field.type === "photos")?.key ?? null;
}
