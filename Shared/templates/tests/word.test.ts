// Word-like editing of client layouts in the visual mapper: typing, deleting, formatting,
// and moving, resizing or deleting pictures, on real client templates.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { allFields, type Answers } from "../definition.ts";
import { attr, child, descendants, DocxPackage, type El, NS, textOf } from "../docx.ts";
import { paragraphsOf, PlaceError } from "../edit.ts";
import { layoutHtml } from "../preview.ts";
import { renderTemplate } from "../render.ts";
import { scanTemplate } from "../scan.ts";
import { deletePicture, editText, movePicture, nudgePicture, paragraphText, pictureInfo, picturesOf, resizePicture, styleText } from "../word.ts";

const ARCHIVE = join(import.meta.dir, "..", "..", "..", "..", "Investigation Forms");
const load = (...path: string[]) => scanTemplate(new Uint8Array(readFileSync(join(ARCHIVE, ...path))));
const bedayty = load("Bedayty Company", "استعلام سكن", "بدايتي س.docx");
const PART = "word/document.xml";

/** A paragraph of plain client words, with no places, pictures, links or fields in it. */
function plainParagraph(pkg: DocxPackage): number {
  return paragraphsOf(pkg, PART).findIndex(
    (p) =>
      textOf(p).trim().length > 20 &&
      !descendants(p, "bookmarkStart").length &&
      !descendants(p, "drawing").length &&
      !descendants(p, "sdt").length &&
      !descendants(p, "hyperlink").length &&
      !descendants(p, "sym").length &&
      !descendants(p, "fldChar").length,
  );
}

/** A paragraph with a field's point after its label ("الاسم: ◂"). */
function pointParagraph(pkg: DocxPackage): { index: number; at: number } {
  const paragraphs = paragraphsOf(pkg, PART);
  for (const [index, paragraph] of paragraphs.entries()) {
    let offset = 0;
    for (let node = paragraph.firstChild; node; node = node.nextSibling) {
      if (node.nodeType !== 1) continue;
      const el = node as El;
      const next = el.nextSibling as El | null;
      if (
        el.localName === "bookmarkStart" && (attr(el, "name") ?? "").startsWith("gp_") &&
        next?.localName === "bookmarkEnd" && offset > 3
      ) return { index, at: offset };
      if (["r", "sdt", "hyperlink"].includes(el.localName ?? "")) offset += textOf(el).length;
    }
  }
  throw new Error("no point found");
}

function renders(docx: Uint8Array): string {
  const answers: Answers = {};
  for (const field of allFields(bedayty.definition)) if (field.type === "text") answers[field.key] = "قيمة";
  const out = renderTemplate(docx, bedayty.bindings, { definition: bedayty.definition, answers, caseValues: {}, images: {}, evidence: { photos: {}, locations: [] }, slots: bedayty.slots });
  return textOf(DocxPackage.open(out.docx).xml(PART).documentElement as El);
}

