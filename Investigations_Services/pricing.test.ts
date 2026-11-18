import { describe, expect, test } from "bun:test";
import { pickRule } from "./pricing.ts";
import { nameKey } from "../Shared/work-area.ts";

const rule = (id: string, client: string | null, governorate: string | null, district: string | null) => ({
  id,
  client_id: client,
  governorate_key: governorate ? nameKey(governorate) : null,
  district_key: district ? nameKey(district) : null,
});

const rules = [
  rule("giza", null, "الجيزة", null),
  rule("dokki", null, "الجيزة", "الدقي"),
  rule("misr", "banque-misr", null, null),
  rule("misr-giza", "banque-misr", "الجيزة", null),
  rule("misr-dokki", "banque-misr", "الجيزة", "الدقي"),
];

describe("which price applies to a case", () => {
  test("the client's price for the exact district wins", () => {
    expect(pickRule(rules, "banque-misr", "الجيزة", "الدقي")?.id).toBe("misr-dokki");
  });

  test("then the client's price for the governorate, then the client's general price", () => {
    expect(pickRule(rules, "banque-misr", "الجيزة", "العجوزة")?.id).toBe("misr-giza");
    expect(pickRule(rules, "banque-misr", "القاهرة", "مدينة نصر")?.id).toBe("misr");
  });

  test("a client with no prices of its own gets the area's price", () => {
    expect(pickRule(rules, "cib", "الجيزة", "الدقي")?.id).toBe("dokki");
    expect(pickRule(rules, "cib", "الجيزة", "العجوزة")?.id).toBe("giza");
  });

  test("no matching rule: the investigation type's own prices", () => {
    expect(pickRule(rules, "cib", "القاهرة", null)).toBeNull();
  });

  test("spelling variants of a place name match (ة/ه, أ/ا)", () => {
    expect(pickRule([rule("x", null, "الجيزة", null)], null, "الجيزه", null)?.id).toBe("x");
  });

  test("another client's price never applies", () => {
    expect(pickRule([rule("cib-only", "cib", null, null)], "banque-misr", "الجيزة", null)).toBeNull();
  });
});
