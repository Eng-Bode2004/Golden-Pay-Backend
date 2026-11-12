/**
 * Fills a prepared client template with one case's data. Only recorded answers, case
 * data and the template's own fixed text appear in the result. Statements that claim a
 * visit, interview or check print only when confirmed and supported by evidence; blanks
 * without an answer stay blank and are reported as missing.
 */
import { DOMParser } from "@xmldom/xmldom";
import {
  ancestor,
  attr,
  child,
  children,
  descendants,
  DocxPackage,
  type El,
  imageKind,
  imageSize,
  insertAfter,
  isW,
  local,
  NS,
  remove,
  textOf,
  wEl,
} from "./docx.ts";
import {
  allFields,
  type Answers,
  evaluate,
  type EvidenceContext,
  type FieldDef,
  isFilled,
  isRequired,
  missingEvidence,
  statementBlanks,
  editedStatement,
  statementText,
  type TemplateDefinition,
  visibleFields,
} from "./definition.ts";
import type { Binding } from "./scan.ts";

export interface RenderImage {
  bytes: Uint8Array;
}

export interface RenderData {
  definition: TemplateDefinition;
  answers: Answers;
  /** Case values by name (`subject_name`, `report_date`…), already formatted. */
  caseValues: Record<string, string | null | undefined>;
  /** Pictures per field key (photos and signatures). */
  images: Record<string, RenderImage[]>;
  /** The Golden Pay stamp, given only once the report is approved. */
  stamp?: Uint8Array | null;
  evidence: EvidenceContext;
  /** Show field names instead of values: used by the mapping preview. */
  preview?: "labels" | null;
  /**
   * The layout's places and their kinds. Inline values, statements and checkboxes are
   * written where they stand; only "cell" places fill their whole (empty) cell.
   */
  slots?: { anchor: string; kind: string }[] | null;
}

export type IssueKind = "missing" | "unsupported_statement" | "unconfirmed_statement" | "unplaced" | "awaiting_approval";
export interface RenderIssue {
  kind: IssueKind;
  key?: string;
  label: string;
  message: string;
}

export interface RenderResult {
  docx: Uint8Array;
  issues: RenderIssue[];
}

interface Mark {
  part: string;
  start: El;
  end: El | null;
}

const ARABIC = /[؀-ۿ]/;
/** A ticked box picture, swapped in for a client's box picture so the box keeps its exact size. */
const TICKED_BOX = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAMbSURBVHhe7ZutksIwFIUrkUgkEolEIpFIJBLJGyCRPAKPgEQikUgkEolEdud0pjuXm9M2aVOmKflmzuxutn/nNJcmAZLL5ZLudrufFLwn+CVJkp9U5j0GEAP4DGA+nxu10hfBW2UA+LuvMK8xANbYV5jXGABr7CvMawyANfYV5jUGwBpD4na7pev1OhvkLJfLbIJTBPMadAAwPxwOP64fOp/PetMM5jXYAF6vVzoejw3z0GQy0ZtnMK/BBoDuro1LMZjXIAM4HA6GYanRaKR3yWBegwvger2mg8HAMC2FgBjMa1ABlNV9rtlslr7fb71rBvMaVACr1cowLIUnwuPx0Lv9w7wGE8DxeDQMa51OJ73bB8xrEAHc7/fKut9sNno3A+a18wGgnvFc14al8P+iupcwr50PAMNcbVgKPQM9xAbmtdMB2NQ9trGFee1sADZ1j97hAvPayQB81r2Eee1kAHhF14alXOpewrx2LgA8y7VhLZe6lzCvzgFgpIURWb4AgbG5L3BsNr+Xwrnrwrw6BVD0wlT3jkhQzxjH62NLYR6A+UBdmFenAMrm4E1D2G63xjGlEHzT3sa8OgVQNhPDBRYtRVVhU/dFU1wXmFenAKq6KEIoW5Rk2NQ9ep4PmFenAGzuFMxgsdKGb9S9hHl1CgBUjc2hqnl5jj63lo+6l+jz1QoAVC1MQLhzZSFkH1Ai+0n5qHsJ81orAHTdxWJhXLAWhqus+z6fz2zhUm8vhXGGb5jXWgEAm/qFptOpEYL+qIoWwkFIvmFeawcAYAwGtQEt9JZ84qLPx+T6JLFFn7txAAB3qmx8kAsh2NS96/ldYF4bBwDwYmcTQpXaqHsJ8+olAFD0RqWt2qp7CfPqLQCAENhkyUZt1b2EefUaAMB8wDWEpue0hXn1HgCwGTLnKnsryzfMaysBAJsVXdshsy+Y19YCAPv93jAtVfVWlm+Y11YDAPr4ubAA8m30tXwlAIByyB+R+NnGOWxgXr8SQFdgXmMArLGvMK8xANbYV5jXGABr7CvMawxAN/781+Z+STGAGMAuTX796/N/yMybS4xhwkEAAAAASUVORK5CYII="), (c) => c.charCodeAt(0));
const EMU_PER_TWIP = 635;
const CM = 360000;