describe("editing words", () => {
  const index = plainParagraph(DocxPackage.open(bedayty.docx));
  const original = paragraphText(DocxPackage.open(bedayty.docx), { part: PART, paragraph: index });

  test("replacing a word changes only those characters and keeps the formatting", () => {
    const pkg = DocxPackage.open(bedayty.docx);
    const before = descendants(paragraphsOf(pkg, PART)[index]!, "rPr").map((rPr) => descendants(rPr, "sz")[0] ? attr(descendants(rPr, "sz")[0], "val") : null);
    editText(pkg, { part: PART, paragraph: index, offset: 3, }, 8, "كلمة جديدة");
    const saved = DocxPackage.open(pkg.save());
    expect(paragraphText(saved, { part: PART, paragraph: index })).toBe(original.slice(0, 3) + "كلمة جديدة" + original.slice(8));
    const sizes = descendants(paragraphsOf(saved, PART)[index]!, "rPr").map((rPr) => descendants(rPr, "sz")[0] ? attr(descendants(rPr, "sz")[0], "val") : null);
    expect(new Set(sizes)).toEqual(new Set(before));
    expect(renders(saved.save())).toContain("كلمة جديدة");
  });

  test("typing and deleting", () => {
    const pkg = DocxPackage.open(bedayty.docx);
    editText(pkg, { part: PART, paragraph: index, offset: original.length }, original.length, " — أضيف");
    expect(paragraphText(pkg, { part: PART, paragraph: index })).toBe(`${original} — أضيف`);
    editText(pkg, { part: PART, paragraph: index, offset: 0 }, 5, "");
    expect(paragraphText(pkg, { part: PART, paragraph: index })).toBe(`${original.slice(5)} — أضيف`);
  });

  test("a new line becomes a line break", () => {
    const pkg = DocxPackage.open(bedayty.docx);
    editText(pkg, { part: PART, paragraph: index, offset: 2 }, 2, "أ\nب");
    expect(descendants(paragraphsOf(pkg, PART)[index]!, "br").length).toBeGreaterThan(0);
  });

  test("words typed at a field's point go before the point, and the field still prints", () => {
    const pkg = DocxPackage.open(bedayty.docx);
    const { index: at, at: offset } = pointParagraph(pkg);
    editText(pkg, { part: PART, paragraph: at, offset }, offset, "XYZ");
    const paragraph = paragraphsOf(pkg, PART)[at]!;
    const nodes = Array.from(paragraph.childNodes) as El[];
    const typed = nodes.findIndex((node) => node.nodeType === 1 && textOf(node) === "XYZ");
    const point = nodes.findIndex((node, i) => i > typed - 3 && node.localName === "bookmarkStart" && (attr(node, "name") ?? "").startsWith("gp_"));
    expect(typed).toBeGreaterThanOrEqual(0);
    expect(typed).toBeLessThan(point);
    expect(renders(pkg.save())).toContain("XYZ");
  });

  test("a change across a field's place is refused and leaves the file as it was", () => {
    const pkg = DocxPackage.open(bedayty.docx);
    const { index: at, at: offset } = pointParagraph(pkg);
    const text = paragraphText(pkg, { part: PART, paragraph: at });
    if (offset < text.length) {
      expect(() => editText(pkg, { part: PART, paragraph: at, offset: offset - 2 }, offset + 1, "")).toThrow(PlaceError);
      expect(paragraphText(pkg, { part: PART, paragraph: at })).toBe(text);
    }
  });

  test("font size, bold and underline apply to the selected words only", () => {
    const pkg = DocxPackage.open(bedayty.docx);
    styleText(pkg, { part: PART, paragraph: index, offset: 2 }, 9, { size: 18, bold: true, underline: true });
    const paragraph = paragraphsOf(DocxPackage.open(pkg.save()), PART)[index]!;
    expect(textOf(paragraph)).toBe(original);
    const styled = descendants(paragraph, "r").filter((run) => attr(child(child(run, "rPr")!, "sz"), "val") === "36");
    expect(styled.map(textOf).join("")).toBe(original.slice(2, 9));
    for (const run of styled) {
      const rPr = child(run, "rPr")!;
      expect(child(rPr, "b")).toBeDefined();
      // Word's property order: b before sz before u.
      const order = Array.from(rPr.childNodes).map((node) => (node as El).localName);
      expect(order.indexOf("b")).toBeLessThan(order.indexOf("sz"));
      expect(order.indexOf("sz")).toBeLessThan(order.indexOf("u"));
    }
  });

  test("the mapper page shows the new size and stays countable", () => {
    const pkg = DocxPackage.open(bedayty.docx);
    styleText(pkg, { part: PART, paragraph: index, offset: 0 }, 4, { size: 20 });
    const html = layoutHtml(pkg.save());
    expect(html).toContain("font-size:25px");
    expect(html).toContain(`data-p="${PART}|${index}"`);
  });
});

