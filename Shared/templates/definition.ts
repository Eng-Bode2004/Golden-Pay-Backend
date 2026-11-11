/**
 * Investigation template definitions: what the investigator fills in, which rules apply,
 * and which statements need recorded evidence. Shared by the forms service (editing and
 * versioning), the investigations service (submission checks) and the report renderer.
 */

export const FIELD_TYPES = [
  "text",
  "textarea",
  "number",
  "date",
  "time",
  "phone",
  "national_id",
  "choice",
  "multichoice",
  "yesno",
  "photos",
  "signature",
  "table",
  "attestation",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Field types whose answer is an image rather than a value in `answers`. */
export const IMAGE_TYPES: readonly FieldType[] = ["photos", "signature"];

export const CONDITION_OPS = ["eq", "neq", "in", "not_in", "filled", "empty", "gt", "lt", "contains"] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

export interface Condition {
  field: string;
  op: ConditionOp;
  value?: string | number | string[];
}
export type ConditionExpr = Condition | { all: ConditionExpr[] } | { any: ConditionExpr[] } | { not: ConditionExpr };

/** Statements that claim something happened. They print only with matching evidence. */
export const EVIDENCE_KINDS = ["visit", "interview", "document", "verification"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export type EvidenceRequirement =
  | { type: "gps"; max_meters?: number }
  | { type: "photos"; field?: string; min?: number }
  | { type: "filled"; field: string };

export interface EvidenceRule {
  kind: EvidenceKind;
  requires: EvidenceRequirement[];
}

/** Case data an investigator's field may start from, so nobody types it twice. */
export const PREFILL_SOURCES = [
  "subject_name",
  "phone",
  "address",
  "landmark",
  "governorate",
  "district",
  "local_unit",
  "main_village",
  "sub_village",
  "national_id",
  "client_reference",
] as const;
export type PrefillSource = (typeof PREFILL_SOURCES)[number];

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  required_if?: ConditionExpr;
  visible_if?: ConditionExpr;
  help?: string;
  options?: string[];
  /** A suggestion shown to the investigator. Never allowed on statements or choices. */
  default?: string;
  prefill?: PrefillSource;
  validation?: {
    min?: number;
    max?: number;
    min_length?: number;
    max_length?: number;
    pattern?: string;
    pattern_message?: string;
  };
  /** photos: how many pictures are needed or allowed. */
  min_items?: number;
  max_items?: number;
  /** table: one row per item (partners, branches, warehouses…). */
  columns?: FieldDef[];
  min_rows?: number;
  max_rows?: number;
  /** table: the library block it came from, if any. */
  block?: string;
  /** attestation: the sentence printed when the investigator confirms it with evidence. */
  statement?: string;
  evidence?: EvidenceRule;
}

export interface SectionDef {
  id: string;
  title: string;
  visible_if?: ConditionExpr;
  fields: FieldDef[];
}

export interface TemplateDefinition {
  schema: 2;
  sections: SectionDef[];
  /** Rules that apply to the whole form; the investigator sees the message. */
  rules?: { id: string; when?: ConditionExpr; require: ConditionExpr; message: string }[];
}

export class DefinitionError extends Error {
  constructor(
    message: string,
    readonly issues: { path: string; message: string }[],
  ) {
    super(message);
  }
}

const KEY = /^[a-z][a-z0-9_]{0,47}$/;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
};
const count = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 1000 ? parsed : undefined;
};

/** Keys every field in a definition uses, including table columns as `table.column`. */
export function allFields(definition: TemplateDefinition): FieldDef[] {
  return definition.sections.flatMap((section) => section.fields);
}

function conditionFields(expr: ConditionExpr | undefined, out: string[] = []): string[] {
  if (!expr) return out;
  if ("all" in expr) expr.all.forEach((item) => conditionFields(item, out));
  else if ("any" in expr) expr.any.forEach((item) => conditionFields(item, out));
  else if ("not" in expr) conditionFields(expr.not, out);
  else out.push(expr.field);
  return out;
}

function parseCondition(raw: unknown, path: string, issues: { path: string; message: string }[]): ConditionExpr | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isObject(raw)) {
    issues.push({ path, message: "Condition must be an object" });
    return undefined;
  }
  for (const group of ["all", "any"] as const) {
    if (group in raw) {
      const list = raw[group];
      if (!Array.isArray(list) || !list.length) {
        issues.push({ path, message: `"${group}" needs at least one condition` });
        return undefined;
      }
      const parsed = list
        .map((item, index) => parseCondition(item, `${path}.${group}[${index}]`, issues))
        .filter(Boolean) as ConditionExpr[];
      return group === "all" ? { all: parsed } : { any: parsed };
    }
  }
  if ("not" in raw) {
    const inner = parseCondition(raw.not, `${path}.not`, issues);
    return inner ? { not: inner } : undefined;
  }
  const field = text(raw.field, 100);
  const op = raw.op as ConditionOp;
  if (!field) issues.push({ path, message: "Condition needs a field" });
  if (!CONDITION_OPS.includes(op)) issues.push({ path, message: `Unknown condition operator: ${String(raw.op)}` });
  if (!field || !CONDITION_OPS.includes(op)) return undefined;
  const value = raw.value;
  if (!["filled", "empty"].includes(op) && (value === undefined || value === null || value === "")) {
    issues.push({ path, message: "Condition needs a value" });
  }
  const normalized =
    Array.isArray(value) ? value.map(String) : typeof value === "number" ? value : value === undefined ? undefined : String(value);
  return { field, op, ...(normalized !== undefined ? { value: normalized } : {}) };
}

