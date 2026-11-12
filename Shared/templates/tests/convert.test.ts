// A conversion whose request has gone away before its turn is skipped, so it does not
// hold up the previews and reports queued behind it.
import { expect, test } from "bun:test";
import { ConversionCancelled, docxToPdf } from "../convert.ts";

test("a cancelled conversion is skipped before it starts", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(docxToPdf(new Uint8Array([1, 2, 3]), controller.signal)).rejects.toBeInstanceOf(ConversionCancelled);
});

test("Word art page borders become a frame LibreOffice can draw; plain borders stay", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { DocxPackage, descendants } = await import("../docx.ts");
  const { drawablePageBorders } = await import("../convert.ts");
  const file = join(import.meta.dir, "..", "..", "..", "..", "Investigation Forms", "CIB Bank", "استعلام موردين", "استعلام موردين CIB.docx");
  const original = new Uint8Array(readFileSync(file));
  const sides = (bytes: Uint8Array) =>
    descendants(DocxPackage.open(bytes).xml("word/document.xml").documentElement as Element, "pgBorders").flatMap((b) =>
      (Array.from(b.childNodes).filter((n) => n.nodeType === 1) as Element[]).map((side) => side.getAttribute("w:val")),
    );
  expect(sides(original)).toEqual(["twistedLines1", "twistedLines1", "twistedLines1", "twistedLines1"]);
  const fixed = drawablePageBorders(original);
  expect(sides(fixed)).toEqual(["thickThinSmallGap", "thickThinSmallGap", "thickThinSmallGap", "thickThinSmallGap"]);
  // A file without art borders is passed on unchanged.
  expect(drawablePageBorders(fixed)).toBe(fixed);
});

test("Wingdings ticks become Unicode symbols for LibreOffice", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { child, descendants, DocxPackage, NS, textOf, wEl } = await import("../docx.ts");
  const { drawablePageBorders } = await import("../convert.ts");
  // QNB's boxes show a Wingdings tick (00FC) when checked: tick the first one as the renderer does.
  const file = join(import.meta.dir, "..", "..", "..", "..", "Investigation Forms", "QNB Bank", "تقرير عمل", "تقرير عمل كيو ان بى.docx");
  const pkg = DocxPackage.open(new Uint8Array(readFileSync(file)));
  const root = pkg.xml("word/document.xml").documentElement as Element;
  const box = descendants(root, "sdt").find((sdt) => descendants(sdt, "checkbox", NS.w14).length)!;
  const run = descendants(box, "r").find((r) => child(r, "t"))!;
  const rPr = child(run, "rPr")!;
  const fonts = child(rPr, "rFonts");
  if (fonts) rPr.removeChild(fonts);
  rPr.insertBefore(wEl(run.ownerDocument!, "rFonts", { ascii: "Wingdings", hAnsi: "Wingdings", cs: "Wingdings" }), rPr.firstChild);
  child(run, "t")!.textContent = String.fromCharCode(0xfc);
  const ticked = pkg.save();
  const fixed = drawablePageBorders(ticked);
  const after = descendants(DocxPackage.open(fixed).xml("word/document.xml").documentElement as Element, "sdt").find((sdt) => descendants(sdt, "checkbox", NS.w14).length)!;
  expect(textOf(after)).toBe("✓");
  // Nothing else to change the second time.
  expect(drawablePageBorders(fixed)).toBe(fixed);
});
