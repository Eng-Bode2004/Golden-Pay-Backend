// Where the server's space goes: free disk, the temporary folders, and the database with its
// largest tables. Read-only, for head office, so a "disk is full" warning can be traced.
import { readdir, stat, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "../Config/db.ts";
import { withPermission } from "../MIddlewares/auth.middleware.ts";
import { PERMISSIONS } from "../Services/rbac.service.ts";
import { ok } from "../Utils/http.ts";
import type { Router } from "../Utils/router.ts";

const MB = 1024 * 1024;
const mb = (bytes: number) => Math.round((bytes / MB) * 10) / 10;

/** Total size of a folder, stopping early on very large trees (it is only an estimate). */
async function folderBytes(path: string, budget = { files: 20_000 }): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (budget.files-- <= 0) break;
    const full = join(path, entry.name);
    try {
      if (entry.isDirectory()) total += await folderBytes(full, budget);
      else if (entry.isFile()) total += (await stat(full)).size;
    } catch {
      // Gone while counting (a conversion just finished): skip it.
    }
  }
  return total;
}

async function disk(path: string) {
  try {
    const info = await statfs(path);
    const total = info.blocks * info.bsize;
    const free = info.bavail * info.bsize;
    return { path, total_mb: mb(total), free_mb: mb(free), used_percent: total ? Math.round(((total - free) / total) * 100) : null };
  } catch {
    return { path, total_mb: null, free_mb: null, used_percent: null };
  }
}

export function registerSystemRoutes(router: Router): void {
  router.get(
    "/admin/system/storage",
    withPermission(PERMISSIONS.HEADOFFICE_MANAGE, async () => {
      const temp = tmpdir();
      const tempFolders = await readdir(temp, { withFileTypes: true }).catch(() => []);
      const biggest = (
        await Promise.all(
          tempFolders
            .filter((entry) => entry.isDirectory())
            .map(async (entry) => ({ name: entry.name, mb: mb(await folderBytes(join(temp, entry.name))) })),
        )
      )
        .sort((a, b) => b.mb - a.mb)
        .slice(0, 12);
      const [database] = await query(
        "SELECT pg_database_size(current_database())::bigint AS bytes, current_database() AS name",
      );
      const tables = await query(
        `SELECT c.relname AS name, pg_total_relation_size(c.oid)::bigint AS bytes, c.reltuples::bigint AS approx_rows
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind = 'r' AND n.nspname = 'public'
         ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 15`,
      );
      const wal = await query("SELECT COALESCE(sum(size), 0)::bigint AS bytes FROM pg_ls_waldir()").catch(() => null);
      return ok({
        disks: await Promise.all(["/", temp, "/app"].map(disk)),
        temp: { path: temp, mb: mb(await folderBytes(temp)), biggest },
        database: {
          name: database?.name,
          mb: mb(Number(database?.bytes ?? 0)),
          wal_mb: wal ? mb(Number(wal[0]?.bytes ?? 0)) : null,
          tables: tables.map((row) => ({ name: row.name, mb: mb(Number(row.bytes)), approx_rows: Number(row.approx_rows) })),
        },
      });
    }),
  );
}
