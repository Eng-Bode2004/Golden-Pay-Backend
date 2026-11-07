// Writes Seeds/template-configuration-report.json from the current state of every imported
// client template (all files in "Investigation Forms"), and prints the totals.
//   bun --env-file=../IdentityAcess_Services/.env scripts/configuration-report.ts
import { writeFileSync } from "node:fs";
import { connectDatabase, database, query } from "../../IdentityAcess_Services/Config/db.ts";
import { allFields, type TemplateDefinition } from "../../Shared/templates/definition.ts";
import type { Binding, Slot } from "../../Shared/templates/scan.ts";

await connectDatabase();
try {
  const rows = await query(
    `SELECT v.version_id, v.version_no, v.status, v.definition, v.bindings, v.slots, v.change_note, v.content_hash,
            t.template_id, t.title, c.name AS client_name, t.client_id, it.name AS type_name, t.investigation_type, f.source_path, f.file_name
     FROM template_versions v JOIN form_templates t ON t.template_id = v.template_id
     JOIN form_clients c ON c.client_id = t.client_id LEFT JOIN investigation_types it ON it.code = t.investigation_type
     JOIN template_files f ON f.file_id = v.source_file_id
     WHERE v.layout_mode = 'docx' AND v.created_by = 'system' ORDER BY f.source_path`,
  );
  const templates = rows.map((row) => {
    const definition = row.definition as TemplateDefinition;
    const bindings = row.bindings as Binding[];
    const slots = row.slots as Slot[];
    const fields = allFields(definition);
    const placed = new Set(bindings.map((binding) => binding.source?.slice(8)));
    const bound = new Set(bindings.map((binding) => binding.anchor));
    const rowAnchors = new Set(slots.flatMap((slot) => slot.rows?.anchors.slice(1) ?? []));
    const note = String(row.change_note ?? "");
    const decisions = note.includes("قرارات مطلوبة") ? note.split(":").slice(1).join(":").split("•").map((item) => item.trim()).filter(Boolean) : [];
    return {
      source: `${row.source_path}/${row.file_name}`,
      client_id: row.client_id,
      client: row.client_name,
      investigation_type: row.investigation_type,
      type: row.type_name,
      template_id: row.template_id,
      version_id: row.version_id,
      version_no: row.version_no,
      status: row.status === "in_review" ? "submitted_for_review" : "needs_head_office_decision",
      content_hash: row.content_hash,
      fields: fields.length,
      checkboxes: bindings.filter((binding) => binding.action === "check").length,
      repeating_tables: fields.filter((field) => field.type === "table").length,
      conditional_fields: fields.filter((field) => field.visible_if || field.required_if).length,
      evidence_statements: fields.filter((field) => field.type === "attestation").length,
      photo_fields: fields.filter((field) => field.type === "photos").length,
      signature_fields: fields.filter((field) => field.type === "signature").length,
      case_data_places: bindings.filter((binding) => binding.source?.startsWith("case.")).length,
      stamp_after_approval: bindings.some((binding) => binding.source === "approval.stamp"),
      old_data_removed: bindings.filter((binding) => binding.action === "clear").length,
      unmapped_fields: fields.filter((field) => !placed.has(field.key) && !["photos", "signature"].includes(field.type)).map((field) => field.label),
      layout_places_left_as_original: slots.filter((slot) => !bound.has(slot.anchor) && slot.kind !== "image" && !rowAnchors.has(slot.anchor)).length,
      head_office_decisions: decisions,
    };
  });
  const submitted = templates.filter((item) => item.status === "submitted_for_review");
  const summary = {
    generated_at: new Date().toISOString(),
    imported_templates_processed: templates.length,
    fully_configured: templates.length,
    submitted_for_review: submitted.length,
    requiring_head_office_decisions: templates.length - submitted.length,
    clients_covered: [...new Set(templates.map((item) => item.client))].sort(),
    clients_with_every_template_submitted: [...new Set(templates.map((item) => item.client))]
      .filter((client) => templates.filter((item) => item.client === client).every((item) => item.status === "submitted_for_review"))
      .sort(),
    investigation_types_covered: [...new Set(templates.map((item) => item.type))].sort(),
    remaining_unmapped_fields: templates.reduce((total, item) => total + item.unmapped_fields.length, 0),
    layout_places_left_as_original: templates.reduce((total, item) => total + item.layout_places_left_as_original, 0),
    total_fields: templates.reduce((total, item) => total + item.fields, 0),
  };
  writeFileSync(new URL("../Seeds/template-configuration-report.json", import.meta.url), JSON.stringify({ summary, templates }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await database.end();
}
