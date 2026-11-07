/**
 * Moving and adding places (bookmarks) in a prepared template, for the visual mapper's
 * drag and drop. A place is addressed by its paragraph (document order within a part,
 * the same order the mapper page uses) and a character offset inside that paragraph.
 * Only bookmarks change: the client's text, tables and formatting are untouched.
 */
import { ancestor, attr, children, child, descendants, DocxPackage, type El, insertAfter, local, NS, remove, textOf, wEl } from "./docx.ts";

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
