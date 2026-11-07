// Copies every file under UPLOAD_DIR into the cloud bucket (STORAGE_*), keeping the same
// relative paths the database stores, then checks that every file the database points to
// can be read back. Safe to run again: files already in the bucket with the same size are skipped.
//   bun --env-file=.env scripts/upload-storage.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { query } from "../Config/db.ts";
import { env } from "../Config/env.ts";
import { getStoredFile, putStoredFile, usesCloudStorage } from "../Utils/files.ts";
import { S3Client } from "bun";

if (!usesCloudStorage() || !env.storage) throw new Error("Set STORAGE_BUCKET and its keys in .env first");
const s3 = new S3Client({ ...env.storage });

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

let uploaded = 0;
let skipped = 0;
for (const path of walk(env.uploadDir)) {
  const rel = relative(env.uploadDir, path).replaceAll("\\", "/");
  const key = env.storage.folder ? `${env.storage.folder}/${rel}` : rel;
  const size = statSync(path).size;
  const existing = await s3.file(key).stat().catch(() => null);
  if (existing?.size === size) {
    skipped++;
    continue;
  }
  for (let attempt = 1; ; attempt++) {
    try {
      await putStoredFile(rel, new Uint8Array(readFileSync(path)));
      break;
    } catch (error) {
      if (attempt >= 4) throw error;
      console.log(`retrying ${rel} (${(error as Error).message})`);
      await Bun.sleep(1000 * attempt);
    }
  }
  uploaded++;
}
console.log(`uploaded ${uploaded}, already there ${skipped}`);

// Every path column the services read files from.
const referenced = await query<{ source: string; path: string }>(`
  select 'national_id_front' source, "FrontID_image" path from users where "FrontID_image" is not null
  union all select 'national_id_back', "BackID_image" from users where "BackID_image" is not null
  union all select 'profile_image', profile_image from users where profile_image is not null
  union all select 'investigation_image', path from investigation_images
  union all select 'report_pdf', pdf_path from investigations where pdf_path is not null
  union all select 'report_docx', report_docx_path from investigations where report_docx_path is not null
  union all select 'template_file', path from template_files
  union all select 'template_docx', docx_path from template_files where docx_path is not null
  union all select 'template_layout', layout_path from template_versions where layout_path is not null
  union all select 'template_preview', path from template_previews`);

const missing: string[] = [];
for (const row of referenced) {
  if (!row.path?.trim()) continue; // account without that photo
  try {
    await getStoredFile(row.path);
  } catch {
    missing.push(`${row.source}: ${row.path}`);
  }
}
const real = referenced.filter((row) => row.path?.trim()).length;
console.log(`database references ${real} files; readable from the bucket: ${real - missing.length}`);
if (missing.length) console.log("missing:\n  " + missing.join("\n  "));
process.exit(0);
