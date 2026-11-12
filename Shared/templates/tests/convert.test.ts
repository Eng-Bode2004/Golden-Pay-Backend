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
