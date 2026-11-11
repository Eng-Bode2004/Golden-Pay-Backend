import { env } from "./Config/env.ts";
import { connectDatabase, disconnectDatabase, isDatabaseReady } from "./Config/db.ts";
import { seedRbac } from "./Services/rbac.service.ts";
import { createRouter } from "./Routes/index.ts";
import { ensureUploadDirectory } from "./Utils/files.ts";
import {
  ApiError,
  errorResponse,
  getClientIp,
  jsonResponse,
} from "./Utils/http.ts";
import type { RequestContext } from "./Utils/http.ts";
import { toApiError } from "./MIddlewares/error.middleware.ts";
import { logger } from "./Utils/logger.ts";
import { keepServiceAlive } from "./Utils/keep-alive.ts";
import { newId } from "./Utils/crypto.ts";

const router = createRouter();
const startedAt = Date.now();

function normalisePath(pathname: string): string {
  if (pathname === "/api/v1") return "/";
  if (pathname.startsWith("/api/v1/")) return pathname.slice(7);
  return pathname;
}

function applyResponseHeaders(
  req: Request,
  response: Response,
  requestId: string,
): Response {
  const headers = response.headers;
  const origin = req.headers.get("origin");

  if (env.corsOrigins.includes("*")) {
    headers.set("Access-Control-Allow-Origin", "*");
  } else if (origin && env.corsOrigins.includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
    headers.set("Access-Control-Allow-Credentials", "true");
  }

  headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, X-Request-Id",
  );
  headers.set("Access-Control-Max-Age", "600");
  headers.set("X-Request-Id", requestId);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");

  return response;
}

/** Domain services sit behind this API, so clients keep one base URL. */
const UPSTREAMS: { prefixes: string[]; url: string }[] = [
  { prefixes: ["/forms"], url: process.env.FORMS_SERVICE_URL ?? "http://127.0.0.1:4002" },
  {
    prefixes: ["/investigators", "/locations"],
    url: process.env.INVESTIGATORS_SERVICE_URL ?? "http://127.0.0.1:4003",
  },
  { prefixes: ["/investigations"], url: process.env.INVESTIGATIONS_SERVICE_URL ?? "http://127.0.0.1:4004" },
  {
    prefixes: ["/headoffice", "/attendance", "/points", "/complaints", "/app"],
    url: process.env.HEADOFFICE_SERVICE_URL ?? "http://127.0.0.1:4005",
  },
];

