// Data mapping on the real client templates: values land in the right place, only the
// chosen boxes are ticked, old report data never survives, statements need evidence,
// Arabic stays right-to-left, pictures embed, rows repeat, and the layout is untouched.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { allFields, type Answers, type TemplateDefinition } from "../definition.ts";
import { attr, descendants, DocxPackage, type El, NS, textOf } from "../docx.ts";
import { renderTemplate, type RenderData } from "../render.ts";
import { scanTemplate, type ScanResult } from "../scan.ts";

const ARCHIVE = join(import.meta.dir, "..", "..", "..", "..", "Investigation Forms");
const CONVERTED = join(import.meta.dir, "..", "..", "..", "DynamicForms_Services", "Seeds", "converted-doc");
const file = (...parts: string[]) => new Uint8Array(readFileSync(join(ARCHIVE, ...parts)));
const photo = new Uint8Array(readFileSync(join(import.meta.dir, "..", "assets", "sample-photo.png")));
const stamp = new Uint8Array(readFileSync(join(import.meta.dir, "..", "assets", "golden-pay-stamp.png")));

const evidence = {
  photos: { any: 3 } as Record<string, number>,
  locations: [{ kind: "submitted", lat: 30.04, lng: 31.21 }],
};

function render(scan: ScanResult, answers: Answers, extra: Partial<RenderData> = {}) {
  const photos = Object.fromEntries(
    allFields(scan.definition).filter((field) => field.type === "photos").map((field) => [field.key, [{ bytes: photo }]]),
  );
  return renderTemplate(scan.docx, scan.bindings, {
    definition: scan.definition,
    answers,
    caseValues: { subject_name: "عميل الاختبار", investigator_name: "مستعلم الاختبار", report_date: "05/11/2026", report_time: "14:30" },
    images: photos,
    stamp: null,
    evidence: { ...evidence, photos: { ...evidence.photos, ...Object.fromEntries(Object.keys(photos).map((key) => [key, 1])) } },
    ...extra,
  });
}

const xmlOf = (docx: Uint8Array, part = "word/document.xml") => DocxPackage.open(docx).xml(part).documentElement as El;
const bodyText = (docx: Uint8Array) => textOf(xmlOf(docx)).replace(/\s+/g, " ");

/** First option of every choice, a value for every text field, every statement confirmed. */
function fullAnswers(definition: TemplateDefinition, confirm = true): Answers {
  const answers: Answers = {};
  for (const field of allFields(definition)) {
    if (field.type === "choice") answers[field.key] = field.options![0];
    else if (field.type === "multichoice") answers[field.key] = [field.options![0]];
    else if (field.type === "yesno") answers[field.key] = "نعم";
    else if (field.type === "attestation") answers[field.key] = confirm;
    else if (field.type === "date") answers[field.key] = "2026-11-05";
    else if (field.type === "number") answers[field.key] = "7";
    else if (field.type === "phone") answers[field.key] = "01001234567";
    else if (field.type === "national_id") answers[field.key] = "29001011234567";
    else if (field.type === "table") answers[field.key] = [{ c1: "صف" }];
    else if (!["photos", "signature"].includes(field.type)) answers[field.key] = `قيمة-${field.key}`;
  }
  return answers;
}

