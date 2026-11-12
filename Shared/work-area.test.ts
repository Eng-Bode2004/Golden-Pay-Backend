// The work area an investigator picks at signup: checked before the account is made.
import { expect, test } from "bun:test";
import { hasWorkArea, nameKey, parseWorkArea } from "./work-area.ts";

test("an area needs a governorate; deeper levels, street and map point are optional", () => {
  const area = parseWorkArea({ governorate: "الجيزة", district: "الدقي", street: "شارع التحرير", lat: 30.04, lng: 31.21 });
  expect(area.names.governorate).toBe("الجيزة");
  expect(area.names.district).toBe("الدقي");
  expect(area.names.local_unit).toBeNull();
  expect(area.street).toBe("شارع التحرير");
  expect([area.lat, area.lng]).toEqual([30.04, 31.21]);
  expect(() => parseWorkArea({ district: "الدقي" })).toThrow();
});

test("a map point comes whole and inside the world", () => {
  expect(() => parseWorkArea({ governorate: "الجيزة", lat: 30 })).toThrow();
  expect(() => parseWorkArea({ governorate: "الجيزة", lat: 120, lng: 31 })).toThrow();
});

test("older app versions send no area: signup goes on without one", () => {
  expect(hasWorkArea({ full_name: "محمد", phone: "010" })).toBe(false);
  expect(hasWorkArea({ governorate: "  " })).toBe(false);
  expect(hasWorkArea({ governorate: "الجيزة" })).toBe(true);
});

test("spelling variants of a place name match", () => {
  expect(nameKey("الإسكندرية")).toBe(nameKey("الاسكندريه"));
  expect(nameKey("  كفر  الشيخ ")).toBe(nameKey("كفر الشيخ"));
});
