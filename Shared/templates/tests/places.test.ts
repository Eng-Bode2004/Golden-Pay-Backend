// Moving and adding statement and checkbox points in the visual mapper: the client's
// original sentence or box is hidden at its old spot, and the new spot prints only what
// the answers (and, for statements, the evidence) support.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { allFields, type Answers, type TemplateDefinition } from "../definition.ts";
import { descendants, DocxPackage, type El, NS, textOf } from "../docx.ts";
import { insertPlace, paragraphsOf, placeHasContent, renamePlace } from "../edit.ts";
import { renderTemplate } from "../render.ts";
import { type Binding, scanTemplate } from "../scan.ts";

const ARCHIVE = join(import.meta.dir, "..", "..", "..", "..", "Investigation Forms");
const scan = scanTemplate(new Uint8Array(readFileSync(join(ARCHIVE, "Bedayty Company", "استعلام سكن", "بدايتي س.docx"))));
const PART = "word/document.xml";
const withEvidence = { photos: { any: 3 } as Record<string, number>, locations: [{ kind: "submitted", lat: 30.04, lng: 31.21 }] };

const statementBinding = scan.bindings.find((b) => b.action === "statement")!;
const statementField = allFields(scan.definition).find((f) => `answers.${f.key}` === statementBinding.source)!;
const boxBinding = scan.bindings.find((b) => b.action === "check")!;
const boxField = allFields(scan.definition).find((f) => `answers.${f.key}` === boxBinding.source)!;
const sentence = (statementField.statement ?? "").trim().slice(0, 20);

/** Moves both points the way the places endpoint does, and adds a new statement and box. */
function moved(): { docx: Uint8Array; bindings: Binding[]; definition: TemplateDefinition; slots: { anchor: string; kind: string }[] } {
  const pkg = DocxPackage.open(scan.docx);
  const paragraphs = paragraphsOf(pkg, PART);
  const target = paragraphs.findIndex((p) => textOf(p).includes("اسم العميل"));
  const end = textOf(paragraphs[target]!).length;
  expect(placeHasContent(pkg, statementBinding.anchor)).toBe(true);
  renamePlace(pkg, statementBinding.anchor, "gp_r001");
  insertPlace(pkg, statementBinding.anchor, { part: PART, paragraph: target, offset: end });
  renamePlace(pkg, boxBinding.anchor, "gp_r002");
  insertPlace(pkg, boxBinding.anchor, { part: PART, paragraph: target, offset: 0 });
  insertPlace(pkg, "gp_u001", { part: PART, paragraph: target + 1, offset: 0 });
  expect(placeHasContent(pkg, statementBinding.anchor)).toBe(false);
  const definition: TemplateDefinition = {
    ...scan.definition,
    sections: [
      ...scan.definition.sections,
      { id: "added", title: "نقاط مضافة", fields: [{ key: "added_attestation", label: "إقرار مضاف", type: "attestation", statement: "تمت المعاينة على الطبيعة", evidence: { kind: "visit", requires: [{ type: "photos", min: 1 }] } }] },
    ],
  };
  return {
    docx: pkg.save(),
    definition,
    slots: [
      ...scan.slots,
      { anchor: "gp_r001", kind: "inline" },
      { anchor: "gp_r002", kind: "inline" },
      { anchor: "gp_u001", kind: "statement" },
    ],
    bindings: [
      ...scan.bindings,
      { anchor: "gp_r001", action: "clear" },
      { anchor: "gp_r002", action: "clear" },
      { anchor: "gp_u001", action: "statement", source: "answers.added_attestation" },
    ],
  };
}

function answers(confirmed: boolean): Answers {
  const out: Answers = {};
  for (const field of allFields(scan.definition)) if (field.type === "attestation") out[field.key] = confirmed;
  out[boxField.key] = boxField.type === "yesno" ? "نعم" : boxField.type === "multichoice" ? [boxBinding.option!] : boxBinding.option!;
  out.added_attestation = confirmed;
  return out;
}

const count = (text: string, part: string) => text.split(part).length - 1;

describe("moving statement and checkbox points", () => {
  const layout = moved();
  const render = (confirmed: boolean, evidence = withEvidence) =>
    renderTemplate(layout.docx, layout.bindings, { definition: layout.definition, answers: answers(confirmed), caseValues: {}, images: {}, evidence, slots: layout.slots });
  const original = renderTemplate(scan.docx, scan.bindings, { definition: scan.definition, answers: answers(true), caseValues: {}, images: {}, evidence: withEvidence });
  const before = count(textOf(DocxPackage.open(original.docx).xml(PART).documentElement as El), sentence);

  test("a confirmed statement with evidence prints once, at its new spot", () => {
    const out = render(true);
    const paragraphs = descendants(DocxPackage.open(out.docx).xml(PART).documentElement as El, "p").map((p) => textOf(p));
    expect(before).toBeGreaterThan(0);
    expect(count(paragraphs.join("\n"), sentence)).toBe(before);
    expect(paragraphs.some((text) => text.includes("اسم العميل") && text.includes(sentence))).toBe(true);
    expect(paragraphs.join("\n")).toContain("تمت المعاينة على الطبيعة");
  });

  test("an unconfirmed or unproven statement prints nowhere", () => {
    for (const out of [render(false), render(true, { photos: {}, locations: [] })]) {
      const text = textOf(DocxPackage.open(out.docx).xml(PART).documentElement as El);
      expect(text).not.toContain(sentence);
      expect(text).not.toContain("تمت المعاينة على الطبيعة");
    }
  });

  test("a moved checkbox is drawn and ticked at its new spot; the original box is hidden", () => {
    const out = render(true);
    const root = DocxPackage.open(out.docx).xml(PART).documentElement as El;
    expect(descendants(root, "p").some((p) => /^\s*☒\s*اسم العميل/.test(textOf(p)))).toBe(true);
    const ticked = descendants(root, "checked", NS.w14).filter((el) => el.getAttributeNS(NS.w14, "val") === "1").length;
    const originalTicked = descendants(DocxPackage.open(original.docx).xml(PART).documentElement as El, "checked", NS.w14).filter(
      (el) => el.getAttributeNS(NS.w14, "val") === "1",
    ).length;
    expect(ticked).toBe(originalTicked - 1);
  });
});
