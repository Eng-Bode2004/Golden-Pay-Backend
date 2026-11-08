/**
 * Moving and adding places (bookmarks) in a prepared template, for the visual mapper's
 * drag and drop. A place is addressed by its paragraph (document order within a part,
 * the same order the mapper page uses) and a character offset inside that paragraph.
 * Only bookmarks change: the client's text, tables and formatting are untouched.
 */
import { ancestor, attr, children, child, descendants, DocxPackage, type El, insertAfter, local, NS, remove, symText, textOf, wEl } from "./docx.ts";

/** Paragraphs of a part in document order, without the legacy duplicates Word keeps in fallbacks. */
export function paragraphsOf(pkg: DocxPackage, part: string): El[] {
  return descendants(pkg.xml(part).documentElement as El, "p").filter((paragraph) => !ancestor(paragraph, "Fallback", NS.mc));
}

/** Length a paragraph-level element adds to the paragraph's text (text boxes count as zero). */
export function lengthOf(node: El): number {
  if (local(node) === "sdt" && descendants(node, "checkbox", NS.w14).length) return 1;
  return ["r", "sdt", "hyperlink", "ins", "smartTag", "customXml", "fldSimple"].includes(local(node)) ? textOf(node).length : 0;
}

function nextBookmarkId(pkg: DocxPackage): number {
  let max = 900000;
  for (const part of pkg.textParts()) {
    for (const mark of descendants(pkg.xml(part).documentElement as El, "bookmarkStart")) {
      max = Math.max(max, Number(attr(mark, "id")) || 0);
    }
  }
  return max + 1;
}

/** Removes a place. Returns true when it existed. */
export function removePlace(pkg: DocxPackage, name: string): boolean {
  let found = false;
  for (const part of pkg.textParts()) {
    const root = pkg.xml(part).documentElement as El;
    for (const start of descendants(root, "bookmarkStart").filter((el) => attr(el, "name") === name)) {
      const id = attr(start, "id");
      for (const end of descendants(root, "bookmarkEnd").filter((el) => attr(el, "id") === id)) remove(end);
      remove(start);
      found = true;
    }
  }
  return found;
}

/** Splits a run so that a new run starts `cut` characters into it. Returns the second half. */
function splitRun(run: El, cut: number): El | null {
  // One text per run first, as the scanner does.
  const parts = children(run).filter((el) => local(el) !== "rPr");
  if (parts.length > 1) {
    const rPr = child(run, "rPr");
    let after: El = run;
    for (const part of parts.slice(1)) {
      const clone = run.cloneNode(false) as El;
      if (rPr) clone.appendChild(rPr.cloneNode(true));
      clone.appendChild(part);
      insertAfter(clone, after);
      after = clone;
    }
    let offset = 0;
    for (let node: El | null = run; node && local(node) === "r"; node = node.nextSibling as El | null) {
      const length = textOf(node).length;
      if (cut === offset) return node;
      if (cut < offset + length) return splitRun(node, cut - offset);
      offset += length;
      if (node === after) break;
    }
    return null;
  }
  const t = child(run, "t");
  if (!t) return null;
  const text = t.textContent ?? "";
  const clone = run.cloneNode(true) as El;
  t.textContent = text.slice(0, cut);
  t.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve");
  const cloneT = child(clone, "t")!;
  cloneT.textContent = text.slice(cut);
  cloneT.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve");
  insertAfter(clone, run);
  return clone;
}

/**
 * The paragraph-level node that starts at character `at` (splitting a run there when the
 * spot falls inside one), or null for the paragraph's end.
 */
export function splitAt(paragraph: El, at: number): El | null {
  let position = 0;
  for (const node of children(paragraph)) {
    const length = lengthOf(node);
    if (!length) continue;
    if (at === position) return node;
    if (at < position + length) {
      if (local(node) !== "r") throw new PlaceError("The selection starts or ends inside a link or a form field; select whole words around it");
      const second = splitRun(node, at - position);
      if (!second) throw new PlaceError("This text cannot be split here; select whole words");
      return second;
    }
    position += length;
  }
  return null;
}

