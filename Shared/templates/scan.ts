/**
 * Reads an approved client Word template, marks every place a value can go with an
 * invisible bookmark, and proposes fields and bindings for Head Office to confirm.
 * Nothing in the client's layout is moved or restyled; only bookmarks are added.
 */
import {
  ancestor,
  attr,
  child,
  children,
  descendants,
  DocxPackage,
  type El,
  insertAfter,
  isEl,
  isW,
  local,
  md5,
  NS,
  symText,
  textOf,
  wEl,
} from "./docx.ts";
import {
  claimsAction,
  defaultEvidence,
  evidenceKindFor,
  type EvidenceRequirement,
  type FieldDef,
  type FieldType,
  type PrefillSource,
  type SectionDef,
  type TemplateDefinition,
} from "./definition.ts";

export type SlotKind = "cell" | "inline" | "checkbox" | "choose" | "image" | "rows" | "statement";

export interface Slot {
  anchor: string;
  kind: SlotKind;
  part: string;
  /** Text next to the slot that describes it, e.g. "اسم العميل". */
  label: string;
  /** What the slot holds in the original file: dots, sample text, options. */
  text: string;
  section: string;
  options?: string[];
  option?: string;
  group?: string;
  image?: { md5: string; role: ImageRole; cx: number; cy: number };
  rows?: { anchors: string[]; columns: string[] };
  sample?: boolean;
  /** A drawn box floating at a fixed spot: how far Head Office moved it sideways, in mm. */
  nudge?: number;
}

export type ImageRole = "golden_pay_logo" | "golden_pay_stamp" | "client_logo" | "unknown";

/** Where a slot gets its value from. */
export type BindingAction = "text" | "check" | "choose" | "image" | "rows" | "statement" | "clear";
export interface Binding {
  anchor: string;
  action: BindingAction;
  /** `answers.<key>`, `case.<column>` or `approval.stamp`. */
  source?: string;
  /** check: the option that ticks this box. */
  option?: string;
  /** rows: the column key filled into each cell of the row, by cell position. */
  columns?: (string | null)[];
}

export interface ScanResult {
  docx: Uint8Array;
  slots: Slot[];
  definition: TemplateDefinition;
  bindings: Binding[];
  warnings: string[];
}

/** Case values a binding can print without the investigator typing them. */
export const CASE_SOURCES: Record<string, string> = {
  "case.reference": "رقم الحالة",
  "case.subject_name": "اسم العميل",
  "case.subject_phone": "هاتف العميل",
  "case.address": "العنوان",
  "case.governorate": "المحافظة",
  "case.district": "المركز / المدينة",
  "case.landmark": "علامة مميزة",
  "case.client_reference": "مرجع العميل",
  "case.client_name": "الجهة",
  "case.form_title": "اسم النموذج",
  "case.investigator_name": "اسم المستعلم",
  "case.employee_number": "الرقم الوظيفي للمستعلم",
  "case.reviewer_name": "اسم المراجع",
  "case.report_date": "تاريخ الاستعلام",
  "case.report_time": "توقيت الاستعلام",
  "case.approved_date": "تاريخ الاعتماد",
  "case.gps": "إحداثيات موقع الإرسال",
  "approval.stamp": "ختم جولدن باي (بعد الاعتماد فقط)",
};

// Known images, by MD5 prefix, found in the original templates.
const GOLDEN_PAY_LOGOS = ["bd6ec3ad", "c4d4bc45", "20bcdc72", "2495e36c", "2f7e9cda", "443e325b", "75402edd", "8b312f59"];
const GOLDEN_PAY_STAMPS = ["b0005974", "cdd1d86f", "fd9f0fa2", "891b00ab", "9124c4c0", "5bdddd95", "a253bbe8", "e48700b1"];

const BOX = /[☐☑☒□■▢]/;
const BOX_G = /[☐☑☒□■▢]/g;
const PLACEHOLDER = /[.…_ـ]{4,}|-{5,}|\(\s+\)|\(\s*[.…]{2,}\s*\)/g;
/** "Not provided" left in a filled sample, e.g. Alex Bank's "لم تتم الافادة". */
const NOT_PROVIDED = /لم\s*(تتم|يتم)\s*الاف?اد[ةه]/;
/** Outside tables a wide gap after a colon is also a blank (drawn as a floating line). */
const GAPS = new RegExp(`${PLACEHOLDER.source}|(?<=[:：؟?])[ \u00A0]{5,}(?=\\S)|${NOT_PROVIDED.source}`, "g");
const SAMPLE = /^(لم\s*نواف[ىقي]?|لا\s*يوجد|لايوجد|طيب[ةه]|جيد[ةه]?|نعم|لا|-?\d{1,2}\s*[-/]\s*\d{1,2}\s*[-/]\s*\d{2,4}|-?\d{1,2}-\d{4}|\d{4}\s*[-/]\s*\d{1,2}\s*[-/]\s*\d{1,2}|\d+)$/;
const DATE_IN_TEXT = /\b\d{1,2}\s*\/\s*\d{1,2}\s*\/\s*20\d{2}\b|\b20\d{2}\s*\/\s*\d{1,2}\s*\/\s*\d{1,2}\b|-\d{1,2}-20\d{2}/;

interface Canon {
  test: RegExp;
  key?: string;
  type?: FieldType;
  prefill?: PrefillSource;
  source?: string;
}
/** Labels that mean data the case already has. Keys follow the case's own names. */
/** Labels are matched without hamza variants: "إسم الإستعلام" matches "اسم الاستعلام". */
export const foldHamza = (value: string) => value.replace(/[إأآ]/g, "ا");

export const CANON: Canon[] = [
  { test: /^(اسم\s*(ال)?عميل(\s*رباعي)?|اسم\s*المستعلم\s*عنه|اسم\s*مقدم\s*الطلب|أسم\s*العميل|اسم\s*العميل\s*\/\s*الشركة)$/, key: "subject_name", prefill: "subject_name" },
  { test: /^(ال)?رقم\s*(ال)?قوم[يى]$|^رقم\s*البطاقة(\s*الشخصية)?$/, key: "national_id", type: "national_id", prefill: "national_id" },
  { test: /^(رقم\s*)?(ال)?(موبايل|محمول|تليفون|هاتف|تلفون)(\s*المحمول)?$/, key: "phone", type: "phone", prefill: "phone" },
  { test: /^(عنوان\s*العميل|العنوان|عنوان\s*السكن|العنوان\s*المرسل\s*من\s*البنك)$/, key: "address", prefill: "address" },
  { test: /^(ال)?محافظ[ةه]$/, key: "governorate", prefill: "governorate" },
  { test: /^(المركز|المدينة|الحي|القسم|المركز\s*\/\s*القسم)$/, key: "district", prefill: "district" },
  { test: /علامة\s*مميز/, key: "landmark", prefill: "landmark" },
  { test: /^(كود\s*العميل|رقم\s*الملف|رقم\s*الطلب|مرجع\s*العميل)$/, key: "client_reference", prefill: "client_reference" },
  { test: /^(تاريخ\s*(ال)?استعلام|تاريخ\s*الزيارة|التاريخ|تاريخ)$/, source: "case.report_date" },
  { test: /^(توقيت\s*(ال)?استعلام|وقت\s*الزيارة|ساعة\s*الزيارة)$/, source: "case.report_time" },
  { test: /^(اسم\s*المستعلم|المستعلم|القائم\s*بالاستعلام|اسم\s*الباحث|اسم\s*مندوب\s*الاستعلام)$/, source: "case.investigator_name" },
  { test: /^(اسم\s*المراجع|المراجع)$/, source: "case.reviewer_name" },
];

