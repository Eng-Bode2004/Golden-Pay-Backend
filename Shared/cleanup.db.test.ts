/**
 * Clean-ups on a real PostgreSQL: deleting an investigator with everything that belongs to
 * them, and clearing test data. Runs only with TEST_DATABASE_URL pointing at a throwaway
 * database (its address must contain "test"), never in production:
 *   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/goldenpay_test bun test Shared/cleanup.db.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const url = process.env.TEST_DATABASE_URL ?? "";
const usable = Boolean(url) && /test/i.test(url) && process.env.NODE_ENV !== "production";

type Db = typeof import("../IdentityAcess_Services/Config/db.ts");
type Cleanup = typeof import("./cleanup.ts");
let db: Db;
let cleanup: Cleanup;
let counter = 0;
const root = join(import.meta.dir, "..");

const statements = (sql: string) =>
  sql
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);

async function person(role: string | null): Promise<string> {
  const id = `c-${++counter}-${Math.random().toString(36).slice(2, 8)}`;
  await db.query(
    `INSERT INTO users (user_id, full_name, phone, national_id_encrypted, national_id_hash, national_id_last4,
       password_hash, account_type, status)
     VALUES ($1, $1, $1, 'x', $1, '0000', 'x', 'new_investigator', 'active')`,
    [id],
  );
  if (role) {
    await db.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, role_id FROM roles WHERE name = $2", [id, role]);
  }
  return id;
}

async function newCase(assignee: string | null, status: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO investigations (investigation_id, reference, status, target_mode, subject_name, address,
       governorate, district, client_id, client_name, template_id, form_title, form_snapshot, created_by, accept_minutes,
       assignee_id, investigator_price)
     VALUES ($1, $1, $2, 'area', 'subject', 'address', 'g', 'd', 'c', 'client', 't', 'form', '{}', 'admin', 30, $3, 150)`,
    [id, status, assignee],
  );
  if (assignee) {
    await db.query(
      "INSERT INTO investigation_locations (investigation_id, user_id, kind, lat, lng) VALUES ($1, $2, 'started', 30, 31)",
      [id, assignee],
    ).catch(() => {});
  }
  return id;
}

const count = async (sql: string, params: unknown[] = []) => Number((await db.query(sql, params))[0]?.n ?? 0);

describe.skipIf(!usable)("clean-ups on PostgreSQL", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    db = await import("../IdentityAcess_Services/Config/db.ts");
    await db.database.unsafe("DROP SCHEMA public CASCADE");
    await db.database.unsafe("CREATE SCHEMA public");
    await db.applySchema();
    for (const file of ["HeadOffice_Services/schema.sql", "Investigators_Services/schema.sql", "Investigations_Services/schema.sql"]) {
      for (const statement of statements(await readFile(join(root, file), "utf8"))) await db.database.unsafe(statement);
    }
    cleanup = await import("./cleanup.ts");
  });
  afterAll(async () => {
    await db?.database.end({ timeout: 5 });
  });

  test("an investigator with unfinished cases is not deleted unless their cases go too", async () => {
    const id = await person("employee");
    await newCase(id, "in_progress");
    await expect(cleanup.deleteInvestigator(id, { deleteReports: false })).rejects.toThrow(/unfinished/);
    expect(await count("SELECT count(*)::int AS n FROM users WHERE user_id = $1", [id])).toBe(1);
  });

  test("deleting an investigator removes everything of theirs; finished reports stay, unnamed", async () => {
    const id = await person("employee");
    const done = await newCase(id, "approved");
    await db.query("INSERT INTO staff_points (user_id, color, reason, day) VALUES ($1, 'black', 'late', current_date)", [id]);
    await db.query("INSERT INTO payroll_adjustments (user_id, month, amount, note) VALUES ($1, date_trunc('month', now()), 50, 'x')", [id]);
    await db.query("INSERT INTO refresh_sessions (session_id, user_id, token_hash, expires_at) VALUES ($1, $1, $1, now() + interval '1 day')", [id]).catch(() => {});

    const result = await cleanup.deleteInvestigator(id, { deleteReports: false });
    expect(result.reports_kept).toBe(1);
    for (const table of ["users", "user_roles", "staff_points", "payroll_adjustments", "investigation_locations", "refresh_sessions"]) {
      expect(await count(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [id])).toBe(0);
    }
    expect(await count("SELECT count(*)::int AS n FROM investigations WHERE investigation_id = $1 AND assignee_id IS NULL", [done])).toBe(1);
  });

  test("with delete_reports, the investigator's cases are deleted too", async () => {
    const id = await person("employee");
    const open = await newCase(id, "in_progress");
    const done = await newCase(id, "approved");
    const result = await cleanup.deleteInvestigator(id, { deleteReports: true });
    expect(result.investigations_deleted).toBe(2);
    expect(await count("SELECT count(*)::int AS n FROM investigations WHERE investigation_id = ANY($1)", [[open, done]])).toBe(0);
  });

  test("administrators and head office cannot be deleted as investigators", async () => {
    for (const role of ["admin", "head_office"]) {
      const id = await person(role);
      await expect(cleanup.deleteInvestigator(id, { deleteReports: true })).rejects.toThrow(/Only investigators/);
      expect(await count("SELECT count(*)::int AS n FROM users WHERE user_id = $1", [id])).toBe(1);
    }
  });

  test("the test-data reset clears every case and investigators' points and money, not admins'", async () => {
    const investigator = await person("employee");
    const admin = await person("admin");
    await newCase(investigator, "approved");
    await newCase(null, "open");
    for (const id of [investigator, admin]) {
      await db.query("INSERT INTO staff_points (user_id, color, reason, day) VALUES ($1, 'green', 'on_time', current_date)", [id]);
      await db.query("INSERT INTO payroll_adjustments (user_id, month, amount, note) VALUES ($1, date_trunc('month', now()), 10, 'x')", [id]);
      await db.query(
        "INSERT INTO payroll_payments (user_id, month, amount, breakdown) VALUES ($1, date_trunc('month', now()), 10, '{}')",
        [id],
      );
    }
    const before = await cleanup.previewTestDataReset();
    expect(before.investigations).toBeGreaterThanOrEqual(2);

    await cleanup.resetTestData(admin);
    expect(await count("SELECT count(*)::int AS n FROM investigations")).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM staff_points WHERE user_id = $1 AND revoked_at IS NULL", [investigator])).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM payroll_adjustments WHERE user_id = $1", [investigator])).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM payroll_payments WHERE user_id = $1", [investigator])).toBe(0);
    // The administrator's own points and payroll are untouched.
    expect(await count("SELECT count(*)::int AS n FROM staff_points WHERE user_id = $1 AND revoked_at IS NULL", [admin])).toBe(1);
    expect(await count("SELECT count(*)::int AS n FROM payroll_payments WHERE user_id = $1", [admin])).toBe(1);
    // A revoked point stops the absence check giving the same point back.
    const again = await db.query(
      "INSERT INTO staff_points (user_id, color, reason, day) VALUES ($1, 'green', 'on_time', current_date) ON CONFLICT (user_id, day, reason) WHERE reason <> 'manual' DO NOTHING RETURNING point_id",
      [investigator],
    );
    expect(again.length).toBe(0);
  });
});