export interface PlaceTarget {
  part: string;
  paragraph: number;
  offset: number;
}

export class PlaceError extends Error {}

/**
 * Inserts an empty bookmark (a point) at a character offset of a paragraph. A point at the
 * start of an empty cell or text box fills that cell; anywhere else the value is written
 * right after the text before it.
 */
export function insertPlace(pkg: DocxPackage, name: string, target: PlaceTarget): { inCell: boolean; label: string } {
  if (!pkg.textParts().includes(target.part)) throw new PlaceError("Unknown part of the document");
  const paragraph = paragraphsOf(pkg, target.part)[target.paragraph];
  if (!paragraph) throw new PlaceError("That paragraph does not exist");
  const doc = paragraph.ownerDocument!;
  const id = String(nextBookmarkId(pkg));
  const start = wEl(doc, "bookmarkStart", { id, name });
  const end = wEl(doc, "bookmarkEnd", { id });

  // Inside another place's range the value would be overwritten together with it.
  const open = new Set<string>();
  let offset = 0;
  let before: El | null = null;
  let placed = false;
  for (const node of children(paragraph)) {
    const kind = local(node);
    if (kind === "pPr") {
      before = node;
      continue;
    }
    if (kind === "bookmarkStart" && (attr(node, "name") ?? "").startsWith("gp_")) {
      const next = node.nextSibling as El | null;
      const point = next && next.nodeType === 1 && local(next) === "bookmarkEnd" && attr(next, "id") === attr(node, "id");
      if (!point) open.add(attr(node, "id") ?? "");
    }
    if (kind === "bookmarkEnd") open.delete(attr(node, "id") ?? "");
    const length = lengthOf(node);
    if (target.offset <= offset) break;
    if (target.offset < offset + length) {
      if (open.size) throw new PlaceError("This spot is inside another place; drop it before or after it");
      if (kind === "r") {
        const second = splitRun(node, target.offset - offset);
        if (second) {
          second.parentNode!.insertBefore(start, second);
          second.parentNode!.insertBefore(end, second);
          placed = true;
        }
      }
      if (!placed) {
        node.parentNode!.insertBefore(start, node);
        node.parentNode!.insertBefore(end, node);
        placed = true;
      }
      break;
    }
    offset += length;
    before = node;
  }
  if (!placed) {
    if (open.size) throw new PlaceError("This spot is inside another place; drop it before or after it");
    if (before) insertAfter(start, before);
    else paragraph.insertBefore(start, paragraph.firstChild);
    insertAfter(end, start);
  }

  const text = textOf(paragraph);
  const holder = ancestor(paragraph, "tc") ?? ancestor(paragraph, "txbxContent");
  const inCell = Boolean(holder) && target.offset === 0 && !text.trim();
  // A label for the mapper: the words just before the point, or the cell's row.
  // The nearest words before the point that are more than punctuation ("عنوان العميل : /" → "عنوان العميل").
  const words = (part: string) => part.replace(/[\s\-–ـ./\\()_.…]+/g, " ").trim();
  let label = words(
    text
      .slice(0, Math.min(target.offset, text.length))
      .split(/[:：]/)
      .filter((part) => words(part).length > 1)
      .pop() ?? "",
  );
  if (!label && holder && local(holder) === "tc") {
    const row = ancestor(holder, "tr");
    const cells = row ? children(row, "tc") : [];
    const index = cells.indexOf(holder);
    label = cells.slice(0, index).map((cell) => textOf(cell).trim()).filter(Boolean).pop() ?? "";
  }
  return { inCell, label: label.slice(-60) || "نقطة جديدة" };
}

/**
 * Wraps characters `target.offset` to `end` of one paragraph in a place, so the client's own
 * sentence becomes the point (a statement that prints only when it is proven). Runs are split
 * at both edges; the text and its formatting stay exactly as they are.
 * Returns the wrapped text.
 */
