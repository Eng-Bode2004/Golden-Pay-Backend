import { describe, expect, test } from "bun:test";
import type { TemplateDefinition } from "../Shared/templates/definition.ts";
import { firstPhotosKey, NOT_IDENTIFIED, negativeAnswers, negativeSummary } from "./negative.ts";

const definition = {
  schema: 2,
  sections: [
    {
      id: "s1",
      title: "البيانات",
      fields: [
        { key: "name", label: "الاسم", type: "text", prefill: "subject_name" },
        { key: "job", label: "الوظيفة", type: "text" },
        { key: "residence", label: "نوع السكن", type: "choice", options: ["ملك", "إيجار"] },
        { key: "known", label: "هل تعرف عليه الجيران", type: "choice", options: ["نعم", "لا", "لم يتم التعرف عليه"] },
        { key: "income", label: "الدخل", type: "number" },
        { key: "house", label: "صورة المنزل", type: "photos" },
        { key: "opinion", label: "رأي المستعلم", type: "textarea" },
        { key: "ok", label: "زرت العنوان", type: "attestation", statement: "تمت الزيارة" },
      ],
    },
  ],
} as unknown as TemplateDefinition;

const row = {
  subject_name: "أحمد علي",
  answers: {},
  negative_asked: "حارس العقار وصاحب المحل المجاور",
  negative_reasons: ["الشخص غير مقيم بالعنوان"],
  negative_note: "لم يتعرف عليه أحد في الشارع.",
};

describe("negative report on the client's form", () => {
  const answers = negativeAnswers(definition, row);

  test("known case details stay, other text reads «لم يتم التعرف عليه»", () => {
    expect(answers.name).toBe("أحمد علي");
    expect(answers.job).toBe(NOT_IDENTIFIED);
  });

  test("choices stay unticked unless the form has a «not identified» option", () => {
    expect(answers.residence).toBeUndefined();
    expect(answers.known).toBe("لم يتم التعرف عليه");
    expect(answers.income).toBeUndefined();
    expect(answers.ok).toBeUndefined();
  });

  test("the notes say whom we asked, the reasons and what happened", () => {
    expect(answers.opinion).toBe(negativeSummary(row));
    expect(String(answers.opinion)).toContain("تم سؤال: حارس العقار وصاحب المحل المجاور");
    expect(String(answers.opinion)).toContain("الشخص غير مقيم بالعنوان");
  });

  test("photos of the place go in the form's first photo box", () => {
    expect(firstPhotosKey(definition)).toBe("house");
  });
});