const formatDate = (value: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
};

export function formatValue(field: FieldDef | undefined, value: unknown): string {
  if (!isFilled(value)) return "";
  if (Array.isArray(value)) {
    if (field?.type === "table") {
      return value
        .map((row, index) =>
          typeof row === "object" && row
            ? `${index + 1}) ${(field.columns ?? [])
                .map((column) => ((row as Record<string, unknown>)[column.key] ? `${column.label}: ${formatValue(column, (row as Record<string, unknown>)[column.key])}` : ""))
                .filter(Boolean)
                .join(" — ")}`
            : "",
        )
        .filter(Boolean)
        .join("\n");
    }
    return value.map(String).join("، ");
  }
  if (field?.type === "date") return formatDate(String(value));
  if (field?.type === "attestation") return field.statement ?? "";
  return String(value);
}

export class TemplateRenderer {
  private readonly pkg: DocxPackage;
  private readonly marks = new Map<string, Mark>();
  private readonly fields = new Map<string, FieldDef>();
  private readonly visible: Set<string>;
  private readonly issues: RenderIssue[] = [];
  private readonly placed = new Set<string>();
  private docPrId = 7000;

  constructor(
    template: Uint8Array,
    private readonly bindings: Binding[],
    private readonly data: RenderData,
  ) {
    this.pkg = DocxPackage.open(template);
    for (const field of allFields(data.definition)) this.fields.set(field.key, field);
    this.visible = new Set(visibleFields(data.definition, data.answers).map((field) => field.key));
    for (const part of this.pkg.textParts()) {
      const root = this.pkg.xml(part).documentElement as El;
      const ends = new Map(descendants(root, "bookmarkEnd").map((el) => [attr(el, "id"), el]));
      for (const start of descendants(root, "bookmarkStart")) {
        const name = attr(start, "name") ?? "";
        if (name.startsWith("gp_")) this.marks.set(name, { part, start, end: ends.get(attr(start, "id")) ?? null });
      }
      this.docPrId = Math.max(
        this.docPrId,
        ...descendants(root, "docPr", NS.wp).map((el) => Number(el.getAttribute("id")) + 1 || 0),
      );
    }
  }

  render(): RenderResult {
    const order: Binding["action"][] = ["clear", "check", "choose", "text", "image", "rows", "statement"];
    const rowsDone = new Set<string>();
    for (const action of order) {
      for (const binding of this.bindings.filter((item) => item.action === action)) {
        if (action === "rows") {
          if (rowsDone.has(binding.source ?? "")) continue;
          rowsDone.add(binding.source ?? "");
          this.rows(this.bindings.filter((item) => item.action === "rows" && item.source === binding.source));
          continue;
        }
        const mark = this.marks.get(binding.anchor);
        if (!mark) continue;
        this.apply(binding, mark);
      }
    }
    this.reportMissing();
    this.appendix();
    this.stripBookmarks();
    return { docx: this.pkg.save(), issues: this.issues };
  }

  // ───────────── values ─────────────

  private fieldOf(source: string | undefined): FieldDef | undefined {
    return source?.startsWith("answers.") ? this.fields.get(source.slice(8)) : undefined;
  }

  private value(source: string | undefined): unknown {
    if (!source) return undefined;
    if (source.startsWith("answers.")) {
      const key = source.slice(8);
      if (this.fields.has(key) && !this.visible.has(key)) return undefined;
      return this.data.answers[key];
    }
    if (source.startsWith("case.")) return this.data.caseValues[source.slice(5)] ?? undefined;
    return undefined;
  }

  private text(source: string | undefined): string {
    const field = this.fieldOf(source);
    if (this.data.preview === "labels") {
      if (source?.startsWith("case.")) return `«${source.slice(5)}»`;
      return field ? `«${field.label}»` : "";
    }
    if (field?.type === "attestation") {
      const value = this.value(source);
      return value === true || value === "true" ? statementText(field, this.data.answers) : "";
    }
    return formatValue(field, this.value(source));
  }

  private apply(binding: Binding, mark: Mark): void {
    const key = binding.source?.startsWith("answers.") ? binding.source.slice(8) : undefined;
    if (key) this.placed.add(key);
    switch (binding.action) {
      case "text":
        this.writeAt(mark, this.text(binding.source));
        break;
      case "choose":
        this.fillContainer(this.container(mark) ?? mark.start.parentNode as El, this.text(binding.source));
        break;
      case "check": {
        const value = this.value(binding.source);
        const chosen = Array.isArray(value) ? value.map(String) : isFilled(value) ? [String(value)] : [];
        this.setBox(mark, this.data.preview === "labels" ? false : chosen.includes(binding.option ?? ""));
        break;
      }
      case "clear":
        this.clearRange(mark, true);
        break;
      case "image":
        this.image(binding, mark);
        break;
      case "statement":
        this.statement(binding, mark);
        break;
    }
  }