export const normalizeLabel = (value: string) =>
  value
    .replace(BOX_G, " ")
    .replace(PLACEHOLDER, " ")
    .replace(/[:：\-–—_*•]+\s*$/u, "")
    .replace(/^\s*[:：\-–—•*]+/u, "")
    .replace(/\s+/g, " ")
    .trim();

export function typeFor(label: string): FieldType {
  if (/تاريخ/.test(label)) return "date";
  if (/^(توقيت|الساعة|وقت)/.test(label)) return "time";
  if (/^(عدد|المساحة|مساحة|نسب[ةه]|السن|رأس\s*المال|راس\s*المال|قيمة|المبلغ|الإيجار\s*الشهري)/.test(label)) return "number";
  if (/ملاحظات|رأي|راي\s|وصف|تعليق|بالتفصيل|ملخص|تقييم|المرفقات|توصي|خريطة|كيفية\s*الوصول/.test(label)) return "textarea";
  return "text";
}

function looksLikeLabel(text: string): boolean {
  if (!text || text.length > 80 || BOX.test(text)) return false;
  if (SAMPLE.test(text.trim())) return false;
  if (/^[\d\s/.\-:]+$/.test(text)) return false;
  return text.split(/\s+/).length <= 12;
}

function optionsFromText(text: string): string[] | null {
  if (BOX.test(text) || text.length > 160) return null;
  let parts = text.split(/\s*\/\s*/).map((part) => part.replace(/^[(\s]+|[)\s]+$/g, "").trim());
  if (parts.length < 2) {
    const paren = text.match(/\(([^()]{1,30})\)/g);
    if (paren && paren.length >= 2 && text.replace(/\([^()]*\)/g, "").trim().length < 4) {
      parts = paren.map((part) => part.slice(1, -1).trim());
    }
  }
  parts = parts.filter(Boolean);
  if (parts.length < 2 || parts.length > 10 || parts.some((part) => part.length > 30)) return null;
  return [...new Set(parts)];
}

/** One piece of paragraph text and the paragraph-level node that holds it. */
interface Atom {
  run: El;
  container: El;
  text: string;
  start: number;
  box: El | null;
  /** Floating drawn box and its distance from the left edge, for ordering. */
  floating?: number;
}

/** Horizontal position of a floating drawing, or undefined when it sits in the text. */
function floatingX(run: El): number | undefined {
  const anchor = descendants(run, "anchor", NS.wp)[0];
  if (anchor) {
    const offset = descendants(anchor, "posOffset", NS.wp)[0];
    return Number(offset?.textContent ?? 0);
  }
  const shape = [...descendants(run, "rect", NS.v), ...descendants(run, "shape", NS.v)][0];
  const style = shape?.getAttribute("style") ?? "";
  if (/position:absolute/.test(style)) return Number(style.match(/margin-left:(-?[\d.]+)pt/)?.[1] ?? 0) * 12700;
  return undefined;
}

export class TemplateScanner {
  private nextId = 1;
  private bookmarkId = 900000;
  private readonly slots: Slot[] = [];
  private readonly bindings: Binding[] = [];
  private readonly sections: SectionDef[] = [];
  private readonly usedKeys = new Map<string, number>();
  private readonly warnings: string[] = [];
  private section = "بيانات الاستعلام";
  private pendingLabel = "";
  private readonly consumed = new WeakSet<El>();
  /** Cells that receive a new picture (stamp, signature, photos); old pictures there are removed. */
  private readonly imageCells = new WeakSet<El>();
  /** Pictures used several times in one part are drawn checkboxes (e.g. Gaboor). */
  private repeatedImages = new Set<string>();
  /** The last short text seen, used to name empty text boxes. */
  private lastLabel = "";

  constructor(
    private readonly pkg: DocxPackage,
    private readonly clientLogos: string[] = [],
  ) {}

  run(): ScanResult {
    for (const part of this.pkg.textParts()) {
      const doc = this.pkg.xml(part);
      this.bookmarkId = Math.max(
        this.bookmarkId,
        ...descendants(doc.documentElement as El, "bookmarkStart").map((el) => Number(attr(el, "id")) + 1 || 0),
      );
      const root = part === "word/document.xml" ? child(doc.documentElement as El, "body") : (doc.documentElement as El);
      if (!root) continue;
      this.section = part === "word/document.xml" ? this.section : "رأس وتذييل الصفحة";
      const uses = new Map<string, number>();
      for (const blip of [...descendants(root, "blip", NS.a), ...descendants(root, "imagedata", NS.v)]) {
        const id = blip.getAttributeNS(NS.r, "embed") || blip.getAttributeNS(NS.r, "id") || "";
        if (id) uses.set(id, (uses.get(id) ?? 0) + 1);
      }
      this.repeatedImages = new Set([...uses].filter(([, total]) => total >= 3).map(([id]) => id));
      this.walkBlocks(root, part);
      this.images(root, part);
      this.sampleSweep(root, part);
    }
    this.finishPhotos();
    const definition: TemplateDefinition = {
      schema: 2,
      sections: this.sections.filter((section) => section.fields.length),
    };
    return { docx: this.pkg.save(), slots: this.slots, definition, bindings: this.bindings, warnings: this.warnings };
  }

  // ───────────── fields ─────────────

  private sectionFor(title: string): SectionDef {
    let section = this.sections.find((item) => item.title === title);
    if (!section) {
      section = { id: `s${this.sections.length + 1}`, title, fields: [] };
      this.sections.push(section);
    }
    return section;
  }

  private keyFor(label: string, canonical?: string): string {
    if (canonical && !this.usedKeys.has(canonical)) {
      this.usedKeys.set(canonical, 1);
      return canonical;
    }
    const seen = (this.usedKeys.get(label) ?? 0) + 1;
    this.usedKeys.set(label, seen);
    const key = `f_${md5(new TextEncoder().encode(`${label}#${seen}`)).slice(0, 7)}`;
    this.usedKeys.set(key, 1);
    return key;
  }

  /** A new field for a label, or a case source when the label means case data. */
  private field(label: string, type?: FieldType, extra: Partial<FieldDef> = {}): { key?: string; source: string } {
    const clean = normalizeLabel(label) || "حقل";
    const canon = CANON.find((item) => item.test.test(foldHamza(clean)));
    if (canon?.source && !type) return { source: canon.source };
    const key = this.keyFor(clean, canon?.key);
    const field: FieldDef = {
      key,
      label: clean,
      type: type ?? canon?.type ?? typeFor(clean),
      ...(canon?.prefill && key === canon.key ? { prefill: canon.prefill } : {}),
      ...extra,
    };
    this.sectionFor(this.section).fields.push(field);
    return { key, source: `answers.${key}` };
  }

  private anchor(): string {
    return `gp_${String(this.nextId++).padStart(3, "0")}`;
  }

  private addSlot(slot: Omit<Slot, "section">): Slot {
    const full = { ...slot, section: this.section };
    this.slots.push(full);
    return full;
  }

  // ───────────── bookmarks ─────────────

  private bookmarkAround(first: El, last: El, name: string): void {
    const doc = first.ownerDocument!;
    const id = String(this.bookmarkId++);
    first.parentNode!.insertBefore(wEl(doc, "bookmarkStart", { id, name }), first);
    insertAfter(wEl(doc, "bookmarkEnd", { id }), last);
  }

