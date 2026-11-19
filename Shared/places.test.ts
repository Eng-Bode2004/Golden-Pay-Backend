import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { closestPlace, distance } from "./places.ts";
import { nameKey } from "./work-area.ts";

const egypt = (await Bun.file(join(import.meta.dir, "..", "Investigators_Services", "Seeds", "egypt.json")).json()) as {
  name: string;
  districts: { name: string }[];
}[];
const governorates = egypt.map((item) => ({ name: item.name }));

describe("one place, many spellings", () => {
  test("spelling variants share one key", () => {
    const cairo = nameKey("القاهرة");
    for (const variant of ["القاهره", "قاهرة", "محافظة القاهرة", " القاهرة. ", "القاهرة‎", "القـاهرة", "القاهِرة"]) {
      expect(nameKey(variant.replace(/‎/g, ""))).toBe(cairo);
    }
    expect(nameKey("كفر الشيخ")).toBe(nameKey("كفرالشيخ"));
    expect(nameKey("مركز ميت غمر")).toBe(nameKey("ميت غمر"));
    expect(nameKey("قرية الشيخ زايد")).toBe(nameKey("الشيخ زايد"));
    expect(nameKey("١٥ مايو")).toBe(nameKey("15 مايو"));
    expect(nameKey("الجيزة")).not.toBe(nameKey("القاهرة"));
  });

  test("a missing or extra letter still finds the governorate", () => {
    expect(closestPlace("القاهر", governorates)?.name).toBe("القاهرة");
    expect(closestPlace("الاسكندريه", governorates)?.name).toBe(egypt.find((g) => nameKey(g.name) === nameKey("الإسكندرية"))?.name);
    expect(closestPlace("الجيزه", governorates)?.name).toBe(egypt.find((g) => nameKey(g.name) === nameKey("الجيزة"))?.name);
    expect(closestPlace("باريس", governorates)).toBeNull();
  });

  test("every governorate and district keeps its own name (no two real places merge)", () => {
    const keys = new Set(governorates.map((g) => nameKey(g.name)));
    expect(keys.size).toBe(governorates.length);
    for (const g of governorates) expect(closestPlace(g.name, governorates)?.name).toBe(g.name);
    for (const governorate of egypt) {
      const districts = governorate.districts.map((d) => ({ name: d.name }));
      // Spelled-alike seed entries («اطسا» / «إطسا») are one place: same key.
      for (const d of districts) expect(nameKey(closestPlace(d.name, districts)!.name)).toBe(nameKey(d.name));
    }
  });

  test("distance", () => {
    expect(distance("قاهره", "قاهر")).toBe(1);
    expect(distance("abc", "abc")).toBe(0);
    expect(distance("abcdef", "xyz", 2)).toBe(3);
  });
});