  // ───────────── locating ─────────────

  /** Nodes between a bookmark's start and end, in the same parent. */
  private range(mark: Mark): El[] {
    const out: El[] = [];
    if (!mark.end || mark.end.parentNode !== mark.start.parentNode) return out;
    for (let node = mark.start.nextSibling; node && node !== mark.end; node = node.nextSibling) {
      if (node.nodeType === 1) out.push(node as El);
    }
    return out;
  }

  /** The cell or text box a point bookmark marks, when it opens an otherwise empty slot. */
  private container(mark: Mark): El | undefined {
    const kind = this.data.slots?.find((slot) => slot.anchor === attr(mark.start, "name"))?.kind;
    if (kind && ["inline", "statement", "checkbox"].includes(kind)) return undefined;
    const paragraph = ancestor(mark.start, "p");
    if (!paragraph) return undefined;
    const holder = ancestor(paragraph, "tc") ?? ancestor(paragraph, "txbxContent");
    if (!holder) return undefined;
    for (let node = mark.start.previousSibling; node; node = node.previousSibling) {
      if (node.nodeType === 1 && local(node as El) !== "pPr" && local(node as El) !== "bookmarkStart" && local(node as El) !== "bookmarkEnd" && textOf(node as El).trim()) {
        return undefined;
      }
    }
    return holder;
  }

  // ───────────── writing text ─────────────

  private runProps(near: El | null | undefined, paragraph: El): El | null {
    const run = near && isW(near, "r") ? near : null;
    const props = run ? child(run, "rPr") : (child(child(paragraph, "pPr") ?? paragraph, "rPr") ?? null);
    if (!props) {
      const first = descendants(paragraph, "r").find((item) => child(item, "rPr"));
      return first ? (child(first, "rPr")!.cloneNode(true) as El) : null;
    }
    const clone = props.cloneNode(true) as El;
    for (const name of ["vanish", "webHidden", "del", "ins"]) remove(child(clone, name));
    return clone;
  }

  private makeRuns(doc: Document, text: string, rPr: El | null): El[] {
    return text.split("\n").map((line, index, lines) => {
      const run = wEl(doc, "r");
      const props = rPr ? (rPr.cloneNode(true) as El) : wEl(doc, "rPr");
      // Arabic text runs right to left; digits, dates and phone numbers must stay left to
      // right or Word mirrors them ("05/11/2026" would read "2026/11/05").
      if (ARABIC.test(line)) {
        if (!child(props, "rtl")) props.appendChild(wEl(doc, "rtl"));
      } else remove(child(props, "rtl"));
      if (props.firstChild) run.appendChild(props);
      const t = wEl(doc, "t");
      t.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve");
      t.textContent = line;
      run.appendChild(t);
      if (index < lines.length - 1) run.appendChild(wEl(doc, "br"));
      return run;
    });
  }

  private writeAt(mark: Mark, text: string): void {
    const holder = this.range(mark).length === 0 ? this.container(mark) : undefined;
    if (holder) {
      this.fillContainer(holder, text);
      return;
    }
    const nodes = this.range(mark);
    const paragraph = ancestor(mark.start, "p");
    if (!paragraph) return;
    if (!nodes.length) {
      // A point blank after a label: add the value after it.
      if (!text) return;
      const before = mark.start.previousSibling as El | null;
      const runs = this.makeRuns(paragraph.ownerDocument!, ` ${text}`, this.runProps(before, paragraph));
      for (const run of runs) mark.start.parentNode!.insertBefore(run, mark.end ?? mark.start.nextSibling);
      return;
    }
    if (!text) return; // Keep the original dots: the blank was not answered.
    const first = nodes.find((node) => isW(node, "r")) ?? nodes[0]!;
    // A blank made of spaces only («معد الاستعلام :      مراجع الاستعلام :») also keeps the
    // next label apart: the value goes before those spaces instead of replacing them.
    const spacesOnly =
      nodes.every((node) => isW(node, "r") && !descendants(node, "drawing").length && !descendants(node, "object").length) &&
      /^[\s ]+$/.test(nodes.map((node) => textOf(node)).join(""));
    // The gap left after the value is what the spaces had room for beyond it (a letter is about
    // two spaces wide), so the line keeps its width and its next label stays apart.
    const gap = spacesOnly
      ? " ".repeat(Math.max(2, Math.round(nodes.map((node) => textOf(node)).join("").length - 2 * text.length)))
      : "";
    const runs = this.makeRuns(paragraph.ownerDocument!, spacesOnly ? ` ${text}${gap}` : text, this.runProps(first, paragraph));
    for (const run of runs) mark.start.parentNode!.insertBefore(run, nodes[0]!);
    for (const node of nodes) remove(node);
  }

