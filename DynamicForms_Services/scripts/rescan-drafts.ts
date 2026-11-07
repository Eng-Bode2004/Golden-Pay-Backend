// Re-scans imported drafts that nobody has touched yet, after the scanner improves.
// Drafts edited by Head Office, and every submitted or approved version, are left alone.
//   bun --env-file=../IdentityAcess_Services/.env scripts/rescan-drafts.ts
import { connectDatabase, database, query } from "../../IdentityAcess_Services/Config/db.ts";
import { parseDefinition } from "../../Shared/templates/definition.ts";
import { sha256 } from "../../Shared/templates/docx.ts";
import type { InventoryRecord } from "../../Shared/templates/inventory.ts";
import { scanTemplate } from "../../Shared/templates/scan.ts";
import { clientProfiles, loadFile, logTemplateEvent, storeFile } from "../templates.ts";

await connectDatabase();
try {
  const drafts = await query(
    `SELECT v.version_id, v.template_id, f.path, f.docx_path, f.inventory FROM template_versions v
     JOIN template_files f ON f.file_id = v.source_file_id
     WHERE v.status = 'draft' AND v.layout_mode = 'docx' AND v.created_by = 'system'
       AND NOT EXISTS (SELECT 1 FROM template_events e WHERE e.version_id = v.version_id AND e.type = 'version.edited')`,
  );
  const logos = (await clientProfiles()).flatMap((client) => client.logo_hashes);
  let updated = 0;
  for (const draft of drafts) {
    const scan = scanTemplate(await loadFile((draft.docx_path ?? draft.path) as string), logos);
    const definition = parseDefinition(scan.definition);
    const layoutPath = await storeFile(`templates/layouts/${draft.version_id}.docx`, scan.docx);
    const warnings = [
      ...((draft.inventory as InventoryRecord).warnings ?? []),
      ...[...new Set(scan.warnings)].map((message) => ({ code: "scan", message, severity: "info" })),
    ];
    await query(
      `UPDATE template_versions SET definition = $2::text::jsonb, bindings = $3::text::jsonb, slots = $4::text::jsonb,
         layout_path = $5, layout_sha256 = $6, warnings = $7::text::jsonb, updated_at = now()
       WHERE version_id = $1 AND status = 'draft'`,
      [draft.version_id, JSON.stringify(definition), JSON.stringify(scan.bindings), JSON.stringify(scan.slots), layoutPath, await sha256(scan.docx), JSON.stringify(warnings)],
    );
    await logTemplateEvent({ type: "version.rescanned", template_id: draft.template_id as string, version_id: draft.version_id as string, note: "أُعيد فحص الملف الأصلي بأحدث محلل" });
    updated += 1;
  }
  console.log(`Re-scanned ${updated} untouched draft(s).`);
} finally {
  await database.end();
}
