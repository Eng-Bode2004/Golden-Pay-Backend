import { expect, test } from "bun:test";
import { allFields, parseDefinition, type TemplateDefinition } from "../Shared/templates/definition.ts";
import type { Binding } from "../Shared/templates/scan.ts";
import { carryOver } from "./templates.ts";

const definition = (fields: [string, string][]): TemplateDefinition =>
  ({ schema: 2, sections: [{ id: "s1", title: "بيانات", fields: fields.map(([key, label]) => ({ key, label, type: "text" })) }] }) as TemplateDefinition;

test("a new draft keeps old keys for matching labels", () => {
  const scan = { definition: definition([["f_new1", "اسم العميل"], ["f_new2", "العنوان"]]), bindings: [{ anchor: "gp_001", action: "text", source: "answers.f_new1" }] as Binding[] };
  carryOver(scan, definition([["subject_name", "اسم العميل"]]));
  expect(allFields(scan.definition).map((field) => field.key)).toEqual(["subject_name", "f_new2"]);
  expect(scan.bindings[0]!.source).toBe("answers.subject_name");
});

test("an old key another new field already has is not taken over", () => {
  // The old version called «العنوان» f_b; the new scan already has a different field keyed f_b.
  const scan = { definition: definition([["f_a", "العنوان"], ["f_b", "رقم التليفون"]]), bindings: [] as Binding[] };
  carryOver(scan, definition([["f_b", "العنوان"]]));
  expect(allFields(scan.definition).map((field) => field.key)).toEqual(["f_a", "f_b"]);
  expect(() => parseDefinition(scan.definition)).not.toThrow();
});