  fillContainer(holder: El, text: string): void {
    const paragraphs = children(holder, "p");
    const first = paragraphs[0] ?? (holder.appendChild(wEl(holder.ownerDocument!, "p")) as El);
    const rPr = this.runProps(null, first);
    for (const paragraph of paragraphs.slice(1)) {
      if (!descendants(paragraph, "bookmarkStart").some((el) => (attr(el, "name") ?? "").startsWith("gp_"))) remove(paragraph);
    }
    for (const node of children(first)) {
      if (["pPr", "bookmarkStart", "bookmarkEnd"].includes(local(node))) continue;
      remove(node);
    }
    if (text) for (const run of this.makeRuns(first.ownerDocument!, text, rPr)) first.appendChild(run);
  }

  private clearRange(mark: Mark, all = false): void {
    for (const node of this.range(mark)) {
      if (!all && descendants(node, "bookmarkStart").length) continue;
      remove(node);
    }
  }

  // ───────────── checkboxes ─────────────

  private setBox(mark: Mark, checked: boolean): void {
    const node = this.range(mark).find((item) => ["sdt", "r"].includes(local(item)));
    if (!node) {
      // A small empty frame the client drew as its box (a text box, not a square shape):
      // nothing when unchosen, a tick fitted inside it when chosen.
      const name = attr(mark.start, "name");
      if (this.data.slots?.find((slot) => slot.anchor === name)?.kind === "cell") {
        const frame = ancestor(mark.start, "txbxContent");
        if (checked && frame) {
          const doc = frame.ownerDocument!;
          const tick = this.parseFragment(
            `<w:p xmlns:w="${NS.w}"><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="0" w:line="180" w:lineRule="exact"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Segoe UI Symbol" w:hAnsi="Segoe UI Symbol" w:cs="Segoe UI Symbol"/><w:b/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr><w:t>✓</w:t></w:r></w:p>`,
            doc,
          );
          // The bookmark stays (it names the place); only the frame's text is replaced.
          for (const paragraph of children(frame, "p")) {
            for (const item of children(paragraph)) if (!["bookmarkStart", "bookmarkEnd", "pPr"].includes(local(item))) paragraph.removeChild(item);
          }
          const first = children(frame, "p")[0];
          for (const run of children(tick, "r")) (first ?? frame).appendChild(run);
          if (first) {
            const props = child(first, "pPr");
            if (props) first.replaceChild(child(tick, "pPr")!, props);
            else first.insertBefore(child(tick, "pPr")!, first.firstChild);
          }
        }
        return;
      }
      // A box Head Office placed on the page (or moved there): draw it.
      if (this.isPoint(mark)) this.writeAt(mark, checked ? "☒" : "☐");
      return;
    }
    const doc = node.ownerDocument!;
    if (local(node) === "sdt") {
      const box = descendants(node, "checkbox", NS.w14)[0];
      if (!box) return;
      const flag = descendants(box, "checked", NS.w14)[0];
      flag?.setAttributeNS(NS.w14, "w14:val", checked ? "1" : "0");
      const state = descendants(box, checked ? "checkedState" : "uncheckedState", NS.w14)[0];
      const code = state?.getAttributeNS(NS.w14, "val") ?? (checked ? "2612" : "2610");
      const font = state?.getAttributeNS(NS.w14, "font") ?? "MS Gothic";
      for (const run of descendants(node, "r")) {
        const t = child(run, "t") ?? child(run, "sym");
        if (!t) continue;
        const rPr = child(run, "rPr") ?? (run.insertBefore(wEl(doc, "rPr"), run.firstChild) as El);
        remove(child(rPr, "rFonts"));
        rPr.insertBefore(wEl(doc, "rFonts", { ascii: font, hAnsi: font, eastAsia: font, cs: font }), rPr.firstChild);
        const replacement = wEl(doc, "t");
        replacement.textContent = String.fromCharCode(parseInt(code, 16));
        run.replaceChild(replacement, t);
        break;
      }
      return;
    }
    const drawing = child(node, "drawing") ?? child(node, "pict") ?? descendants(node, "AlternateContent", NS.mc)[0];
    if (drawing) {
      if (!checked) return;
      // A floating drawn box keeps its exact place: draw the tick inside it.
      if (writeInsideShape(node, "✓")) return;
      // An inline picture of a box: the same picture frame, showing a ticked box. A ☒ glyph
      // would take a symbol font the converter may lack, and a wider fallback wraps the line.
      const blips = [...descendants(node, "blip", NS.a), ...descendants(node, "imagedata", NS.v)];
      if (blips.length) {
        const rel = this.pkg.addImage(mark.part, TICKED_BOX, "png");
        for (const blip of blips) {
          if (local(blip) === "blip") blip.setAttributeNS(NS.r, "r:embed", rel);
          else blip.setAttributeNS(NS.r, "r:id", rel);
        }
        return;
      }
      // Otherwise show a ticked box character instead.
      const run = wEl(doc, "r");
      const rPr = wEl(doc, "rPr");
      rPr.appendChild(wEl(doc, "rFonts", { ascii: "Segoe UI Symbol", hAnsi: "Segoe UI Symbol", cs: "Segoe UI Symbol" }));
      rPr.appendChild(wEl(doc, "sz", { val: "18" }));
      run.appendChild(rPr);
      const t = wEl(doc, "t");
      t.textContent = "☒";
      run.appendChild(t);
      node.parentNode!.replaceChild(run, node);
      return;
    }
    const sym = child(node, "sym");
    const t = child(node, "t");
    if (!sym && !t) return;
    const original = textOf(node).trim();
    const replacement = wEl(doc, "t");
    replacement.textContent = checked ? "☒" : original === "□" ? "□" : "☐";
    if (sym) node.replaceChild(replacement, sym);
    else node.replaceChild(replacement, t!);
    if (checked) {
      const rPr = child(node, "rPr") ?? (node.insertBefore(wEl(doc, "rPr"), node.firstChild) as El);
      remove(child(rPr, "rFonts"));
      rPr.insertBefore(wEl(doc, "rFonts", { ascii: "Segoe UI Symbol", hAnsi: "Segoe UI Symbol", eastAsia: "Segoe UI Symbol", cs: "Segoe UI Symbol" }), rPr.firstChild);
    }
  }