function parseEvidence(raw: unknown, path: string, issues: { path: string; message: string }[]): EvidenceRule | undefined {
  if (!isObject(raw)) {
    issues.push({ path, message: "A statement needs an evidence rule" });
    return undefined;
  }
  const kind = raw.kind as EvidenceKind;
  if (!EVIDENCE_KINDS.includes(kind)) issues.push({ path: `${path}.kind`, message: "Unknown evidence kind" });
  const requires: EvidenceRequirement[] = [];
  for (const [index, item] of (Array.isArray(raw.requires) ? raw.requires : []).entries()) {
    if (!isObject(item)) continue;
    if (item.type === "gps") {
      const meters = count(item.max_meters);
      requires.push({ type: "gps", ...(meters ? { max_meters: meters } : {}) });
    } else if (item.type === "photos") {
      const field = text(item.field, 48);
      requires.push({ type: "photos", ...(field ? { field } : {}), min: Math.max(1, count(item.min) ?? 1) });
    } else if (item.type === "filled") {
      const field = text(item.field, 100);
      if (field) requires.push({ type: "filled", field });
      else issues.push({ path: `${path}.requires[${index}]`, message: "Evidence needs the field that proves it" });
    } else issues.push({ path: `${path}.requires[${index}]`, message: "Unknown evidence requirement" });
  }
  if (!requires.length) issues.push({ path, message: "A statement needs at least one piece of evidence" });
  return EVIDENCE_KINDS.includes(kind) ? { kind, requires } : undefined;
}

function parseField(
  raw: unknown,
  path: string,
  issues: { path: string; message: string }[],
  nested: boolean,
): FieldDef | null {
  if (!isObject(raw)) {
    issues.push({ path, message: "Field must be an object" });
    return null;
  }
  const key = text(raw.key, 48) ?? "";
  const label = text(raw.label, 300) ?? "";
  const type = raw.type as FieldType;
  if (!KEY.test(key)) issues.push({ path: `${path}.key`, message: `Invalid field key "${key}" (lowercase letters, digits, _)` });
  if (!label) issues.push({ path: `${path}.label`, message: "Field needs a label" });
  if (!FIELD_TYPES.includes(type)) {
    issues.push({ path: `${path}.type`, message: `Unknown field type: ${String(raw.type)}` });
    return null;
  }
  if (nested && ["table", "photos", "signature", "attestation"].includes(type)) {
    issues.push({ path, message: `A table column cannot be of type ${type}` });
  }
  const field: FieldDef = { key, label, type };
  if (raw.required === true) field.required = true;
  const requiredIf = parseCondition(raw.required_if, `${path}.required_if`, issues);
  if (requiredIf) field.required_if = requiredIf;
  const visibleIf = parseCondition(raw.visible_if, `${path}.visible_if`, issues);
  if (visibleIf) field.visible_if = visibleIf;
  const help = text(raw.help, 500);
  if (help) field.help = help;

  if (type === "choice" || type === "multichoice") {
    const options = Array.isArray(raw.options)
      ? [...new Set(raw.options.map((option) => String(option).trim()).filter(Boolean))].slice(0, 60)
      : [];
    if (options.length < 1) issues.push({ path: `${path}.options`, message: `"${label}" needs at least one option` });
    field.options = options;
  }
  const fallback = text(raw.default, 4000);
  if (fallback) {
    if (["choice", "multichoice", "yesno", "attestation", "photos", "signature", "table"].includes(type)) {
      issues.push({
        path: `${path}.default`,
        message: `"${label}" cannot have a default answer: the investigator must choose it`,
      });
    } else if (claimsAction(fallback)) {
      issues.push({
        path: `${path}.default`,
        message: `"${label}" has a default text that claims a visit, interview or check took place. Use a statement field with evidence instead.`,
      });
    } else field.default = fallback;
  }
  if (raw.prefill !== undefined && raw.prefill !== null && raw.prefill !== "") {
    if (!PREFILL_SOURCES.includes(raw.prefill as PrefillSource)) {
      issues.push({ path: `${path}.prefill`, message: `Unknown prefill source: ${String(raw.prefill)}` });
    } else field.prefill = raw.prefill as PrefillSource;
  }
  if (isObject(raw.validation)) {
    const v = raw.validation;
    const validation: NonNullable<FieldDef["validation"]> = {};
    for (const name of ["min", "max"] as const) {
      if (v[name] !== undefined && v[name] !== null && v[name] !== "") {
        const parsed = Number(v[name]);
        if (Number.isFinite(parsed)) validation[name] = parsed;
        else issues.push({ path: `${path}.validation.${name}`, message: `${name} must be a number` });
      }
    }
    for (const name of ["min_length", "max_length"] as const) {
      const parsed = count(v[name]);
      if (parsed !== undefined) validation[name] = parsed;
    }
    const pattern = text(v.pattern, 200);
    if (pattern) {
      try {
        new RegExp(pattern, "u");
        validation.pattern = pattern;
        const message = text(v.pattern_message, 200);
        if (message) validation.pattern_message = message;
      } catch {
        issues.push({ path: `${path}.validation.pattern`, message: "Invalid pattern" });
      }
    }
    if (Object.keys(validation).length) field.validation = validation;
  }
  if (type === "photos") {
    const min = count(raw.min_items);
    const max = count(raw.max_items);
    if (min !== undefined) field.min_items = min;
    if (max !== undefined) field.max_items = max;
    if (min !== undefined && max !== undefined && min > max) {
      issues.push({ path, message: `"${label}": the minimum number of photos is above the maximum` });
    }
  }
  if (type === "table") {
    const columns = (Array.isArray(raw.columns) ? raw.columns : [])
      .map((column, index) => parseField(column, `${path}.columns[${index}]`, issues, true))
      .filter(Boolean) as FieldDef[];
    if (!columns.length) issues.push({ path: `${path}.columns`, message: `Table "${label}" needs at least one column` });
    const seen = new Set<string>();
    for (const column of columns) {
      if (seen.has(column.key)) issues.push({ path, message: `Table "${label}" repeats column ${column.key}` });
      seen.add(column.key);
    }
    field.columns = columns;
    const minRows = count(raw.min_rows);
    const maxRows = count(raw.max_rows);
    if (minRows !== undefined) field.min_rows = minRows;
    if (maxRows !== undefined) field.max_rows = maxRows;
    const block = text(raw.block, 40);
    if (block) field.block = block;
  }
  if (type === "attestation") {
    const statement = text(raw.statement, 2000);
    if (!statement) issues.push({ path: `${path}.statement`, message: `Statement "${label}" needs its sentence` });
    else field.statement = statement;
    const evidence = parseEvidence(raw.evidence, `${path}.evidence`, issues);
    if (evidence) field.evidence = evidence;
  }
  return field;
}

