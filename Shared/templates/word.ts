/**
 * Word-like editing of a client's layout from the visual mapper: type, delete and replace
 * text, change its size and weight, and move, resize or delete pictures. Text is addressed
 * like places (paragraph number and character offsets, as the mapper page counts them);
 * pictures by their order in the part. Edits never cut through a place (a field's point
 * or a wrapped sentence), so every binding keeps working.
 */
import { ancestor, attr, child, children, descendants, DocxPackage, type El, local, NS, remove, textOf, wEl } from "./docx.ts";
import { lengthOf, paragraphsOf, PlaceError, type PlaceTarget, splitAt } from "./edit.ts";

const EMU_PER_MM = 36000;
const PT_PER_MM = 72 / 25.4;
const XML_SPACE = "http://www.w3.org/XML/1998/namespace";

/** What a run may hold for its text to be edited: words, tabs and line breaks. */
const PLAIN_RUN = new Set(["rPr", "t", "tab", "br", "cr", "lastRenderedPageBreak", "noBreakHyphen", "softHyphen"]);

function paragraphAt(pkg: DocxPackage, target: PlaceTarget): El {
  if (!pkg.textParts().includes(target.part)) throw new PlaceError("Unknown part of the document");
  const paragraph = paragraphsOf(pkg, target.part)[target.paragraph];
  if (!paragraph) throw new PlaceError("That paragraph does not exist");
  return paragraph;
}

/** Ids of the places (gp_ bookmarks) of a part, so their ends are recognised too. */
function placeIds(pkg: DocxPackage, part: string): Set<string> {
  return new Set(
    descendants(pkg.xml(part).documentElement as El, "bookmarkStart")
      .filter((mark) => (attr(mark, "name") ?? "").startsWith("gp_"))
      .map((mark) => attr(mark, "id") ?? ""),
  );
}

/** The paragraph's direct children covering characters [from, to), after splitting runs at both ends. */
function rangeNodes(paragraph: El, from: number, to: number): { nodes: El[]; after: El | null } {
  const after = splitAt(paragraph, to);
  const first = splitAt(paragraph, from);
  const nodes: El[] = [];
  for (let node = first as Node | null; node && node !== after; node = node.nextSibling) {
    if (node.nodeType === 1) nodes.push(node as El);
  }
  return { nodes, after };
}

function clampRange(paragraph: El, offset: number, end: number): { from: number; to: number } {
  const total = textOf(paragraph).length;
  const from = Math.max(0, Math.min(offset, total));
  return { from, to: Math.max(from, Math.min(end, total)) };
}

/** Runs holding `text`, with the formatting of `rPr`; a new line becomes a line break. */
function runsFor(doc: Document, text: string, rPr: El | null): El[] {
  const run = wEl(doc, "r");
  if (rPr) run.appendChild(rPr.cloneNode(true));
  else if (/[؀-ۿ]/.test(text)) {
    const props = wEl(doc, "rPr");
    props.appendChild(wEl(doc, "rtl"));
    run.appendChild(props);
  }
  text.split("\n").forEach((line, index) => {
    if (index) run.appendChild(wEl(doc, "br"));
    if (!line) return;
    const t = wEl(doc, "t");
    t.setAttributeNS(XML_SPACE, "xml:space", "preserve");
    t.textContent = line;
    run.appendChild(t);
  });
  return [run];
}

/** The formatting new text takes: the run it replaces, else the run before, else the run after. */
function formattingNear(paragraph: El, nodes: El[], at: El | null): El | null {
  const runWithText = (node: El | null | undefined) => (node && local(node) === "r" && textOf(node).length ? node : null);
  let source = nodes.map(runWithText).find(Boolean) ?? null;
  for (let node = (nodes[0] ?? at)?.previousSibling ?? (at ? null : paragraph.lastChild); !source && node; node = node.previousSibling) {
    if (node.nodeType === 1) source = runWithText(node as El);
  }
  for (let node = at as Node | null; !source && node; node = node.nextSibling) {
    if (node.nodeType === 1) source = runWithText(node as El);
  }
  const rPr = source ? child(source, "rPr") : undefined;
  return rPr ?? null;
}

/**
 * Replaces characters `target.offset` to `end` of a paragraph with `text` (an empty range
 * inserts, empty text deletes). Text inside a place may be edited, but the change may not
 * reach across a place's edge, a picture, a link or a form field.
 */
