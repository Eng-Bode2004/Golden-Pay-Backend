import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import { env } from "./env.ts";
import { logger } from "../Utils/logger.ts";

/**
 * PostgreSQL access layer.
 *
 * The pure-JS `postgres` driver is used instead of Bun's built-in SQL client:
 * Bun's client crashes (and takes the server backend down with it) on this
 * Windows host. The public surface stays the same (`query`, `transaction`,
 * `applySchema`), so models and services do not care which driver is used.
 */
export const database = postgres(env.databaseUrl, {
  max: Number(process.env.DB_POOL_MAX ?? 5),
  idle_timeout: 30,
  connect_timeout: 10,
  prepare: true,
  onnotice: () => {},
  transform: { undefined: null },
});

type Executor = Pick<ReturnType<typeof postgres>, "unsafe">;

const transactions = new AsyncLocalStorage<Executor>();
let connected = false;

/** Raised when PostgreSQL rejects a write because of a UNIQUE constraint. */
export class DatabaseConflict extends Error {
  readonly code = "23505";

  constructor(readonly field: string) {
    super(`Duplicate value for ${field}`);
    this.name = "DatabaseConflict";
  }
}

function duplicateField(error: unknown): string | null {
  const pg = error as {
    code?: string;
    errno?: string;
    detail?: string;
    message?: string;
  };

  const isUnique =
    pg.code === "23505" ||
    pg.errno === "23505" ||
    /duplicate key value violates unique constraint/i.test(pg.message ?? "");

  if (!isUnique) return null;

  const detailMatch = /Key \(([^)]+)\)/.exec(pg.detail ?? "");
  const field = detailMatch?.[1]?.split(",")[0]?.trim();
  return field && field.length > 0 ? field : "record";
}

const CONNECTION_CODES = new Set([
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
  "CONNECT_TIMEOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "57P01", // admin shutdown
  "57P03", // cannot connect now (server starting)
  "53300", // too many connections
]);

/** True when PostgreSQL could not be reached, as opposed to rejecting the query itself. */
export function isConnectionError(error: unknown): boolean {
  const code = (error as { code?: string; errno?: string })?.code ?? (error as { errno?: string })?.errno ?? "";
  return CONNECTION_CODES.has(code);
}

const RETRY_DELAYS_MS = [250, 1000, 2500];

export async function query(
  text: string,
  values: readonly unknown[] = [],
): Promise<Record<string, unknown>[]> {
  const inTransaction = transactions.getStore();
  for (let attempt = 0; ; attempt++) {
    try {
      const rows = await (inTransaction ?? database).unsafe(text, values as never[]);
      return rows as unknown as Record<string, unknown>[];
    } catch (error) {
      const field = duplicateField(error);
      if (field) throw new DatabaseConflict(field);
      // A dropped connection outside a transaction is retried; inside one, the whole
      // transaction is retried by transaction() instead.
      if (!inTransaction && isConnectionError(error) && attempt < RETRY_DELAYS_MS.length) {
        logger.warn("postgresql.retry", { attempt: attempt + 1, error: (error as Error).message });
        await Bun.sleep(RETRY_DELAYS_MS[attempt]!);
        continue;
      }
      throw error;
    }
  }
}

/** Runs `action` inside a transaction, or joins the one already in progress. */
export async function transaction<T>(action: () => Promise<T>): Promise<T> {
  if (transactions.getStore()) return action();

  for (let attempt = 0; ; attempt++) {
    let started = false;
    try {
      return (await database.begin(async (sql) => {
        started = true;
        const executor: Executor = {
          unsafe: ((text: string, values?: unknown[]) =>
            sql.unsafe(text, (values ?? []) as never[])) as Executor["unsafe"],
        };
        return transactions.run(executor, action);
      })) as T;
    } catch (error) {
      // Only retry when the connection failed before any of our statements ran, so
      // nothing can be applied twice.
      if (!started && isConnectionError(error) && attempt < RETRY_DELAYS_MS.length) {
        logger.warn("postgresql.retry", { attempt: attempt + 1, error: (error as Error).message });
        await Bun.sleep(RETRY_DELAYS_MS[attempt]!);
        continue;
      }
      throw error;
    }
  }
}

function schemaStatements(schema: string): string[] {
  return schema
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** Applies Config/schema.sql. Every statement is idempotent. */
export async function applySchema(): Promise<void> {
  const schema = await readFile(join(import.meta.dir, "schema.sql"), "utf8");
  const statements = schemaStatements(schema);

  for (const statement of statements) {
    await database.unsafe(statement);
  }

  logger.info("postgresql.schema_ready", { statements: statements.length });
}

export async function connectDatabase(): Promise<void> {
  await query("SELECT 1");
  await applySchema();
  connected = true;
  logger.info("postgresql.connected", { database: databaseUrlName() });
}

function databaseUrlName(): string {
  try {
    return new URL(env.databaseUrl).pathname.replace(/^\//, "") || "(default)";
  } catch {
    return "(custom)";
  }
}

export async function disconnectDatabase(): Promise<void> {
  if (!connected) return;
  await database.end({ timeout: 5 });
  connected = false;
}

export async function isDatabaseReady(): Promise<boolean> {
  if (!connected) return false;
  try {
    await query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