/** Validates and normalizes a definition. Throws DefinitionError listing every problem. */
export function parseDefinition(raw: unknown): TemplateDefinition {
  const issues: { path: string; message: string }[] = [];
  const sectionsRaw = isObject(raw) && Array.isArray(raw.sections) ? raw.sections : Array.isArray(raw) ? raw : null;
  if (!sectionsRaw || !sectionsRaw.length) throw new DefinitionError("A form needs at least one section", [{ path: "sections", message: "A form needs at least one section" }]);

  const sectionIds = new Set<string>();
  const sections: SectionDef[] = sectionsRaw.map((rawSection, s) => {
    const section = isObject(rawSection) ? rawSection : {};
    const title = text(section.title, 160) ?? "";
    if (!title) issues.push({ path: `sections[${s}].title`, message: "Section needs a title" });
    let id = text(section.id, 48) ?? `s${s + 1}`;
    if (!KEY.test(id) || sectionIds.has(id)) id = `s${s + 1}_${sectionIds.size}`;
    sectionIds.add(id);
    const fields = (Array.isArray(section.fields) ? section.fields : [])
      .map((field, f) => parseField(field, `sections[${s}].fields[${f}]`, issues, false))
      .filter(Boolean) as FieldDef[];
    const visibleIf = parseCondition(section.visible_if, `sections[${s}].visible_if`, issues);
    return { id, title, ...(visibleIf ? { visible_if: visibleIf } : {}), fields };
  });

  const definition: TemplateDefinition = { schema: 2, sections };
  const keys = new Map<string, FieldDef>();
  for (const field of allFields(definition)) {
    if (keys.has(field.key)) issues.push({ path: field.key, message: `Duplicate field key: ${field.key}` });
    keys.set(field.key, field);
  }
  if (!keys.size) issues.push({ path: "sections", message: "A form needs at least one field" });

  const known = (ref: string) => {
    const [table, column] = ref.split(".");
    const field = keys.get(table ?? "");
    if (!field) return false;
    return column === undefined || Boolean(field.columns?.some((item) => item.key === column));
  };
  for (const field of keys.values()) {
    for (const ref of [...conditionFields(field.visible_if), ...conditionFields(field.required_if)]) {
      if (!known(ref)) issues.push({ path: field.key, message: `"${field.label}" depends on an unknown field: ${ref}` });
      if (ref === field.key) issues.push({ path: field.key, message: `"${field.label}" cannot depend on itself` });
    }
    for (const need of field.evidence?.requires ?? []) {
      if (need.type === "filled" && !known(need.field)) {
        issues.push({ path: field.key, message: `Statement "${field.label}" relies on an unknown field: ${need.field}` });
      }
      if (need.type === "photos" && need.field && keys.get(need.field)?.type !== "photos") {
        issues.push({ path: field.key, message: `Statement "${field.label}" relies on a photo field that does not exist: ${need.field}` });
      }
    }
  }
  for (const section of sections) {
    for (const ref of conditionFields(section.visible_if)) {
      if (!known(ref)) issues.push({ path: section.id, message: `Section "${section.title}" depends on an unknown field: ${ref}` });
    }
  }
  if (isObject(raw) && Array.isArray(raw.rules)) {
    definition.rules = raw.rules.flatMap((rule, index) => {
      if (!isObject(rule)) return [];
      const require = parseCondition(rule.require, `rules[${index}].require`, issues);
      const when = parseCondition(rule.when, `rules[${index}].when`, issues);
      const message = text(rule.message, 300);
      if (!require || !message) {
        issues.push({ path: `rules[${index}]`, message: "A rule needs a requirement and a message" });
        return [];
      }
      return [{ id: text(rule.id, 48) ?? `r${index + 1}`, ...(when ? { when } : {}), require, message }];
    });
  }
  if (issues.length) throw new DefinitionError(issues[0]!.message, issues);
  return definition;
}