export function editText(pkg: DocxPackage, target: PlaceTarget, end: number, text: string): void {
  const paragraph = paragraphAt(pkg, target);
  const { from, to } = clampRange(paragraph, target.offset, end);
  if (from === to && !text) throw new PlaceError("Nothing to change");
  if (text.length > 4000) throw new PlaceError("That text is too long for one line");
  const doc = paragraph.ownerDocument!;
  const places = placeIds(pkg, target.part);

  if (from === to) {
    const at = splitAt(paragraph, from);
    // Typed right where a field's point sits: the words belong before the point.
    let before: Node | null = at;
    for (;;) {
      const previous: Node | null = before ? before.previousSibling : paragraph.lastChild;
      if (!previous || previous.nodeType !== 1) break;
      const node = previous as El;
      const kind = local(node);
      if (kind === "proofErr") {
        before = node;
        continue;
      }
      if (kind === "bookmarkEnd" && places.has(attr(node, "id") ?? "")) {
        const start = node.previousSibling as El | null;
        if (start && start.nodeType === 1 && local(start) === "bookmarkStart" && attr(start, "id") === attr(node, "id")) {
          before = start;
          continue;
        }
      }
      break;
    }
    const rPr = formattingNear(paragraph, [], at);
    for (const run of runsFor(doc, text, rPr)) {
      if (before) before.parentNode!.insertBefore(run, before);
      else paragraph.appendChild(run);
    }
    return;
  }

  // Check the whole range before changing anything.
  const probe = DocxPackage.open(pkg.save());
  const probeParagraph = paragraphAt(probe, target);
  for (const node of rangeNodes(probeParagraph, from, to).nodes) checkEditable(node, places);

  const { nodes, after } = rangeNodes(paragraph, from, to);
  const rPr = formattingNear(paragraph, nodes, after);
  let insertBefore: Node | null = after;
  for (const node of nodes) {
    const kind = local(node);
    if (kind === "r" || kind === "proofErr") remove(node);
  }
  if (text) {
    // Bookmarks the range held (not places) stay where the words were.
    const kept = nodes.filter((node) => node.parentNode === paragraph);
    if (kept.length) insertBefore = kept[0]!;
    for (const run of runsFor(doc, text, rPr ? (rPr.cloneNode(true) as El) : null)) {
      if (insertBefore) insertBefore.parentNode!.insertBefore(run, insertBefore);
      else paragraph.appendChild(run);
    }
  }
}

function checkEditable(node: El, places: Set<string>): void {
  const kind = local(node);
  if ((kind === "bookmarkStart" || kind === "bookmarkEnd") && places.has(attr(node, "id") ?? "")) {
    throw new PlaceError("The change reaches across a field's place; edit the words on one side of it only");
  }
  if (kind === "r") {
    for (const item of children(node)) {
      if (item.namespaceURI === NS.w && PLAIN_RUN.has(local(item))) continue;
      if (descendants(item, "blip", NS.a).length || local(item) === "drawing" || local(item) === "pict" || local(item) === "AlternateContent") {
        throw new PlaceError("The selection includes a picture; move or delete pictures with the picture tools");
      }
      throw new PlaceError("The selection includes a checkbox or a Word field. To delete an option's box, click it in «ربط الحقول» and press «حذف المربع»");
    }
    return;
  }
  if (["bookmarkStart", "bookmarkEnd", "proofErr", "permStart", "permEnd"].includes(kind)) return;
  if (lengthOf(node) === 0) return;
  throw new PlaceError("The selection includes a checkbox, a link or a form field. To delete an option's box, click it in «ربط الحقول» and press «حذف المربع»");
}

// ───────────── formatting ─────────────

/** Word's order of run properties; elements out of order make Word reject the file. */
const RPR_ORDER = [
  "rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike", "dstrike", "outline", "shadow", "emboss",
  "imprint", "noProof", "snapToGrid", "vanish", "webHidden", "color", "spacing", "w", "kern", "position", "sz", "szCs",
  "highlight", "u", "effect", "bdr", "shd", "fitText", "vertAlign", "rtl", "cs", "em", "lang", "eastAsianLayout",
  "specVanish", "oMath",
];

function setProperty(rPr: El, name: string, attrs: Record<string, string> | null): void {
  for (const existing of children(rPr, name)) remove(existing);
  if (!attrs) return;
  const element = wEl(rPr.ownerDocument!, name, attrs);
  const rank = RPR_ORDER.indexOf(name);
  const next = children(rPr).find((item) => RPR_ORDER.indexOf(local(item)) > rank);
  if (next) rPr.insertBefore(element, next);
  else rPr.appendChild(element);
}

