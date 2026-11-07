import { readFile } from "node:fs/promises";
import {
  connectDatabase,
  disconnectDatabase,
  database,
  isDatabaseReady,
} from "../IdentityAcess_Services/Config/db.ts";
import { toApiError } from "../IdentityAcess_Services/MIddlewares/error.middleware.ts";
import { newId } from "../IdentityAcess_Services/Utils/crypto.ts";
import {
  ApiError,
  errorResponse,
  getClientIp,
  ok,
  type RequestContext,
} from "../IdentityAcess_Services/Utils/http.ts";
import { logger } from "../IdentityAcess_Services/Utils/logger.ts";
import type { Router } from "../IdentityAcess_Services/Utils/router.ts";

export interface ServiceOptions {
  name: string;
  port: number;
  router: Router;
  /** Absolute path of the idempotent schema.sql owned by this service. */
  schema: string;
  /** Prefix of this service's own health route, e.g. "/forms". */
  healthPrefix: string;
  seed?: () => Promise<void>;
}

/** Splits SQL on semicolons, keeping `$$ … $$` function bodies whole. */
export function splitSql(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inDollar = false;
  for (const raw of sql.split("\n")) {
    // Windows line endings would hide the end of a "--" comment from the regex.
    const line = raw.replace(/\r$/, "");
    const clean = inDollar ? line : line.replace(/--.*$/, "");
    for (let index = 0; index < clean.length; index += 1) {
      if (clean.startsWith("$$", index)) {
        inDollar = !inDollar;
        current += "$$";
        index += 1;
        continue;
      }
      const char = clean[index]!;
      if (char === ";" && !inDollar) {
        if (current.trim()) statements.push(current.trim());
        current = "";
      } else current += char;
    }
    current += "\n";
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

async function applySchema(path: string): Promise<void> {
  for (const statement of splitSql(await readFile(path, "utf8"))) await database.unsafe(statement);
}

/** Runs a domain service: shared database, auth, error format and logging. */
export async function startService(options: ServiceOptions): Promise<void> {
  const { name, port, router, schema, healthPrefix, seed } = options;

  async function handle(req: Request): Promise<Response> {
    const requestId = req.headers.get("x-request-id")?.slice(0, 100) || newId();
    const url = new URL(req.url);
    const pathname = url.pathname.replace(/^\/api\/v1(?=\/|$)/, "") || "/";
    const context: RequestContext = {
      req,
      url,
      params: {},
      requestId,
      ip: getClientIp(req),
    };

    try {
      if (req.method === "GET" && pathname === `${healthPrefix}/health`) {
        return ok({ service: name, database: (await isDatabaseReady()) ? "connected" : "disconnected" });
      }
      const match = router.match(req.method, pathname);
      if (!match) throw new ApiError(404, "NOT_FOUND", "Endpoint not found");
      return await match.handler({ ...context, params: match.params });
    } catch (error) {
      return errorResponse(toApiError(error, requestId), requestId);
    }
  }

  try {
    await connectDatabase();
    await applySchema(schema);
    await seed?.();
    // Internal services are reached only through the Identity API on the same machine.
    const server = Bun.serve({ hostname: process.env.INTERNAL_HOST ?? "127.0.0.1", port, maxRequestBodySize: 32 * 1024 * 1024, fetch: handle });
    logger.info("service.started", { service: name, port: server.port });

    const stop = async () => {
      server.stop();
      await disconnectDatabase();
      process.exit(0);
    };
    process.on("SIGINT", () => void stop());
    process.on("SIGTERM", () => void stop());
  } catch (error) {
    logger.error("service.startup_failed", {
      service: name,
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

/** Reads an optional float, rejecting anything that is not a real number. */
export function optionalNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw ApiError.badRequest(`${field} must be a number`, { field, message: `${field} must be a number` });
  }
  return parsed;
}

export function optionalText(value: unknown, max = 500): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text.slice(0, max) : null;
}

export function requiredText(value: unknown, field: string, max = 500): string {
  const text = optionalText(value, max);
  if (!text) {
    throw ApiError.badRequest(`${field} is required`, { field, message: `${field} is required` });
  }
  return text;
}