/** Old definitions are a plain list of sections with the original seven field types. */
export function upgradeLegacy(sections: unknown): TemplateDefinition {
  const list = Array.isArray(sections) ? sections : [];
  const definition = {
    schema: 2,
    sections: list.map((section: Record<string, unknown>, index) => ({
      id: `s${index + 1}`,
      title: section.title,
      fields: (Array.isArray(section.fields) ? section.fields : []).map((field: Record<string, unknown>) => {
        const { default: fallback, ...rest } = field;
        // A pre-filled declaration with blanks ("أقر أنا …… بأنه…") becomes a statement the
        // investigator completes in place and confirms, instead of an empty text box.
        if (typeof fallback === "string" && isDeclaration(fallback)) {
          return {
            ...rest,
            key: legacyKey(String(field.key)),
            type: "attestation",
            options: undefined,
            statement: fallback.replace(/\s+/g, " ").trim(),
            evidence: defaultEvidence(evidenceKindFor(fallback)),
          };
        }
        // Old seeds pre-filled some "we visited…" sentences; those become blank answers.
        const keep = typeof fallback === "string" && !claimsAction(fallback) && !["choice", "yesno"].includes(String(field.type));
        // A list question saved without options can only be answered as text.
        const noOptions =
          field.type === "choice" && !(Array.isArray(field.options) && field.options.some((option) => String(option).trim()));
        return {
          ...rest,
          key: legacyKey(String(field.key)),
          ...(noOptions ? { type: "text", options: undefined } : {}),
          ...(keep ? { default: fallback } : {}),
        };
      }),
    })),
  };
  return parseDefinition(definition);
}

/** "أقر / نقر / أتعهد …" with at least one blank to fill. */
export function isDeclaration(text: string): boolean {
  return /^\s*(أقر|اقر|إقرار|اقرار|نقر|أتعهد|اتعهد|أشهد|اشهد)/.test(text) && statementBlanks(text) > 0;
}

/** Legacy keys were sometimes camel or mixed case; v2 keys are lowercase. */
export function legacyKey(key: string): string {
  const cleaned = key.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^[^a-z]+/, "");
  return (cleaned || `f_${key}`).slice(0, 48);
}

// Sentences that say an action took place: "تم مقابلة", "تمت الزيارة", "تم الاطلاع"...
const CLAIM = /(?<![\u0600-\u06FF])(تم|تمت|قمت|قمنا|قام|أقر|اقر)\s*(ت?ال?)?(مقابل|زيار|الزيار|الاطلاع|اطلاع|الإطلاع|التأكد|التاكد|التحقق|معاين|الاتصال|سؤال|بسؤال|الوصول|المرور)|(?<![\u0600-\u06FF])(بالوصول|بسؤال|بسـؤال)|(?<![\u0600-\u06FF])تمت\s+زيارة|قد\s+تمت/;
export function claimsAction(value: string): boolean {
  const sentence = value.replace(/\s+/g, " ").trim();
  // Questions ("هل تم الاطلاع…؟") and labels ("اسم من تمت مقابلته") ask; they do not claim.
  if (/^هل\s|[؟?]\s*(نعم|لا)?\s*(نعم|لا)?\s*$/.test(sentence)) return false;
  if (/(الذي|التي|الذين|من)\s+(تم|تمت)\s/.test(sentence) && sentence.length < 90) return false;
  return CLAIM.test(sentence);
}

/** Guesses the evidence a sentence needs from its wording. */
export function evidenceKindFor(sentence: string): EvidenceKind {
  if (/مقابل|سؤال|بسؤال|بسـؤال|تعرف|أفاد|افاد|حديث/.test(sentence)) return "interview";
  if (/الاطلاع|اطلاع|الإطلاع|مستند|بطاقة|سجل|عقد|إيصال|ايصال/.test(sentence)) return "document";
  if (/التأكد|التاكد|التحقق|الاتصال|مراجعة/.test(sentence)) return "verification";
  return "visit";
}