export interface TextStyle {
  /** Font size in points. */
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

/** Changes the size, weight, slant or underline of characters `target.offset` to `end`. */
export function styleText(pkg: DocxPackage, target: PlaceTarget, end: number, style: TextStyle): number {
  const paragraph = paragraphAt(pkg, target);
  const { from, to } = clampRange(paragraph, target.offset, end);
  if (from === to) throw new PlaceError("Select the words to format first");
  if (style.size !== undefined && !(style.size >= 4 && style.size <= 96)) throw new PlaceError("Choose a size between 4 and 96");
  const runs = rangeNodes(paragraph, from, to).nodes.flatMap((node) => (local(node) === "r" ? [node] : descendants(node, "r")));
  let changed = 0;
  for (const run of runs) {
    if (!textOf(run).length) continue;
    let rPr = child(run, "rPr");
    if (!rPr) {
      rPr = wEl(run.ownerDocument!, "rPr");
      run.insertBefore(rPr, run.firstChild);
    }
    if (style.size !== undefined) {
      const half = String(Math.round(style.size * 2));
      setProperty(rPr, "sz", { val: half });
      setProperty(rPr, "szCs", { val: half });
    }
    if (style.bold !== undefined) {
      setProperty(rPr, "b", style.bold ? {} : { val: "0" });
      setProperty(rPr, "bCs", style.bold ? {} : { val: "0" });
    }
    if (style.italic !== undefined) {
      setProperty(rPr, "i", style.italic ? {} : { val: "0" });
      setProperty(rPr, "iCs", style.italic ? {} : { val: "0" });
    }
    if (style.underline !== undefined) setProperty(rPr, "u", { val: style.underline ? "single" : "none" });
    changed += 1;
  }
  if (!changed) throw new PlaceError("There are no words to format in the selection");
  return changed;
}

/** The exact text of a paragraph, as the mapper counts characters. */
export function paragraphText(pkg: DocxPackage, target: Omit<PlaceTarget, "offset">): string {
  return textOf(paragraphAt(pkg, { ...target, offset: 0 }));
}

// ───────────── pictures ─────────────

function inFallback(node: Node): boolean {
  for (let parent = node.parentNode; parent; parent = parent.parentNode) {
    if (parent.nodeType === 1 && (parent as El).namespaceURI === NS.mc && local(parent as El) === "Fallback") return true;
  }
  return false;
}

/** Pictures of a part in document order: the drawings (inline or floating) that show an image. */
export function picturesOf(pkg: DocxPackage, part: string): El[] {
  const out: El[] = [];
  const walk = (node: Node) => {
    if (node.nodeType !== 1) return;
    const el = node as El;
    if (el.namespaceURI === NS.mc && local(el) === "Fallback") return;
    if (el.namespaceURI === NS.wp && (local(el) === "inline" || local(el) === "anchor")) {
      if (descendants(el, "blip", NS.a).length) out.push(el);
      return;
    }
    for (let next = el.firstChild; next; next = next.nextSibling) walk(next);
  };
  walk(pkg.xml(part).documentElement as El);
  return out;
}

export interface PictureInfo {
  id: string;
  floating: boolean;
  widthMm: number;
  heightMm: number;
  /** Inside a field's place (a photo or stamp slot): moved with the place, not on its own. */
  inPlace: boolean;
}

function pictureById(pkg: DocxPackage, id: string): { picture: El; part: string } {
  const [part, index] = id.split("|");
  if (!part || !pkg.textParts().includes(part)) throw new PlaceError("Picture not found");
  const picture = picturesOf(pkg, part)[Number(index)];
  if (!picture) throw new PlaceError("Picture not found; reload the page");
  return { picture, part };
}

/** The run holding a picture, and the run's child that carries it (the drawing or its alternate content). */
function holderOf(picture: El): { run: El; item: El } {
  const run = ancestor(picture, "r");
  if (!run) throw new PlaceError("This picture is inside a shape and cannot be moved on its own");
  let item: Node = picture;
  while (item.parentNode && item.parentNode !== run) item = item.parentNode;
  return { run, item: item as El };
}

/** Whether a run sits between the start and end of a field's place in its paragraph. */
function insidePlace(run: El, places: Set<string>): boolean {
  const open = new Set<string>();
  for (let node = run.parentNode?.firstChild ?? null; node && node !== run; node = node.nextSibling) {
    if (node.nodeType !== 1) continue;
    const el = node as El;
    if (local(el) === "bookmarkStart" && places.has(attr(el, "id") ?? "")) open.add(attr(el, "id") ?? "");
    if (local(el) === "bookmarkEnd") open.delete(attr(el, "id") ?? "");
  }
  return open.size > 0;
}

export function pictureInfo(pkg: DocxPackage, id: string): PictureInfo {
  const { picture, part } = pictureById(pkg, id);
  const extent = child(picture, "extent", NS.wp);
  const { run } = holderOf(picture);
  return {
    id,
    floating: local(picture) === "anchor",
    widthMm: Math.round((Number(extent?.getAttribute("cx") ?? 0) / EMU_PER_MM) * 10) / 10,
    heightMm: Math.round((Number(extent?.getAttribute("cy") ?? 0) / EMU_PER_MM) * 10) / 10,
    inPlace: insidePlace(run, placeIds(pkg, part)),
  };
}

/** The legacy (VML) copy Word keeps next to a floating picture, if any. */
function legacyShape(picture: El): El | undefined {
  const alternate = ancestor(picture, "AlternateContent", NS.mc);
  const fallback = alternate ? child(alternate, "Fallback", NS.mc) : undefined;
  return fallback ? ["shape", "rect", "roundrect", "oval"].flatMap((name) => descendants(fallback, name, NS.v))[0] : undefined;
}

function shiftStyle(shape: El | undefined, property: string, deltaPt: number): void {
  if (!shape) return;
  const style = shape.getAttribute("style") ?? "";
  const match = new RegExp(`${property}:\\s*(-?[\\d.]+)pt`).exec(style);
  if (!match) return;
  const value = Math.round((Number(match[1]) + deltaPt) * 100) / 100;
  shape.setAttribute("style", style.replace(match[0], `${property}:${value}pt`));
}

/** Moves a floating picture by millimetres (positive: right and down). */
export function nudgePicture(pkg: DocxPackage, id: string, dxMm: number, dyMm: number): void {
  const { picture } = pictureById(pkg, id);
  if (local(picture) !== "anchor") throw new PlaceError("This picture sits in the text; drag it to another spot instead");
  for (const [axis, delta] of [["positionH", dxMm], ["positionV", dyMm]] as const) {
    if (!delta) continue;
    const position = child(picture, axis, NS.wp);
    const offset = position ? child(position, "posOffset", NS.wp) : undefined;
    if (!offset) throw new PlaceError("Word aligns this picture automatically; drag it to another spot instead");
    offset.textContent = String(Math.round(Number(offset.textContent ?? 0) + delta * EMU_PER_MM));
  }
  const shape = legacyShape(picture);
  shiftStyle(shape, "margin-left", dxMm * PT_PER_MM);
  shiftStyle(shape, "margin-top", dyMm * PT_PER_MM);
}

/** Resizes a picture by a factor, keeping its proportions. */
export function resizePicture(pkg: DocxPackage, id: string, factor: number): void {
  if (!(factor > 0.05 && factor < 20)) throw new PlaceError("Choose a sensible size");
  const { picture } = pictureById(pkg, id);
  const extent = child(picture, "extent", NS.wp);
  if (!extent) throw new PlaceError("This picture has no size to change");
  const cx = Number(extent.getAttribute("cx") ?? 0);
  const cy = Number(extent.getAttribute("cy") ?? 0);
  const width = Math.round(cx * factor);
  const height = Math.round(cy * factor);
  if (width < 3 * EMU_PER_MM || height < 3 * EMU_PER_MM) throw new PlaceError("The picture cannot be smaller than 3 mm");
  if (width > 400 * EMU_PER_MM || height > 400 * EMU_PER_MM) throw new PlaceError("The picture cannot be larger than the page");
  extent.setAttribute("cx", String(width));
  extent.setAttribute("cy", String(height));
  for (const ext of descendants(picture, "ext", NS.a)) {
    // The picture's own frame (a:xfrm/a:ext), not the extension lists that share the name.
    if (local(ext.parentNode as El) !== "xfrm") continue;
    ext.setAttribute("cx", String(Math.round(Number(ext.getAttribute("cx") ?? cx) * factor)));
    ext.setAttribute("cy", String(Math.round(Number(ext.getAttribute("cy") ?? cy) * factor)));
  }
  const shape = legacyShape(picture);
  if (shape) {
    const style = shape.getAttribute("style") ?? "";
    shape.setAttribute(
      "style",
      style.replace(/(width|height):\s*([\d.]+)pt/g, (_, name: string, value: string) => `${name}:${Math.round(Number(value) * factor * 100) / 100}pt`),
    );
  }
}

/**
 * The place (photo, logo or stamp slot) a picture's run sits in: its start and end
 * bookmarks and everything between them, when they share the run's paragraph.
 */
function enclosingPlace(run: El, places: Set<string>): El[] | null {
  const open: El[] = [];
  for (let node = run.parentNode?.firstChild ?? null; node && node !== run; node = node.nextSibling) {
    if (node.nodeType !== 1) continue;
    const el = node as El;
    if (local(el) === "bookmarkStart" && places.has(attr(el, "id") ?? "")) open.push(el);
    if (local(el) === "bookmarkEnd") {
      const index = open.findIndex((start) => attr(start, "id") === attr(el, "id"));
      if (index >= 0) open.splice(index, 1);
    }
  }
  const start = open.pop();
  if (!start) return null;
  const unit: El[] = [];
  for (let node: Node | null = start; node; node = node.nextSibling) {
    if (node.nodeType !== 1) continue;
    unit.push(node as El);
    if (local(node as El) === "bookmarkEnd" && attr(node as El, "id") === attr(start, "id")) return unit;
  }
  return null;
}

/**
 * Takes a picture out of the page so it can be put elsewhere: with its place when it has
 * one (so the field bound to it follows), else in a run of its own.
 */
function detachPicture(pkg: DocxPackage, id: string): { nodes: El[]; names: string[] } {
  const { picture, part } = pictureById(pkg, id);
  const { run, item } = holderOf(picture);
  const places = placeIds(pkg, part);
  if (insidePlace(run, places)) {
    const unit = enclosingPlace(run, places);
    if (!unit) throw new PlaceError("This picture's place spreads over several lines; move the place instead");
    if (unit.some((node) => local(node) === "r" && textOf(node).trim())) {
      throw new PlaceError("This picture shares its place with words; edit the words first or move the place instead");
    }
    for (const node of unit) remove(node);
    const names = unit.filter((node) => local(node) === "bookmarkStart").map((node) => attr(node, "name") ?? "");
    return { nodes: unit, names };
  }
  const rest = children(run).filter((node) => node !== item && local(node) !== "rPr");
  if (!rest.length) {
    remove(run);
    return { nodes: [run], names: [] };
  }
  // The run also holds words: the picture leaves in a run of its own.
  const own = wEl(run.ownerDocument!, "r");
  const rPr = child(run, "rPr");
  if (rPr) own.appendChild(rPr.cloneNode(true));
  remove(item);
  own.appendChild(item);
  return { nodes: [own], names: [] };
}

/** Removes a picture. A photo, logo or stamp place stays (as an empty point) with its binding. */
export function deletePicture(pkg: DocxPackage, id: string): void {
  const { picture } = pictureById(pkg, id);
  const { run, item } = holderOf(picture);
  remove(item);
  if (!children(run).some((node) => local(node) !== "rPr")) remove(run);
}

/**
 * Moves a picture to a character offset of a paragraph (like dragging it in Word). Returns
 * the names of the places that moved with it.
 */
export function movePicture(pkg: DocxPackage, id: string, target: PlaceTarget): string[] {
  const paragraph = paragraphAt(pkg, target);
  const places = placeIds(pkg, target.part);
  const { from } = clampRange(paragraph, target.offset, target.offset);
  // Never into another place's range: its content is replaced when the report is made.
  let offset = 0;
  const open = new Set<string>();
  for (const node of children(paragraph)) {
    const kind = local(node);
    const length = lengthOf(node);
    if (from <= offset && kind !== "bookmarkEnd") break;
    if (kind === "bookmarkStart" && places.has(attr(node, "id") ?? "")) {
      const next = node.nextSibling as El | null;
      const point = next && next.nodeType === 1 && local(next) === "bookmarkEnd" && attr(next, "id") === attr(node, "id");
      if (!point) open.add(attr(node, "id") ?? "");
    }
    if (kind === "bookmarkEnd") open.delete(attr(node, "id") ?? "");
    if (from < offset + length) break;
    offset += length;
  }
  if (open.size) throw new PlaceError("This spot is inside a field's place; drop the picture before or after it");
  const { nodes, names } = detachPicture(pkg, id);
  const fresh = paragraphAt(pkg, target);
  const at = splitAt(fresh, Math.min(from, textOf(fresh).length));
  for (const node of nodes) {
    if (at) at.parentNode!.insertBefore(node, at);
    else fresh.appendChild(node);
  }
  return names;
}
