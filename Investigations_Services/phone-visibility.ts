import { allFields, type TemplateDefinition } from "../Shared/templates/definition.ts";

/**
 * The customer's phone number is for administrators: they compare it when reviewing. An
 * investigator never receives it, neither as a field, nor written inside another field
 * (notes, address), nor as the form's starting value. The client's report still prints it.
 */
type Row = Record<string, unknown>;

export const HIDDEN_NUMBER = "(رقم مخفي)";

/** Arabic-Indic and Persian digits as ASCII, one character for one, so positions stay the same. */
const ascii = (value: string) =>
  value
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));

const GAP = "[ \\t\\u00a0().\\-]*";
const COUNTRY = `(?:(?:\\+|00)?${GAP}2${GAP}0${GAP})?`;
const MOBILE = `(?<!\\d)${COUNTRY}(?:0${GAP})?1${GAP}[0125](?:${GAP}\\d){8}(?!\\d)`;
const LANDLINE = "(?<!\\d)0[2-9]\\d?[ \\-]?\\d{7,8}(?!\\d)";

/** Each number in the phone box, without country code or leading zero. */
function numbersOf(phone: unknown): string[] {
  if (typeof phone !== "string") return [];
  const text = ascii(phone);
  const found = [...(text.match(new RegExp(MOBILE, "g")) ?? []), ...text.split(/[^\d+().\- \t]+/)];
  const numbers = found
    .map((part) => part.replace(/\D/g, "").replace(/^(0020|20(?=\d{9,10}$))/, "").replace(/^0/, ""))
    .filter((digits) => digits.length >= 5);
  return [...new Set(numbers)].sort((a, b) => b.length - a.length);
}

const patternOf = (digits: string) => `(?<!\\d)${COUNTRY}(?:0${GAP})?${digits.split("").join(GAP)}(?!\\d)`;

/** `value` with every match replaced; the rest keeps its own digits and spelling. */
function without(value: string, patterns: string[], replacement: string): string {
  if (!patterns.length) return value;
  let out = "";
  let at = 0;
  for (const match of ascii(value).matchAll(new RegExp(patterns.join("|"), "g"))) {
    out += value.slice(at, match.index) + replacement;
    at = match.index + match[0].length;
  }
  if (!at) return value;
  out += value.slice(at);
  return out.replace(/[ \t]{2,}/g, " ").replace(/[\s,،\-–:|/]+$/, "").trim();
}

/**
 * A case row as an investigator may see it. Works on a full row and on a list row (which
 * needs subject_phone and source selected; subject_phone is removed here).
 */
export function withoutPhone<T extends Row>(row: T): T {
  const own = numbersOf(row.subject_phone).map(patternOf);
  // A client's email often repeats numbers (a second phone, a relative's) in the text.
  const inText = row.source === "email" ? [...own, MOBILE, LANDLINE] : own;
  const out: Row = { ...row };
  delete out.subject_phone;
  const clean = (key: string, patterns: string[], replacement: string) => {
    const value = row[key];
    if (typeof value === "string") out[key] = without(value, patterns, replacement) || null;
  };
  // These two start form answers, so the number is cut out rather than replaced with a marker.
  clean("address", inText, "");
  clean("landmark", inText, "");
  clean("admin_notes", inText, HIDDEN_NUMBER);
  clean("review_note", own, HIDDEN_NUMBER);
  clean("client_reference", own, "");
  clean("subject_name", own, "");
  // The app expects text for these two.
  for (const key of ["address", "subject_name"]) if (key in row && out[key] === null) out[key] = "";
  return out as T;
}

const phoneFields = (definition: TemplateDefinition) => allFields(definition).filter((field) => field.prefill === "phone");

/**
 * Saved answers as this investigator may see them. What they typed themselves stays; a draft
 * left by the investigator before them (reassigned, excused, timed out) loses the number.
 */
export function answersFor(definition: TemplateDefinition, row: Row, userId: string): Row {
  const answers = { ...((row.answers as Row | null) ?? {}) };
  const time = (value: unknown) => (value ? new Date(value as string | Date).getTime() : 0);
  // Receiving a case sets claimed_at and updated_at together; saving moves updated_at on.
  const savedByThem =
    row.assignee_id === userId && Boolean(row.started_at || row.submitted_at) && time(row.updated_at) > time(row.claimed_at);
  if (!savedByThem) for (const field of phoneFields(definition)) delete answers[field.key];
  return answers;
}

/** The answers a report prints: a phone box the investigator left empty gets the case's number. */
export function answersForReport(definition: TemplateDefinition, row: Row): Row {
  const answers = { ...((row.answers as Row | null) ?? {}) };
  if (typeof row.subject_phone !== "string" || !row.subject_phone.trim()) return answers;
  for (const field of phoneFields(definition)) {
    if (!String(answers[field.key] ?? "").trim()) answers[field.key] = row.subject_phone.trim();
  }
  return answers;
}