// ───────────────────────── evaluation ─────────────────────────

export type Answers = Record<string, unknown>;

export function isFilled(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "boolean") return true;
  return true;
}

function lookup(answers: Answers, ref: string, row?: Record<string, unknown>): unknown {
  const [head, column] = ref.split(".");
  if (column !== undefined) {
    const rows = answers[head ?? ""];
    return Array.isArray(rows) ? rows.map((item) => (isObject(item) ? item[column] : undefined)) : undefined;
  }
  if (row && head && head in row) return row[head];
  return answers[head ?? ""];
}

export function evaluate(expr: ConditionExpr | undefined, answers: Answers, row?: Record<string, unknown>): boolean {
  if (!expr) return true;
  if ("all" in expr) return expr.all.every((item) => evaluate(item, answers, row));
  if ("any" in expr) return expr.any.some((item) => evaluate(item, answers, row));
  if ("not" in expr) return !evaluate(expr.not, answers, row);
  const actual = lookup(answers, expr.field, row);
  const values = Array.isArray(actual) ? actual.map(String) : isFilled(actual) ? [String(actual)] : [];
  const expected = Array.isArray(expr.value) ? expr.value.map(String) : expr.value === undefined ? [] : [String(expr.value)];
  switch (expr.op) {
    case "filled":
      return values.some((value) => value.trim() !== "");
    case "empty":
      return !values.some((value) => value.trim() !== "");
    case "eq":
      return values.some((value) => value === expected[0]);
    case "neq":
      return !values.some((value) => value === expected[0]);
    case "in":
      return values.some((value) => expected.includes(value));
    case "not_in":
      return !values.some((value) => expected.includes(value));
    case "contains":
      return values.some((value) => value.includes(expected[0] ?? ""));
    case "gt":
      return values.some((value) => Number(value) > Number(expected[0]));
    case "lt":
      return values.some((value) => Number(value) < Number(expected[0]));
  }
}

export function sectionVisible(section: SectionDef, answers: Answers): boolean {
  return evaluate(section.visible_if, answers);
}

/** Fields the investigator can currently see, given the answers so far. */
export function visibleFields(definition: TemplateDefinition, answers: Answers): FieldDef[] {
  return definition.sections
    .filter((section) => sectionVisible(section, answers))
    .flatMap((section) => section.fields.filter((field) => evaluate(field.visible_if, answers)));
}

export function isRequired(field: FieldDef, answers: Answers, row?: Record<string, unknown>): boolean {
  return field.required === true || (field.required_if !== undefined && evaluate(field.required_if, answers, row));
}

// ───────────────────────── evidence ─────────────────────────

export interface EvidenceContext {
  /** Photos uploaded per field key. */
  photos: Record<string, number>;
  /** GPS fixes recorded while working on the case. */
  locations: { kind: string; lat: number; lng: number }[];
  /** Where the case address is, if the administrator placed it on the map. */
  target?: { lat: number; lng: number } | null;
}

export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/** Why a statement is not supported by what was recorded; empty when it is. */
export function missingEvidence(field: FieldDef, answers: Answers, context: EvidenceContext): string[] {
  const missing: string[] = [];
  for (const need of field.evidence?.requires ?? []) {
    if (need.type === "gps") {
      const onSite = context.locations.filter((point) => point.kind !== "accepted");
      if (!onSite.length) missing.push("لا يوجد موقع GPS مسجّل أثناء العمل على الحالة");
      else if (need.max_meters && context.target) {
        const nearest = Math.min(...onSite.map((point) => distanceMeters(point, context.target!)));
        if (nearest > need.max_meters) {
          missing.push(`أقرب موقع مسجّل يبعد ${Math.round(nearest)} م عن العنوان (الحد ${need.max_meters} م)`);
        }
      }
    } else if (need.type === "photos") {
      const total = need.field
        ? (context.photos[need.field] ?? 0)
        : Object.values(context.photos).reduce((sum, value) => sum + value, 0);
      if (total < (need.min ?? 1)) missing.push(`مطلوب ${need.min ?? 1} صورة على الأقل${need.field ? ` في «${need.field}»` : ""}`);
    } else if (need.type === "filled") {
      if (!isFilled(lookup(answers, need.field))) missing.push(`الحقل «${need.field}» فارغ`);
    }
  }
  return missing;
}

/** Default evidence for a statement of each kind. */
export function defaultEvidence(kind: EvidenceKind): EvidenceRule {
  switch (kind) {
    case "visit":
      return { kind, requires: [{ type: "gps", max_meters: 1000 }, { type: "photos", min: 1 }] };
    case "interview":
      return { kind, requires: [{ type: "gps" }] };
    case "document":
      return { kind, requires: [{ type: "photos", min: 1 }] };
    case "verification":
      return { kind, requires: [{ type: "gps" }] };
  }
}

// ───────────────────────── answer validation ─────────────────────────

