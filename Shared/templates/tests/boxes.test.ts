// Drawn checkboxes that float at a fixed spot (Mogo's merchant form): Head Office can move
// them sideways so each sits next to its option, and preview only those rows.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { attr, descendants, DocxPackage, type El, NS, textOf } from "../docx.ts";
import { excerptLayout, isFloatingBox, nudgeBox, PlaceError } from "../edit.ts";
import { scanTemplate } from "../scan.ts";

const ARCHIVE = join(import.meta.dir, "..", "..", "..", "..", "Investigation Forms");
const scan = scanTemplate(new Uint8Array(readFileSync(join(ARCHIVE, "Mogo Company", "استعلام تجار", "استعلام تجار.docx"))));
const boxes = scan.slots.filter((slot) => slot.kind === "checkbox");
const pkg0 = DocxPackage.open(scan.docx);
const floating = boxes.filter((slot) => isFloatingBox(pkg0, slot.anchor));
// The payment providers question: فوري، باي موب، … ضامن، بي.
const source = scan.bindings.find((binding) => binding.action === "check" && binding.option?.includes("ضامن"))?.source;
const group = boxes.filter((slot) => scan.bindings.some((binding) => binding.anchor === slot.anchor && binding.source === source));

/** The DrawingML offset and the VML margin of the box a place wraps. */
function position(pkg: DocxPackage, anchor: string): { emu: number; pt: number | null } {
  const root = pkg.xml("word/document.xml").documentElement as El;
  const start = descendants(root, "bookmarkStart").find((el) => attr(el, "name") === anchor)!;
  const run = start.nextSibling as El;
  const offset = descendants(descendants(run, "positionH", NS.wp)[0]!, "posOffset", NS.wp)[0]!;
  const shape = descendants(run, "rect", NS.v)[0];
  const margin = /margin-left:(-?[\d.]+)pt/.exec(shape?.getAttribute("style") ?? "");
  return { emu: Number(offset.textContent), pt: margin ? Number(margin[1]) : null };
}

describe("floating drawn checkboxes", () => {
  test("the form's drawn boxes are recognised as floating", () => {
    expect(floating.length).toBeGreaterThanOrEqual(6);
    expect(group.length).toBeGreaterThanOrEqual(6);
    expect(group.every((slot) => floating.includes(slot))).toBe(true);
  });

  test("moving a box shifts both its drawing and its legacy copy, and nothing else", () => {
    const pkg = DocxPackage.open(scan.docx);
    const [first, second] = group;
    const before = position(pkg, first!.anchor);
    const other = position(pkg, second!.anchor);
    const text = textOf(pkg.xml("word/document.xml").documentElement as El);
    nudgeBox(pkg, first!.anchor, 2.5);
    const after = position(pkg, first!.anchor);
    expect(after.emu - before.emu).toBe(2.5 * 36000);
    if (before.pt !== null) expect(after.pt! - before.pt).toBeCloseTo(2.5 * (72 / 25.4), 1);
    expect(position(pkg, second!.anchor)).toEqual(other);
    expect(textOf(pkg.xml("word/document.xml").documentElement as El)).toBe(text);
    // Saved and opened again, the move is kept.
    expect(position(DocxPackage.open(pkg.save()), first!.anchor).emu).toBe(after.emu);
  });

  test("a box that flows with the text cannot be moved", () => {
    const inline = scanTemplate(new Uint8Array(readFileSync(join(ARCHIVE, "Bedayty Company", "استعلام سكن", "بدايتي س.docx"))));
    const box = inline.slots.find((slot) => slot.kind === "checkbox" && !isFloatingBox(DocxPackage.open(inline.docx), slot.anchor));
    expect(box).toBeDefined();
    expect(() => nudgeBox(DocxPackage.open(inline.docx), box!.anchor, 1)).toThrow(PlaceError);
  });

  test("the excerpt keeps only the rows with the question's boxes, without header or footer", () => {
    const excerpt = DocxPackage.open(excerptLayout(scan.docx, group.map((slot) => slot.anchor)));
    const root = excerpt.xml("word/document.xml").documentElement as El;
    const names = descendants(root, "bookmarkStart").map((el) => attr(el, "name"));
    for (const slot of group) expect(names).toContain(slot.anchor);
    expect(descendants(root, "tr").length).toBeLessThanOrEqual(3);
    expect(descendants(root, "headerReference").length).toBe(0);
    expect(textOf(root)).toContain("ضامن");
    expect(textOf(root)).not.toContain("المؤمن عليهم");
  });
});