  /** An empty bookmark at the start of a paragraph: marks a whole cell or row. */
  private bookmarkPoint(paragraph: El, name: string): void {
    const doc = paragraph.ownerDocument!;
    const id = String(this.bookmarkId++);
    const start = wEl(doc, "bookmarkStart", { id, name });
    const end = wEl(doc, "bookmarkEnd", { id });
    const pPr = child(paragraph, "pPr");
    if (pPr) {
      insertAfter(end, pPr);
      paragraph.insertBefore(start, end);
    } else {
      paragraph.insertBefore(end, paragraph.firstChild);
      paragraph.insertBefore(start, end);
    }
  }

  private firstParagraph(cell: El): El {
    let paragraph = child(cell, "p");
    if (!paragraph) {
      paragraph = wEl(cell.ownerDocument!, "p");
      cell.appendChild(paragraph);
    }
    return paragraph;
  }

  // ───────────── runs ─────────────

  /** Splits runs so each holds one text, tab, symbol or drawing. */
  private explode(paragraph: El): void {
    const runs = [...children(paragraph, "r"), ...this.nestedRuns(paragraph)];
    for (const run of runs) {
      const parts = children(run).filter((el) => local(el) !== "rPr");
      if (parts.length <= 1) continue;
      const rPr = child(run, "rPr");
      let after: El = run;
      for (const part of parts.slice(1)) {
        const clone = run.cloneNode(false) as El;
        if (rPr) clone.appendChild(rPr.cloneNode(true));
        clone.appendChild(part);
        insertAfter(clone, after);
        after = clone;
      }
    }
  }

  private nestedRuns(paragraph: El): El[] {
    const out: El[] = [];
    for (const wrapper of children(paragraph)) {
      if (["hyperlink", "ins", "smartTag", "customXml", "fldSimple"].includes(local(wrapper))) {
        out.push(...children(wrapper, "r"));
      }
    }
    return out;
  }

  private atoms(paragraph: El): Atom[] {
    this.explode(paragraph);
    const atoms: Atom[] = [];
    let offset = 0;
    for (const container of children(paragraph)) {
      const name = local(container);
      if (name === "r") {
        if (this.isBoxGraphic(container)) {
          atoms.push({ run: container, container, text: "☐", start: offset, box: container, floating: floatingX(container) });
          offset += 1;
          continue;
        }
        const text = textOf(container);
        atoms.push({ run: container, container, text, start: offset, box: BOX.test(text) && text.trim().length === 1 ? container : null });
        offset += text.length;
      } else if (name === "sdt") {
        const checkbox = descendants(container, "checkbox", NS.w14)[0];
        const text = textOf(container);
        if (checkbox) {
          atoms.push({ run: container, container, text: "☐", start: offset, box: container });
          offset += 1;
        } else {
          atoms.push({ run: container, container, text, start: offset, box: null });
          offset += text.length;
        }
      } else if (["hyperlink", "ins", "smartTag", "customXml"].includes(name)) {
        for (const run of children(container, "r")) {
          const text = textOf(run);
          atoms.push({ run, container: run, text, start: offset, box: null });
          offset += text.length;
        }
      }
    }
    return atoms;
  }

  private hasBoxes(el: El, text: string): boolean {
    return BOX.test(text) || descendants(el, "checkbox", NS.w14).length > 0 || descendants(el, "r").some((run) => this.isBoxGraphic(run));
  }

  /** A drawn checkbox: a small empty square shape, or a tiny picture repeated on the page. */
  isBoxGraphic(run: El): boolean {
    const drawing = child(run, "drawing") ?? child(run, "pict") ?? descendants(run, "AlternateContent", NS.mc)[0];
    if (!drawing) return false;
    const blip = descendants(drawing, "blip", NS.a)[0] ?? descendants(drawing, "imagedata", NS.v)[0];
    if (blip) {
      const id = blip.getAttributeNS(NS.r, "embed") || blip.getAttributeNS(NS.r, "id") || "";
      return this.repeatedImages.has(id);
    }
    if (descendants(drawing, "txbxContent").some((box) => textOf(box).trim())) return false;
    if (descendants(drawing, "cNvCnPr", NS.wps).length) return false; // a line
    const extent = descendants(drawing, "extent", NS.wp)[0];
    if (extent) {
      const cx = Number(extent.getAttribute("cx"));
      const cy = Number(extent.getAttribute("cy"));
      return cx > 40000 && cy > 40000 && cx < 420000 && cy < 420000 && Math.abs(cx - cy) / Math.max(cx, cy) < 0.4;
    }
    // Legacy drawings: a small rectangle or plain shape without a picture or text.
    const rect = ["rect", "shape", "roundrect"].flatMap((name) => descendants(drawing, name, NS.v)).find((el) => !descendants(el, "imagedata", NS.v).length);
    const style = rect?.getAttribute("style") ?? "";
    const width = Number(style.match(/width:([\d.]+)pt/)?.[1] ?? 0);
    const height = Number(style.match(/height:([\d.]+)pt/)?.[1] ?? 0);
    // Checkbox squares are small; value frames (even short ones) are taller than 20pt.
    return width > 3 && height > 3 && width < 26 && height < 20;
  }

  /** Splits the atom containing `offset` so a new run starts exactly there. */
  private splitAt(paragraph: El, offset: number): void {
    for (const atom of this.atoms(paragraph)) {
      if (offset <= atom.start || offset >= atom.start + atom.text.length) continue;
      if (local(atom.run) !== "r") return;
      const t = child(atom.run, "t");
      if (!t) return;
      const cut = offset - atom.start;
      const text = t.textContent ?? "";
      const clone = atom.run.cloneNode(true) as El;
      t.textContent = text.slice(0, cut);
      t.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve");
      const cloneT = child(clone, "t")!;
      cloneT.textContent = text.slice(cut);
      cloneT.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve");
      insertAfter(clone, atom.run);
      return;
    }
  }

  /** Gives every typed box character its own run so it can be ticked alone. */
  private isolateBoxes(paragraph: El): void {
    const text = this.atoms(paragraph).map((atom) => atom.text).join("");
    const positions = [...text.matchAll(BOX_G)].map((match) => match.index!);
    for (const position of positions.reverse()) {
      this.splitAt(paragraph, position + 1);
      this.splitAt(paragraph, position);
    }
  }

  /** Bookmarks the text between two offsets of a paragraph. */
  private markRange(paragraph: El, start: number, end: number, name: string): string {
    this.splitAt(paragraph, start);
    this.splitAt(paragraph, end);
    const inside = this.atoms(paragraph).filter(
      (atom) => atom.start >= start && atom.start + atom.text.length <= end && atom.text.length > 0,
    );
    if (!inside.length) {
      // A point blank (after a trailing colon): bookmark right after the text before it.
      const before = this.atoms(paragraph).filter((atom) => atom.start + atom.text.length <= start).pop();
      if (before) {
        const doc = paragraph.ownerDocument!;
        const id = String(this.bookmarkId++);
        const end = wEl(doc, "bookmarkEnd", { id });
        insertAfter(end, before.container);
        paragraph.insertBefore(wEl(doc, "bookmarkStart", { id, name }), end);
      } else this.bookmarkPoint(paragraph, name);
      return name;
    }
    this.bookmarkAround(inside[0]!.container, inside[inside.length - 1]!.container, name);
    return name;
  }

