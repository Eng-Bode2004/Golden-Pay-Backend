import { detectKind, findNationalId, isNationalId, normalizeMobile, normalizeText, type CaseKind } from "./rules.ts";

/**
 * Case lists that arrive as tables (Excel files, HTML tables in the email): every row with a
 * name is a person to investigate. Columns are found by their header words, so a client can
 * reorder or rename columns without breaking anything; a header the reader does not know is
 * kept in the notes.
 */
export interface ExtractedCase {
  subject_name: string | null;
  national_id: string | null;
  phone: string | null;
  home_address: string | null;
  work_address: string | null;
  company: string | null;
  governorate: string | null;
  district: string | null;
  kind: CaseKind | null;
  fast: boolean;
  client_reference: string | null;
  notes: string | null;
  confidence: number;
  doubts: string[];
}

export type Field =
  | "subject_name"
  | "national_id"
  | "phone"
  | "home_address"
  | "work_address"
  | "company"
  | "governorate"
  | "district"
  | "kind"
  | "client_reference"
  | "notes";

/** Header words per field, most specific first. Checked against the normalised header. */
const HEADERS: [Field, string[]][] = [
  ["work_address", ["business address", "work address", "عنوان العمل", "عنوان جهه العمل", "عنوان الشركه", "company address"]],
  ["home_address", ["home address", "inqury address", "inquiry address", "عنوان السكن", "محل الاقامه", "العنوان", "address", "عنوان", "home"]],
  ["national_id", ["national id", "id number", "nid", "رقم قومي", "الرقم القومي", "الرقم القومى", "بطاقه"]],
  ["company", ["company name", "comapnay name", "employer name", "employer", "اسم جهه العمل", "جهه العمل", "الوظيفه", "job"]],
  ["subject_name", ["client`s name", "client's name", "customer full name", "customer name", "client name", "اسم العميل", "اسم صاحب الطلب", "الاسم", "name"]],
  ["phone", ["mobile", "phone", "client number","رقم الهاتف", "الموبايل", "الموبيل", "تليفون", "هاتف", "تلفون"]],
  ["governorate", ["governorate", "governate", "المحافظه", "محافظه"]],
  ["district", ["district", "area", "المركز", "الحي", "المنطقه"]],
  ["kind", ["verification required", "verification type", "type of investigation", "نوع الاستعلام", "investigation type"]],
  ["client_reference", ["application number", "code", "cid", "reference", "رقم الطلب", "الكود", "كود"]],
  ["notes", ["notes", "ملاحظات", "landmark", "علامه مميزه"]],
];

/** Columns about a partner or guarantor, never the applicant. */
const SKIP_HEADER = /شريك|partner|ضامن|guarantor|مرجعي|reference person|credit analyst|sales|branch|department|card limit|serial|^ser$|^sr$|date|تاريخ|فرع/;

export function fieldOfHeader(header: string): Field | null {
  const h = normalizeText(header);
  if (!h || SKIP_HEADER.test(h)) return null;
  for (const [field, words] of HEADERS) {
    if (words.some((word) => h.includes(normalizeText(word)))) return field;
  }
  return null;
}

function emptyCase(): ExtractedCase {
  return {
    subject_name: null,
    national_id: null,
    phone: null,
    home_address: null,
    work_address: null,
    company: null,
    governorate: null,
    district: null,
    kind: null,
    fast: false,
    client_reference: null,
    notes: null,
    confidence: 1,
    doubts: [],
  };
}

const clean = (value: string | undefined) => {
  const v = (value ?? "").replace(/\s+/g, " ").trim();
  return v && !/^(لا يوجد|none|n\/a|-|—|0)$/i.test(v) ? v : null;
};

/** «Governate : القاهرة , Area : حي حلوان , Street : …» (one client's export) into its parts. */
export function splitLabelledAddress(value: string): { governorate?: string; district?: string; rest: string } {
  const parts = value.split(/\s*,\s*/);
  const out: { governorate?: string; district?: string; rest: string } = { rest: value };
  const rest: string[] = [];
  for (const part of parts) {
    const m = /^\s*(governate|governorate|area|district|المحافظه|المحافظة|المنطقة|المنطقه)\s*:\s*(.*)$/i.exec(part);
    if (!m) {
      rest.push(part.replace(/^\s*\w+\s*:\s*/, ""));
      continue;
    }
    const label = normalizeText(m[1]!);
    const v = (m[2] ?? "").trim();
    if (!v) continue;
    if (/govern|محافظ/.test(label)) out.governorate = v;
    else out.district = v;
  }
  if (out.governorate || out.district) out.rest = [out.district, ...rest.filter(Boolean)].filter(Boolean).join(" - ");
  return out;
}

function finish(item: ExtractedCase, extras: string[]): ExtractedCase {
  if (item.national_id) {
    const nid = findNationalId(item.national_id);
    if (nid) item.national_id = nid;
    else {
      item.doubts.push("الرقم القومي غير صحيح");
      item.national_id = normalizeText(item.national_id).replace(/\D/g, "") || null;
    }
  }
  if (item.phone) item.phone = normalizeMobile(item.phone) ?? item.phone;
  for (const key of ["home_address", "work_address"] as const) {
    const value = item[key];
    if (value && /:\s*\S/.test(value)) {
      const split = splitLabelledAddress(value);
      item.governorate ??= split.governorate ?? null;
      item.district ??= split.district ?? null;
      item[key] = split.rest;
    }
  }
  if (extras.length) item.notes = [item.notes, ...extras].filter(Boolean).join(" | ");
  if (!item.subject_name) item.doubts.push("لا يوجد اسم");
  if (!item.home_address && !item.work_address) item.doubts.push("لا يوجد عنوان");
  item.confidence = item.doubts.length ? 0.5 : 1;
  return item;
}