export interface Issue {
  key: string;
  label: string;
  message: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;

function checkValue(field: FieldDef, value: unknown, label: string): string | null {
  if (!isFilled(value)) return null;
  const textValue = Array.isArray(value) ? "" : String(value).trim();
  switch (field.type) {
    case "number": {
      const parsed = Number(textValue.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))));
      if (!Number.isFinite(parsed)) return `«${label}» يجب أن يكون رقمًا`;
      if (field.validation?.min !== undefined && parsed < field.validation.min) return `«${label}» أقل من ${field.validation.min}`;
      if (field.validation?.max !== undefined && parsed > field.validation.max) return `«${label}» أكبر من ${field.validation.max}`;
      break;
    }
    case "date":
      if (!DATE.test(textValue) || Number.isNaN(new Date(textValue).getTime())) return `«${label}» تاريخ غير صحيح`;
      break;
    case "time":
      if (!TIME.test(textValue)) return `«${label}» وقت غير صحيح`;
      break;
    case "national_id":
      if (!/^[23]\d{13}$/.test(textValue.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))))) {
        return `«${label}» يجب أن يكون 14 رقمًا`;
      }
      break;
    case "phone":
      if (!/^\+?[0-9٠-٩][0-9٠-٩ -]{5,18}$/.test(textValue)) return `«${label}» رقم هاتف غير صحيح`;
      break;
    case "choice":
    case "yesno": {
      const options = field.type === "yesno" ? ["نعم", "لا"] : (field.options ?? []);
      if (!options.includes(textValue)) return `«${label}» اختيار غير موجود في القائمة`;
      break;
    }
    case "multichoice": {
      const list = Array.isArray(value) ? value.map(String) : [textValue];
      const unknown = list.filter((item) => !(field.options ?? []).includes(item));
      if (unknown.length) return `«${label}» يحتوي اختيارًا غير موجود: ${unknown.join("، ")}`;
      break;
    }
    case "attestation":
      if (value !== true && value !== "true" && value !== "نعم") return `«${label}» قيمة غير صحيحة`;
      break;
  }
  const v = field.validation;
  if (v && typeof value === "string") {
    if (v.min_length !== undefined && textValue.length < v.min_length) return `«${label}» أقصر من ${v.min_length} حرفًا`;
    if (v.max_length !== undefined && textValue.length > v.max_length) return `«${label}» أطول من ${v.max_length} حرفًا`;
    if (v.pattern && !new RegExp(v.pattern, "u").test(textValue)) return v.pattern_message ?? `«${label}» بصيغة غير صحيحة`;
  }
  return null;
}

/**
 * Everything wrong with a set of answers: missing required values, invalid values,
 * statements without evidence and failed form rules. Hidden fields are ignored.
 */
export function validateAnswers(definition: TemplateDefinition, answers: Answers, context: EvidenceContext): Issue[] {
  const issues: Issue[] = [];
  for (const field of visibleFields(definition, answers)) {
    const value = answers[field.key];
    const required = isRequired(field, answers);
    if (field.type === "photos" || field.type === "signature") {
      const total = context.photos[field.key] ?? 0;
      const min = field.type === "photos" ? Math.max(field.min_items ?? 0, required ? 1 : 0) : required ? 1 : 0;
      if (total < min) {
        issues.push({
          key: field.key,
          label: field.label,
          message: field.type === "signature" ? `«${field.label}» يحتاج توقيعًا` : `«${field.label}» يحتاج ${min} صورة على الأقل`,
        });
      }
      if (field.type === "photos" && field.max_items !== undefined && total > field.max_items) {
        issues.push({ key: field.key, label: field.label, message: `«${field.label}» يسمح بـ ${field.max_items} صور فقط` });
      }
      continue;
    }
    if (field.type === "table") {
      const rows = Array.isArray(value) ? value.filter(isObject) : [];
      const min = Math.max(field.min_rows ?? 0, required ? 1 : 0);
      if (rows.length < min) issues.push({ key: field.key, label: field.label, message: `«${field.label}» يحتاج ${min} صف على الأقل` });
      if (field.max_rows !== undefined && rows.length > field.max_rows) {
        issues.push({ key: field.key, label: field.label, message: `«${field.label}» يسمح بـ ${field.max_rows} صفوف فقط` });
      }
      rows.forEach((row, index) => {
        for (const column of field.columns ?? []) {
          if (!evaluate(column.visible_if, answers, row)) continue;
          const label = `${field.label} (${index + 1}) — ${column.label}`;
          if (isRequired(column, answers, row) && !isFilled(row[column.key])) {
            issues.push({ key: `${field.key}.${column.key}`, label, message: `«${label}» مطلوب` });
          }
          const problem = checkValue(column, row[column.key], label);
          if (problem) issues.push({ key: `${field.key}.${column.key}`, label, message: problem });
        }
      });
      continue;
    }
    if (field.type === "attestation") {
      const confirmed = value === true || value === "true" || value === "نعم";
      if (required && !confirmed) issues.push({ key: field.key, label: field.label, message: `«${field.label}» مطلوب` });
      const blanks = statementBlanks(field.statement);
      const edited = editedStatement(field, answers);
      if (confirmed && edited) {
        // A rewritten sentence must not keep any dots or brackets waiting to be filled.
        if (UNFILLED.test(edited)) {
          issues.push({ key: field.key, label: field.label, message: `أكمل الفراغات في «${field.label}» قبل تأكيده` });
        }
      } else if (confirmed && blanks) {
        const typed = answers[blanksKey(field.key)];
        const filled = Array.isArray(typed) ? typed.filter((item) => String(item ?? "").trim()).length : 0;
        if (filled < blanks) {
          issues.push({ key: field.key, label: field.label, message: `أكمل الفراغات في «${field.label}» قبل تأكيده` });
        }
      }
      if (confirmed) {
        const gaps = missingEvidence(field, answers, context);
        if (gaps.length) {
          issues.push({
            key: field.key,
            label: field.label,
            message: `لا يمكن تأكيد «${field.label}» دون دليل: ${gaps.join("؛ ")}`,
          });
        }
      }
      continue;
    }
    if (required && !isFilled(value)) {
      issues.push({ key: field.key, label: field.label, message: `«${field.label}» مطلوب` });
      continue;
    }
    const problem = checkValue(field, value, field.label);
    if (problem) issues.push({ key: field.key, label: field.label, message: problem });
  }
  for (const rule of definition.rules ?? []) {
    if (evaluate(rule.when, answers) && !evaluate(rule.require, answers)) {
      issues.push({ key: rule.id, label: rule.id, message: rule.message });
    }
  }
  return issues;
}