  // ───────────── walking ─────────────

  private walkBlocks(root: El, part: string): void {
    for (const block of children(root)) {
      const name = local(block);
      if (name === "p") {
        this.paragraph(block, part);
        this.textBoxes(block, part);
      } else if (name === "tbl") this.table(block, part);
      else if (name === "sdt") {
        const content = child(block, "sdtContent");
        if (content) this.walkBlocks(content, part);
      }
    }
  }

  /** "صور السكن": the visit photos go right under the client's own heading. */
  private photoHeading(paragraph: El, part: string, title: string): void {
    this.section = title;
    const doc = paragraph.ownerDocument!;
    const holder = wEl(doc, "p");
    const pPr = wEl(doc, "pPr");
    pPr.appendChild(wEl(doc, "bidi"));
    pPr.appendChild(wEl(doc, "jc", { val: "center" }));
    holder.appendChild(pPr);
    insertAfter(holder, paragraph);
    this.consumed.add(holder);
    const anchor = this.anchor();
    this.bookmarkPoint(holder, anchor);
    const { key } = this.field(title, "photos", { min_items: 1 });
    this.addSlot({ anchor, kind: "image", part, label: title, text: "", image: { md5: "", role: "unknown", cx: 0, cy: 0 } });
    this.bindings.push({ anchor, action: "image", source: `answers.${key}` });
    this.pendingLabel = "";
  }

  private contains(root: Node, node: Node): boolean {
    for (let current: Node | null = node; current; current = current.parentNode) if (current === root) return true;
    return false;
  }

  /** Floating text boxes: filled ones are read like the page, empty ones take a value. */
  private textBoxes(paragraph: El, part: string): void {
    for (const box of descendants(paragraph, "txbxContent")) {
      if (ancestor(box, "Fallback", NS.mc)) continue;
      // A box inside another box of this paragraph is read when its parent box is walked.
      const outer = ancestor(box, "txbxContent");
      if (outer && this.contains(paragraph, outer)) continue;
      // A frame is empty only if nothing at all is inside it: no text, no nested frames,
      // no pictures. Filling a frame replaces its content, so this must be certain.
      const nested = descendants(box, "txbxContent").length + descendants(box, "drawing").length + descendants(box, "pict").length;
      if ((box.textContent ?? "").trim() || nested) {
        this.walkBlocks(box, part);
        continue;
      }
      const label = this.pendingLabel || this.lastLabel;
      const anchor = this.anchor();
      this.bookmarkPoint(this.firstParagraph(box), anchor);
      if (!label) {
        // Still selectable in the visual mapper, so Head Office can say what goes here.
        this.addSlot({ anchor, kind: "cell", part, label: "مربع نص فارغ", text: "" });
        continue;
      }
      const { source } = this.field(label);
      this.addSlot({ anchor, kind: "cell", part, label, text: "" });
      this.bindings.push({ anchor, action: "text", source });
      this.pendingLabel = "";
      this.lastLabel = "";
    }
  }

  private isHeading(paragraph: El, text: string): boolean {
    if (!text || text.length > 70 || BOX.test(text) || PLACEHOLDER.test(text)) {
      PLACEHOLDER.lastIndex = 0;
      return false;
    }
    PLACEHOLDER.lastIndex = 0;
    const bold = descendants(paragraph, "b").length > 0;
    const centered = attr(child(child(paragraph, "pPr") ?? paragraph, "jc") ?? undefined, "val") === "center";
    const shaded = Boolean(child(child(paragraph, "pPr") ?? paragraph, "shd"));
    return (bold || centered || shaded) && text.split(/\s+/).length <= 9 && !SAMPLE.test(text);
  }

  private paragraph(paragraph: El, part: string, cellLabel?: string): void {
    if (this.consumed.has(paragraph)) return;
    const text = textOf(paragraph).replace(/\s+$/, "");
    if (!text.trim()) {
      // Squares drawn on their own, away from their option text: each becomes a checkbox
      // place, named later from where it sits on the page.
      for (const run of children(paragraph, "r").filter((item) => this.isBoxGraphic(item))) {
        const anchor = this.anchor();
        this.bookmarkAround(run, run, anchor);
        this.addSlot({ anchor, kind: "checkbox", part, label: "مربع اختيار", text: "☐", option: "", group: "" });
      }
      return;
    }

    const pattern = this.blankPattern(paragraph);
    // A claim sentence: printed only when the investigator confirms it with evidence.
    if (claimsAction(text) && text.trim().length > 20 && !this.hasBoxes(paragraph, text)) {
      this.statement(paragraph, part, text);
      return;
    }
    if (this.hasBoxes(paragraph, text)) {
      const floating = this.checkboxGroup([paragraph], part, cellLabel);
      // Floating boxes leave the paragraph's own blanks untouched; read them too.
      pattern.lastIndex = 0;
      if (floating && pattern.test(textOf(paragraph))) this.placeholders(paragraph, part, cellLabel, pattern, true);
      pattern.lastIndex = 0;
      return;
    }
    pattern.lastIndex = 0;
    // "اسم المعرض :" with nothing after it: the investigator writes right after the colon.
    // Only when the next line does not carry the blank itself (that line takes the label).
    const trailing =
      pattern === GAPS &&
      /[:：]\s*$/.test(text) &&
      (!this.isHeading(paragraph, text.trim()) || this.inLabelList(paragraph, text.trim())) &&
      (descendants(paragraph, "drawing").length > 0 || (text.trim().length < 60 && !this.blankFollows(paragraph)));
    if (pattern.test(text) || trailing) {
      pattern.lastIndex = 0;
      this.placeholders(paragraph, part, cellLabel, pattern, false, trailing);
      return;
    }
    pattern.lastIndex = 0;
    if (DATE_IN_TEXT.test(text) && text.length < 60) {
      // A filled-in date left over from a real report, e.g. "التاريخ: 12/10/2025".
      const match = text.match(DATE_IN_TEXT)!;
      const start = text.indexOf(match[0]);
      const anchor = this.markRange(paragraph, start, start + match[0].length, this.anchor());
      this.addSlot({ anchor, kind: "inline", part, label: normalizeLabel(text.slice(0, start)) || "التاريخ", text: match[0], sample: true });
      this.bindings.push({ anchor, action: "text", source: "case.report_date" });
      this.warnings.push(`تاريخ من تقرير سابق «${match[0]}» سيُستبدل بتاريخ الاستعلام`);
      return;
    }
    if (/^(ال)?صور(ة)?(\s|$)/.test(text.trim()) && text.trim().length < 40 && !ancestor(paragraph, "tc")) {
      this.photoHeading(paragraph, part, normalizeLabel(text));
      return;
    }
    if (this.isHeading(paragraph, text.trim())) {
      this.section = normalizeLabel(text) || this.section;
      this.pendingLabel = "";
      return;
    }
    this.pendingLabel = /[:：]\s*$/.test(text) && text.length < 80 ? normalizeLabel(text) : "";
    if (looksLikeLabel(text.trim())) this.lastLabel = normalizeLabel(text);
  }

  /** The text of the next written paragraph in the same flow ("" at a table or the end). */
  private nextText(paragraph: El): string {
    for (let node = paragraph.nextSibling; node; node = node.nextSibling) {
      if (node.nodeType !== 1) continue;
      if (!isW(node, "p")) return "";
      const next = textOf(node as El).trim();
      if (next) return next;
    }
    return "";
  }