async function forward(req: Request, pathname: string, url: URL): Promise<Response | null> {
  const upstream = UPSTREAMS.find(({ prefixes }) =>
    prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)),
  );
  if (!upstream) return null;

  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.set("x-forwarded-for", getClientIp(req));
  try {
    const response = await fetch(`${upstream.url}${pathname}${url.search}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      redirect: "manual",
      // A request the browser gave up on stops waiting in the services too.
      signal: req.signal,
    });
    return new Response(response.body, { status: response.status, headers: response.headers });
  } catch {
    throw new ApiError(503, "SERVICE_UNAVAILABLE", "This service is temporarily unavailable");
  }
}

function serviceInfo(): Response {
  return jsonResponse({
    success: true,
    data: {
      service: env.serviceName,
      version: "1.0.0",
      environment: env.nodeEnv,
      base_path: "/api/v1",
      docs: "See README.md for the full API reference",
      endpoints: {
        login: "POST /api/v1/auth/login",
        signup_existing_start: "POST /api/v1/auth/signup/existing/start",
        signup_existing_complete: "POST /api/v1/auth/signup/existing/complete",
        signup_new: "POST /api/v1/auth/signup/new",
        biometric_register: "POST /api/v1/auth/biometric/register",
        biometric_challenge: "POST /api/v1/auth/biometric/challenge",
        biometric_login: "POST /api/v1/auth/biometric/login",
        refresh: "POST /api/v1/auth/refresh",
        profile: "GET /api/v1/users/me",
        admin: "/api/v1/admin/*",
        health: "GET /api/v1/health",
      },
    },
  });
}

/** Database state for the lightweight /health check; it never queries the database. */
let databaseState: "connecting" | "connected" | "unavailable" = "connecting";

/** GET /health: answers 200 as soon as the server listens, whatever the database does. */
function liveness(): Response {
  return jsonResponse(
    {
      success: true,
      data: {
        status: "ok",
        service: env.serviceName,
        uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
        database: databaseState,
        timestamp: new Date().toISOString(),
      },
    },
    200,
  );
}

/** GET /api/v1/health: ready to serve, which needs the database. */
async function healthInfo(): Promise<Response> {
  const healthy = await isDatabaseReady();
  return jsonResponse(
    {
      success: true,
      data: {
        status: healthy ? "ok" : "degraded",
        service: env.serviceName,
        uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
        database: healthy ? "connected" : "disconnected",
        timestamp: new Date().toISOString(),
      },
    },
    healthy ? 200 : 503,
  );
}

async function handleRequest(req: Request): Promise<Response> {
  const requestIdHeader = req.headers.get("x-request-id")?.trim().slice(0, 100);
  const requestId = requestIdHeader || newId();
  const started = performance.now();
  const url = new URL(req.url);
  const pathname = normalisePath(url.pathname);
  const ip = getClientIp(req);

  const baseContext: RequestContext = {
    req,
    url,
    params: {},
    requestId,
    ip,
  };

  let response: Response;

  try {
    if (req.method === "OPTIONS") {
      response = new Response(null, { status: 204 });
    } else if (url.pathname === "/health" && req.method === "GET") {
      response = liveness();
    } else if (pathname === "/health" && req.method === "GET") {
      response = await healthInfo();
    } else if (pathname === "/" && req.method === "GET") {
      response = serviceInfo();
    } else {
      const forwarded = await forward(req, pathname, url);
      const match = forwarded ? null : router.match(req.method, pathname);

      if (forwarded) {
        response = forwarded;
      } else if (!match) {
        const allowed = router.allowedMethods(pathname);
        if (allowed.length > 0) {
          response = errorResponse(
            new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed", {
              headers: { Allow: allowed.join(", ") },
            }),
            requestId,
          );
        } else {
          response = errorResponse(
            new ApiError(404, "NOT_FOUND", "Endpoint not found"),
            requestId,
          );
        }
      } else {
        const context: RequestContext = { ...baseContext, params: match.params };
        response = await match.handler(context);
      }
    }
  } catch (error) {
    response = errorResponse(toApiError(error, requestId), requestId);
  }

  response = applyResponseHeaders(req, response, requestId);

  const durationMs = Math.round((performance.now() - started) * 100) / 100;
  const log = response.status >= 500 ? logger.error : logger.info;
  log("http.request", {
    request_id: requestId,
    method: req.method,
    path: pathname,
    status: response.status,
    duration_ms: durationMs,
    ip,
  });

  return response;
}

/** Where the database is, without credentials, for logs. */
function databaseTarget(): string {
  try {
    const url = new URL(env.databaseUrl);
    return `${url.hostname}:${url.port || "5432"}${url.pathname}`;
  } catch {
    return "(DATABASE_URL is not a valid URL)";
  }
}

/**
 * Connects to PostgreSQL, applies the schema and seeds roles, retrying until it works.
 * The HTTP server is already up, so health checks answer and requests that need the
 * database get a clear 503 instead of a refused connection.
 */
async function connectWithRetry(): Promise<void> {
  const target = databaseTarget();
  for (let attempt = 1; ; attempt++) {
    try {
      await connectDatabase();
      await seedRbac();
      await ensureUploadDirectory();
      databaseState = "connected";
      logger.info("postgresql.ready", { target, attempt });
      return;
    } catch (error) {
      databaseState = "unavailable";
      const wait = Math.min(60, 5 * attempt);
      logger.error("postgresql.unreachable", {
        target,
        attempt,
        error: error instanceof Error ? error.message : String(error),
        retry_in_seconds: wait,
        hint: "Check DATABASE_URL and that this database accepts connections from this server",
      });
      await Bun.sleep(wait * 1000);
    }
  }
}

async function bootstrap(): Promise<void> {
  keepServiceAlive(env.serviceName);
  const server = Bun.serve({
    hostname: process.env.LISTEN_HOST ?? "0.0.0.0",
    port: env.port,
    development: !env.isProduction,
    // App updates (APKs up to 200 MB) pass through to head office; every other route still
    // checks its own, much smaller, limit.
    maxRequestBodySize: Math.max(env.maxUploadBytes * 2 + env.maxJsonBytes + 1024 * 1024, 210 * 1024 * 1024),
    // Report previews and PDFs are built while the request waits (often more than Bun's
    // default 10 seconds); 255 s is Bun's maximum.
    idleTimeout: 255,
    fetch: handleRequest,
  });

  logger.info("service.started", {
    host: server.hostname,
    port: server.port,
    environment: env.nodeEnv,
    base_path: "/api/v1",
    database: databaseTarget(),
  });
  void connectWithRetry();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("service.shutting_down", { signal });
    server.stop();
    await disconnectDatabase();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

try {
  await bootstrap();
} catch (error) {
  logger.error("service.startup_failed", {
    error: error instanceof Error ? error.message : String(error),
    ...(env.isProduction
      ? {}
      : { stack: error instanceof Error ? error.stack?.split("\n").slice(0, 8) : undefined }),
  });
  process.exit(1);
}
