/**
 * Brings the original client templates into the versioned system, once.
 *
 * - Every form already in use becomes version 1 ("standard" Golden Pay layout), active,
 *   so running cases and the mobile app keep working unchanged.
 * - Every original Word file in the archive is stored by hash, classified, scanned, and
 *   added as a draft that keeps the client's own layout. Drafts need Head Office review
 *   and approval before any case uses them.
 *
 * Safe to run on every start: files already stored (same SHA-256) are skipped.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { query } from "../IdentityAcess_Services/Config/db.ts";
import { logger } from "../IdentityAcess_Services/Utils/logger.ts";
import { upgradeLegacy } from "../Shared/templates/definition.ts";
import { INVESTIGATION_TYPES, KNOWN_CLIENTS, markSharedLayouts, type InventoryRecord } from "../Shared/templates/inventory.ts";
import { draftFromFile, intakeFile, logTemplateEvent } from "./templates.ts";

const ARCHIVE = process.env.TEMPLATE_ARCHIVE_DIR ?? join(import.meta.dir, "..", "..", "Investigation Forms");
const CONVERTED = join(import.meta.dir, "Seeds", "converted-doc");

export async function seedCatalog(): Promise<void> {
  for (const [index, type] of INVESTIGATION_TYPES.entries()) {
    await query(
      `INSERT INTO investigation_types(code,name,sort) VALUES($1,$2,$3)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, sort = EXCLUDED.sort`,
      [type.code, type.name, index + 1],
    );
  }
  for (const client of KNOWN_CLIENTS) {
    // Head Office may have edited these; only fill what is still empty.
    await query(
      `UPDATE form_clients SET name_en = COALESCE(name_en, $2),
         aliases = CASE WHEN aliases = '[]'::jsonb THEN $3::text::jsonb ELSE aliases END,
         logo_hashes = CASE WHEN logo_hashes = '[]'::jsonb THEN $4::text::jsonb ELSE logo_hashes END
       WHERE client_id = $1`,
      [client.client_id, client.name_en ?? null, JSON.stringify(client.aliases), JSON.stringify(client.logo_hashes)],
    );
  }
}

/** Forms created before versioning become version 1, active, exactly as they were. */
export async function legacyVersions(): Promise<number> {
  const families = await query(
    `SELECT t.template_id, t.sections, t.version FROM form_templates t
     WHERE t.active_version_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM template_versions v WHERE v.template_id = t.template_id AND v.layout_mode = 'standard')
       AND jsonb_array_length(t.sections) > 0`,
  );
  let made = 0;
  for (const family of families) {
    try {
      const definition = upgradeLegacy(family.sections);
      const rows = await query(
        `INSERT INTO template_versions(template_id,version_no,status,layout_mode,definition,created_by,change_note,
           submitted_by,submitted_at,reviewed_by,reviewed_at,activated_by,activated_at,review_note)
         VALUES($1,(SELECT COALESCE(MAX(version_no), 0) + 1 FROM template_versions WHERE template_id = $1),
           'active','standard',$2::text::jsonb,'system',$3,'system',now(),'system',now(),'system',now(),$4)
         RETURNING version_id`,
        [
          family.template_id,
          JSON.stringify(definition),
          "النموذج المستخدم قبل نظام الإصدارات (التصميم الموحّد لجولدن باي)",
          "اعتُمد تلقائيًا عند الترحيل لأنه كان مستخدمًا بالفعل",
        ],
      );
      await query("UPDATE form_templates SET active_version_id = $2 WHERE template_id = $1", [family.template_id, rows[0]!.version_id]);
      await logTemplateEvent({
        type: "version.migrated",
        template_id: family.template_id as string,
        version_id: rows[0]!.version_id as string,
        note: "ترحيل النموذج الحالي كإصدار 1",
      });
      made += 1;
    } catch (error) {
      logger.warn("templates.legacy_skipped", {
        template_id: family.template_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return made;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(docx|doc|pdf)$/i.test(name) && !name.startsWith("~$")) out.push(path);
  }
  return out;
}

export async function importArchive(): Promise<{ files: number; drafts: number }> {
  if (!existsSync(ARCHIVE)) return { files: 0, drafts: 0 };
  const paths = walk(ARCHIVE);
  const added: { file: Record<string, unknown>; inventory: InventoryRecord; rel: string }[] = [];
  for (const path of paths) {
    const rel = relative(ARCHIVE, path).replaceAll("\\", "/");
    const parts = rel.split("/");
    const bytes = new Uint8Array(readFileSync(path));
    // Legacy .doc files: use the .docx converted earlier when there is one.
    const converted = join(CONVERTED, `${parts[0]}__${parts[1]}.docx`);
    const docxBytes = /\.doc$/i.test(path) && existsSync(converted) ? new Uint8Array(readFileSync(converted)) : null;
    try {
      const result = await intakeFile({
        bytes,
        fileName: parts[parts.length - 1]!,
        sourcePath: parts.slice(0, -1).join("/"),
        docxBytes,
      });
      if (result.created) added.push({ file: result.file, inventory: result.inventory, rel });
    } catch (error) {
      logger.warn("templates.import_failed", { file: rel, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (!added.length) return { files: 0, drafts: 0 };

  // Templates whose fixed text is identical across clients are worth knowing about.
  const records = added.map((item) => item.inventory);
  markSharedLayouts(records);
  for (const item of added) {
    await query("UPDATE template_files SET inventory = $2::text::jsonb WHERE file_id = $1", [item.file.file_id, JSON.stringify(item.inventory)]);
    item.file.inventory = item.inventory;
  }

  let drafts = 0;
  for (const item of added) {
    const [family] = await query(
      "SELECT template_id, investigation_type FROM form_templates WHERE source_file = $1 ORDER BY created_at LIMIT 1",
      [item.rel],
    );
    let templateId = family?.template_id as string | undefined;
    const type = item.inventory.investigation_type.code;
    if (family && !family.investigation_type && type) {
      await query("UPDATE form_templates SET investigation_type = $2 WHERE template_id = $1", [templateId, type]);
    }
    if (!templateId) {
      const client = item.inventory.client.client_id ?? item.inventory.client.suggested;
      if (!client || !type) continue;
      const [known] = await query("SELECT 1 FROM form_clients WHERE client_id = $1", [client]);
      if (!known) continue;
      const rows = await query(
        `INSERT INTO form_templates(code,client_id,title,category,sections,source_file,active,investigation_type)
         VALUES($1,$2,$3,$4,'[]'::jsonb,$5,false,$6) RETURNING template_id`,
        [`${client}-${crypto.randomUUID().slice(0, 8)}`, client, item.inventory.title || item.rel, item.inventory.investigation_type.name, item.rel, type],
      );
      templateId = rows[0]!.template_id as string;
    }
    try {
      await draftFromFile({
        file: item.file,
        templateId,
        actorId: "system",
        note: "استيراد تلقائي من الملف الأصلي: الحقول والربط مقترحة آليًا وتحتاج مراجعة الإدارة العليا",
      });
      drafts += 1;
    } catch (error) {
      logger.warn("templates.draft_failed", { file: item.rel, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { files: added.length, drafts };
}

export async function seedTemplates(): Promise<void> {
  await seedCatalog();
  const legacy = await legacyVersions();
  const archive = await importArchive();
  if (legacy || archive.files) logger.info("templates.imported", { legacy_versions: legacy, ...archive });
}
