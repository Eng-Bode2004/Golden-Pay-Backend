import { describe, expect, test } from "bun:test";
import {
  cleanAnswers,
  claimsAction,
  DefinitionError,
  evaluate,
  missingEvidence,
  parseDefinition,
  upgradeLegacy,
  validateAnswers,
  type EvidenceContext,
  type TemplateDefinition,
} from "../definition.ts";

const noEvidence: EvidenceContext = { photos: {}, locations: [] };
const onSite: EvidenceContext = {
  photos: { visit_photos: 2 },
  locations: [{ kind: "submitted", lat: 30.0384, lng: 31.2113 }],
  target: { lat: 30.0385, lng: 31.2114 },
};

const form = (fields: unknown[], extra: Record<string, unknown> = {}) =>
  parseDefinition({ schema: 2, sections: [{ id: "s1", title: "بيانات", fields }], ...extra });

function issuesOf(definition: TemplateDefinition, answers: Record<string, unknown>, evidence = noEvidence) {
  return validateAnswers(definition, answers, evidence).map((issue) => issue.key);
}

describe("definition validation", () => {
  test("rejects unknown types, bad keys and duplicate keys", () => {
    expect(() => form([{ key: "a", label: "أ", type: "colour" }])).toThrow(DefinitionError);
    expect(() => form([{ key: "Bad Key", label: "أ", type: "text" }])).toThrow(DefinitionError);
    expect(() => form([{ key: "a", label: "أ", type: "text" }, { key: "a", label: "ب", type: "text" }])).toThrow(/Duplicate/);
  });

  test("choices need options; statements need a sentence and evidence", () => {
    expect(() => form([{ key: "c", label: "اختيار", type: "choice", options: [] }])).toThrow(/option/);
    expect(() => form([{ key: "s", label: "إقرار", type: "attestation" }])).toThrow(DefinitionError);
    expect(() =>
      form([{ key: "s", label: "إقرار", type: "attestation", statement: "تمت الزيارة", evidence: { kind: "visit", requires: [] } }]),
    ).toThrow(/evidence/);
  });

  test("conditions must point at fields that exist", () => {
    expect(() => form([{ key: "a", label: "أ", type: "text", visible_if: { field: "nope", op: "filled" } }])).toThrow(/unknown field/);
    expect(() => form([{ key: "a", label: "أ", type: "text", required_if: { field: "a", op: "filled" } }])).toThrow(/itself/);
  });

  test("a default answer may not claim that a visit or check happened", () => {
    expect(() => form([{ key: "n", label: "ملاحظة", type: "text", default: "تمت زيارة العميل بمقر سكنه" }])).toThrow(/claims/);
    expect(() => form([{ key: "c", label: "اختيار", type: "choice", options: ["أ"], default: "أ" }])).toThrow(/default/);
    expect(form([{ key: "n", label: "ملاحظة", type: "text", default: "لا يوجد" }]).sections[0]!.fields[0]!.default).toBe("لا يوجد");
  });

  test("questions and labels are not claims; sentences are", () => {
    expect(claimsAction("تم مقابلة العميل وتم الاطلاع على بطاقة الرقم القومي")).toBe(true);
    expect(claimsAction("بسؤال الجيران تعرفوا على العميل")).toBe(true);
    expect(claimsAction("هل تم الاطلاع علي الاوراق الخاصه للنشاط ؟ نعم لا")).toBe(false);
    expect(claimsAction("اسم من تمت مقابلته")).toBe(false);
    expect(claimsAction("امكانية الوصول للعنوان : سهلة صعبة لم يتم الوصول")).toBe(false);
  });

  test("legacy forms upgrade without losing questions or keeping claim defaults", () => {
    const upgraded = upgradeLegacy([
      {
        title: "قديم",
        fields: [
          { key: "fab12", label: "النتيجة", type: "textarea", default: "أقر أنا مكتب استعلامات بانه قد تمت زيارة المقار" },
          { key: "fcd34", label: "النوع", type: "choice", options: [] },
        ],
      },
    ]);
    const [result, kind] = upgraded.sections[0]!.fields;
    expect(result!.default).toBeUndefined();
    expect(kind!.type).toBe("text");
  });
});

