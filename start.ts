// Runs the whole Golden Pay backend as one service, for cloud hosting:
//   1. checks the required settings and stops with a clear message when one is missing,
//   2. starts the Identity API at once on 0.0.0.0:$PORT (default 4001), the only public
//      entry. It answers GET /health immediately and connects to PostgreSQL in the
//      background (applying the schema and roles), retrying with clear log lines,
//   3. once the database is connected, starts the internal services on 127.0.0.1:4002-4005,
//      which the Identity API proxies (/forms, /investigators, /investigations, /headoffice).
// A service that stops is restarted; SIGTERM stops everything cleanly.
//   bun start.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";

const root = import.meta.dir;
const identityDir = join(root, "IdentityAcess_Services");
// Locally the settings live in IdentityAcess_Services/.env; in the cloud they are set as
// environment variables on the service, and the file does not exist.
const envFile = process.env.GOLDEN_PAY_ENV_FILE ?? join(identityDir, ".env");
const hasEnvFile = envFile !== "" && existsSync(envFile);
const envArgs = hasEnvFile ? [`--env-file=${envFile}`] : [];
const bun = process.execPath;
const port = process.env.PORT ?? "4001";

const log = (level: "info" | "warn" | "error", message: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, service: "golden-pay-launcher", message, ...extra }));

/** Settings from the environment, with the local .env file filling any gaps. */
function settings(): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = {};
  if (hasEnvFile) {
    for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (match) merged[match[1]!] = match[2]!.replace(/^["']|["']$/g, "");
    }
  }
  return { ...merged, ...process.env };
}

function checkSettings(): void {
  const values = settings();
  const production = values.NODE_ENV === "production";
  const required = production
    ? ["DATABASE_URL", "JWT_SECRET", "NATIONAL_ID_ENCRYPTION_KEY", "NATIONAL_ID_HMAC_SECRET", "REFRESH_TOKEN_PEPPER"]
    : [];
  const missing = required.filter((name) => !values[name]?.trim());
  if (missing.length) {
    log("error", "startup stopped: required environment variables are missing", { missing });
    process.exit(1);
  }
  const bucket = values.STORAGE_BUCKET || values.S3_BUCKET;
  if (production && !bucket) {
    log("warn", "no STORAGE_BUCKET / S3_BUCKET: files will be written to the container's temporary disk and lost on restart");
  }
  for (const [name, path] of [["Chromium", values.CHROME_PATH], ["LibreOffice", values.SOFFICE_PATH]] as const) {
    if (path && !existsSync(path)) log("warn", `${name} not found at ${path}: PDF reports will fail`);
  }
}

const SERVICES = [
  { name: "dynamic-forms", dir: "DynamicForms_Services", pool: "3" },
  { name: "investigators", dir: "Investigators_Services", pool: "3" },
  { name: "investigations", dir: "Investigations_Services", pool: "3" },
  { name: "head-office", dir: "HeadOffice_Services", pool: "3" },
];
const IDENTITY = { name: "identity-api", dir: "IdentityAcess_Services", pool: process.env.DB_POOL_MAX ?? "5" };

const running = new Map<string, Subprocess>();
let stopping = false;

function start(service: { name: string; dir: string; pool: string }, restarts = 0): void {
  const child = Bun.spawn([bun, ...envArgs, "app.ts"], {
    cwd: join(root, service.dir),
    env: { ...process.env, DB_POOL_MAX: service.pool },
    stdout: "inherit",
    stderr: "inherit",
  });
  running.set(service.name, child);
  log("info", `${service.name} started`, { pid: child.pid });
  void child.exited.then((code) => {
    running.delete(service.name);
    if (stopping) return;
    const wait = Math.min(30, 2 ** Math.min(restarts, 5));
    log("error", `${service.name} exited with code ${code}; restarting in ${wait}s`);
    setTimeout(() => start(service, restarts + 1), wait * 1000);
  });
}

/** Waits until the Identity API reports a connected database, then starts the others. */
async function startInternalServicesWhenReady(): Promise<void> {
  let lastState = "";
  while (!stopping) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
      const body = (await response.json()) as { data?: { database?: string } };
      const state = body.data?.database ?? "unknown";
      if (state === "connected") {
        log("info", "database connected; starting internal services");
        for (const service of SERVICES) start(service);
        return;
      }
      if (state !== lastState) log("warn", `waiting for the database (${state}); internal services start once it connects`);
      lastState = state;
    } catch {
      // The Identity API is still starting.
    }
    await Bun.sleep(2000);
  }
}

function stopAll(signal: string): void {
  if (stopping) return;
  stopping = true;
  log("info", `${signal} received, stopping services`);
  for (const child of running.values()) child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 8000).unref();
  void Promise.all([...running.values()].map((child) => child.exited)).then(() => process.exit(0));
}
process.on("SIGTERM", () => stopAll("SIGTERM"));
process.on("SIGINT", () => stopAll("SIGINT"));

checkSettings();
start(IDENTITY);
log("info", `Golden Pay backend starting; public port ${port}`, { health: "/health", readiness: "/api/v1/health" });
void startInternalServicesWhenReady();
