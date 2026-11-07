// Runs the whole Golden Pay backend as one service, for cloud hosting:
//   1. applies the database schema and RBAC seed (retried while the database wakes up),
//   2. starts the domain services on internal ports (4002-4005),
//   3. starts the Identity API on $PORT (default 4001): the only public entry, which
//      proxies /forms, /investigators, /investigations and /headoffice to the others.
// A service that stops is restarted; SIGTERM stops everything cleanly.
//   bun start.ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";

const root = import.meta.dir;
const identityDir = join(root, "IdentityAcess_Services");
// Locally the settings live in IdentityAcess_Services/.env; in the cloud they are set as
// environment variables on the service, and this file does not exist.
const envFile = join(identityDir, ".env");
const envArgs = existsSync(envFile) ? [`--env-file=${envFile}`] : [];
const bun = process.execPath;

const SERVICES = [
  { name: "dynamic-forms", dir: "DynamicForms_Services", pool: "3" },
  { name: "investigators", dir: "Investigators_Services", pool: "3" },
  { name: "investigations", dir: "Investigations_Services", pool: "3" },
  { name: "head-office", dir: "HeadOffice_Services", pool: "3" },
  { name: "identity-api", dir: "IdentityAcess_Services", pool: process.env.DB_POOL_MAX ?? "5" },
];

const log = (message: string) => console.log(JSON.stringify({ timestamp: new Date().toISOString(), service: "golden-pay-launcher", message }));

async function initDatabase(): Promise<void> {
  for (let attempt = 1; attempt <= 10; attempt++) {
    const init = Bun.spawn([bun, ...envArgs, "scripts/init-db.ts"], { cwd: identityDir, stdout: "inherit", stderr: "inherit" });
    if ((await init.exited) === 0) return;
    log(`database init failed (attempt ${attempt}/10), retrying in ${attempt * 3}s`);
    await Bun.sleep(attempt * 3000);
  }
  throw new Error("Database initialisation failed; check DATABASE_URL");
}

const running = new Map<string, Subprocess>();
let stopping = false;

function start(service: (typeof SERVICES)[number], restarts = 0): void {
  const child = Bun.spawn([bun, ...envArgs, "app.ts"], {
    cwd: join(root, service.dir),
    env: { ...process.env, DB_POOL_MAX: service.pool },
    stdout: "inherit",
    stderr: "inherit",
  });
  running.set(service.name, child);
  log(`${service.name} started (pid ${child.pid})`);
  void child.exited.then((code) => {
    running.delete(service.name);
    if (stopping) return;
    const wait = Math.min(30, 2 ** Math.min(restarts, 5));
    log(`${service.name} exited with code ${code}; restarting in ${wait}s`);
    setTimeout(() => start(service, restarts + 1), wait * 1000);
  });
}

function stopAll(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  log(`${signal} received, stopping services`);
  for (const child of running.values()) child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 8000).unref();
  void Promise.all([...running.values()].map((child) => child.exited)).then(() => process.exit(0));
}
process.on("SIGTERM", () => stopAll("SIGTERM"));
process.on("SIGINT", () => stopAll("SIGINT"));

await initDatabase();
for (const service of SERVICES) start(service);
log(`Golden Pay backend is starting; public port ${process.env.PORT ?? "4001"}`);