  /** Whether the next written paragraph opens with a blank (dots, underscores, empty brackets). */
  private blankFollows(paragraph: El): boolean {
    return /^([.…_ـ]{4,}|-{5,}|\(\s*[.…]*\s*\))/.test(this.nextText(paragraph));
  }

  /** A "Label :" line followed by another one: a list of fields, even when bold. */
  private inLabelList(paragraph: El, text: string): boolean {
    const next = this.nextText(paragraph);
    return /[:：]\s*$/.test(text) && text.length < 60 && /^[^:：]{2,40}[:：]/.test(next);
  }

  private blankPattern(paragraph: El): RegExp {
    return ancestor(paragraph, "tc") ? PLACEHOLDER : GAPS;
  }

  private placeholders(
    paragraph: El,
    part: string,
    cellLabel?: string,
    pattern: RegExp = PLACEHOLDER,
    afterOptions = false,
    trailing = false,
  ): void {
    const text = textOf(paragraph);
    pattern.lastIndex = 0;
    const matches = [...text.matchAll(pattern)];
    let previousEnd = 0;
    const found: { start: number; end: number; label: string; sample: boolean }[] = [];
    const labelOf = (chunk: string) => {
      // "هل مؤمن عليه:  نعم   لا   الرقم التأمينى:" → the last phrase names the blank.
      const pieces = chunk.split(/\s{3,}/).map(normalizeLabel).filter(Boolean);
      return (afterOptions || pieces.length > 1 ? pieces.pop() : normalizeLabel(chunk)) ?? "";
    };
    for (const match of matches) {
      const start = match.index!;
      const end = start + match[0].length;
      let label = labelOf(text.slice(previousEnd, start));
      if (!label) label = normalizeLabel(text.slice(end).split(pattern)[0] ?? "").slice(0, 60);
      pattern.lastIndex = 0;
      found.push({ start, end, label: label || this.pendingLabel || cellLabel || "بيان", sample: NOT_PROVIDED.test(match[0]) });
      previousEnd = end;
    }
    if (trailing) {
      const end = text.trimEnd().length;
      found.push({ start: end, end, label: labelOf(text.slice(previousEnd)) || "بيان", sample: false });
    }
    // Mark from the end so earlier offsets stay valid while runs are split.
    const anchors = found.map(() => this.anchor());
    for (let index = found.length - 1; index >= 0; index -= 1) {
      this.markRange(paragraph, found[index]!.start, found[index]!.end, anchors[index]!);
    }
    found.forEach((item, index) => {
      const { source } = this.field(item.label);
      this.addSlot({
        anchor: anchors[index]!,
        kind: "inline",
        part,
        label: item.label,
        text: text.slice(item.start, item.end),
        ...(item.sample ? { sample: true } : {}),
      });
      this.bindings.push({ anchor: anchors[index]!, action: "text", source });
      if (item.sample) this.warnings.push(`نص من تقرير سابق «${text.slice(item.start, item.end)}» في «${item.label}» سيُستبدل بإجابة المستعلم`);
    });
    this.pendingLabel = "";
  }

  private statement(paragraph: El, part: string, text: string): void {
    const anchor = this.anchor();
    // Inline blanks inside the sentence are facts the investigator fills in.
    const inner: string[] = [];
    PLACEHOLDER.lastIndex = 0;
    if (PLACEHOLDER.test(text)) {
      PLACEHOLDER.lastIndex = 0;
      const before = this.bindings.length;
      this.placeholders(paragraph, part, "بيان");
      for (const binding of this.bindings.slice(before)) {
        if (binding.source?.startsWith("answers.")) inner.push(binding.source.slice(8));
      }
    }
    PLACEHOLDER.lastIndex = 0;
    const pPr = child(paragraph, "pPr");
    const contents = children(paragraph).filter((el) => el !== pPr);
    if (contents.length) this.bookmarkAround(contents[0]!, contents[contents.length - 1]!, anchor);
    else this.bookmarkPoint(paragraph, anchor);

    const sentence = text.replace(/\s+/g, " ").trim();
    const kinds = new Set([evidenceKindFor(sentence)]);
    if (/الاطلاع|اطلاع|الإطلاع/.test(sentence)) kinds.add("document");
    if (/الوصول|زيار|معاين/.test(sentence)) kinds.add("visit");
    const requires: EvidenceRequirement[] = [];
    for (const kind of kinds) {
      for (const need of defaultEvidence(kind).requires) {
        if (!requires.some((item) => JSON.stringify(item) === JSON.stringify(need))) requires.push(need);
      }
    }
    for (const key of inner) requires.push({ type: "filled", field: key });
    const label = sentence.length > 70 ? `${sentence.slice(0, 67)}…` : sentence;
    const { key } = this.field(label, "attestation", {
      statement: sentence,
      evidence: { kind: [...kinds][0]!, requires },
      help: "أكّد هذه العبارة فقط إذا حدث ذلك فعلًا أثناء الاستعلام. لا تُطبع في التقرير دون تأكيدك والدليل المسجّل.",
    });
    this.addSlot({ anchor, kind: "statement", part, label, text: sentence });
    this.bindings.push({ anchor, action: "statement", source: `answers.${key}` });
  }