/** A table whose first matching row is a header: one case per later row with a name. */
function fromHeaderRow(rows: string[][]): ExtractedCase[] | null {
  for (let h = 0; h < Math.min(rows.length, 12); h += 1) {
    const header = rows[h] ?? [];
    const columns = new Map<number, Field>();
    const taken = new Set<Field>();
    header.forEach((cell, index) => {
      const field = fieldOfHeader(cell);
      if (field && !taken.has(field)) {
        columns.set(index, field);
        taken.add(field);
      }
    });
    if (!taken.has("subject_name") || columns.size < 2) continue;
    const cases: ExtractedCase[] = [];
    for (const row of rows.slice(h + 1)) {
      const item = emptyCase();
      const extras: string[] = [];
      for (const [index, field] of columns) {
        const value = clean(row[index]);
        if (!value) continue;
        if (field === "kind") item.kind = detectKind(value);
        else if (field === "notes") item.notes = item.notes ? `${item.notes} | ${value}` : value;
        else (item as unknown as Record<string, string | null>)[field] = value;
      }
      // Columns the reader does not know still reach the investigator.
      row.forEach((cell, index) => {
        const value = clean(cell);
        const label = clean(header[index]);
        if (value && label && !columns.has(index) && !SKIP_HEADER.test(normalizeText(label))) extras.push(`${label}: ${value}`);
      });
      if (!item.subject_name || /^\d+$/.test(item.subject_name)) continue;
      cases.push(finish(item, extras));
    }
    return cases;
  }
  return null;
}

/** One person written top to bottom: a label cell next to its value (one client's per-person sheet). */
function fromLabelColumn(rows: string[][]): ExtractedCase[] | null {
  const item = emptyCase();
  let found = 0;
  // A merchant form («استعلام تجار») names the business, not a person: «اسم التاجر».
  let merchant: string | null = null;
  for (const row of rows) {
    const cells = row.map((cell) => cell.trim());
    for (let i = 0; i < cells.length; i += 1) {
      if (!merchant && cells[i] && MERCHANT_NAME.test(normalizeText(cells[i]!))) {
        merchant = clean(cells.find((cell, j) => j !== i && cell && !(cell.length <= 30 && fieldOfHeader(cell)))) ?? null;
        if (merchant) found += 1;
        break;
      }
      const field = cells[i] && cells[i]!.length <= 30 ? fieldOfHeader(cells[i]!) : null;
      if (!field) continue;
      // The value is the other filled cell on the row (an address may itself contain «الحي»).
      const value = clean(cells.find((cell, j) => j !== i && cell && !(cell.length <= 30 && fieldOfHeader(cell))));
      if (!value) continue;
      if (field === "kind") item.kind = detectKind(value);
      else if (!(item as unknown as Record<string, unknown>)[field]) (item as unknown as Record<string, string>)[field] = value;
      found += 1;
      break;
    }
  }
  if (merchant) {
    item.company ??= merchant;
    item.subject_name ??= merchant;
    item.kind ??= "merchant_coding";
  }
  return found >= 3 && item.subject_name ? [finish(item, [])] : null;
}

const MERCHANT_NAME = /^اسم (ال)?(تاجر|محل|معرض)$/;

/** Cases from one grid (an Excel sheet or an HTML table). */
export function casesFromGrid(rows: string[][]): ExtractedCase[] {
  const filled = rows.filter((row) => row.some((cell) => cell.trim()));
  if (!filled.length) return [];
  return fromHeaderRow(filled) ?? fromLabelColumn(filled) ?? [];
}

/** HTML tables in an email body as grids. */
export function htmlTables(html: string): string[][][] {
  const decode = (s: string) =>
    s
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/\s+/g, " ")
      .trim();
  return [...html.matchAll(/<table\b[\s\S]*?<\/table>/gi)].map((table) =>
    [...table[0].matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map((tr) =>
      [...tr[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((td) => decode(td[1] ?? "")),
    ),
  );
}

/** Whether a grid row looks like a real person (name with letters, NID valid if present). */
export function looksComplete(item: ExtractedCase): boolean {
  return Boolean(
    item.subject_name &&
      (item.home_address || item.work_address) &&
      (!item.national_id || isNationalId(item.national_id)) &&
      !item.doubts.length,
  );
}

/** A CSV file as a grid (quoted cells may hold commas and line breaks). */
export function csvGrid(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, "");
  const firstLine = source.split("\n", 1)[0] ?? "";
  const separator = !firstLine.includes(",") && firstLine.includes(";") ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    if (quoted) {
      if (char !== '"') cell += char;
      else if (source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === separator) {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      rows.push([...row, cell]);
      row = [];
      cell = "";
    } else if (char !== "\r") cell += char;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

/** Columns only a follow-up, billing or result sheet has, never a list of new requests. */
const TRACKER_HEADER =
  /^(ال)?(سعر|قيمه|مندوب|موقف|خصم|مراجع|منسق|مستعلم|نتيجه|تاخير)$|^اسم (ال)?(مراجع|مندوب|مستعلم)$|^تاريخ (ال)?(ارسال|زياره|خروج|الغاء)|^تاريخ ارسال|^حاله الطلب|^(price|amount|status|result)$/;

/** A sheet that tracks or bills cases already sent. */
export function isTrackerGrid(rows: string[][]): boolean {
  return rows.slice(0, 12).some((row) => {
    const filled = row.filter((cell) => cell.trim());
    if (filled.length < 3 || !filled.some((cell) => fieldOfHeader(cell) === "subject_name")) return false;
    return filled.some((cell) => TRACKER_HEADER.test(normalizeText(cell)));
  });
}
