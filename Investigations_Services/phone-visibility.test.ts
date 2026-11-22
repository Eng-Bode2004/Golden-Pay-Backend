import { describe, expect, test } from "bun:test";
import type { TemplateDefinition } from "../Shared/templates/definition.ts";
import { answersFor, answersForReport, HIDDEN_NUMBER, withoutPhone } from "./phone-visibility.ts";

// Invented numbers and text only: this repository is public.
const PHONE = "01001234567";
const definition = {
  sections: [{ title: "s", fields: [{ key: "phone", label: "الهاتف", type: "phone", prefill: "phone" }, { key: "notes", label: "ملاحظات", type: "textarea" }] }],
} as unknown as TemplateDefinition;

describe("the customer's number never reaches the investigator", () => {
  test("the field itself is removed", () => {
    expect(withoutPhone({ subject_phone: PHONE, subject_name: "عميل" })).toEqual({ subject_name: "عميل" } as never);
  });

  test("every way of writing it inside the notes is hidden", () => {
    for (const written of [PHONE, "0100 123 4567", "0100-123-4567", "+20 100 123 4567", "00201001234567", "1001234567", "٠١٠٠١٢٣٤٥٦٧", "۰۱۰۰۱۲۳۴۵۶۷"]) {
      expect(withoutPhone({ subject_phone: PHONE, admin_notes: `اتصل ${written} قبلها` }).admin_notes).toBe(`اتصل ${HIDDEN_NUMBER} قبلها`);
    }
  });

  test("the number typed another way in the phone box is still found", () => {
    for (const typed of ["+20 100 123 4567", "٠١٠٠١٢٣٤٥٦٧", "0100-123-4567"]) {
      expect(withoutPhone({ subject_phone: typed, admin_notes: PHONE }).admin_notes).toBe(HIDDEN_NUMBER);
    }
  });

  test("two numbers in the box are both hidden", () => {
    for (const box of [`${PHONE} / 01227654321`, `${PHONE} 01227654321`]) {
      const notes = withoutPhone({ subject_phone: box, admin_notes: `${PHONE} - 01227654321` }).admin_notes as string;
      expect(notes).not.toMatch(/\d{5}/);
    }
  });

  test("a landline or short number in the box is hidden too", () => {
    expect(withoutPhone({ subject_phone: "02 12345678", admin_notes: "0212345678" }).admin_notes).toBe(HIDDEN_NUMBER);
    expect(withoutPhone({ subject_phone: "16000", admin_notes: "16000" }).admin_notes).toBe(HIDDEN_NUMBER);
  });

  test("cut from the address and reference, which start form answers", () => {
    const row = withoutPhone({ subject_phone: PHONE, address: `شارع 5 - ${PHONE}`, client_reference: PHONE });
    expect(row.address).toBe("شارع 5");
    expect(row.client_reference).toBeNull();
  });

  test("email cases hide other numbers in the text, and keep IDs and dates", () => {
    const row = withoutPhone({
      source: "email",
      subject_phone: PHONE,
      admin_notes: "الرقم القومي: 29001011234567\nهاتف آخر 01551234567\nأرضي 0212345678\nبتاريخ 05-11-2030",
    });
    expect(row.admin_notes).toBe(`الرقم القومي: 29001011234567\nهاتف آخر ${HIDDEN_NUMBER}\nأرضي ${HIDDEN_NUMBER}\nبتاريخ 05-11-2030`);
  });

  test("a typed case keeps other numbers the admin wrote for the investigator", () => {
    expect(withoutPhone({ source: "manual", subject_phone: PHONE, admin_notes: "الأمن 01551234567" }).admin_notes).toBe("الأمن 01551234567");
  });

  test("text without the number is untouched, Arabic digits included", () => {
    const row = { subject_phone: PHONE, address: "١٢ شارع التحرير", admin_notes: "سطر\n  سطر", subject_name: "عميل" };
    const { subject_phone: _hidden, ...rest } = row;
    expect(withoutPhone(row)).toEqual(rest as never);
  });
});

describe("answers", () => {
  const claimed = new Date("2030-01-01T10:00:00Z");
  const later = new Date("2030-01-01T11:00:00Z");
  const row = { answers: { phone: PHONE, notes: "n" }, assignee_id: "me", claimed_at: claimed, started_at: later, updated_at: later };

  test("what the investigator typed stays theirs", () => {
    expect(answersFor(definition, row, "me")).toEqual({ phone: PHONE, notes: "n" });
  });

  test("an offer, a taken-back case and a reassigned case do not pass the number on", () => {
    expect(answersFor(definition, { ...row, assignee_id: null }, "me")).toEqual({ notes: "n" });
    expect(answersFor(definition, { ...row, started_at: null }, "me")).toEqual({ notes: "n" });
    expect(answersFor(definition, { ...row, started_at: new Date("2029-12-31T09:00:00Z"), updated_at: claimed }, "me")).toEqual({ notes: "n" });
  });

  test("the report still prints it, and a typed answer wins", () => {
    expect(answersForReport(definition, { answers: {}, subject_phone: PHONE })).toEqual({ phone: PHONE });
    expect(answersForReport(definition, { answers: { phone: "01227654321" }, subject_phone: PHONE })).toEqual({ phone: "01227654321" });
  });
});
