/**
 * Dispatch against a real PostgreSQL: transactions, row locks, unique indexes and concurrent
 * connections. Runs only with TEST_DATABASE_URL pointing at a database whose name contains
 * "test" (it is wiped first):
 *
 *   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/goldenpay_test bun test Investigations_Services/dispatch.db.test.ts
 *
 * Without it the suite is skipped (the pure fairness rules are in dispatch.test.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const url = process.env.TEST_DATABASE_URL ?? "";
const usable = (() => {
  try {
    return Boolean(url) && /test/i.test(new URL(url).pathname) && process.env.NODE_ENV !== "production";
  } catch {
    return false;
  }
})();

type Db = typeof import("../IdentityAcess_Services/Config/db.ts");
type Dispatch = typeof import("./dispatch.ts");
type Area = typeof import("../Shared/work-area.ts");
let db: Db;
let dispatch: Dispatch;
let area: Area;
let counter = 0;
const root = join(import.meta.dir, "..");

const statements = (sql: string) =>
  sql
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);

async function user(status = "active"): Promise<string> {
  const id = `t-${++counter}-${Math.random().toString(36).slice(2, 8)}`;
  await db.query(
    `INSERT INTO users (user_id, full_name, phone, national_id_encrypted, national_id_hash, national_id_last4,
       password_hash, account_type, status)
     VALUES ($1, $1, $1, 'x', $1, '0000', 'x', 'new_investigator', $2)`,
    [id, status],
  );
  return id;
}

async function investigator(governorate: string, district: string, extra: { available?: boolean; status?: string } = {}) {
  const id = await user(extra.status ?? "active");
  await area.saveWorkArea(area.parseWorkArea({ governorate, district }), id);
  // Registered long ago: not a newcomer unless a test says so.
  await db.query("UPDATE investigator_service_areas SET created_at = now() - interval '90 days' WHERE user_id = $1", [id]);
  if (extra.available === false) await db.query("UPDATE investigator_profiles SET available = false WHERE user_id = $1", [id]);
  return id;
}

async function newCase(governorate: string, district: string, extra: { mode?: "person" | "area"; preferred?: string; recipients?: string[] } = {}) {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO investigations (investigation_id, reference, status, target_mode, preferred_id, subject_name, address,
       governorate, district, client_id, client_name, template_id, form_title, form_snapshot, created_by, accept_minutes)
     VALUES ($1, $1, 'open', $2, $3, 'subject', 'address', $4, $5, 'c', 'client', 't', 'form', '{}', 'admin', 30)`,
    [id, extra.mode ?? "person", extra.preferred ?? null, governorate, district],
  );
  for (const recipient of extra.recipients ?? []) {
    await db.query("INSERT INTO investigation_recipients (investigation_id, user_id) VALUES ($1, $2)", [id, recipient]);
  }
  return id;
}

const openOffers = async (caseId: string) =>
  (await db.query("SELECT user_id FROM investigation_offers WHERE investigation_id = $1 AND response IS NULL", [caseId]))
    .map((row) => row.user_id as string)
    .sort();

const expireAll = async (caseId: string) => {
  await db.query("UPDATE investigation_offers SET expires_at = now() - interval '1 second' WHERE investigation_id = $1 AND response IS NULL", [caseId]);
  await dispatch.expireOffers();
};

/** Finishes a case through the normal review path (approval ends the assignment). */
const complete = async (caseId: string) => {
  await db.query("UPDATE investigations SET status = 'approved', started_at = now() WHERE investigation_id = $1", [caseId]);
  await dispatch.endAssignment(caseId, "completed", "admin");
};

const sorted = (list: string[]) => [...list].sort();

