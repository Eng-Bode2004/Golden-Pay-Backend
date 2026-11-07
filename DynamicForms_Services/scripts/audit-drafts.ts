// Lists what each client-layout draft still needs: weak labels, unbound places,
// unresolved pictures, old data, and the checks that block review.
//   bun --env-file=../IdentityAcess_Services/.env scripts/audit-drafts.ts [filter]
import { connectDatabase, database, query } from "../../IdentityAcess_Services/Config/db.ts";
import { allFields, type TemplateDefinition } from "../../Shared/templates/definition.ts";
import type { Binding, Slot } from "../../Shared/templates/scan.ts";
import { checkVersion } from "../templates.ts";

await connectDatabase();
try {
  const filter = process.argv[2] ?? "";
  const rows = await query(
    `SELECT v.*, t.title, t.client_id, t.investigation_type, f.source_path, f.inventory
     FROM template_versions v JOIN form_templates t ON t.template_id = v.template_id
     JOIN template_files f ON f.file_id = v.source_file_id
     WHERE v.layout_mode = 'docx' AND v.status IN ('draft','in_review') ORDER BY f.source_path`,
  );
  for (const row of rows) {
    if (filter && !String(row.source_path).includes(filter)) continue;
    const definition = row.definition as TemplateDefinition;
    const bindings = row.bindings as Binding[];
    const slots = row.slots as Slot[];
    const fields = allFields(definition);
    const bound = new Set(bindings.map((binding) => binding.anchor));
    const weak = fields.filter((field) => field.label.length < 3 || /^(بيان|لا|نعم|حقل|خيار|مربع نص فارغ)$/.test(field.label) || /[:：]/.test(field.label));
    const unbound = slots.filter((slot) => !bound.has(slot.anchor));
    const check = await checkVersion(row);
    const inv = row.inventory as { client: { client_id: string | null; suggested: string | null }; investigation_type: { code: string | null } };
    console.log(
      `\n## ${row.source_path} | ${row.client_id} (${inv.client.client_id ?? `suggested ${inv.client.suggested}`}) | ${row.investigation_type} | ${row.status}`,
    );
    console.log(`fields ${fields.length} | slots ${slots.length} | unbound ${unbound.length} | errors ${check.errors.length} | warnings ${check.warnings.length}`);
    if (weak.length) console.log(`  weak labels: ${weak.map((field) => `${field.key}=«${field.label}»`).join(" ; ")}`);
    for (const slot of unbound.slice(0, 12)) console.log(`  unbound ${slot.anchor} ${slot.kind} «${slot.label}» ${slot.text ? `[${slot.text.slice(0, 30)}]` : ""}`);
    for (const error of check.errors.slice(0, 8)) console.log(`  ERROR ${error.message.slice(0, 140)}`);
  }
} finally {
  await database.end();
}