export function wrapPlace(pkg: DocxPackage, name: string, target: PlaceTarget, end: number): string {
  if (!pkg.textParts().includes(target.part)) throw new PlaceError("Unknown part of the document");
  const paragraph = paragraphsOf(pkg, target.part)[target.paragraph];
  if (!paragraph) throw new PlaceError("That paragraph does not exist");
  const whole = textOf(paragraph);
  const total = whole.length;
  let from = Math.max(0, Math.min(target.offset, total));
  let to = Math.min(end, total);
  // A double-click often takes the space after a word too.
  while (from < to && /\s/.test(whole[from]!)) from += 1;
  while (to > from && /\s/.test(whole[to - 1]!)) to -= 1;
  if (to <= from) throw new PlaceError("Select the sentence's text first");

  // The selection may not overlap another place: it would be printed or removed with it.
  const open = new Set<string>();
  let offset = 0;
  for (const node of children(paragraph)) {
    const kind = local(node);
    if (kind === "bookmarkStart" && (attr(node, "name") ?? "").startsWith("gp_")) {
      const next = node.nextSibling as El | null;
      const point = next && next.nodeType === 1 && local(next) === "bookmarkEnd" && attr(next, "id") === attr(node, "id");
      if (offset > from && offset < to) throw new PlaceError("The selected text contains another point; select only the sentence");
      if (!point) open.add(attr(node, "id") ?? "");
    }
    if (kind === "bookmarkEnd" && open.delete(attr(node, "id") ?? "") && offset > from && offset < to) {
      throw new PlaceError("The selected text overlaps another place; select only the sentence");
    }
    const length = lengthOf(node);
    if (length && open.size && offset < to && offset + length > from) {
      throw new PlaceError("The selected text is already part of another place");
    }
    if (descendants(node, "bookmarkStart").some((mark) => (attr(mark, "name") ?? "").startsWith("gp_")) && offset < to && offset + length > from) {
      throw new PlaceError("The selected text contains another point; select only the sentence");
    }
    offset += length;
  }

  /** The node a boundary at `at` goes before (splitting a run there), or null for the paragraph's end. */
  const boundary = (at: number) => splitAt(paragraph, at);
  const doc = paragraph.ownerDocument!;
  const id = String(nextBookmarkId(pkg));
  // The end first: splitting at the start never moves a node after it.
  const endNode = boundary(to);
  const startNode = boundary(from)!;
  const startMark = wEl(doc, "bookmarkStart", { id, name });
  const endMark = wEl(doc, "bookmarkEnd", { id });
  startNode.parentNode!.insertBefore(startMark, startNode);
  if (endNode) endNode.parentNode!.insertBefore(endMark, endNode);
  else paragraph.appendChild(endMark);
  return textOf(paragraph).slice(from, to);
}

/** Whether a place wraps client content (a sentence, a box) rather than being an empty point. */
export function placeHasContent(pkg: DocxPackage, name: string): boolean {
  for (const part of pkg.textParts()) {
    const root = pkg.xml(part).documentElement as El;
    const start = descendants(root, "bookmarkStart").find((el) => attr(el, "name") === name);
    if (!start) continue;
    const end = descendants(root, "bookmarkEnd").find((el) => attr(el, "id") === attr(start, "id"));
    if (!end || end.parentNode !== start.parentNode) return true;
    for (let node = start.nextSibling; node && node !== end; node = node.nextSibling) {
      if (node.nodeType === 1 && !["bookmarkStart", "bookmarkEnd", "proofErr"].includes(local(node as El))) return true;
    }
    return false;
  }
  return false;
}

/** Gives a place a new name, keeping exactly what it wraps. */
export function renamePlace(pkg: DocxPackage, from: string, to: string): boolean {
  let found = false;
  for (const part of pkg.textParts()) {
    for (const start of descendants(pkg.xml(part).documentElement as El, "bookmarkStart").filter((el) => attr(el, "name") === from)) {
      start.setAttributeNS(NS.w, "w:name", to);
      found = true;
    }
  }
  return found;
}

