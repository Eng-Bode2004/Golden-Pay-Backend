import { describe, expect, test } from "bun:test";
import { nextGroup } from "./dispatch.ts";

const candidate = (user_id: string, tier: number, busy = false) => ({ user_id, tier, busy });

describe("who gets a case at once", () => {
  test("an area case goes to everyone free in the area", () => {
    const ranked = [candidate("a", 3), candidate("b", 1), candidate("c", 0, true), candidate("d", 0)];
    expect(nextGroup(ranked, true).map((item) => item.user_id)).toEqual(["a", "b", "d"]);
  });

  test("an address case goes to everyone free at the closest matching level", () => {
    const ranked = [candidate("busy", 5, true), candidate("a", 4), candidate("b", 4), candidate("c", 2)];
    expect(nextGroup(ranked, false).map((item) => item.user_id)).toEqual(["a", "b"]);
  });

  test("nobody free means no offers yet", () => {
    expect(nextGroup([candidate("a", 4, true)], false)).toEqual([]);
    expect(nextGroup([], true)).toEqual([]);
  });
});
