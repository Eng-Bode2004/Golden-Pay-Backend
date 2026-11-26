import { describe, expect, test } from "bun:test";
import { carryAnswers, deadlineFor, EDITABLE, RESENDABLE } from "./edit.ts";

describe("editing a sent investigation", () => {
  test("a new form keeps the answers it has fields for and lists the rest", () => {
    const { kept, dropped } = carryAnswers(
      { job: "محاسب", salary: "5000", shop_size: "كبير", empty: "", none: null, list: [] },
      new Set(["job", "salary", "rooms"]),
    );
    expect(kept).toEqual({ job: "محاسب", salary: "5000" });
    // Blank answers are not counted as lost.
    expect(dropped).toEqual(["shop_size"]);
  });

  test("no answers yet: nothing kept, nothing lost", () => {
    expect(carryAnswers(null, new Set(["a"]))).toEqual({ kept: {}, dropped: [] });
  });

  test("the deadline counts from when the case was sent, or is the appointment", () => {
    const sent = new Date("2026-11-20T10:00:00Z");
    expect(deadlineFor({ delivery_hours: 24 }, null, sent).toISOString()).toBe("2026-11-21T10:00:00.000Z");
    const appointment = new Date("2026-11-30T09:00:00Z");
    expect(deadlineFor({ delivery_hours: 24 }, appointment, sent)).toEqual(appointment);
  });

  test("a scheduled type needs an appointment", () => {
    expect(() => deadlineFor({ delivery_hours: null }, null, new Date())).toThrow();
  });

  test("approved and cancelled cases stay as they are; re-sending only before work starts", () => {
    expect(EDITABLE).not.toContain("approved");
    expect(EDITABLE).not.toContain("cancelled");
    expect(RESENDABLE).not.toContain("in_progress");
    expect(RESENDABLE).not.toContain("submitted");
  });
});