  // ───────────── images ─────────────

  private parseFragment(xml: string, doc: Document): El {
    const parsed = new DOMParser().parseFromString(xml, "application/xml") as unknown as Document;
    return doc.importNode(parsed.documentElement!, true) as unknown as El;
  }

  private pictureRun(part: string, doc: Document, bytes: Uint8Array, maxCx: number, maxCy: number): El | null {
    const kind = imageKind(bytes);
    if (!kind) return null;
    const rel = this.pkg.addImage(part, bytes, kind);
    const size = imageSize(bytes) ?? { width: 4, height: 3 };
    const scale = Math.min(maxCx / size.width, maxCy / size.height);
    const cx = Math.round(size.width * scale);
    const cy = Math.round(size.height * scale);
    const id = this.docPrId++;
    return this.parseFragment(
      `<w:r xmlns:w="${NS.w}" xmlns:wp="${NS.wp}" xmlns:a="${NS.a}" xmlns:pic="${NS.pic}" xmlns:r="${NS.r}"><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="GP ${id}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="GP ${id}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rel}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`,
      doc,
    );
  }

  private holderWidth(holder: El | undefined): number {
    const width = holder && local(holder) === "tc" ? Number(attr(child(child(holder, "tcPr") ?? holder, "tcW"), "w") ?? 0) : 0;
    if (width > 400) return width * EMU_PER_TWIP;
    if (holder) return 6 * CM;
    // Body text: the page width between the margins.
    const body = child(this.pkg.xml("word/document.xml").documentElement as El, "body");
    const sect = body ? child(body, "sectPr") : undefined;
    const page = Number(attr(sect ? child(sect, "pgSz") : undefined, "w") ?? 11906);
    const margins = sect ? child(sect, "pgMar") : undefined;
    const text = page - Number(attr(margins, "left") ?? 1440) - Number(attr(margins, "right") ?? 1440);
    return Math.max(text, 4000) * EMU_PER_TWIP;
  }