describe.skipIf(!usable)("dispatch on PostgreSQL", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.DB_POOL_MAX = "25";
    db = await import("../IdentityAcess_Services/Config/db.ts");
    await db.database.unsafe("DROP SCHEMA public CASCADE");
    await db.database.unsafe("CREATE SCHEMA public");
    await db.applySchema();
    for (const file of ["Investigators_Services/schema.sql", "Investigations_Services/schema.sql"]) {
      for (const statement of statements(await readFile(join(root, file), "utf8"))) await db.database.unsafe(statement);
    }
    dispatch = await import("./dispatch.ts");
    area = await import("../Shared/work-area.ts");
  });
  afterAll(async () => {
    await db?.database.end({ timeout: 5 });
  });

  test("1–5: four investigators share cases one round at a time, then a new round starts", async () => {
    const [A, B, C, D] = await Promise.all(["", "", "", ""].map(() => investigator("gov-fair", "d1")));
    const people = [A!, B!, C!, D!];
    const winners = [A!, B!, C!, D!];
    for (let step = 0; step < 4; step++) {
      const caseId = await newCase("gov-fair", "d1");
      await dispatch.offerNext(caseId);
      const expected = sorted(people.filter((person) => !winners.slice(0, step).includes(person)));
      expect(await openOffers(caseId)).toEqual(expected);
      await dispatch.acceptOffer(caseId, winners[step]!);
      await complete(caseId);
    }
    // Everyone has one: the next case goes to all four again.
    const fifth = await newCase("gov-fair", "d1");
    await dispatch.offerNext(fifth);
    expect(await openOffers(fifth)).toEqual(sorted(people));
  });

  test("6: simultaneous acceptance has exactly one winner, one ledger row, no double count", async () => {
    const people = await Promise.all(Array.from({ length: 6 }, () => investigator("gov-race", "d1")));
    const caseId = await newCase("gov-race", "d1");
    await dispatch.offerNext(caseId);
    const results = await Promise.allSettled(people.map((person) => dispatch.acceptOffer(caseId, person)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const ledger = await db.query("SELECT * FROM investigation_assignments WHERE investigation_id = $1", [caseId]);
    expect(ledger).toHaveLength(1);
    const offers = await db.query("SELECT response, count(*)::int AS n FROM investigation_offers WHERE investigation_id = $1 GROUP BY response", [caseId]);
    expect(Object.fromEntries(offers.map((row) => [row.response, row.n]))).toEqual({ accepted: 1, taken: 5 });
    // Repeating the winning request is harmless.
    const winner = ledger[0]!.user_id as string;
    expect((await dispatch.acceptOffer(caseId, winner)).repeated).toBe(true);
    expect(await db.query("SELECT 1 FROM investigation_assignments WHERE investigation_id = $1", [caseId])).toHaveLength(1);
  });

  test("7: two cases dispatched and accepted at the same time stay consistent", async () => {
    const [A, B] = await Promise.all([investigator("gov-two", "d1"), investigator("gov-two", "d1")]);
    const [one, two] = await Promise.all([newCase("gov-two", "d1"), newCase("gov-two", "d1")]);
    await Promise.all([dispatch.offerNext(one), dispatch.offerNext(two)]);
    expect(await openOffers(one)).toEqual(sorted([A!, B!]));
    expect(await openOffers(two)).toEqual(sorted([A!, B!]));
    await Promise.all([dispatch.acceptOffer(one, A!), dispatch.acceptOffer(two, B!)]);
    const owners = await db.query("SELECT investigation_id, assignee_id FROM investigations WHERE investigation_id = ANY($1::text[])", [[one, two]]);
    expect(Object.fromEntries(owners.map((row) => [row.investigation_id, row.assignee_id]))).toEqual({ [one]: A, [two]: B });
  });

  test("8 & 10: an offline investigator who never answers does not block the area", async () => {
    const silent = await investigator("gov-silent", "d1");
    const other = await investigator("gov-silent", "d1");
    // `other` has more history, so the silent one is asked first.
    const history = await newCase("gov-silent", "elsewhere");
    await db.query("INSERT INTO investigation_assignments (investigation_id, user_id, source, ended_at, end_reason) VALUES ($1, $2, 'manual', now(), 'completed')", [history, other]);
    const caseId = await newCase("gov-silent", "d1");
    await dispatch.offerNext(caseId);
    expect(await openOffers(caseId)).toEqual([silent]);
    await expireAll(caseId);
    expect(await openOffers(caseId)).toEqual([other]);
    await expireAll(caseId);
    const [row] = await db.query("SELECT status FROM investigations WHERE investigation_id = $1", [caseId]);
    expect(row!.status).toBe("unassigned");
  });

  test("9: a decline leaves the others' offers open; the next group gets it when all decline", async () => {
    const [A, B, C] = await Promise.all([investigator("gov-dec", "d1"), investigator("gov-dec", "d1"), investigator("gov-dec", "d1")]);
    const old = await newCase("gov-dec", "past");
    await db.query("INSERT INTO investigation_assignments (investigation_id, user_id, source, ended_at, end_reason) VALUES ($1, $2, 'manual', now(), 'completed')", [old, C]);
    const caseId = await newCase("gov-dec", "d1");
    await dispatch.offerNext(caseId);
    expect(await openOffers(caseId)).toEqual(sorted([A!, B!]));
    await dispatch.declineOffer(caseId, A!, "busy");
    expect(await openOffers(caseId)).toEqual([B!]);
    await dispatch.declineOffer(caseId, B!, null);
    expect(await openOffers(caseId)).toEqual([C!]);
  });

  test("11: an investigator who changes area stops receiving the old area's cases", async () => {
    const mover = await investigator("gov-move", "d1");
    const stayer = await investigator("gov-move", "d1");
    await area.saveWorkArea(area.parseWorkArea({ governorate: "gov-elsewhere", district: "d9" }), mover);
    const caseId = await newCase("gov-move", "d1");
    await dispatch.offerNext(caseId);
    expect(await openOffers(caseId)).toEqual([stayer]);
  });

  test("12: overlapping service areas give one offer per investigator", async () => {
    const both = await investigator("gov-overlap", "d1");
    await db.query(
      `INSERT INTO investigator_service_areas (user_id, governorate, district, governorate_key, district_key)
       VALUES ($1, 'gov-overlap', 'd1', 'gov-overlap', 'd1')`,
      [both],
    );
    const caseId = await newCase("gov-overlap", "d1");
    await dispatch.offerNext(caseId);
    expect(await db.query("SELECT 1 FROM investigation_offers WHERE investigation_id = $1", [caseId])).toHaveLength(1);
  });

  test("13: a suspended investigator is excluded and the reason is recorded", async () => {
    const suspended = await investigator("gov-susp", "d1", { status: "suspended" });
    const active = await investigator("gov-susp", "d1");
    const caseId = await newCase("gov-susp", "d1");
    await dispatch.offerNext(caseId);
    expect(await openOffers(caseId)).toEqual([active]);
    const [attempt] = await db.query("SELECT excluded FROM dispatch_attempts WHERE investigation_id = $1", [caseId]);
    expect(attempt!.excluded).toContainEqual({ user_id: suspended, reason: "account_suspended" });
  });

  test("14: a case cancelled before work started stops counting for fairness", async () => {
    const person = await investigator("gov-cancel", "d1");
    const caseId = await newCase("gov-cancel", "d1");
    await dispatch.offerNext(caseId);
    await dispatch.acceptOffer(caseId, person);
    await db.query("UPDATE investigations SET status = 'cancelled' WHERE investigation_id = $1", [caseId]);
    await dispatch.endAssignment(caseId, "cancelled", "admin", "client withdrew");
    const [row] = await db.query("SELECT counts, end_reason FROM investigation_assignments WHERE investigation_id = $1", [caseId]);
    expect(row).toEqual({ counts: false, end_reason: "cancelled" });
  });

  test("15 & 16: manual assignment and reassignment close offers and keep the ledger exact", async () => {
    const [A, B] = await Promise.all([investigator("gov-manual", "d1"), investigator("gov-manual", "d1")]);
    const caseId = await newCase("gov-manual", "d1");
    await dispatch.offerNext(caseId);
    await dispatch.assignManually(caseId, A!, (await user()) as string, "client asked for A");
    expect(await openOffers(caseId)).toEqual([]);
    await db.query("UPDATE investigations SET started_at = now(), status = 'in_progress' WHERE investigation_id = $1", [caseId]);
    await dispatch.assignManually(caseId, B!, (await user()) as string, "A is sick");
    const ledger = await db.query(
      "SELECT user_id, source, counts, end_reason FROM investigation_assignments WHERE investigation_id = $1 ORDER BY assigned_at",
      [caseId],
    );
    expect(ledger).toEqual([
      { user_id: A, source: "manual", counts: true, end_reason: "reassigned" },
      { user_id: B, source: "manual", counts: true, end_reason: null },
    ]);
    const [item] = await db.query("SELECT assignee_id, status FROM investigations WHERE investigation_id = $1", [caseId]);
    expect(item).toEqual({ assignee_id: B, status: "in_progress" });
  });

  test("17: a newcomer joining an area is offered before established investigators", async () => {
    const established = await investigator("gov-new", "d1");
    for (let index = 0; index < 3; index++) {
      const done = await newCase("gov-new", "past");
      await db.query("INSERT INTO investigation_assignments (investigation_id, user_id, source, ended_at, end_reason) VALUES ($1, $2, 'manual', now(), 'completed')", [done, established]);
    }
    const newcomer = await investigator("gov-new", "d1");
    await db.query("UPDATE investigator_service_areas SET created_at = now() WHERE user_id = $1", [newcomer]);
    const caseId = await newCase("gov-new", "d1");
    await dispatch.offerNext(caseId);
    expect(await openOffers(caseId)).toEqual([newcomer]);
  });

  test("18: an investigator at the workload limit gets no new offers", async () => {
    const busy = await investigator("gov-busy", "d1");
    const free = await investigator("gov-busy", "d1");
    const first = await newCase("gov-busy", "d1");
    await dispatch.assignManually(first, busy, (await user()) as string, "setup");
    // Score-wise `busy` now has one; give `free` more history so only the limit decides.
    for (let index = 0; index < 2; index++) {
      const done = await newCase("gov-busy", "past");
      await db.query("INSERT INTO investigation_assignments (investigation_id, user_id, source, ended_at, end_reason) VALUES ($1, $2, 'manual', now(), 'completed')", [done, free]);
    }
    const caseId = await newCase("gov-busy", "d1");
    await dispatch.offerNext(caseId);
    expect(await openOffers(caseId)).toEqual([free]);
  });

  test("19: several workers dispatching the same case at once issue each offer once", async () => {
    await Promise.all(Array.from({ length: 3 }, () => investigator("gov-workers", "d1")));
    const caseId = await newCase("gov-workers", "d1");
    await Promise.all(Array.from({ length: 8 }, () => dispatch.offerNext(caseId)));
    await Promise.all(Array.from({ length: 4 }, () => dispatch.resumeOpenCases()));
    expect(await db.query("SELECT 1 FROM investigation_offers WHERE investigation_id = $1", [caseId])).toHaveLength(3);
    expect(await db.query("SELECT 1 FROM dispatch_outbox WHERE investigation_id = $1 AND kind = 'offer'", [caseId])).toHaveLength(3);
  });

  test("20: three hundred investigators are offered at once and one accept wins", async () => {
    const people: string[] = [];
    for (let batch = 0; batch < 6; batch++) {
      people.push(...(await Promise.all(Array.from({ length: 50 }, () => investigator("gov-big", "d1")))));
    }
    const caseId = await newCase("gov-big", "d1");
    await dispatch.offerNext(caseId);
    expect(await openOffers(caseId)).toHaveLength(300);
    const results = await Promise.allSettled(people.slice(0, 40).map((person) => dispatch.acceptOffer(caseId, person)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await openOffers(caseId)).toEqual([]);
  });

  test("an area case reaches everyone the admin's area selected", async () => {
    const people = await Promise.all(Array.from({ length: 3 }, () => investigator("gov-area", "anywhere")));
    const caseId = await newCase("gov-area", "d1", { mode: "area", recipients: people });
    await dispatch.offerNext(caseId);
    expect(await openOffers(caseId)).toEqual(sorted(people));
  });
});
