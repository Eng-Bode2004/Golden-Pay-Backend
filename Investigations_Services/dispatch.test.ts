import { describe, expect, test } from "bun:test";
import { DEFAULT_POLICY, imbalance, type Policy, type PoolMember, selectNext, selectSequential } from "./fairness.ts";

const member = (user_id: string, extra: Partial<PoolMember> = {}): PoolMember => ({
  user_id,
  tier: 2,
  km: null,
  account_status: "active",
  available: true,
  recent: 0,
  active: 0,
  newcomer: false,
  offered: false,
  declined: false,
  ...extra,
});
const ids = (list: { user_id: string }[]) => list.map((item) => item.user_id).sort();
const policy = (extra: Partial<Policy> = {}): Policy => ({ ...DEFAULT_POLICY, newcomer_boost: false, ...extra });

describe("least-assigned-first broadcast", () => {
  test("four investigators at zero: the first case goes to all four", () => {
    const pool = ["A", "B", "C", "D"].map((id) => member(id));
    expect(ids(selectNext(pool, policy()).offer)).toEqual(["A", "B", "C", "D"]);
  });

  test("after A has one, the next case goes to B, C and D; then C and D; then D", () => {
    const counts: Record<string, number> = { A: 1, B: 0, C: 0, D: 0 };
    const pool = () => Object.entries(counts).map(([id, recent]) => member(id, { recent }));
    expect(ids(selectNext(pool(), policy()).offer)).toEqual(["B", "C", "D"]);
    counts.B = 1;
    expect(ids(selectNext(pool(), policy()).offer)).toEqual(["C", "D"]);
    counts.C = 1;
    expect(ids(selectNext(pool(), policy()).offer)).toEqual(["D"]);
  });

  test("when everyone is equal again, a new round starts with all of them", () => {
    const pool = ["A", "B", "C", "D"].map((id) => member(id, { recent: 1 }));
    expect(ids(selectNext(pool, policy()).offer)).toEqual(["A", "B", "C", "D"]);
  });

  test("nobody accepts: the next score group gets it, without asking the first group again", () => {
    const pool = [
      member("A", { recent: 0, offered: true }),
      member("B", { recent: 0, offered: true }),
      member("C", { recent: 2 }),
      member("D", { recent: 3 }),
    ];
    const next = selectNext(pool, policy());
    expect(ids(next.offer)).toEqual(["C"]);
    expect(next.excluded.filter((item) => item.reason === "already_offered").map((item) => item.user_id).sort()).toEqual(["A", "B"]);
  });

  test("everyone asked and nobody accepted: exhausted, escalate to the admin", () => {
    const pool = ["A", "B"].map((id) => member(id, { offered: true }));
    const result = selectNext(pool, policy());
    expect(result.offer).toEqual([]);
    expect(result.exhausted).toBe(true);
  });

  test("a decline excludes only that investigator for this round", () => {
    const pool = [member("A", { declined: true, offered: true }), member("B", { recent: 1 })];
    const result = selectNext(pool, policy());
    expect(ids(result.offer)).toEqual(["B"]);
    expect(result.excluded).toContainEqual({ user_id: "A", reason: "declined" });
  });
});

describe("eligibility", () => {
  test("suspended, unavailable and busy investigators are excluded with a reason", () => {
    const pool = [
      member("S", { account_status: "suspended" }),
      member("U", { available: false }),
      member("W", { active: 1 }),
      member("OK", { recent: 5 }),
    ];
    const result = selectNext(pool, policy());
    expect(ids(result.offer)).toEqual(["OK"]);
    expect(Object.fromEntries(result.excluded.map((item) => [item.user_id, item.reason]))).toEqual({
      S: "account_suspended",
      U: "unavailable",
      W: "workload_limit",
    });
  });

  test("a single unavailable investigator never blocks the area", () => {
    const pool = [member("U", { available: false }), member("B", { recent: 4 })];
    expect(ids(selectNext(pool, policy()).offer)).toEqual(["B"]);
  });

  test("everyone busy: wait for someone to finish instead of escalating", () => {
    const result = selectNext([member("A", { active: 1 }), member("B", { available: false })], policy());
    expect(result.waiting).toBe(true);
    expect(result.exhausted).toBe(false);
  });

  test("a higher workload limit lets busy investigators receive offers", () => {
    const pool = [member("A", { active: 2, recent: 0 }), member("B", { recent: 1 })];
    expect(ids(selectNext(pool, policy({ max_active: 3 })).offer)).toEqual(["A"]);
  });

  test("the closest geographic level goes first, regardless of scores further out", () => {
    const pool = [member("village", { tier: 4, recent: 6 }), member("district", { tier: 2, recent: 0 })];
    expect(ids(selectNext(pool, policy()).offer)).toEqual(["village"]);
    const next = selectNext([member("village", { tier: 4, offered: true }), member("district", { tier: 2 })], policy());
    expect(ids(next.offer)).toEqual(["district"]);
  });

  test("investigators outside the case's area are never offered it", () => {
    expect(selectNext([member("far", { tier: 0 })], policy()).offer).toEqual([]);
  });
});

describe("fairness policy", () => {
  test("hybrid mode adds active workload to the score", () => {
    const pool = [member("A", { recent: 1, active: 0 }), member("B", { recent: 0, active: 2 })];
    expect(ids(selectNext(pool, policy({ score_mode: "hybrid", max_active: 5 })).offer)).toEqual(["A"]);
    expect(ids(selectNext(pool, policy({ score_mode: "assignments", max_active: 5 })).offer)).toEqual(["B"]);
  });

  test("a newcomer starts just under the established minimum, not at zero", () => {
    const pool = [member("old1", { recent: 5 }), member("old2", { recent: 6 }), member("new", { recent: 0, newcomer: true })];
    const result = selectNext(pool, policy({ newcomer_boost: true }));
    expect(ids(result.offer)).toEqual(["new"]);
    expect(result.eligible.find((item) => item.user_id === "new")?.score).toBe(4);
  });

  test("the sequential engine (rollback) offers one investigator at a time", () => {
    const pool = ["A", "B", "C"].map((id) => member(id));
    expect(selectSequential(pool, policy()).offer).toHaveLength(1);
  });

  test("hundreds of investigators: one decision, everyone at the minimum is offered", () => {
    const pool = Array.from({ length: 400 }, (_, index) => member(`u${index}`, { recent: index % 3 }));
    const result = selectNext(pool, policy());
    expect(result.offer).toHaveLength(134);
    expect(result.min_score).toBe(0);
  });

  test("imbalance measures how uneven the work is", () => {
    expect(imbalance([1, 1, 1, 1])).toEqual({ spread: 0, stddev: 0 });
    expect(imbalance([0, 2]).spread).toBe(2);
  });
});