/** Drops answers for unknown or hidden fields, so stale values never reach a report. */
export function cleanAnswers(definition: TemplateDefinition, answers: Answers): Answers {
  const visible = new Map(visibleFields(definition, answers).map((field) => [field.key, field]));
  const output: Answers = {};
  for (const [key, value] of Object.entries(answers)) {
    if (key.endsWith("__text")) {
      // A statement the investigator rewrote travels with that statement.
      const owner = visible.get(key.slice(0, -"__text".length));
      if (owner?.type === "attestation" && typeof value === "string" && value.trim()) output[key] = value.trim().slice(0, 2000);
      continue;
    }
    if (key.endsWith("__blanks")) {
      // Words typed into a statement's blanks travel with that statement.
      const owner = visible.get(key.slice(0, -"__blanks".length));
      if (owner?.type === "attestation" && Array.isArray(value)) {
        output[key] = value.slice(0, statementBlanks(owner.statement)).map((item) => String(item ?? "").trim().slice(0, 300));
      }
      continue;
    }
    const field = visible.get(key);
    if (!field || IMAGE_TYPES.includes(field.type)) continue;
    if (field.type === "table") {
      output[key] = (Array.isArray(value) ? value : []).filter(isObject).map((row) =>
        Object.fromEntries(
          (field.columns ?? [])
            .filter((column) => isFilled(row[column.key]) && evaluate(column.visible_if, answers, row))
            .map((column) => [column.key, typeof row[column.key] === "string" ? (row[column.key] as string).trim() : row[column.key]]),
        ),
      );
    } else if (field.type === "attestation") {
      if (value === true || value === "true" || value === "نعم") output[key] = true;
    } else if (field.type === "multichoice") {
      const list = (Array.isArray(value) ? value : [value]).map(String).filter((item) => item.trim());
      if (list.length) output[key] = list;
    } else if (isFilled(value)) output[key] = typeof value === "string" ? value.trim() : value;
  }
  return output;
}

// ───────────────────────── statement blanks ─────────────────────────

/**
 * Gaps the investigator fills inside a statement, in reading order: runs of dots (….. or
 * ......), underscores, tatweel (ـــــ) or dashes (-----), empty brackets "( )", the name
 * after a title ("السيد/ ", "السيدة/ "…) when nothing follows it, and a colon that ends the
 * sentence ("تمت مقابلة كل من :"). The mobile app uses the same pattern.
 */
const BLANK = /\.{3,}|…+|_{3,}|ـ{3,}|-{4,}|\(\s*\)|(?<=(?:السيد|السيدة|الأستاذ|الاستاذ|الأستاذة|المهندس|الدكتور|السادة)\/)\s*(?=\/|\)|$)|[:：]\s*$/g;
/** What still marks a blank in a sentence the investigator rewrote. */
const UNFILLED = /\.{3,}|…+|_{3,}|ـ{3,}|\(\s*\)/;

/** Answers key holding the whole sentence when the investigator rewrote it. */
export const statementTextKey = (key: string) => `${key}__text`;