  /** One choice field from boxes spread across one or more paragraphs. */
  private checkboxGroup(paragraphs: El[], part: string, label?: string, optionHint?: string[]): boolean {
    type Box = { paragraph: El; atom: Atom; option: string };
    let anyFloating = false;
    const boxes: Box[] = [];
    let groupLabel = label ?? "";
    const trailing: { paragraph: El; start: number; end: number; option: string; label: string }[] = [];

    for (const paragraph of paragraphs) {
      this.isolateBoxes(paragraph);
      const atoms = this.atoms(paragraph);
      const text = atoms.map((atom) => atom.text).join("");
      const positions = atoms.filter((atom) => atom.box);
      if (!positions.length) continue;
      if (positions.every((atom) => atom.floating !== undefined)) {
        // Floating boxes sit anywhere in the text; pair them with the option words by
        // position: on a right-to-left page the rightmost box belongs to the first word.
        anyFloating = true;
        const split = text.search(/[:：؟?]/);
        if (split >= 0 && !groupLabel) groupLabel = normalizeLabel(text.slice(0, split));
        const words = text
          .slice(split + 1)
          .split(/\s{2,}/)
          .map((word) => normalizeLabel(word))
          .filter((word) => word && !NOT_PROVIDED.test(word) && !/[:：]/.test(word));
        const ordered = [...positions].sort((a, b) => (b.floating ?? 0) - (a.floating ?? 0));
        ordered.forEach((atom, index) => boxes.push({ paragraph, atom, option: words[index] ?? "" }));
        continue;
      }
      let head = text.slice(0, positions[0]!.start);
      const colon = head.search(/[:：]/);
      if (colon >= 0) {
        if (!groupLabel) groupLabel = normalizeLabel(head.slice(0, colon));
        head = head.slice(colon + 1);
      }
      const boxFirst = /^[\s\-–—:.()]*$/.test(head);
      positions.forEach((atom, index) => {
        let segment: string;
        if (boxFirst) {
          const end = positions[index + 1]?.start ?? text.length;
          segment = text.slice(atom.start + 1, end);
        } else {
          const start = index === 0 ? text.length - head.length - (text.length - positions[0]!.start) : positions[index - 1]!.start + 1;
          segment = text.slice(Math.max(0, start), atom.start);
        }
        // A blank after an option ("نعم - اذكر……") is a detail shown when it is chosen.
        PLACEHOLDER.lastIndex = 0;
        const blank = PLACEHOLDER.exec(segment);
        PLACEHOLDER.lastIndex = 0;
        let option = segment;
        if (blank) {
          const absolute = (boxFirst ? atom.start + 1 : atom.start - segment.length) + blank.index;
          option = segment.slice(0, blank.index);
          trailing.push({
            paragraph,
            start: absolute,
            end: absolute + blank[0].length,
            option: "",
            label: normalizeLabel(segment.slice(0, blank.index)),
          });
        }
        option = normalizeLabel(option.split(/[:：]/).pop() ?? option).slice(0, 60);
        boxes.push({ paragraph, atom, option });
      });
    }
    if (!boxes.length) return anyFloating;
    boxes.forEach((box, index) => {
      if (!box.option) box.option = optionHint?.[index] ?? `خيار ${index + 1}`;
    });
    const options = [...new Set(boxes.map((box) => box.option))];
    const name = groupLabel || this.pendingLabel || boxes.map((box) => box.option).slice(0, 2).join(" / ");
    const exclusive = options.length <= 3 || options.every((option) => /^(نعم|لا|يوجد|لا يوجد|ملك|إيجار|ايجار)$/.test(option));
    const { key } = this.field(name, exclusive ? "choice" : "multichoice", { options });
    const group = key!;

    // Bookmark detail blanks first (they split runs), then each box.
    for (const item of trailing.reverse()) {
      const owner = boxes.find((box) => box.paragraph === item.paragraph && box.atom.start < item.start);
      const anchor = this.anchor();
      this.markRange(item.paragraph, item.start, item.end, anchor);
      const { source } = this.field(item.label || `${name} — تفاصيل`, "text", {
        ...(owner ? { visible_if: { field: group, op: "eq" as const, value: owner.option } } : {}),
      });
      this.addSlot({ anchor, kind: "inline", part, label: item.label || name, text: "…" });
      this.bindings.push({ anchor, action: "text", source });
    }
    for (const box of boxes) {
      const anchor = this.anchor();
      const fresh = this.atoms(box.paragraph).find(
        (atom) => atom.box && (atom.container === box.atom.container || atom.run === box.atom.run),
      ) ?? box.atom;
      this.bookmarkAround(fresh.container, fresh.container, anchor);
      this.addSlot({ anchor, kind: "checkbox", part, label: name, text: "☐", option: box.option, group });
      this.bindings.push({ anchor, action: "check", source: `answers.${group}`, option: box.option });
    }
    this.pendingLabel = "";
    return anyFloating;
  }

  // ───────────── tables ─────────────

  private cellInfo(cell: El) {
    const paragraphs = children(cell, "p");
    const text = paragraphs.map(textOf).join(" ").replace(/\s+/g, " ").trim();
    const merge = child(child(cell, "tcPr") ?? cell, "vMerge");
    const continued = Boolean(merge) && attr(merge, "val") !== "restart";
    const span = Number(attr(child(child(cell, "tcPr") ?? cell, "gridSpan"), "val") ?? 1) || 1;
    return {
      cell,
      paragraphs,
      text,
      continued,
      span,
      nested: children(cell, "tbl").length > 0,
      drawing: descendants(cell, "drawing").length + descendants(cell, "pict").length > 0,
      boxes: this.hasBoxes(cell, text),
      placeholder: (PLACEHOLDER.lastIndex = 0, PLACEHOLDER.test(text)),
      empty: !text && !(descendants(cell, "drawing").length + descendants(cell, "pict").length),
    };
  }

  private table(table: El, part: string): void {
    const rows = children(table, "tr");
    const info = rows.map((row) => {
      let column = 0;
      return children(row, "tc").map((cell) => {
        const item = { ...this.cellInfo(cell), column, row };
        column += item.span;
        return item;
      });
    });
    PLACEHOLDER.lastIndex = 0;

    for (let r = 0; r < rows.length; r += 1) {
      const cells = info[r]!;
      const row = rows[r]!;
      const real = cells.filter((cell) => !cell.continued);
      if (real.every((cell) => cell.empty)) continue;

      // Section title: one wide cell of short text. "Wide" is measured against the row: a label
      // cell spanning 3 of 15 grid columns next to an empty answer cell («اسم العميل | …») is a
      // field, not a title.
      const filled = real.filter((cell) => !cell.empty);
      const rowSpan = real.reduce((sum, cell) => sum + cell.span, 0) || 1;
      if (filled.length === 1 && real.length <= 2 && !filled[0]!.boxes && !filled[0]!.placeholder && !filled[0]!.nested &&
        looksLikeLabel(filled[0]!.text) && (real.length === 1 || filled[0]!.span / rowSpan >= 0.6) && !claimsAction(filled[0]!.text)) {
        const below = info[r + 1];
        const labelBelow = below?.some((cell) => looksLikeLabel(cell.text));
        if (real.length === 1 || labelBelow) {
          this.section = normalizeLabel(filled[0]!.text) || this.section;
          continue;
        }
      }

      // Repeating table: a row of column titles followed by empty rows.
      if (real.length >= 2 && real.every((cell) => looksLikeLabel(cell.text) && !cell.empty)) {
        let end = r + 1;
        while (end < rows.length && info[end]!.length === cells.length && info[end]!.every((cell) => cell.empty)) end += 1;
        if (end - r - 1 >= 1) {
          this.repeatingRows(rows.slice(r + 1, end), real.map((cell) => normalizeLabel(cell.text)), part, table);
          r = end - 1;
          continue;
        }
        // Column titles over one row of values: pair vertically.
        const next = info[r + 1];
        if (
          next && next.length === cells.length &&
          (next.every((cell) => cell.empty || this.isSample(cell.text) || cell.drawing) ||
            (next.some((cell) => cell.empty) && next.every((cell) => !/[:：]/.test(cell.text) && !cell.boxes && !cell.placeholder)))
        ) {
          real.forEach((cell, index) => this.pairCell(cell.text, next[index]!, part));
          r += 1;
          continue;
        }
      }

      for (let c = 0; c < cells.length; c += 1) {
        const cell = cells[c]!;
        if (cell.continued || this.consumed.has(cell.cell)) continue;
        if (cell.nested) {
          for (const nested of children(cell.cell, "tbl")) this.table(nested, part);
          for (const paragraph of cell.paragraphs) this.paragraph(paragraph, part);
          this.consumed.add(cell.cell);
          continue;
        }
        if (cell.boxes) {
          // Boxes spread over the next cells belong to the same question.
          const group = [cell];
          while (cells[c + 1]?.boxes && !cells[c + 1]!.text.includes(":") && !this.consumed.has(cells[c + 1]!.cell)) {
            group.push(cells[++c]!);
          }
          this.checkboxGroup(group.flatMap((item) => item.paragraphs), part, this.pendingLabel || undefined);
          group.forEach((item) => this.consumed.add(item.cell));
          continue;
        }
        if (cell.placeholder || claimsAction(cell.text)) {
          for (const paragraph of cell.paragraphs) this.paragraph(paragraph, part, normalizeLabel(cells[c - 1]?.text ?? ""));
          this.consumed.add(cell.cell);
          continue;
        }
        if (this.labelInCell(cell, cells[c + 1], part)) continue;
        if (looksLikeLabel(cell.text) && !cell.empty) {
          const next = cells[c + 1];
          if (next && !this.consumed.has(next.cell) && !next.continued) {
            if (next.boxes) {
              this.pendingLabel = normalizeLabel(cell.text);
              continue;
            }
            const options = optionsFromText(next.text);
            if (options) {
              this.choose(next, cell.text, options, part);
              c += 1;
              continue;
            }
            if (next.empty || this.isSample(next.text) || (next.drawing && !next.text)) {
              this.pairCell(cell.text, next, part);
              c += 1;
              continue;
            }
            if (next.nested || next.placeholder || claimsAction(next.text)) {
              this.pendingLabel = normalizeLabel(cell.text);
              continue;
            }
          }
          // Label with its value cell below (same column).
          const below = info[r + 1]?.find((item) => item.column === cell.column && !item.continued);
          if (below && below.empty && !this.consumed.has(below.cell) && !(info[r + 1] ?? []).some((item) => looksLikeLabel(item.text) && !item.empty)) {
            this.pairCell(cell.text, below, part);
            continue;
          }
          this.pendingLabel = normalizeLabel(cell.text);
          continue;
        }
        if (!cell.empty) {
          for (const paragraph of cell.paragraphs) this.paragraph(paragraph, part);
        }
      }
      void row;
    }
  }

