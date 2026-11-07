import { join } from "node:path";
import { query } from "../IdentityAcess_Services/Config/db.ts";
import { withAuth, withPermission } from "../IdentityAcess_Services/MIddlewares/auth.middleware.ts";
import { PERMISSIONS } from "../IdentityAcess_Services/Services/rbac.service.ts";
import { ApiError, ok, type RequestContext } from "../IdentityAcess_Services/Utils/http.ts";
import { Router } from "../IdentityAcess_Services/Utils/router.ts";
import { requiredText, startService } from "../Shared/service.ts";
import { seedTemplates } from "./importer.ts";
import { registerTemplateRoutes } from "./templates.ts";

interface SeedForm {
  code: string;
  client_slug: string;
  client_name: string;
  client_type: string;
  title: string;
  category: string;
  source_file: string;
  sections: unknown[];
}

/** Inserts the converted forms once. Later changes are versions, never overwritten here. */
async function seedForms(): Promise<void> {
  const forms = (await Bun.file(join(import.meta.dir, "Seeds", "forms.json")).json()) as SeedForm[];
  for (const form of forms) {
    await query(
      "INSERT INTO form_clients(client_id,name,client_type) VALUES($1,$2,$3) ON CONFLICT (client_id) DO NOTHING",
      [form.client_slug, form.client_name, form.client_type],
    );
    await query(
      `INSERT INTO form_templates(code,client_id,title,category,sections,source_file)
       VALUES($1,$2,$3,$4,$5::text::jsonb,$6) ON CONFLICT (code) DO NOTHING`,
      [form.code, form.client_slug, form.title, form.category, JSON.stringify(form.sections), form.source_file],
    );
  }
}

function fieldCount(definition: unknown): number {
  const sections = Array.isArray(definition) ? definition : ((definition as { sections?: unknown[] })?.sections ?? []);
  return (sections as { fields?: unknown[] }[]).reduce((total, section) => total + (section.fields?.length ?? 0), 0);
}

async function listClients(): Promise<Response> {
  const clients = await query(
    `SELECT c.client_id, c.name, c.name_en, c.client_type,
            count(t.template_id) FILTER (WHERE t.active AND t.active_version_id IS NOT NULL)::int AS form_count
     FROM form_clients c LEFT JOIN form_templates t ON t.client_id = c.client_id
     WHERE c.active GROUP BY c.client_id ORDER BY c.client_type, c.name`,
  );
  return ok({ clients });
}

async function listTypes(): Promise<Response> {
  return ok({ types: await query("SELECT code, name FROM investigation_types WHERE active ORDER BY sort") });
}

/** Templates new cases may use: switched on, with an approved active version. */
async function listTemplates(context: RequestContext): Promise<Response> {
  const client = context.url.searchParams.get("client");
  const type = context.url.searchParams.get("type");
  const rows = await query(
    `SELECT t.template_id, t.title, t.category, t.client_id, t.investigation_type, t.updated_at, t.active,
            c.name AS client_name, c.client_type, it.name AS type_name,
            v.version_id, v.version_no AS version, v.layout_mode, v.definition, v.activated_at
     FROM form_templates t JOIN form_clients c ON c.client_id = t.client_id
     JOIN template_versions v ON v.version_id = t.active_version_id AND v.status = 'active'
     LEFT JOIN investigation_types it ON it.code = t.investigation_type
     WHERE t.active AND ($1::text IS NULL OR t.client_id = $1) AND ($2::text IS NULL OR t.investigation_type = $2)
     ORDER BY c.client_type, c.name, it.sort NULLS LAST, t.title`,
    [client || null, type || null],
  );
  return ok({
    templates: rows.map(({ definition, ...row }) => ({ ...row, field_count: fieldCount(definition) })),
  });
}

/** A template with the exact active version a new case will copy. */
async function getTemplate(context: RequestContext): Promise<Response> {
  const rows = await query(
    `SELECT t.template_id, t.code, t.title, t.category, t.client_id, t.investigation_type, t.active, t.updated_at,
            c.name AS client_name, c.client_type, it.name AS type_name,
            v.version_id, v.version_no, v.layout_mode, v.definition, v.content_hash, v.activated_at
     FROM form_templates t JOIN form_clients c ON c.client_id = t.client_id
     LEFT JOIN investigation_types it ON it.code = t.investigation_type
     LEFT JOIN template_versions v ON v.version_id = t.active_version_id AND v.status = 'active'
     WHERE t.template_id = $1`,
    [context.params.template_id],
  );
  const row = rows[0];
  if (!row) throw ApiError.notFound("Form not found");
  if (!row.version_id) throw new ApiError(409, "NO_ACTIVE_VERSION", "This form has no approved version yet");
  const definition = row.definition as { sections: unknown[] };
  return ok({
    template: {
      ...row,
      version: row.version_no,
      // Older clients read `sections`; new ones read `definition`.
      sections: definition.sections,
    },
  });
}

/** The active templates for one client and investigation type. */
async function resolveTemplate(context: RequestContext): Promise<Response> {
  const client = requiredText(context.url.searchParams.get("client"), "client", 64);
  const type = requiredText(context.url.searchParams.get("type"), "type", 40);
  const rows = await query(
    `SELECT t.template_id, t.title, v.version_id, v.version_no, v.layout_mode
     FROM form_templates t JOIN template_versions v ON v.version_id = t.active_version_id AND v.status = 'active'
     WHERE t.active AND t.client_id = $1 AND t.investigation_type = $2 ORDER BY t.title`,
    [client, type],
  );
  return ok({ templates: rows });
}

const router = new Router();
router.get("/forms/clients", withAuth(listClients));
router.get("/forms/types", withAuth(listTypes));
router.get("/forms/resolve", withAuth(resolveTemplate));
router.get("/forms/templates", withAuth(listTemplates));
router.get("/forms/templates/:template_id", withAuth(getTemplate));
router.patch(
  "/forms/templates/:template_id",
  withPermission(PERMISSIONS.FORMS_MANAGE, async () => {
    // Forms are versioned: changes are drafts that Head Office reviews and approves.
    throw new ApiError(
      409,
      "TEMPLATE_VERSIONING",
      "Form changes are made as new versions in the Head Office template manager, then reviewed and approved.",
    );
  }),
);
registerTemplateRoutes(router);

await startService({
  name: "golden-pay-dynamic-forms",
  port: Number(process.env.FORMS_PORT ?? 4002),
  router,
  schema: join(import.meta.dir, "schema.sql"),
  healthPrefix: "/forms",
  seed: async () => {
    await seedForms();
    await seedTemplates();
  },
});