// ───────────── drawn checkbox positions ─────────────

const EMU_PER_MM = 36000;
const PT_PER_MM = 72 / 25.4;

/** The floating drawn shapes a place wraps: DrawingML anchors and their legacy VML copies. */
function floatingShapes(pkg: DocxPackage, name: string): { anchors: El[]; vml: El[] } {
  for (const part of pkg.textParts()) {
    const root = pkg.xml(part).documentElement as El;
    const start = descendants(root, "bookmarkStart").find((el) => attr(el, "name") === name);
    if (!start) continue;
    const end = descendants(root, "bookmarkEnd").find((el) => attr(el, "id") === attr(start, "id"));
    const anchors: El[] = [];
    const vml: El[] = [];
    for (let node = start.nextSibling; node && node !== end; node = node.nextSibling) {
      if (node.nodeType !== 1) continue;
      anchors.push(...descendants(node as El, "anchor", NS.wp));
      vml.push(
        ...["rect", "shape", "roundrect", "oval"]
          .flatMap((shape) => descendants(node as El, shape, NS.v))
          .filter((shape) => /position:\s*absolute/.test(shape.getAttribute("style") ?? "")),
      );
    }
    return { anchors, vml };
  }
  throw new PlaceError("This point is not in the layout");
}

/** Whether a place is a drawn box floating at a fixed spot (rather than flowing with the text). */
export function isFloatingBox(pkg: DocxPackage, name: string): boolean {
  try {
    const { anchors, vml } = floatingShapes(pkg, name);
    return anchors.length > 0 || vml.length > 0;
  } catch {
    return false;
  }
}

/** Where a floating drawn box sits from the left, in mm (null when it flows with the text). */
export function boxOffset(pkg: DocxPackage, name: string): number | null {
  const { anchors, vml } = floatingShapes(pkg, name);
  const position = anchors[0] ? descendants(anchors[0], "positionH", NS.wp)[0] : undefined;
  const offset = position ? descendants(position, "posOffset", NS.wp)[0] : undefined;
  if (offset) return Math.round((Number(offset.textContent ?? 0) / EMU_PER_MM) * 10) / 10;
  const margin = /margin-left:\s*(-?[\d.]+)pt/.exec(vml[0]?.getAttribute("style") ?? "");
  return margin ? Math.round((Number(margin[1]) / PT_PER_MM) * 10) / 10 : null;
}

/**
 * Moves a floating drawn box sideways by `dxMm` millimetres (positive: to the right), in both
 * the modern drawing and its legacy copy, so Word and LibreOffice draw it at the same spot.
 * Only the box moves; the client's text stays where it is.
 */
export function nudgeBox(pkg: DocxPackage, name: string, dxMm: number): void {
  const { anchors, vml } = floatingShapes(pkg, name);
  if (!anchors.length && !vml.length) throw new PlaceError("This box flows with the text, so it already stays next to its option");
  for (const anchor of anchors) {
    const position = descendants(anchor, "positionH", NS.wp)[0];
    const offset = position ? descendants(position, "posOffset", NS.wp)[0] : undefined;
    if (!offset) throw new PlaceError("Word aligns this box automatically; it cannot be moved by a fixed amount");
    offset.textContent = String(Math.round(Number(offset.textContent ?? 0) + dxMm * EMU_PER_MM));
  }
  for (const shape of vml) {
    const style = shape.getAttribute("style") ?? "";
    const match = /margin-left:\s*(-?[\d.]+)pt/.exec(style);
    if (!match) continue;
    const moved = Math.round((Number(match[1]) + dxMm * PT_PER_MM) * 100) / 100;
    shape.setAttribute("style", style.replace(match[0], `margin-left:${moved}pt`));
  }
}

function within(node: Node, holder: Node): boolean {
  for (let current: Node | null = node; current; current = current.parentNode) if (current === holder) return true;
  return false;
}

/**
 * A small document holding only the part of the page around some places: the rows of the
 * table (or the paragraphs) that contain them, with the page's size and margins, and no
 * header or footer. Used to preview a few boxes quickly.
 */