describe("Bedayty residence (checkbox controls, labels in cells, statements, stamp)", () => {
  const original = file("Bedayty Company", "استعلام سكن", "بدايتي س.docx");
  const scan = scanTemplate(original);
  const answers = fullAnswers(scan.definition, false);
  const out = render(scan, answers);

  test("case data and answers are written next to their labels", () => {
    const paragraphs = descendants(xmlOf(out.docx), "p").map((p) => textOf(p).replace(/\s+/g, " "));
    expect(paragraphs.some((text) => /اسم العميل\s*:\s*قيمة-subject_name/.test(text))).toBe(true);
    expect(paragraphs.some((text) => text.includes("مستعلم الاختبار"))).toBe(true);
  });

  test("old report data never survives", () => {
    const text = bodyText(out.docx);
    expect(text).not.toContain("لم نواف");
    expect(text).not.toMatch(/-11-2025/);
    expect(text).not.toContain("فاطمة وطني");
  });

  test("exactly the chosen option is ticked in each checkbox group", () => {
    const groups = allFields(scan.definition).filter(
      (field) => ["choice", "multichoice"].includes(field.type) && scan.bindings.some((b) => b.action === "check" && b.source === `answers.${field.key}`),
    );
    const checked = descendants(xmlOf(out.docx), "checked", NS.w14).filter((el) => el.getAttributeNS(NS.w14, "val") === "1");
    expect(groups.length).toBeGreaterThan(5);
    expect(checked.length).toBe(groups.length);
  });

  test("unconfirmed statements are left out; confirmed ones print with evidence", () => {
    expect(bodyText(out.docx)).not.toContain("تم مقابلة");
    expect(out.issues.filter((issue) => issue.kind === "unconfirmed_statement").length).toBeGreaterThan(0);
    const confirmed = render(scan, fullAnswers(scan.definition, true));
    expect(bodyText(confirmed.docx)).toContain("تم مقابلة");
    const noProof = render(scan, fullAnswers(scan.definition, true), { evidence: { photos: {}, locations: [] } });
    expect(bodyText(noProof.docx)).not.toContain("تم مقابلة");
    expect(noProof.issues.some((issue) => issue.kind === "unsupported_statement")).toBe(true);
  });

  test("the Golden Pay stamp appears only after approval", () => {
    const blips = (docx: Uint8Array) => descendants(xmlOf(docx), "blip", NS.a).length;
    const approved = render(scan, answers, { stamp });
    expect(blips(approved.docx)).toBe(blips(out.docx) + 1);
    expect(out.issues.some((issue) => issue.kind === "awaiting_approval")).toBe(true);
  });

  test("visit photos are embedded under the client's own photo heading", () => {
    const pkg = DocxPackage.open(out.docx);
    expect(pkg.names().some((name) => /^word\/media\/gp-\d+\.png$/.test(name))).toBe(true);
    const paragraphs = descendants(pkg.xml("word/document.xml").documentElement as El, "p");
    const heading = paragraphs.findIndex((p) => textOf(p).trim() === "صور السكن");
    expect(descendants(paragraphs[heading + 1]!, "blip", NS.a).length).toBe(1);
  });

  test("Arabic runs are right-to-left, numbers stay left-to-right", () => {
    const runs = descendants(xmlOf(out.docx), "r");
    const arabic = runs.find((run) => textOf(run).trim() === "قيمة-subject_name");
    const phone = runs.find((run) => textOf(run).includes("01001234567") && !/[؀-ۿ]/.test(textOf(run)));
    expect(arabic && descendants(arabic, "rtl").length).toBe(1);
    expect(phone && descendants(phone, "rtl").length).toBe(0);
    const date = runs.find((run) => textOf(run).trim() === "05/11/2026");
    expect(date && descendants(date, "rtl").length).toBe(0);
  });

  test("layout is untouched: sections, page breaks, headers, footers; no helper bookmarks left", () => {
    const before = DocxPackage.open(original);
    const after = DocxPackage.open(out.docx);
    const count = (pkg: DocxPackage, name: string) => descendants(pkg.xml("word/document.xml").documentElement as El, name).length;
    expect(count(after, "sectPr")).toBe(count(before, "sectPr"));
    expect(count(after, "tbl")).toBe(count(before, "tbl"));
    const pageBreaks = (pkg: DocxPackage) =>
      descendants(pkg.xml("word/document.xml").documentElement as El, "br").filter((br) => attr(br, "type") === "page").length;
    expect(pageBreaks(after)).toBe(pageBreaks(before));
    for (const part of before.textParts().filter((name) => name !== "word/document.xml")) {
      expect(textOf(after.xml(part).documentElement as El)).toBe(textOf(before.xml(part).documentElement as El));
    }
    const leftovers = after.textParts().flatMap((part) =>
      descendants(after.xml(part).documentElement as El, "bookmarkStart").filter((el) => (attr(el, "name") ?? "").startsWith("gp_")),
    );
    expect(leftovers.length).toBe(0);
  });

  test("unanswered blanks stay blank instead of being filled with anything", () => {
    const blank = render(scan, {});
    const text = bodyText(blank.docx);
    expect(text).not.toContain("قيمة-");
    expect(blank.issues.filter((issue) => issue.kind === "missing").length).toBe(
      allFields(scan.definition).filter((field) => field.required).length,
    );
  });
});