/** The sentence the investigator wrote for a statement, if they rewrote it. */
export function editedStatement(field: FieldDef, answers: Answers): string | null {
  const value = answers[statementTextKey(field.key)];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Answers key holding the words typed into a statement's blanks. */
export const blanksKey = (key: string) => `${key}__blanks`;

export function statementBlanks(statement: string | undefined): number {
  return statement ? (statement.match(BLANK) ?? []).length : 0;
}

/** The sentence split around its blanks: text, blank, text, blank, … text. */
export function statementParts(statement: string): string[] {
  return statement.split(BLANK);
}

/** The statement with every filled blank replaced by what was typed; unfilled blanks stay. */
export function fillStatement(statement: string, values: unknown): string {
  const list = Array.isArray(values) ? values.map((item) => String(item ?? "").trim()) : [];
  let index = 0;
  return statement.replace(BLANK, (blank) => {
    const value = list[index++];
    if (!value) return blank;
    if (blank.startsWith("(")) return `(${value})`;
    if (/^[:：]/.test(blank)) return `: ${value}`;
    // A name after "السيد/": keep a space before what follows it.
    if (!blank.trim() && blank.length < 3) return `${value} `;
    return value;
  });
}

/**
 * What a confirmed statement says: the sentence the investigator rewrote, else the
 * statement with their words in its blanks.
 */
export function statementText(field: FieldDef, answers: Answers): string {
  const edited = editedStatement(field, answers);
  if (edited) return edited;
  const sentence = field.statement?.trim() || field.label;
  return fillStatement(sentence, answers[blanksKey(field.key)]).replace(/\s+\)/g, ")").replace(/[ \t]{2,}/g, " ");
}

// ───────────────────────── reusable blocks ─────────────────────────

const col = (key: string, label: string, type: FieldType = "text", extra: Partial<FieldDef> = {}): FieldDef => ({
  key,
  label,
  type,
  ...extra,
});

/** Repeating tables that many client forms share. */
export const BLOCKS: Record<string, { label: string; field: Omit<FieldDef, "key"> }> = {
  partners: {
    label: "الشركاء",
    field: {
      label: "الشركاء",
      type: "table",
      block: "partners",
      columns: [
        col("name", "اسم الشريك", "text", { required: true }),
        col("national_id", "الرقم القومي", "national_id"),
        col("share", "نسبة المشاركة %", "number", { validation: { min: 0, max: 100 } }),
        col("role", "الصفة"),
        col("phone", "رقم الهاتف", "phone"),
      ],
    },
  },
  board_members: {
    label: "أعضاء مجلس الإدارة",
    field: {
      label: "أعضاء مجلس الإدارة",
      type: "table",
      block: "board_members",
      columns: [
        col("name", "الاسم", "text", { required: true }),
        col("position", "المنصب", "text", { required: true }),
        col("national_id", "الرقم القومي", "national_id"),
        col("nationality", "الجنسية"),
      ],
    },
  },
  branches: {
    label: "الفروع",
    field: {
      label: "الفروع",
      type: "table",
      block: "branches",
      columns: [
        col("name", "اسم الفرع"),
        col("address", "العنوان", "text", { required: true }),
        col("ownership", "نوع الحيازة", "choice", { options: ["تمليك", "إيجار", "أخرى"] }),
        col("employees", "عدد العاملين", "number", { validation: { min: 0 } }),
      ],
    },
  },
  sales_outlets: {
    label: "منافذ البيع",
    field: {
      label: "منافذ البيع",
      type: "table",
      block: "sales_outlets",
      columns: [
        col("name", "اسم المنفذ"),
        col("address", "العنوان", "text", { required: true }),
        col("area_m2", "المساحة م²", "number", { validation: { min: 0 } }),
        col("ownership", "نوع الحيازة", "choice", { options: ["تمليك", "إيجار", "أخرى"] }),
      ],
    },
  },
  warehouses: {
    label: "المخازن",
    field: {
      label: "المخازن",
      type: "table",
      block: "warehouses",
      columns: [
        col("address", "العنوان", "text", { required: true }),
        col("area_m2", "المساحة م²", "number", { validation: { min: 0 } }),
        col("ownership", "نوع الحيازة", "choice", { options: ["تمليك", "إيجار", "أخرى"] }),
        col("stock", "حجم البضاعة", "choice", { options: ["كبير", "متوسط", "ضعيف"] }),
      ],
    },
  },
  verification_sources: {
    label: "مصادر التحقق",
    field: {
      label: "مصادر التحقق",
      type: "table",
      block: "verification_sources",
      columns: [
        col("source", "المصدر", "choice", {
          required: true,
          options: ["حارس العقار", "الجيران", "صاحب محل مجاور", "زميل عمل", "شؤون العاملين", "العميل نفسه", "أخرى"],
        }),
        col("name", "الاسم"),
        col("relation", "الصلة بالعميل"),
        col("phone", "رقم الهاتف", "phone"),
        col("result", "النتيجة", "textarea", { required: true }),
      ],
    },
  },
  references: {
    label: "الأشخاص المرجعيون",
    field: {
      label: "الأشخاص المرجعيون",
      type: "table",
      block: "references",
      columns: [
        col("name", "الاسم", "text", { required: true }),
        col("relation", "صلة القرابة"),
        col("phone", "رقم الهاتف", "phone"),
        col("address", "العنوان"),
      ],
    },
  },
};