  private image(binding: Binding, mark: Mark): void {
    const nodes = this.range(mark);
    const existing = nodes.find((node) => descendants(node, "blip", NS.a).length || descendants(node, "imagedata", NS.v).length);
    let pictures: Uint8Array[] = [];
    let label = "";
    if (binding.source === "approval.stamp") {
      label = "ختم جولدن باي";
      if (this.data.stamp) pictures = [this.data.stamp];
      else if (this.data.preview !== "labels") {
        this.issues.push({ kind: "awaiting_approval", label, message: "يُضاف ختم جولدن باي بعد اعتماد التقرير فقط." });
      }
    } else if (binding.source?.startsWith("answers.")) {
      const field = this.fieldOf(binding.source);
      label = field?.label ?? "";
      if (field && this.visible.has(field.key)) pictures = (this.data.images[field.key] ?? []).map((image) => image.bytes);
    }

    if (existing) {
      // Replace a picture in place, keeping its frame size; with no picture, remove it.
      const blip = descendants(existing, "blip", NS.a)[0];
      const extent = descendants(existing, "extent", NS.wp)[0];
      if (pictures[0] && blip && extent && imageKind(pictures[0])) {
        const rel = this.pkg.addImage(mark.part, pictures[0], imageKind(pictures[0])!);
        blip.setAttributeNS(NS.r, "r:embed", rel);
        const size = imageSize(pictures[0]);
        if (size) {
          const cx = Number(extent.getAttribute("cx"));
          const cy = Number(extent.getAttribute("cy"));
          const scale = Math.min(cx / size.width, cy / size.height);
          const nx = String(Math.round(size.width * scale));
          const ny = String(Math.round(size.height * scale));
          extent.setAttribute("cx", nx);
          extent.setAttribute("cy", ny);
          const ext = descendants(existing, "ext", NS.a).find((el) => el.getAttribute("cx"));
          ext?.setAttribute("cx", nx);
          ext?.setAttribute("cy", ny);
        }
        remove(descendants(existing, "Fallback", NS.mc)[0]);
        pictures = pictures.slice(1);
      } else {
        remove(existing);
      }
    }
    if (!pictures.length) return;
    const holder = this.container(mark) ?? ancestor(mark.start, "tc");
    const paragraph = ancestor(mark.start, "p");
    if (!paragraph) return;
    const doc = paragraph.ownerDocument!;
    const width = this.holderWidth(holder);
    const stamp = binding.source === "approval.stamp";
    const perRow = stamp || pictures.length === 1 ? 1 : 2;
    const maxCx = stamp ? Math.min(width * 0.9, 3.4 * CM) : Math.min(width / perRow - 0.2 * CM, 8.5 * CM);
    const maxCy = stamp ? 3.4 * CM : 6.2 * CM;
    let anchorNode: Node = mark.end ?? mark.start;
    pictures.forEach((bytes, index) => {
      const run = this.pictureRun(mark.part, doc, bytes, maxCx, maxCy);
      if (!run) {
        this.issues.push({ kind: "missing", label, message: `صورة في «${label}» بصيغة لا يدعمها Word (استخدم JPEG أو PNG).` });
        return;
      }
      if (index > 0) {
        const gap = wEl(doc, "r");
        gap.appendChild(index % perRow === 0 ? wEl(doc, "br") : (() => { const t = wEl(doc, "t"); t.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve"); t.textContent = " "; return t; })());
        insertAfter(gap, anchorNode);
        anchorNode = gap;
      }
      insertAfter(run, anchorNode);
      anchorNode = run;
    });
  }

  // ───────────── statements ─────────────

  /** A bookmark with nothing inside: a spot where the system writes, not client text. */
  private isPoint(mark: Mark): boolean {
    if (!mark.end || mark.end.parentNode !== mark.start.parentNode) return false;
    for (let node = mark.start.nextSibling; node && node !== mark.end; node = node.nextSibling) {
      if (node.nodeType === 1 && !["bookmarkStart", "bookmarkEnd", "proofErr"].includes(local(node as El))) return false;
    }
    return true;
  }

  private statement(binding: Binding, mark: Mark): void {
    const field = this.fieldOf(binding.source);
    if (!field) return;
    const point = this.isPoint(mark);
    if (this.data.preview === "labels") {
      if (point) this.writeAt(mark, `«${field.label}»`);
      return;
    }
    const value = this.value(binding.source);
    const confirmed = value === true || value === "true" || value === "نعم";
    const gaps = confirmed ? missingEvidence(field, this.data.answers, this.data.evidence) : [];
    if (confirmed && !gaps.length) {
      // A placed point: write the statement. A client sentence: keep it as written, unless
      // it has blanks the investigator filled; then it is replaced by the completed sentence.
      if (point || statementBlanks(field.statement) || editedStatement(field, this.data.answers)) {
        this.writeAt(mark, statementText(field, this.data.answers));
      }
      return;
    }
    this.issues.push(
      confirmed
        ? {
            kind: "unsupported_statement",
            key: field.key,
            label: field.label,
            message: `حُذفت العبارة لعدم وجود دليل: ${gaps.join("؛ ")}`,
          }
        : {
            kind: "unconfirmed_statement",
            key: field.key,
            label: field.label,
            message: "لم يؤكد المستعلم هذه العبارة، فلم تُطبع.",
          },
    );
    if (point) return; // Nothing was written there, so nothing to remove.
    this.clearRange(mark, true);
    // An emptied sentence leaves no blank bullet behind, unless the cell would be left empty.
    const paragraph = ancestor(mark.start, "p");
    const holder = paragraph?.parentNode as El | null;
    if (paragraph && holder && !textOf(paragraph).trim() && children(holder, "p").length > 1 && !descendants(paragraph, "drawing").length) {
      remove(paragraph);
    }
  }

  // ───────────── repeating rows ─────────────

  private rows(group: Binding[]): void {
    const field = this.fieldOf(group[0]!.source);
    if (field) this.placed.add(field.key);
    const value = this.value(group[0]!.source);
    const items = this.data.preview === "labels"
      ? [Object.fromEntries((field?.columns ?? []).map((column) => [column.key, `«${column.label}»`]))]
      : Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
    const rows = group
      .map((binding) => this.marks.get(binding.anchor))
      .map((mark) => (mark ? ancestor(mark.start, "tr") : undefined))
      .filter((row): row is El => Boolean(row));
    if (!rows.length) return;
    const columns = group[0]!.columns ?? [];
    const fill = (row: El, item: Record<string, unknown> | undefined) => {
      children(row, "tc").forEach((cell, index) => {
        const key = columns[index];
        if (!key) return;
        const column = field?.columns?.find((entry) => entry.key === key);
        const text = item ? (this.data.preview === "labels" ? String(item[key] ?? "") : formatValue(column, item[key])) : "";
        this.fillContainer(cell, text);
      });
    };
    rows.forEach((row, index) => fill(row, items[index]));
    let last = rows[rows.length - 1]!;
    for (const item of items.slice(rows.length)) {
      const clone = last.cloneNode(true) as El;
      for (const mark of [...descendants(clone, "bookmarkStart"), ...descendants(clone, "bookmarkEnd")]) remove(mark);
      insertAfter(clone, last);
      fill(clone, item);
      last = clone;
    }
  }

  // ───────────── missing data and appendix ─────────────

  private reportMissing(): void {
    if (this.data.preview === "labels") return;
    for (const field of visibleFields(this.data.definition, this.data.answers)) {
      if (field.type === "attestation") continue;
      const hasValue = field.type === "photos" || field.type === "signature"
        ? (this.data.images[field.key]?.length ?? 0) > 0
        : isFilled(this.data.answers[field.key]);
      if (!hasValue && isRequired(field, this.data.answers)) {
        this.issues.push({ kind: "missing", key: field.key, label: field.label, message: `«${field.label}» مطلوب ولم يُدخل.` });
      }
    }
  }

  /** Answers with no place in the client's layout are printed after it, never dropped. */
  private appendix(): void {
    const body = child(this.pkg.xml("word/document.xml").documentElement as El, "body");
    if (!body) return;
    const doc = body.ownerDocument!;
    const extraValues = visibleFields(this.data.definition, this.data.answers).filter(
      (field) => !this.placed.has(field.key) && !["photos", "signature", "attestation"].includes(field.type) &&
        isFilled(this.data.answers[field.key]),
    );
    const extraPhotos = visibleFields(this.data.definition, this.data.answers).filter(
      (field) => !this.placed.has(field.key) && ["photos", "signature"].includes(field.type) && (this.data.images[field.key]?.length ?? 0) > 0,
    );
    const statements = visibleFields(this.data.definition, this.data.answers).filter(
      (field) => field.type === "attestation" && !this.placed.has(field.key) && this.data.answers[field.key] === true &&
        !missingEvidence(field, this.data.answers, this.data.evidence).length,
    );
    if (!extraValues.length && !extraPhotos.length && !statements.length) return;
    for (const field of extraValues) {
      this.issues.push({ kind: "unplaced", key: field.key, label: field.label, message: `«${field.label}» ليس له مكان في نموذج العميل؛ طُبع في الملحق.` });
    }
    const sectPr = child(body, "sectPr");
    const add = (node: El) => body.insertBefore(node, sectPr ?? null);
    const paragraph = (text: string, opts: { bold?: boolean; size?: number; pageBreak?: boolean; center?: boolean } = {}) => {
      const p = wEl(doc, "p");
      const pPr = wEl(doc, "pPr");
      if (opts.pageBreak) pPr.appendChild(wEl(doc, "pageBreakBefore"));
      pPr.appendChild(wEl(doc, "bidi"));
      pPr.appendChild(wEl(doc, "spacing", { before: "60", after: "60" }));
      if (opts.center) pPr.appendChild(wEl(doc, "jc", { val: "center" }));
      p.appendChild(pPr);
      if (text) {
        const rPr = wEl(doc, "rPr");
        if (opts.bold) {
          rPr.appendChild(wEl(doc, "b"));
          rPr.appendChild(wEl(doc, "bCs"));
        }
        if (opts.size) {
          rPr.appendChild(wEl(doc, "sz", { val: String(opts.size) }));
          rPr.appendChild(wEl(doc, "szCs", { val: String(opts.size) }));
        }
        for (const run of this.makeRuns(doc, text, rPr)) p.appendChild(run);
      }
      return p;
    };
    add(paragraph("ملحق التقرير", { bold: true, size: 30, pageBreak: true, center: true }));
    if (extraValues.length) {
      add(paragraph("بيانات إضافية", { bold: true, size: 24 }));
      const table = wEl(doc, "tbl");
      const tblPr = wEl(doc, "tblPr");
      tblPr.appendChild(wEl(doc, "bidiVisual"));
      tblPr.appendChild(wEl(doc, "tblW", { w: "5000", type: "pct" }));
      const borders = wEl(doc, "tblBorders");
      for (const side of ["top", "left", "bottom", "right", "insideH", "insideV"]) {
        borders.appendChild(wEl(doc, side, { val: "single", sz: "4", space: "0", color: "BFBFBF" }));
      }
      tblPr.appendChild(borders);
      table.appendChild(tblPr);
      const grid = wEl(doc, "tblGrid");
      grid.appendChild(wEl(doc, "gridCol", { w: "3400" }));
      grid.appendChild(wEl(doc, "gridCol", { w: "6200" }));
      table.appendChild(grid);
      for (const field of extraValues) {
        const row = wEl(doc, "tr");
        for (const [text, bold, width] of [[field.label, true, "3400"], [formatValue(field, this.data.answers[field.key]), false, "6200"]] as const) {
          const cell = wEl(doc, "tc");
          const tcPr = wEl(doc, "tcPr");
          tcPr.appendChild(wEl(doc, "tcW", { w: width, type: "dxa" }));
          cell.appendChild(tcPr);
          cell.appendChild(paragraph(text, { bold }));
          row.appendChild(cell);
        }
        table.appendChild(row);
      }
      add(table);
    }
    for (const field of statements) add(paragraph(`• ${statementText(field, this.data.answers)}`));
    for (const field of extraPhotos) {
      add(paragraph(field.label, { bold: true, size: 24 }));
      const holder = paragraph("", { center: true });
      add(holder);
      const marker = wEl(doc, "bookmarkStart", { id: "999999", name: `gp_appendix_${field.key}` });
      holder.appendChild(marker);
      this.image({ anchor: "", action: "image", source: `answers.${field.key}` }, { part: "word/document.xml", start: marker, end: null });
      remove(marker);
    }
  }

  private stripBookmarks(): void {
    for (const part of this.pkg.textParts()) {
      const root = this.pkg.xml(part).documentElement as El;
      const ids = new Set<string>();
      for (const start of descendants(root, "bookmarkStart")) {
        if ((attr(start, "name") ?? "").startsWith("gp_")) {
          ids.add(attr(start, "id") ?? "");
          remove(start);
        }
      }
      for (const end of descendants(root, "bookmarkEnd")) if (ids.has(attr(end, "id") ?? "")) remove(end);
    }
  }
}

/**
 * Writes text inside a floating drawn shape (DrawingML or legacy VML) so it appears exactly
 * where the shape is. Returns false for inline pictures, which have no inside.
 */
export function writeInsideShape(run: El, text: string, halfPoints = 18): boolean {
  const doc = run.ownerDocument!;
  const parse = (xml: string) =>
    doc.importNode(new DOMParser().parseFromString(xml, "application/xml").documentElement!, true) as unknown as El;
  const content = `<w:txbxContent xmlns:w="${NS.w}"><w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="0" w:line="${Math.max(halfPoints * 10, 40)}" w:lineRule="exact"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Segoe UI Symbol" w:hAnsi="Segoe UI Symbol" w:cs="Segoe UI Symbol"/><w:b/><w:sz w:val="${halfPoints}"/><w:szCs w:val="${halfPoints}"/></w:rPr><w:t>${text}</w:t></w:r></w:p></w:txbxContent>`;
  const anchored = descendants(run, "anchor", NS.wp).length > 0;
  const shape = descendants(run, "wsp", NS.wps)[0];
  if (shape && anchored && !descendants(shape, "txbx", NS.wps).length) {
    const body = descendants(shape, "bodyPr", NS.wps)[0];
    if (!body) return false;
    const box = parse(`<wps:txbx xmlns:wps="${NS.wps}">${content}</wps:txbx>`);
    body.parentNode!.insertBefore(box, body);
    for (const name of ["lIns", "tIns", "rIns", "bIns"]) body.setAttribute(name, "0");
    remove(descendants(run, "Fallback", NS.mc)[0]);
    return true;
  }
  const vml = ["rect", "shape", "roundrect", "oval"].flatMap((name) => descendants(run, name, NS.v))
    .find((el) => /position:absolute/.test(el.getAttribute("style") ?? "") && !descendants(el, "textbox", NS.v).length);
  if (vml) {
    const box = parse(`<v:textbox xmlns:v="${NS.v}" inset="0,0,0,0">${content}</v:textbox>`);
    vml.appendChild(box);
    return true;
  }
  return false;
}

export function renderTemplate(template: Uint8Array, bindings: Binding[], data: RenderData): RenderResult {
  return new TemplateRenderer(template, bindings, data).render();
}

/** Fields that have no place in the layout (they go to the appendix). */
export function unplacedFields(definition: TemplateDefinition, bindings: Binding[]): FieldDef[] {
  const placed = new Set(bindings.map((binding) => binding.source?.startsWith("answers.") ? binding.source.slice(8) : ""));
  return allFields(definition).filter((field) => !placed.has(field.key));
}

export { evaluate };