describe("Gaboor home (picture checkboxes, repeating rows)", () => {
  const scan = scanTemplate(file("Gaboor Company", "استعلام منزل", "تقرير استعلام منزل.docx"));

  test("rows repeat when there are more items than rows in the layout", () => {
    const table = allFields(scan.definition).find((field) => field.type === "table")!;
    const binding = scan.bindings.find((b) => b.action === "rows" && b.source === `answers.${table.key}`)!;
    const rowsInLayout = scan.bindings.filter((b) => b.action === "rows" && b.source === binding.source).length;
    const items = Array.from({ length: rowsInLayout + 2 }, (_, index) =>
      Object.fromEntries(table.columns!.map((column) => [column.key, `عنصر ${index + 1}`])),
    );
    const out = render(scan, { [table.key]: items });
    const text = bodyText(out.docx);
    for (let index = 1; index <= items.length; index += 1) expect(text).toContain(`عنصر ${index}`);
    const rows = (docx: Uint8Array) => descendants(xmlOf(docx), "tr").length;
    expect(rows(out.docx) - rows(scan.docx)).toBe(2);
  });

  test("a drawn picture checkbox shows a ticked box when chosen", () => {
    const group = allFields(scan.definition).find((field) =>
      field.type === "choice" && scan.bindings.some((b) => b.action === "check" && b.source === `answers.${field.key}`),
    )!;
    const out = render(scan, { [group.key]: group.options![0] });
    expect(bodyText(out.docx)).toContain("☒");
  });
});

describe("Crédit Agricole clinic (dotted blanks, typed boxes, conditional details)", () => {
  const scan = scanTemplate(file("Credit agricole Bank", "استعلام عيادة", "استعلام عيادة.docx"));

  test("a blank after an option is a detail shown only when that option is chosen", () => {
    expect(allFields(scan.definition).some((field) => (field.visible_if as { op?: string } | undefined)?.op === "eq")).toBe(true);
  });

  test("answered blanks replace the dots; unanswered dots remain", () => {
    const first = scan.bindings.find((b) => b.action === "text" && b.source?.startsWith("answers."))!;
    const out = render(scan, { [first.source!.slice(8)]: "مستشفى الأمل" });
    const text = bodyText(out.docx);
    expect(text).toContain("مستشفى الأمل");
    expect(text).toMatch(/\.{6,}/);
  });

  test("typed boxes are ticked for the chosen option only", () => {
    const group = allFields(scan.definition).find((field) =>
      field.type === "choice" && scan.bindings.filter((b) => b.action === "check" && b.source === `answers.${field.key}`).length >= 2,
    )!;
    const out = render(scan, { [group.key]: group.options![1] });
    expect((bodyText(out.docx).match(/☒/g) ?? []).length).toBe(1);
  });
});

describe("Alex Bank (floating text boxes and drawn squares)", () => {
  const scan = scanTemplate(file("Alex Bank", "استعلام عمل", "اسكندرية.docx"));

  test("a floating square gets a tick inside it, in place", () => {
    const group = allFields(scan.definition).find((field) =>
      field.type === "choice" && scan.bindings.some((b) => b.action === "check" && b.source === `answers.${field.key}`),
    )!;
    const out = render(scan, { [group.key]: group.options![0] });
    // Text boxes are skipped by textOf on purpose, so read the box's own text.
    const ticks = descendants(xmlOf(out.docx), "txbxContent").filter((box) => (box.textContent ?? "").trim() === "✓");
    expect(ticks.length).toBe(1);
  });

  test("sample answers like «لم تتم الافادة» are flagged and replaced", () => {
    expect(scan.slots.some((slot) => slot.sample && /الافاد/.test(slot.text))).toBe(true);
    expect(bodyText(render(scan, fullAnswers(scan.definition)).docx)).not.toMatch(/لم تتم الافاد/);
  });
});