  /**
   * "اسم العميل :" in a wide cell, or "الشهرة : لم نواف": the value belongs after the
   * colon in the same cell, unless the next cell is an empty value cell.
   */
  private labelInCell(
    cell: ReturnType<TemplateScanner["cellInfo"]>,
    next: ReturnType<TemplateScanner["cellInfo"]> | undefined,
    part: string,
  ): boolean {
    if (cell.empty || cell.boxes || cell.placeholder || cell.paragraphs.length === 0) return false;
    const paragraph = cell.paragraphs.find((item) => /[:：]/.test(textOf(item)));
    if (!paragraph || cell.paragraphs.filter((item) => textOf(item).trim()).length > 1) return false;
    const text = textOf(paragraph);
    const colon = text.search(/[:：]/);
    const label = normalizeLabel(text.slice(0, colon));
    const rest = text.slice(colon + 1);
    if (!label || label.length > 60 || !looksLikeLabel(label)) return false;
    const restText = rest.trim();
    if (restText && !this.isSample(restText) && !NOT_PROVIDED.test(restText)) return false;
    if (!restText && next && !next.continued && !this.consumed.has(next.cell)) {
      // The next cell answers this label, or this is a row heading for filled text beside it.
      if (next.empty || next.boxes || optionsFromText(next.text) || !/[:：]/.test(next.text)) return false;
    }
    this.consumed.add(cell.cell);
    const anchor = this.anchor();
    if (restText) {
      const start = colon + 1 + (rest.length - rest.trimStart().length);
      this.markRange(paragraph, start, text.trimEnd().length, anchor);
      this.warnings.push(`نص من تقرير سابق «${restText}» في «${label}» سيُستبدل بإجابة المستعلم`);
    } else {
      this.markRange(paragraph, colon + 1, colon + 1, anchor);
    }
    const { source } = this.field(label);
    this.addSlot({ anchor, kind: "inline", part, label, text: restText, ...(restText ? { sample: true } : {}) });
    this.bindings.push({ anchor, action: "text", source });
    return true;
  }

  private isSample(text: string): boolean {
    return Boolean(text) && (SAMPLE.test(text.trim()) || DATE_IN_TEXT.test(text) || /^-?\d{1,2}-\d{1,2}-20\d{2}$/.test(text.trim()));
  }

  private pairCell(labelText: string, target: ReturnType<TemplateScanner["cellInfo"]>, part: string): void {
    const label = normalizeLabel(labelText);
    this.consumed.add(target.cell);
    const anchor = this.anchor();
    // «المفوض بالتوقيع» / «حق التوقيع» name who signs: a name to write, not a signature to draw.
    const signs = /توقيع|إمضاء|امضاء/.test(label) && !/مفوض|المفوضين|حق التوقيع|بالتوقيع/.test(label);
    if (/ختم|^(ال)?صور|^المرفقات$|^مرفقات/.test(label) || signs) this.imageCells.add(target.cell);
    if (/ختم/.test(label)) {
      this.bookmarkPoint(this.firstParagraph(target.cell), anchor);
      this.addSlot({ anchor, kind: "image", part, label, text: "", image: { md5: "", role: "golden_pay_stamp", cx: 0, cy: 0 } });
      this.bindings.push({ anchor, action: "image", source: "approval.stamp" });
      return;
    }
    if (signs) {
      this.bookmarkPoint(this.firstParagraph(target.cell), anchor);
      const { key } = this.field(label, "signature");
      this.addSlot({ anchor, kind: "image", part, label, text: "", image: { md5: "", role: "unknown", cx: 0, cy: 0 } });
      this.bindings.push({ anchor, action: "image", source: `answers.${key}` });
      return;
    }
    if (/^(ال)?صور|^المرفقات$|^مرفقات/.test(label)) {
      this.bookmarkPoint(this.firstParagraph(target.cell), anchor);
      const { key } = this.field(label, "photos", { min_items: 1 });
      this.addSlot({ anchor, kind: "image", part, label, text: "", image: { md5: "", role: "unknown", cx: 0, cy: 0 } });
      this.bindings.push({ anchor, action: "image", source: `answers.${key}` });
      return;
    }
    this.bookmarkPoint(this.firstParagraph(target.cell), anchor);
    const sample = !target.empty;
    const { source } = this.field(label);
    this.addSlot({ anchor, kind: "cell", part, label, text: target.text, ...(sample ? { sample: true } : {}) });
    this.bindings.push({ anchor, action: "text", source });
    if (sample) this.warnings.push(`نص من تقرير سابق «${target.text}» في «${label}» سيُستبدل بإجابة المستعلم`);
  }

  private choose(target: ReturnType<TemplateScanner["cellInfo"]>, labelText: string, options: string[], part: string): void {
    this.consumed.add(target.cell);
    const anchor = this.anchor();
    this.bookmarkPoint(this.firstParagraph(target.cell), anchor);
    const label = normalizeLabel(labelText);
    const yesNo = options.length === 2 && options.includes("نعم") && options.includes("لا");
    const { source } = this.field(label, yesNo ? "yesno" : "choice", yesNo ? {} : { options });
    this.addSlot({ anchor, kind: "choose", part, label, text: target.text, options });
    this.bindings.push({ anchor, action: "choose", source });
  }

  private repeatingRows(rows: El[], titles: string[], part: string, table: El): void {
    const label = this.pendingLabel || this.section;
    const anchors = rows.map((row) => {
      const anchor = this.anchor();
      this.bookmarkPoint(this.firstParagraph(children(row, "tc")[0]!), anchor);
      return anchor;
    });
    const columns: FieldDef[] = [];
    const used = new Set<string>();
    const keys = titles.map((title, index) => {
      let key = `c${index + 1}`;
      const canon = CANON.find((item) => item.test.test(foldHamza(title)));
      if (canon?.key && !used.has(canon.key)) key = canon.key;
      used.add(key);
      columns.push({ key, label: title || `عمود ${index + 1}`, type: typeFor(title) === "textarea" ? "text" : typeFor(title) });
      return key;
    });
    const { key } = this.field(label, "table", { columns, max_rows: Math.max(rows.length, 20) });
    this.addSlot({ anchor: anchors[0]!, kind: "rows", part, label, text: titles.join(" | "), rows: { anchors, columns: keys } });
    this.bindings.push({ anchor: anchors[0]!, action: "rows", source: `answers.${key}`, columns: keys });
    for (const anchor of anchors.slice(1)) {
      this.bindings.push({ anchor, action: "rows", source: `answers.${key}`, columns: keys });
    }
    void table;
  }