export function excerptLayout(bytes: Uint8Array, names: string[], pick?: (pkg: DocxPackage) => El[]): Uint8Array {
  const pkg = DocxPackage.open(bytes);
  const root = pkg.xml("word/document.xml").documentElement as El;
  const body = child(root, "body");
  if (!body) throw new PlaceError("The layout has no body");
  const starts = pick
    ? pick(pkg).filter((el) => within(el, body))
    : descendants(body, "bookmarkStart").filter((el) => names.includes(attr(el, "name") ?? ""));
  if (!starts.length) throw new PlaceError("This part is not in the page body; check it in the PDF preview");
  const topOf = (node: El): El => {
    let current = node;
    while (current.parentNode && current.parentNode !== body) current = current.parentNode as El;
    return current;
  };
  const blocks = new Set(starts.map(topOf));
  for (const block of children(body)) {
    const kind = local(block);
    if (kind === "sectPr") {
      for (const name of ["headerReference", "footerReference", "titlePg"]) for (const item of children(block, name)) remove(item);
      continue;
    }
    if (!blocks.has(block)) {
      remove(block);
      continue;
    }
    if (kind === "tbl") {
      for (const row of children(block, "tr")) {
        if (!starts.some((start) => within(start, row))) remove(row);
      }
    }
  }
  // Word needs a paragraph after a table at the end of the body.
  const last = children(body).filter((node) => local(node) !== "sectPr").pop();
  if (last && local(last) === "tbl") {
    const sect = child(body, "sectPr");
    const paragraph = wEl(root.ownerDocument!, "p");
    if (sect) body.insertBefore(paragraph, sect);
    else body.appendChild(paragraph);
  }
  return pkg.save();
}

/** Characters that draw a checkbox in a client's text. */
const BOX_CHARS = /[☐☑☒□■▢◻◼✓✔]/g;

/**
 * Deletes a checkbox from the page together with its place: a Word checkbox control, a box
 * character (☐, or a Wingdings box symbol), or a small drawn square. Words around it stay.
 * Returns false when the place holds no box.
 */
export function removeBox(pkg: DocxPackage, name: string): boolean {
  for (const part of pkg.textParts()) {
    const root = pkg.xml(part).documentElement as El;
    const start = descendants(root, "bookmarkStart").find((el) => attr(el, "name") === name);
    if (!start) continue;
    const end = descendants(root, "bookmarkEnd").find((el) => attr(el, "id") === attr(start, "id"));
    const inside: El[] = [];
    for (let node = start.nextSibling; node && node !== end; node = node.nextSibling) if (node.nodeType === 1) inside.push(node as El);
    let removed = false;
    for (const node of inside) {
      const kind = local(node);
      if (kind === "sdt" && descendants(node, "checkbox", NS.w14).length) {
        remove(node);
        removed = true;
        continue;
      }
      const runs = kind === "r" ? [node] : descendants(node, "r");
      for (const run of runs) {
        // A drawn square (a shape without a picture) or a Wingdings box symbol.
        const drawing = children(run).find((item) => ["drawing", "pict", "AlternateContent"].includes(local(item)));
        if (drawing && !descendants(drawing, "blip", NS.a).length && !descendants(drawing, "imagedata", NS.v).length) {
          remove(drawing);
          removed = true;
        }
        for (const sym of children(run, "sym")) {
          if (symText(sym)) {
            remove(sym);
            removed = true;
          }
        }
        for (const t of children(run, "t")) {
          const text = t.textContent ?? "";
          const cleaned = text.replace(BOX_CHARS, "");
          if (cleaned !== text) {
            t.textContent = cleaned;
            t.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve");
            removed = true;
          }
        }
        if (!children(run).some((item) => local(item) !== "rPr" && (local(item) !== "t" || (item.textContent ?? "") !== ""))) remove(run);
      }
    }
    if (!removed) return false;
    removePlace(pkg, name);
    return true;
  }
  return false;
}