describe("every archive template", () => {
  test("scans into a valid definition and renders without leaving old sample text in bound places", () => {
    const failures: string[] = [];
    for (const [client, folder, name] of [
      ["Bedayty Company", "استعلام تاجر", "تاجر بدايتي.docx"],
      ["CIB Bank", "تقرير استعلام المشروعات", "تقرير استعلام المشروعات.docx"],
      ["QNB Bank", "استعلام اصحاب الاعمال", "استعلام اصحاب الاعمال (النموذج الموحد).docx"],
      ["Tanmiya Company", "استعلام شركة", "نموذج (جديد) - جولدن باي.docx"],
      ["Hermes Company", "تقرير زيارة شركة", "تقرير زيارة شركة هيرميس.docx"],
      ["Mogo Company", "استعلام سكن", "موجو -سكن.docx"],
    ] as const) {
      try {
        const scan = scanTemplate(file(client, folder, name));
        const out = render(scan, fullAnswers(scan.definition));
        DocxPackage.open(out.docx).xml("word/document.xml");
        // Each bound sample is replaced; the same words may still appear elsewhere as a real label.
        const occurrences = (text: string, needle: string) => text.split(needle).length - 1;
        const before = bodyText(scan.docx);
        const after = bodyText(out.docx);
        const bound = scan.slots.filter((slot) => slot.sample && slot.text.length > 4 && scan.bindings.some((b) => b.anchor === slot.anchor));
        for (const text of new Set(bound.map((slot) => slot.text))) {
          const replaced = bound.filter((slot) => slot.text === text).length;
          if (occurrences(after, text) > occurrences(before, text) - replaced) failures.push(`${client}: «${text}» survived`);
        }
      } catch (error) {
        failures.push(`${client}/${folder}: ${(error as Error).message}`);
      }
    }
    if (failures.length) console.log(failures.join(" | "));
    expect(failures).toEqual([]);
  });

  test("legacy .doc files converted to .docx scan too", () => {
    const scan = scanTemplate(new Uint8Array(readFileSync(join(CONVERTED, "Industrial Development Bank__استعلام ميداني(موردين).docx"))));
    expect(allFields(scan.definition).length).toBeGreaterThan(20);
  });
});

describe("label lines with nothing after the colon", () => {
  test("every «Label :» line of Global's showroom form becomes a field", () => {
    const scan = scanTemplate(file("Global Company", "تكويد معرض سيارات", "تكويد معرض سيارات.docx"));
    const labels = allFields(scan.definition).map((field) => field.label);
    for (const label of ["اسم المعرض", "بيانات مسؤول التواصل", "مواعيد العمل", "عدد الموظفين", "البنوك المتعامل معها", "عدد السيارات", "سجل المستوردين", "وصف المقر"]) {
      expect(labels).toContain(label);
    }
    expect(allFields(scan.definition).filter((field) => field.type === "attestation").length).toBeLessThanOrEqual(1);
  });
});

describe("Alex Bank's drawn boxes", () => {
  test("wide drawn squares, options before the question and a question without a colon", () => {
    const scan = scanTemplate(file("Alex Bank", "استعلام عمل", "اسكندرية.docx"));
    const fields = allFields(scan.definition);
    const options = (label: string) => fields.find((field) => field.label === label)?.options;
    expect(options("نوع العقد")).toEqual(["دائم", "مؤقت", "مؤقت ويجدد", "مقابل اجر"]);
    expect(options("هل العميل مؤمن عليه")).toEqual(["نعم", "لا"]);
    expect(options("هل تم الاطلاع علي الاوراق الخاصه للنشاط")).toEqual(["نعم", "لا"]);
    expect(options("هل العميل كان متواجد اثناء الزيارة")).toEqual(["نعم", "لا"]);
    // The spaces between options are not blanks to fill in.
    expect(fields.map((field) => field.label)).not.toContain("لا");
    expect(fields.map((field) => field.label)).not.toContain("هل العنوان صحيح؟");
  });
});