describe("conditions", () => {
  test("operators over single values, lists and table columns", () => {
    const answers = { owner: "نعم", banks: ["حسابات جارية", "قروض"], staff: "12", partners: [{ share: "60" }, { share: "40" }] };
    expect(evaluate({ field: "owner", op: "eq", value: "نعم" }, answers)).toBe(true);
    expect(evaluate({ field: "banks", op: "eq", value: "قروض" }, answers)).toBe(true);
    expect(evaluate({ field: "banks", op: "not_in", value: ["ودائع"] }, answers)).toBe(true);
    expect(evaluate({ all: [{ field: "staff", op: "gt", value: 10 }, { not: { field: "staff", op: "lt", value: 5 } }] }, answers)).toBe(true);
    expect(evaluate({ any: [{ field: "owner", op: "eq", value: "لا" }, { field: "partners.share", op: "eq", value: "40" }] }, answers)).toBe(true);
    expect(evaluate({ field: "missing", op: "empty" }, answers)).toBe(true);
  });
});

describe("answer validation", () => {
  const definition = form([
    { key: "has_partners", label: "هل للعميل شركاء؟", type: "yesno", required: true },
    {
      key: "partners",
      label: "الشركاء",
      type: "table",
      visible_if: { field: "has_partners", op: "eq", value: "نعم" },
      required_if: { field: "has_partners", op: "eq", value: "نعم" },
      columns: [
        { key: "name", label: "الاسم", type: "text", required: true },
        { key: "share", label: "النسبة", type: "number", validation: { min: 0, max: 100 } },
      ],
    },
    { key: "national_id", label: "الرقم القومي", type: "national_id" },
    { key: "visit_photos", label: "صور الزيارة", type: "photos", min_items: 1 },
    {
      key: "visited",
      label: "تمت الزيارة",
      type: "attestation",
      statement: "تمت زيارة العميل بمقر سكنه",
      evidence: { kind: "visit", requires: [{ type: "gps", max_meters: 500 }, { type: "photos", field: "visit_photos", min: 2 }] },
    },
  ]);

  test("conditional requirements follow the answers", () => {
    expect(issuesOf(definition, { has_partners: "لا" }, onSite)).toEqual([]);
    expect(issuesOf(definition, { has_partners: "نعم" }, onSite)).toContain("partners");
  });

  test("table rows are checked column by column", () => {
    const keys = issuesOf(definition, { has_partners: "نعم", partners: [{ share: "150" }] }, onSite);
    expect(keys).toContain("partners.name");
    expect(keys).toContain("partners.share");
  });

  test("values are checked by type", () => {
    expect(issuesOf(definition, { has_partners: "ربما" }, onSite)).toContain("has_partners");
    expect(issuesOf(definition, { has_partners: "لا", national_id: "123" }, onSite)).toContain("national_id");
    expect(issuesOf(definition, { has_partners: "لا", national_id: "٢٩٠٠١٠١٠٠٠٠٠٠٠" }, onSite)).toEqual([]);
  });

  test("photos below the minimum are reported", () => {
    expect(issuesOf(definition, { has_partners: "لا" }, noEvidence)).toContain("visit_photos");
  });

  test("a confirmed statement needs its evidence; an unconfirmed one is just left out", () => {
    const visit = definition.sections[0]!.fields.find((field) => field.key === "visited")!;
    expect(issuesOf(definition, { has_partners: "لا" }, onSite)).not.toContain("visited");
    expect(issuesOf(definition, { has_partners: "لا", visited: true }, onSite)).toEqual([]);
    expect(issuesOf(definition, { has_partners: "لا", visited: true }, { ...onSite, photos: { visit_photos: 1 } })).toContain("visited");
    const far = { ...onSite, locations: [{ kind: "submitted", lat: 30.1, lng: 31.3 }] };
    expect(missingEvidence(visit, {}, far)[0]).toMatch(/يبعد/);
    expect(missingEvidence(visit, {}, { ...onSite, locations: [{ kind: "accepted", lat: 30.0384, lng: 31.2113 }] })[0]).toMatch(/GPS/);
  });

  test("hidden answers and unknown keys never reach a report", () => {
    const cleaned = cleanAnswers(definition, { has_partners: "لا", partners: [{ name: "x" }], injected: "<b>", visited: "نعم" });
    expect(cleaned).toEqual({ has_partners: "لا", visited: true });
  });
});
