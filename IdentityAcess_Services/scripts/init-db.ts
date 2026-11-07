#!/usr/bin/env bun
/**
 * Prepares the PostgreSQL database.
 *
 *   bun run db:init
 *
 * 1. Connects using DATABASE_URL (see .env.example).
 * 2. Applies Config/schema.sql (idempotent: safe to run on every deploy).
 * 3. Seeds the RBAC roles and permissions.
 *
 * The identity service also applies the schema on start, so this script is only
 * needed for a first-time setup, CI or when running migrations manually.
 */

import { connectDatabase, disconnectDatabase } from "../Config/db.ts";
import { seedRbac, ROLES, PERMISSIONS } from "../Services/rbac.service.ts";
import { ensureUploadDirectory, usesCloudStorage } from "../Utils/files.ts";
import { env } from "../Config/env.ts";
import { logger } from "../Utils/logger.ts";

function describeDatabase(): string {
  try {
    const url = new URL(env.databaseUrl);
    return `${url.hostname}:${url.port || "5432"}${url.pathname}`;
  } catch {
    return "(custom DATABASE_URL)";
  }
}

async function main(): Promise<void> {
  console.log(`Database: ${describeDatabase()}`);

  await connectDatabase();

  try {
    await seedRbac();
    console.log(`Seeded roles: ${Object.values(ROLES).join(", ")}`);
    console.log(`Seeded permissions: ${Object.values(PERMISSIONS).join(", ")}`);

    await ensureUploadDirectory();
    console.log(usesCloudStorage() ? `File storage: cloud bucket ${env.storage?.bucket}` : `Upload directory ready: ${env.uploadDir}`);

    logger.info("db.init.completed");
  } finally {
    await disconnectDatabase();
  }
}

await main()
  .then(() => {
    console.log("Database initialisation completed.");
  })
  .catch((error: unknown) => {
    console.error(
      "Database initialisation failed:",
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  });