describe("pictures", () => {
  const mogo = load("Mogo Company", "استعلام تجار", "استعلام تجار.docx");
  const credit = load("Credit agricole Bank", "استعلام عيادة", "استعلام عيادة.docx");

  test("every picture is marked on the mapper page", () => {
    for (const scan of [bedayty, mogo, credit]) {
      const pkg = DocxPackage.open(scan.docx);
      const count = pkg.textParts().reduce((sum, part) => sum + picturesOf(pkg, part).length, 0);
      const html = layoutHtml(scan.docx);
      expect((html.match(/data-img="/g) ?? []).length).toBe(count);
    }
  });

  test("resizing keeps the proportions in the frame and the drawing", () => {
    const pkg = DocxPackage.open(mogo.docx);
    const part = pkg.textParts().find((name) => picturesOf(pkg, name).length)!;
    const id = `${part}|0`;
    const before = pictureInfo(pkg, id);
    resizePicture(pkg, id, 1.5);
    const after = pictureInfo(DocxPackage.open(pkg.save()), id);
    expect(after.widthMm).toBeCloseTo(before.widthMm * 1.5, 0);
    expect(after.heightMm).toBeCloseTo(before.heightMm * 1.5, 0);
  });

  test("a floating picture moves by millimetres", () => {
    const pkg = DocxPackage.open(credit.docx);
    const part = pkg.textParts().find((name) => picturesOf(pkg, name).some((p) => p.localName === "anchor"))!;
    const index = picturesOf(pkg, part).findIndex((p) => p.localName === "anchor");
    const offset = () => Number(descendants(child(picturesOf(pkg, part)[index]!, "positionH", NS.wp)!, "posOffset", NS.wp)[0]!.textContent);
    const x = offset();
    nudgePicture(pkg, `${part}|${index}`, 5, -2);
    expect(offset() - x).toBe(5 * 36000);
  });

  test("an inline picture moves with its place to another line, and its binding still works", () => {
    const pkg = DocxPackage.open(bedayty.docx);
    const part = pkg.textParts().find((name) => picturesOf(pkg, name).some((p) => p.localName === "inline"))!;
    const index = picturesOf(pkg, part).findIndex((p) => p.localName === "inline");
    const id = `${part}|${index}`;
    const info = pictureInfo(pkg, id);
    const target = plainParagraph(pkg);
    const names = movePicture(pkg, id, { part: PART, paragraph: target, offset: 0 });
    const saved = DocxPackage.open(pkg.save());
    const moved = paragraphsOf(saved, PART)[target]!;
    expect(descendants(moved, "blip", NS.a).length).toBe(1);
    if (info.inPlace) {
      expect(names.length).toBe(1);
      const marks = descendants(moved, "bookmarkStart").map((mark) => attr(mark, "name"));
      expect(marks).toContain(names[0]!);
    }
    expect(() => renders(saved.save())).not.toThrow();
  });

  test("deleting a picture keeps its place", () => {
    const pkg = DocxPackage.open(bedayty.docx);
    const part = pkg.textParts().find((name) => picturesOf(pkg, name).length)!;
    const count = picturesOf(pkg, part).length;
    const marks = descendants(pkg.xml(part).documentElement as El, "bookmarkStart").length;
    deletePicture(pkg, `${part}|0`);
    const saved = DocxPackage.open(pkg.save());
    expect(picturesOf(saved, part).length).toBe(count - 1);
    expect(descendants(saved.xml(part).documentElement as El, "bookmarkStart").length).toBe(marks);
  });
});

describe("text boxes", () => {
  // Mogo's work form has an empty frame under «ماكينة تصوير … كاميرات مراقبة».
  const mogoWork = load("Mogo Company", "استعلام عمل", "موجو -عمل.docx");

  test("an empty text box can be chosen on the page and deleted, and the rest still prints", () => {
    const pkg = DocxPackage.open(mogoWork.docx);
    const html = layoutHtml(mogoWork.docx);
    const frames = [...html.matchAll(/class="doc-textbox" data-img="([^"]+)"/g)].map((match) => match[1]!);
    expect(frames.length).toBeGreaterThan(0);
    const near = html.indexOf("طفايات حريق");
    const id = [...html.matchAll(/class="doc-textbox" data-img="([^"]+)"/g)].find((match) => match.index! > near)![1]!;
    expect(pictureInfo(pkg, id).kind).toBe("textbox");
    const before = textOf(pkg.xml(PART).documentElement as El);
    const count = picturesOf(pkg, PART).length;
    const gone = deletePicture(pkg, id);
    const saved = DocxPackage.open(pkg.save());
    expect(picturesOf(saved, PART).length).toBe(count - 1);
    expect(textOf(saved.xml(PART).documentElement as El)).toBe(before);
    const bindings = mogoWork.bindings.filter((binding) => !gone.includes(binding.anchor));
    expect(() =>
      renderTemplate(saved.save(), bindings, { definition: mogoWork.definition, answers: {}, caseValues: {}, images: {}, evidence: { photos: {}, locations: [] } }),
    ).not.toThrow();
  });
});