  // ───────────── images ─────────────

  private images(root: El, part: string): void {
    const drawings = [...descendants(root, "drawing"), ...descendants(root, "pict")];
    for (const drawing of drawings) {
      const blip = descendants(drawing, "blip", NS.a)[0] ?? descendants(drawing, "imagedata", NS.v)[0];
      const id = blip?.getAttributeNS(NS.r, "embed") || blip?.getAttributeNS(NS.r, "id") || "";
      const target = id ? this.pkg.relTarget(part, id) : null;
      const bytes = target ? this.pkg.bytes(target) : undefined;
      if (!bytes) continue;
      const hash = md5(bytes);
      const role: ImageRole = GOLDEN_PAY_LOGOS.includes(hash.slice(0, 8))
        ? "golden_pay_logo"
        : GOLDEN_PAY_STAMPS.includes(hash.slice(0, 8))
          ? "golden_pay_stamp"
          : this.clientLogos.includes(hash.slice(0, 8))
            ? "client_logo"
            : "unknown";
      const extent = descendants(drawing, "extent", NS.wp)[0];
      const cx = Number(extent?.getAttribute("cx") ?? 0);
      const cy = Number(extent?.getAttribute("cy") ?? 0);
      const run = ancestor(drawing, "r");
      if (!run || ancestor(drawing, "Fallback", NS.mc) || this.isBoxGraphic(run)) continue;
      const anchor = this.anchor();
      const holder = ancestor(run, "sdt") && ancestor(run, "sdt")!.parentNode && isW(ancestor(run, "sdt")!.parentNode, "p")
        ? ancestor(run, "sdt")!
        : run;
      this.bookmarkAround(holder, holder, anchor);
      const cell = ancestor(run, "tc");
      if (cell && this.imageCells.has(cell)) {
        // An old stamp, signature or photo where the new one will be placed.
        this.slots.push({ anchor, kind: "image", part, label: "صورة قديمة", text: "", image: { md5: hash, role, cx, cy }, section: "الصور والشعارات" });
        this.bindings.push({ anchor, action: "clear" });
        continue;
      }
      const label = cell ? normalizeLabel(textOf(cell)) || "صورة" : "صورة";
      this.slots.push({ anchor, kind: "image", part, label, text: "", image: { md5: hash, role, cx, cy }, section: "الصور والشعارات" });
      if (role === "golden_pay_stamp") this.bindings.push({ anchor, action: "image", source: "approval.stamp" });
      else if (role === "unknown") {
        // Photos, signatures and QR codes copied from a real report must not reappear.
        this.bindings.push({ anchor, action: "clear" });
        this.warnings.push("صورة مضمّنة غير معروفة (قد تكون صورة زيارة أو توقيعًا من تقرير سابق) ستُحذف من التقرير ما لم تحدد الإدارة دورها");
      }
    }
  }

  /**
   * Last safety net: answers left from a real report ("لم نوافي", "لم تتم الافادة", old
   * dates) that no slot covers become flagged places. A version cannot go to review until
   * Head Office binds them to a field or removes them, so they never print by accident.
   */
  private sampleSweep(root: El, part: string): void {
    const sweep = new RegExp(`${NOT_PROVIDED.source}|لم\\s*نواف[ىقي]?|${DATE_IN_TEXT.source}`, "g");
    for (const paragraph of descendants(root, "p")) {
      if (ancestor(paragraph, "Fallback", NS.mc)) continue;
      const text = textOf(paragraph);
      sweep.lastIndex = 0;
      if (!sweep.test(text)) continue;
      // Text offsets already covered by a slot in this paragraph.
      const covered: [number, number][] = [];
      const holder = ancestor(paragraph, "tc") ?? ancestor(paragraph, "txbxContent");
      const cellSlot = holder && descendants(holder, "bookmarkStart").some((mark) => {
        const name = attr(mark, "name") ?? "";
        const next = mark.nextSibling as El | null;
        return name.startsWith("gp_") && next !== null && local(next) === "bookmarkEnd" && !this.textBefore(mark);
      });
      if (cellSlot) continue;
      const open = new Map<string, number>();
      let offset = 0;
      for (const node of children(paragraph)) {
        const name = local(node);
        if (name === "bookmarkStart" && (attr(node, "name") ?? "").startsWith("gp_")) open.set(attr(node, "id") ?? "", offset);
        else if (name === "bookmarkEnd" && open.has(attr(node, "id") ?? "")) {
          covered.push([open.get(attr(node, "id") ?? "")!, offset]);
          open.delete(attr(node, "id") ?? "");
        } else offset += name === "sdt" && descendants(node, "checkbox", NS.w14).length ? 1 : textOf(node).length;
      }
      sweep.lastIndex = 0;
      const found = [...text.matchAll(sweep)]
        .map((match) => ({ start: match.index!, end: match.index! + match[0].length, text: match[0] }))
        .filter((item) => !covered.some(([from, to]) => item.start >= from && item.end <= to));
      for (const item of found.reverse()) {
        const anchor = this.anchor();
        this.markRange(paragraph, item.start, item.end, anchor);
        const label = normalizeLabel(text.slice(0, item.start).split(/[:：]/).slice(-2, -1)[0] ?? "") || "بيانات من تقرير سابق";
        this.slots.push({ anchor, kind: "inline", part, label, text: item.text, sample: true, section: "بيانات قديمة" });
        // Removed unless Head Office binds it to a question: old data must never print.
        this.bindings.push({ anchor, action: "clear" });
        this.warnings.push(`نص من تقرير سابق «${item.text}» سيُحذف من التقرير؛ اربطه بسؤال إن كان مكانًا لإجابة`);
      }
    }
  }

  /** True when real text comes before a bookmark in its paragraph. */
  private textBefore(mark: El): boolean {
    for (let node = mark.previousSibling; node; node = node.previousSibling) {
      if (node.nodeType === 1 && textOf(node as El).trim()) return true;
    }
    return false;
  }

  /** Every form gets somewhere to put the visit photos, even if the layout has no slot. */
  private finishPhotos(): void {
    const hasPhotos = this.sections.some((section) => section.fields.some((field) => field.type === "photos"));
    if (!hasPhotos) {
      this.section = "صور الزيارة";
      this.field("صور الزيارة", "photos", {
        min_items: 1,
        help: "تُطبع في ملحق الصور في نهاية التقرير.",
      });
    }
  }
}

export function scanTemplate(bytes: Uint8Array, clientLogos: string[] = []): ScanResult {
  return new TemplateScanner(DocxPackage.open(bytes), clientLogos).run();
}

/** Bookmark names already in a prepared template, in document order. */
export function anchorsIn(bytes: Uint8Array): string[] {
  const pkg = DocxPackage.open(bytes);
  return pkg.textParts().flatMap((part) =>
    descendants(pkg.xml(part).documentElement as El, "bookmarkStart")
      .map((el) => attr(el, "name") ?? "")
      .filter((name) => name.startsWith("gp_")),
  );
}

export { isEl };
