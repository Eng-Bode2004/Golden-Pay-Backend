import { join } from "node:path";
import { query, transaction } from "../IdentityAcess_Services/Config/db.ts";
import {
  withAuth,
  withPermission,
  type AuthContext,
} from "../IdentityAcess_Services/MIddlewares/auth.middleware.ts";
import { recordAudit } from "../IdentityAcess_Services/Services/audit.service.ts";
import { hasPermission, PERMISSIONS } from "../IdentityAcess_Services/Services/rbac.service.ts";
import {
  deleteStoredFiles,
  getFormFile,
  readStoredFile,
  saveImage,
} from "../IdentityAcess_Services/Utils/files.ts";
import { ApiError, created, ok, readFormData, readJson, type RequestContext } from "../IdentityAcess_Services/Utils/http.ts";
import { Router } from "../IdentityAcess_Services/Utils/router.ts";
import { optionalNumber, optionalText, requiredText, startService } from "../Shared/service.ts";
import { findServiceLevel, registerFinanceRoutes, seedServiceLevels } from "./finance.ts";
import { quotePrice, registerPricingRoutes } from "./pricing.ts";
import { registerFollowUpRoutes } from "./followup.ts";
import { registerIntakeRoutes, startIntake, type IntakeDeps } from "./intake/index.ts";
import { matchInvestigators } from "../Investigators_Services/app.ts";
import {
  acceptOffer,
  assignManually,
  declineOffer,
  dispatchMetrics,
  endAssignment,
  fairnessBoard,
  loadPolicy,
  excuseCase,
  listExcuses,
  loadWorkRules,
  setWorkRules,
  logEvent,
  offerNext,
  resumeOpenCases,
  startDispatcher,
  TIER_LABELS,
  updatePolicy,
} from "./dispatch.ts";
import { EXCLUSION_LABELS, imbalance } from "./fairness.ts";
import { notify } from "../Shared/notifications.ts";
import { seesMoney, withoutMoney } from "./money-visibility.ts";
import { canonicalNames } from "../Shared/places.ts";
import { firstPhotosKey, NEGATIVE_PHOTOS_KEY, negativeAnswers, negativeSummary } from "./negative.ts";
import { LOCATION_KINDS, NEGATIVE_REASONS } from "./outcome.ts";
import { renderStandardPdf } from "./pdf.ts";
import { storeReportFile } from "./reports.ts";
import { ConverterUnavailable, countPdfPages, docxToPdf } from "../Shared/templates/convert.ts";
import {
  allFields,
  cleanAnswers,
  type EvidenceContext,
  type TemplateDefinition,
  upgradeLegacy,
  validateAnswers,
} from "../Shared/templates/definition.ts";
import { renderDocxReport } from "../Shared/templates/report.ts";
import type { Binding } from "../Shared/templates/scan.ts";

const AREA_LEVELS = ["governorate", "district", "local_unit", "main_village", "sub_village"] as const;
const FORMS_URL = process.env.FORMS_SERVICE_URL ?? "http://127.0.0.1:4002";
const INVESTIGATORS_URL = process.env.INVESTIGATORS_SERVICE_URL ?? "http://127.0.0.1:4003";
const MANAGE = PERMISSIONS.INVESTIGATIONS_MANAGE;

type Row = Record<string, unknown>;
/** Cases created before versioning stored a plain list of sections. */
function definitionOf(snapshot: unknown): TemplateDefinition {
  return Array.isArray(snapshot) ? upgradeLegacy(snapshot) : (snapshot as TemplateDefinition);
}

/** What was recorded while working on the case: the evidence statements rely on. */
async function evidenceFor(row: Row, extra: { lat: number; lng: number } | null = null): Promise<EvidenceContext> {
  const [photos, locations] = await Promise.all([
    query("SELECT field_key, count(*)::int AS total FROM investigation_images WHERE investigation_id=$1 GROUP BY field_key", [
      row.investigation_id,
    ]),
    query("SELECT kind, lat, lng FROM investigation_locations WHERE investigation_id=$1", [row.investigation_id]),
  ]);
  return {
    photos: Object.fromEntries(photos.map((item) => [item.field_key, Number(item.total)])),
    locations: [
      ...locations.map((item) => ({ kind: item.kind as string, lat: Number(item.lat), lng: Number(item.lng) })),
      ...(extra ? [{ kind: "submitted", ...extra }] : []),
    ],
    target: row.lat !== null && row.lng !== null && row.lat !== undefined ? { lat: Number(row.lat), lng: Number(row.lng) } : null,
  };
}

/** Calls a sibling service with the administrator's own token. */
async function sibling<T>(base: string, path: string, context: RequestContext, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: context.req.headers.get("authorization") ?? "",
      "Content-Type": "application/json",
    },
  });
  const body = (await response.json()) as { data: T; error?: { code: string; message: string; details?: unknown } };
  if (!response.ok) {
    throw new ApiError(response.status, body.error?.code ?? "UPSTREAM_ERROR", body.error?.message ?? "Service error", {
      details: body.error?.details,
    });
  }
  return body.data;
}

async function nextReference(): Promise<string> {
  const rows = await query(
    `INSERT INTO counters("_id",value) VALUES('investigation_reference',1)
     ON CONFLICT ("_id") DO UPDATE SET value = counters.value + 1 RETURNING value`,
  );
  return `INV-${new Date().getFullYear()}-${String(rows[0]?.value).padStart(6, "0")}`;
}

async function findCase(id: string | undefined): Promise<Row> {
  const rows = await query("SELECT * FROM investigations WHERE investigation_id = $1", [id]);
  if (!rows[0]) throw ApiError.notFound("Investigation not found");
  return rows[0];
}

const isManager = (auth: AuthContext) => hasPermission(auth.access, MANAGE);

/** Investigators reach only cases sent to them or that they took. */
async function assertAccess(row: Row, auth: AuthContext): Promise<void> {
  if (isManager(auth) || row.assignee_id === auth.user.user_id) return;
  if (row.status === "open") {
    const offered = await query(
      "SELECT 1 FROM investigation_offers WHERE investigation_id=$1 AND user_id=$2 AND response IS NULL",
      [row.investigation_id, auth.user.user_id],
    );
    if (offered.length) return;
  }
  throw ApiError.forbidden("This investigation is not assigned to you");
}

function assertWorker(row: Row, auth: AuthContext): void {
  if (row.assignee_id !== auth.user.user_id) throw ApiError.forbidden("This investigation is not assigned to you");
  if (!["assigned", "in_progress", "returned"].includes(row.status as string)) {
    throw new ApiError(409, "INVESTIGATION_LOCKED", "This investigation can no longer be edited");
  }
}

function withImages(row: Row, images: Row[], manager: boolean) {
  const { form_snapshot, client_price, investigator_price, ...rest } = row;
  return {
    ...rest,
    investigator_price: Number(investigator_price),
    // Only managers see what the client pays.
    ...(manager ? { client_price: Number(client_price) } : {}),
    sections: definitionOf(form_snapshot).sections,
    definition: definitionOf(form_snapshot),
    images: images.map((image) => ({
      image_id: image.image_id,
      field_key: image.field_key,
      created_at: image.created_at,
    })),
  };
}

const imagesOf = (id: unknown) =>
  query("SELECT * FROM investigation_images WHERE investigation_id=$1 ORDER BY created_at", [id]);

const LIST_COLUMNS = `i.investigation_id, i.reference, i.status, i.target_mode, i.subject_name, i.address, i.governorate,
  i.district, i.main_village, i.client_name, i.form_title, i.pdf_status, i.created_at, i.submitted_at, i.review_note,
  i.lat, i.lng, u.full_name AS assignee_name, u.employee_number AS assignee_number, i.service_level, i.service_name,
  i.due_at, i.investigator_price::float8 AS investigator_price, i.outcome`;

/**
 * Builds the case report. With an approved client layout (and a Word engine installed) the
 * report is the client's own Word form, filled in; otherwise the standard Golden Pay layout.
 * The Golden Pay stamp is added only once the report is approved.
 */
async function buildReport(id: string): Promise<void> {
  const row = await findCase(id);
  await query("UPDATE investigations SET pdf_status='generating', report_error=NULL WHERE investigation_id=$1", [id]);
  try {
    const [users, reviewer, images, trail, evidence] = await Promise.all([
      query("SELECT full_name, employee_number FROM users WHERE user_id=$1", [row.assignee_id]),
      row.reviewed_by ? query("SELECT full_name FROM users WHERE user_id=$1", [row.reviewed_by]) : Promise.resolve([]),
      imagesOf(id),
      query("SELECT kind, lat, lng, created_at FROM investigation_locations WHERE investigation_id=$1 ORDER BY created_at", [id]),
      evidenceFor(row),
    ]);
    const definition = definitionOf(row.form_snapshot);
    const approved = row.status === "approved";
    const [version] = row.template_version_id
      ? await query("SELECT layout_mode, layout_path, bindings, slots FROM template_versions WHERE version_id=$1", [row.template_version_id])
      : [];
    let pdf: Uint8Array | null = null;
    let docx: Uint8Array | null = null;
    let layout = "standard";
    let engine = "chrome";
    let pages: number | null = null;
    let issues: unknown[] = [];
    let note: string | null = null;

    const negative = row.outcome === "negative";
    if (version?.layout_mode === "docx" && version.layout_path) {
      try {
        const imageBytes: Record<string, { bytes: Uint8Array }[]> = {};
        // A negative report prints the photos of the place in the form's first photo box.
        const placeKey = negative ? firstPhotosKey(definition) : null;
        for (const image of images) {
          const { bytes } = await readStoredFile(image.path as string);
          const key = placeKey && image.field_key === NEGATIVE_PHOTOS_KEY ? placeKey : (image.field_key as string);
          (imageBytes[key] ??= []).push({ bytes: new Uint8Array(bytes) });
        }
        const { bytes: layoutBytes } = await readStoredFile(version.layout_path as string);
        const report = await renderDocxReport({
          layout: new Uint8Array(layoutBytes),
          bindings: version.bindings as Binding[],
          slots: (version.slots as { anchor: string; kind: string }[] | null) ?? null,
          definition,
          // Negative: the same client form, «لم يتم التعرف عليه» and whom we asked.
          answers: negative ? negativeAnswers(definition, row) : (row.answers as Record<string, unknown>),
          context: {
            reference: row.reference as string,
            subject_name: row.subject_name as string,
            subject_phone: row.subject_phone as string | null,
            address: row.address as string,
            governorate: row.governorate as string | null,
            district: row.district as string | null,
            landmark: row.landmark as string | null,
            client_reference: row.client_reference as string | null,
            client_name: row.client_name as string,
            form_title: row.form_title as string,
            investigator_name: (users[0]?.full_name as string) ?? null,
            employee_number: (users[0]?.employee_number as string) ?? null,
            reviewer_name: approved ? ((reviewer[0]?.full_name as string) ?? null) : null,
            submitted_at: row.submitted_at as Date,
            approved_at: approved ? (row.reviewed_at as Date) : null,
            submit_lat: row.submit_lat as number | null,
            submit_lng: row.submit_lng as number | null,
          },
          images: imageBytes,
          evidence,
          approved,
        });
        pdf = report.pdf;
        docx = report.docx;
        layout = "docx";
        engine = report.engine;
        pages = report.pages;
        issues = report.issues;
      } catch (error) {
        if (!(error instanceof ConverterUnavailable)) throw error;
        note = "لا يوجد محرك Word على الخادم؛ استُخدم التصميم الموحّد لجولدن باي بدلًا من تصميم العميل.";
      }
    }

    if (!pdf) {
      pdf = await renderStandardPdf({
        reference: row.reference as string,
        subject_name: row.subject_name as string,
        subject_phone: row.subject_phone as string | null,
        client_reference: row.client_reference as string | null,
        client_name: row.client_name as string,
        form_title: row.form_title as string,
        address: row.address as string,
        location: AREA_LEVELS.map((level) => row[level]).filter(Boolean).join(" - "),
        landmark: row.landmark as string | null,
        admin_notes: row.admin_notes as string | null,
        investigator: (users[0]?.full_name as string) ?? "—",
        employee_number: (users[0]?.employee_number as string) ?? null,
        submitted_at: new Date(row.submitted_at as string),
        submit_lat: row.submit_lat as number | null,
        submit_lng: row.submit_lng as number | null,
        definition,
        answers: row.answers as Record<string, unknown>,
        images: images as never,
        outcome: row.outcome as string,
        negative_reasons: (row.negative_reasons as string[] | null) ?? [],
        negative_note: negative ? negativeSummary(row) : (row.negative_note as string | null),
        trail: trail as never,
        evidence,
        approved,
      });
    }
    const path = await storeReportFile(id, "report.pdf", pdf);
    const docxPath = docx ? await storeReportFile(id, "report.docx", docx) : null;
    await query(
      `UPDATE investigations SET pdf_status='ready', pdf_path=$2, report_docx_path=$3, report_layout=$4, report_engine=$5,
         report_pages=$6, report_issues=$7::text::jsonb, report_error=$8, report_built_at=now(),
         report_edited_at=NULL, report_edited_by=NULL, report_edited_note=NULL WHERE investigation_id=$1`,
      [id, path, docxPath, layout, engine, pages, JSON.stringify(issues), note],
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await query("UPDATE investigations SET pdf_status='failed', report_error=$2 WHERE investigation_id=$1", [id, message.slice(0, 500)]);
    console.error("investigation.pdf_failed", id, message);
  }
}

async function createInvestigation(context: RequestContext, auth: AuthContext): Promise<Response> {
  const body = await readJson(context.req);
  const mode = body.target_mode;
  if (mode !== "person" && mode !== "area") throw ApiError.badRequest("target_mode must be person or area");

  const templateId = requiredText(body.template_id, "template_id", 64);
  // The forms service answers with the active approved version; the case keeps a copy.
  const { template } = await sibling<{ template: Row }>(
    FORMS_URL,
    `/forms/templates/${encodeURIComponent(templateId)}`,
    context,
  );
  const result = await insertCase(body, template, auth.user.user_id, async (filter) => {
    const { investigators } = await sibling<{ investigators: { user_id: string }[] }>(
      INVESTIGATORS_URL,
      "/investigators/match",
      context,
      { method: "POST", body: JSON.stringify(filter) },
    );
    return investigators.map((person) => person.user_id);
  });
  await recordAudit({
    event: "investigation.created",
    actorId: auth.user.user_id,
    success: true,
    context,
    metadata: { reference: result.reference, target_mode: mode, recipients: result.recipients, template_version: template.version_no },
  });
  return created(result);
}

/** The active approved version of a form, read directly (the email intake has no user token). */
export async function activeTemplate(templateId: string): Promise<Row> {
  const [row] = await query(
    `SELECT t.template_id, t.title, t.client_id, t.investigation_type, t.active, c.name AS client_name,
            v.version_id, v.version_no, v.definition, v.content_hash
     FROM form_templates t JOIN form_clients c ON c.client_id = t.client_id
     LEFT JOIN template_versions v ON v.version_id = t.active_version_id AND v.status = 'active'
     WHERE t.template_id = $1`,
    [templateId],
  );
  if (!row) throw new ApiError(404, "NOT_FOUND", "Form not found");
  return row;
}

/**
 * Creates one investigation from validated input and offers it. Shared by the admin's
 * "send a case" screen and the email intake. `match` finds the area's investigators.
 */
export async function insertCase(
  body: Row,
  template: Row,
  actorId: string,
  match: (filter: Row) => Promise<string[]>,
  extra: { source?: string; mailCaseId?: string | null } = {},
): Promise<{ investigation_id: string; reference: string; recipients: number }> {
  const mode = body.target_mode;
  if (mode !== "person" && mode !== "area") throw ApiError.badRequest("target_mode must be person or area");
  if (!template.version_id || template.active === false) {
    throw new ApiError(409, "TEMPLATE_NOT_ACTIVE", "This form is not active for new investigations");
  }

  let recipients: string[];
  let area: unknown = null;
  if (mode === "person") {
    const assignee = requiredText(body.assignee_id, "assignee_id", 64);
    const found = await query(
      "SELECT 1 FROM users WHERE user_id=$1 AND status='active' AND deleted_at IS NULL",
      [assignee],
    );
    if (!found.length) throw ApiError.badRequest("Choose an active investigator");
    recipients = [assignee];
  } else {
    area = body.area;
    recipients = await match({ ...((area as Row | null) ?? {}), client_id: template.client_id ?? null });
    if (!recipients.length) {
      throw new ApiError(
        409,
        "NO_INVESTIGATORS_IN_AREA",
        "No investigator in this area works for this company or bank; head office assigns clients to investigators",
      );
    }
  }

  // The type sets the deadline and the default prices; managers may adjust both.
  const level = await findServiceLevel(requiredText(body.service_level, "service_level", 40));
  const scheduledRaw = optionalText(body.scheduled_at, 40);
  const scheduled = scheduledRaw ? new Date(scheduledRaw) : null;
  if (scheduled && Number.isNaN(scheduled.getTime())) throw ApiError.badRequest("scheduled_at must be a date");
  if (level.delivery_hours === null && !scheduled) {
    throw ApiError.badRequest("Choose the appointment for a scheduled investigation", { field: "scheduled_at" });
  }
  const dueAt = scheduled ?? new Date(Date.now() + Number(level.delivery_hours) * 3_600_000);
  // The subject's area, each name snapped to the existing place (no «القاهر» next to «القاهرة»).
  const typedPlace = Object.fromEntries(AREA_LEVELS.map((name) => [name, optionalText(body[name], 120)])) as Record<
    (typeof AREA_LEVELS)[number],
    string | null
  >;
  const place = typedPlace.governorate ? await canonicalNames(typedPlace, { strictGovernorate: false }) : typedPlace;
  // Prices come from head office's price list: this client, this area, this type.
  const quote = await quotePrice(
    level,
    (template.client_id as string | null) ?? null,
    place.governorate,
    place.district,
  );

  const id = crypto.randomUUID();
  const reference = await nextReference();
  await transaction(async () => {
    await query(
      `INSERT INTO investigations(investigation_id,reference,status,target_mode,area_filter,preferred_id,subject_name,
         subject_phone,client_reference,address,governorate,district,local_unit,main_village,sub_village,landmark,
         lat,lng,admin_notes,client_id,client_name,template_id,form_title,form_snapshot,created_by,claimed_at,
         service_level,service_name,client_price,investigator_price,due_at,accept_minutes,
         template_version_id,template_version_no,template_hash,investigation_type)
       VALUES($1,$2,$3,$4,$5::text::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24::text::jsonb,$25,$26,
         $27,$28,$29,$30,$31,$32,$33,$34,$35,$36)`,
      [
        id,
        reference,
        "open",
        mode,
        area ? JSON.stringify(area) : null,
        mode === "person" ? recipients[0] : null,
        requiredText(body.subject_name, "subject_name", 160),
        optionalText(body.subject_phone, 30),
        optionalText(body.client_reference, 80),
        requiredText(body.address, "address", 400),
        ...AREA_LEVELS.map((name) => place[name]),
        optionalText(body.landmark, 300),
        optionalNumber(body.lat, "lat"),
        optionalNumber(body.lng, "lng"),
        optionalText(body.admin_notes, 2000),
        template.client_id,
        template.client_name,
        template.template_id,
        template.title,
        JSON.stringify(template.definition),
        actorId,
        null,
        level.code,
        level.name_ar,
        quote.client_price,
        quote.investigator_price,
        dueAt,
        level.accept_minutes,
        template.version_id,
        template.version_no,
        template.content_hash ?? null,
        template.investigation_type ?? null,
      ],
    );
    // An area case may only travel inside the chosen area; a personal case falls
    // back to the nearest investigators if the chosen person does not accept.
    if (mode === "area") {
      for (const user of recipients) {
        await query("INSERT INTO investigation_recipients(investigation_id,user_id) VALUES($1,$2)", [id, user]);
      }
    }
    await query("UPDATE investigations SET price_rule_id = $2, source = $3, mail_case_id = $4 WHERE investigation_id = $1", [
      id,
      quote.rule_id,
      extra.source ?? "manual",
      extra.mailCaseId ?? null,
    ]);
    await logEvent(id, "created", null, actorId);
  });
  await offerNext(id);
  return { investigation_id: id, reference, recipients: recipients.length };
}

async function listAll(context: RequestContext, auth: AuthContext): Promise<Response> {
  const status = context.url.searchParams.get("status");
  const search = context.url.searchParams.get("search")?.trim();
  const rows = await query(
    `SELECT ${LIST_COLUMNS}, i.client_price::float8 AS client_price, (SELECT count(*)::int FROM investigation_recipients r
        WHERE r.investigation_id = i.investigation_id) AS recipients,
       o.expires_at AS offer_expires_at, o.offered_to, o.offered_count
     FROM investigations i LEFT JOIN users u ON u.user_id = i.assignee_id
     -- A case is offered to several investigators at once: one row per case.
     LEFT JOIN LATERAL (
       SELECT min(x.expires_at) AS expires_at, count(*)::int AS offered_count,
         CASE WHEN count(*) = 1 THEN min(ou.full_name) ELSE count(*)::text || ' مستعلمين' END AS offered_to
       FROM investigation_offers x JOIN users ou ON ou.user_id = x.user_id
       WHERE x.investigation_id = i.investigation_id AND x.response IS NULL
       HAVING count(*) > 0
     ) o ON true
     WHERE ($1::text IS NULL OR i.status = $1)
       AND ($2::text IS NULL OR i.subject_name ILIKE '%'||$2||'%' OR i.reference ILIKE '%'||$2||'%')
     ORDER BY i.created_at DESC LIMIT 200`,
    [status || null, search || null],
  );
  const counts = await query("SELECT status, count(*)::int AS total FROM investigations GROUP BY status");
  const listed = {
    investigations: rows,
    counts: Object.fromEntries(counts.map((row) => [row.status, row.total])),
  };
  return ok(seesMoney(auth) ? listed : withoutMoney(listed));
}

async function listMine(_context: RequestContext, auth: AuthContext): Promise<Response> {
  const me = auth.user.user_id;
  const [available, active, done] = await Promise.all([
    query(
      `SELECT ${LIST_COLUMNS}, o.expires_at AS offer_expires_at FROM investigations i
       JOIN investigation_offers o ON o.investigation_id = i.investigation_id AND o.user_id = $1 AND o.response IS NULL
       LEFT JOIN users u ON u.user_id = i.assignee_id
       WHERE i.status = 'open' ORDER BY o.expires_at`,
      [me],
    ),
    query(
      `SELECT ${LIST_COLUMNS} FROM investigations i LEFT JOIN users u ON u.user_id = i.assignee_id
       WHERE i.assignee_id = $1 AND i.status IN ('assigned','in_progress','returned')
       ORDER BY i.status = 'returned' DESC, i.created_at DESC`,
      [me],
    ),
    query(
      `SELECT ${LIST_COLUMNS} FROM investigations i LEFT JOIN users u ON u.user_id = i.assignee_id
       WHERE i.assignee_id = $1 AND i.status IN ('submitted','approved')
       ORDER BY i.submitted_at DESC LIMIT 50`,
      [me],
    ),
  ]);
  return ok({ available, active, done });
}

const answersOf = (body: Row): string => {
  if (typeof body.answers !== "object" || body.answers === null || Array.isArray(body.answers)) {
    throw ApiError.badRequest("answers must be an object");
  }
  return JSON.stringify(body.answers);
};

const router = new Router();

router.get("/investigations/mine", withAuth(listMine));
registerFinanceRoutes(router);
registerPricingRoutes(router);
registerFollowUpRoutes(router);
// Case emails from clients; the same case creation as the admin's screen.
const intakeDeps: IntakeDeps = { activeTemplate, insertCase, matchInvestigators };
registerIntakeRoutes(router, intakeDeps);
router.get("/investigations", withPermission(MANAGE, listAll));
router.post("/investigations", withPermission(MANAGE, createInvestigation));

// ───────────── dispatch & fairness (docs/dispatch-fairness.md) ─────────────

router.get(
  "/investigations/dispatch/overview",
  withPermission(MANAGE, async () => {
    const policy = await loadPolicy();
    const [board, metrics, waiting] = await Promise.all([
      fairnessBoard(policy),
      dispatchMetrics(),
      query(
        `SELECT i.investigation_id, i.reference, i.status, i.subject_name, i.governorate, i.district, i.created_at,
           i.due_at, i.dispatch_round,
           (SELECT count(*)::int FROM investigation_offers o WHERE o.investigation_id = i.investigation_id AND o.response IS NULL) AS open_offers,
           (SELECT min(o.expires_at) FROM investigation_offers o WHERE o.investigation_id = i.investigation_id AND o.response IS NULL) AS expires_at,
           (SELECT d.outcome FROM dispatch_attempts d WHERE d.investigation_id = i.investigation_id AND NOT d.shadow
             ORDER BY d.created_at DESC LIMIT 1) AS last_outcome
         FROM investigations i WHERE i.status IN ('open','unassigned') ORDER BY i.created_at LIMIT 200`,
      ),
    ]);
    const eligibleScores = board
      .filter((row) => row.status === "active" && row.available)
      .map((row) => Number(row.score));
    return ok({ policy, investigators: board, metrics, waiting, imbalance: imbalance(eligibleScores), exclusion_labels: EXCLUSION_LABELS });
  }),
);

router.patch(
  "/investigations/dispatch/policy",
  withPermission(MANAGE, async (context, auth) => {
    const before = await loadPolicy();
    const policy = await updatePolicy(await readJson(context.req), auth.user.user_id);
    await recordAudit({
      event: "dispatch.policy_updated" as never,
      actorId: auth.user.user_id,
      success: true,
      context,
      metadata: { before, after: policy },
    });
    return ok({ policy });
  }),
);

/** Head office: how long an investigator has, after accepting, before the case moves on. */
router.get(
  "/investigations/dispatch/work-time",
  withPermission(PERMISSIONS.HEADOFFICE_MANAGE, async () => ok(await loadWorkRules())),
);
router.patch(
  "/investigations/dispatch/work-time",
  withPermission(PERMISSIONS.HEADOFFICE_MANAGE, async (context, auth) => {
    const body = await readJson(context.req);
    const rules = await setWorkRules(body, auth.user.user_id);
    await recordAudit({
      event: "dispatch.work_rules.updated",
      userId: auth.user.user_id,
      employeeNumber: auth.user.employee_number ?? null,
      success: true,
      context,
      metadata: rules as unknown as Record<string, unknown>,
    });
    return ok(rules);
  }),
);

/** Head office: investigators who excused themselves from accepted cases. */
router.get(
  "/investigations/excuses",
  withPermission(PERMISSIONS.HEADOFFICE_MANAGE, async () => ok({ excuses: await listExcuses() })),
);

/** The investigator excuses themselves from a case they accepted; it goes to someone else. */
router.post(
  "/investigations/:id/excuse",
  withAuth(async (context, auth) => {
    const body = await readJson(context.req);
    const reason = optionalText(body.reason, 500);
    if (!reason || reason.length < 5) throw ApiError.badRequest("Write the reason for your excuse", { field: "reason" });
    const result = await excuseCase(context.params.id ?? "", auth.user.user_id, reason);
    return ok({ status: "excused", ...result });
  }),
);

/** New offers and closed offers for the signed-in investigator, each delivered once. */
router.get(
  "/investigations/feed",
  withAuth(async (context, auth) => {
    const after = Number(context.url.searchParams.get("after") ?? 0) || 0;
    const rows = await query(
      `SELECT x.outbox_id, x.kind, x.investigation_id, x.payload, x.created_at, i.reference, i.status
       FROM dispatch_outbox x JOIN investigations i ON i.investigation_id = x.investigation_id
       WHERE x.user_id = $1 AND x.outbox_id > $2 ORDER BY x.outbox_id LIMIT 100`,
      [auth.user.user_id, after],
    );
    if (rows.length) {
      await query(
        "UPDATE dispatch_outbox SET delivered_at = COALESCE(delivered_at, now()) WHERE user_id = $1 AND outbox_id = ANY($2::bigint[])",
        [auth.user.user_id, rows.map((row) => row.outbox_id)],
      );
    }
    return ok({ items: rows, last: rows.length ? rows[rows.length - 1]!.outbox_id : after });
  }),
);

router.get(
  "/investigations/:id",
  withAuth(async (context, auth) => {
    const row = await findCase(context.params.id);
    await assertAccess(row, auth);
    const users = row.assignee_id
      ? await query("SELECT full_name, employee_number, phone FROM users WHERE user_id=$1", [row.assignee_id])
      : [];
    const manager = isManager(auth);
    const [offer] = await query(
      "SELECT expires_at, seen_at FROM investigation_offers WHERE investigation_id=$1 AND user_id=$2 AND response IS NULL",
      [row.investigation_id, auth.user.user_id],
    );
    // Administrators review cases without the money; the investigator sees their own pay.
    const hideMoney = manager && row.assignee_id !== auth.user.user_id && !seesMoney(auth);
    const detail = withImages(row, await imagesOf(row.investigation_id), manager);
    return ok({
      investigation: {
        ...(hideMoney ? withoutMoney(detail) : detail),
        assignee: users[0] ?? null,
        offer_expires_at: offer?.expires_at ?? null,
        negative_reasons_catalog: NEGATIVE_REASONS,
        ...(manager
          ? {
              ...(await timeline(row.investigation_id as string)),
              locations: await query(
                `SELECT kind, lat, lng, accuracy, created_at FROM investigation_locations
                 WHERE investigation_id=$1 ORDER BY created_at`,
                [row.investigation_id],
              ),
            }
          : {}),
      },
    });
  }),
);

/** Offers, events and durations for the admin's case drawer. */
async function timeline(id: string) {
  const [events, offers] = await Promise.all([
    query(
      `SELECT e.type, e.note, e.created_at, u.full_name AS user_name, a.full_name AS actor_name
       FROM investigation_events e LEFT JOIN users u ON u.user_id = e.user_id LEFT JOIN users a ON a.user_id = e.actor_id
       WHERE e.investigation_id = $1 ORDER BY e.created_at`,
      [id],
    ),
    query(
      `SELECT o.tier, o.round, o.offered_at, o.expires_at, o.seen_at, o.responded_at, o.response, o.reason,
         u.full_name, u.employee_number
       FROM investigation_offers o JOIN users u ON u.user_id = o.user_id
       WHERE o.investigation_id = $1 ORDER BY o.offered_at`,
      [id],
    ),
  ]);
  return {
    events,
    offers: offers.map((offer) => ({ ...offer, tier_label: TIER_LABELS[offer.tier as number] ?? "" })),
  };
}

/** Marks the investigator's current offer as seen; only the first view counts. */
router.post(
  "/investigations/:id/seen",
  withAuth(async (context, auth) => {
    const rows = await query(
      `UPDATE investigation_offers SET seen_at = now()
       WHERE investigation_id=$1 AND user_id=$2 AND response IS NULL AND seen_at IS NULL RETURNING offer_id`,
      [context.params.id, auth.user.user_id],
    );
    if (rows.length) await logEvent(context.params.id ?? "", "seen", auth.user.user_id);
    return ok({ seen: true });
  }),
);

router.post(
  "/investigations/:id/decline",
  withAuth(async (context, auth) => {
    const body = await readJson(context.req).catch(() => ({}) as Row);
    await declineOffer(context.params.id ?? "", auth.user.user_id, optionalText(body.reason, 300));
    return ok({ declined: true });
  }),
);

/** Why the case went to whom: every dispatch decision with scores and exclusions. */
router.get(
  "/investigations/:id/dispatch",
  withPermission(MANAGE, async (context) => {
    const row = await findCase(context.params.id);
    const [attempts, ledger] = await Promise.all([
      query(
        `SELECT attempt_id, round, engine, shadow, tier, min_score::float8 AS min_score, pool_size, offered, eligible,
           excluded, outcome, created_at
         FROM dispatch_attempts WHERE investigation_id = $1 ORDER BY created_at`,
        [row.investigation_id],
      ),
      query(
        `SELECT a.source, a.counts, a.assigned_at, a.ended_at, a.end_reason, a.note, u.full_name,
           b.full_name AS assigned_by_name, e.full_name AS ended_by_name
         FROM investigation_assignments a JOIN users u ON u.user_id = a.user_id
         LEFT JOIN users b ON b.user_id = a.assigned_by LEFT JOIN users e ON e.user_id = a.ended_by
         WHERE a.investigation_id = $1 ORDER BY a.assigned_at`,
        [row.investigation_id],
      ),
    ]);
    const ids = new Set<string>();
    for (const attempt of attempts) {
      for (const list of [attempt.offered, attempt.eligible, attempt.excluded] as unknown[]) {
        for (const entry of (list as (string | { user_id: string })[]) ?? []) ids.add(typeof entry === "string" ? entry : entry.user_id);
      }
    }
    const names = ids.size
      ? await query("SELECT user_id, full_name, employee_number FROM users WHERE user_id = ANY($1::text[])", [[...ids]])
      : [];
    return ok({ attempts, ledger, names: Object.fromEntries(names.map((user) => [user.user_id, user])), exclusion_labels: EXCLUSION_LABELS });
  }),
);

/** Manual assignment or reassignment, with a reason that is kept on the case. */
router.post(
  "/investigations/:id/assign",
  withPermission(MANAGE, async (context, auth) => {
    const body = await readJson(context.req);
    const userId = requiredText(body.user_id, "user_id", 64);
    const reason = requiredText(body.reason, "reason", 500);
    const result = await assignManually(context.params.id ?? "", userId, auth.user.user_id, reason);
    await recordAudit({
      event: (result.previous ? "investigation.reassigned" : "investigation.assigned") as never,
      actorId: auth.user.user_id,
      success: true,
      context,
      metadata: { investigation_id: context.params.id, to: userId, from: result.previous, reason },
    });
    return ok(result);
  }),
);

router.post(
  "/investigations/:id/redispatch",
  withPermission(MANAGE, async (context, auth) => {
    const rows = await query(
      `UPDATE investigations SET status='open', dispatch_round = dispatch_round + 1, updated_at=now()
       WHERE investigation_id=$1 AND status IN ('open','unassigned') RETURNING investigation_id`,
      [context.params.id],
    );
    if (!rows.length) throw new ApiError(409, "INVALID_STATUS_TRANSITION", "This case is already taken");
    await query(
      "UPDATE investigation_offers SET response='cancelled', responded_at=now() WHERE investigation_id=$1 AND response IS NULL",
      [context.params.id],
    );
    await logEvent(context.params.id ?? "", "redispatched", null, auth.user.user_id);
    await offerNext(context.params.id ?? "");
    return ok({ status: "open" });
  }),
);

router.post(
  "/investigations/:id/claim",
  withAuth(async (context, auth) => {
    const id = context.params.id ?? "";
    const body = await readJson(context.req).catch(() => ({}) as Row);
    let result;
    try {
      // One transaction: exactly one investigator wins; repeating the request is harmless.
      result = await acceptOffer(id, auth.user.user_id);
    } catch (error) {
      if (error instanceof ApiError && error.code === "INVESTIGATION_TAKEN") {
        await logEvent(id, "accept_conflict", auth.user.user_id).catch(() => {});
      }
      throw error;
    }
    if (!result.repeated) {
      await saveLocation(id, auth.user.user_id, "accepted", body);
      await recordAudit({
        event: "investigation.claimed",
        userId: auth.user.user_id,
        success: true,
        context,
        metadata: { investigation_id: id },
      });
    }
    return ok({ investigation_id: result.investigation_id, status: result.status, repeated: result.repeated });
  }),
);

/** Stores a GPS fix taken while the investigator works on the case. */
async function saveLocation(id: string, userId: string, kind: string, body: Row): Promise<boolean> {
  const lat = optionalNumber(body.lat, "lat");
  const lng = optionalNumber(body.lng, "lng");
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;
  await query(
    "INSERT INTO investigation_locations(investigation_id,user_id,kind,lat,lng,accuracy) VALUES($1,$2,$3,$4,$5,$6)",
    [id, userId, kind, lat, lng, optionalNumber(body.accuracy, "accuracy")],
  );
  return true;
}

router.post(
  "/investigations/:id/location",
  withAuth(async (context, auth) => {
    const row = await findCase(context.params.id);
    assertWorker(row, auth);
    const body = await readJson(context.req);
    const kind = String(body.kind ?? "draft");
    if (!(LOCATION_KINDS as readonly string[]).includes(kind)) throw ApiError.badRequest("Unknown location kind");
    if (!(await saveLocation(row.investigation_id as string, auth.user.user_id, kind, body))) {
      throw ApiError.badRequest("lat and lng are required", { field: "lat" });
    }
    return created({ saved: true });
  }),
);

router.patch(
  "/investigations/:id/answers",
  withAuth(async (context, auth) => {
    const row = await findCase(context.params.id);
    assertWorker(row, auth);
    const body = await readJson(context.req);
    if (!row.started_at) await logEvent(row.investigation_id as string, "started", auth.user.user_id);
    // Drafts keep everything typed so far, but only for fields of this form.
    const keys = new Set(allFields(definitionOf(row.form_snapshot)).map((field) => field.key));
    const draft = Object.fromEntries(Object.entries(JSON.parse(answersOf(body))).filter(([key]) => keys.has(key)));
    await query(
      `UPDATE investigations SET answers=$2::text::jsonb, status='in_progress',
         started_at=COALESCE(started_at, now()), updated_at=now() WHERE investigation_id=$1`,
      [row.investigation_id, JSON.stringify(draft)],
    );
    return ok({ saved: true });
  }),
);

router.post(
  "/investigations/:id/images",
  withAuth(async (context, auth) => {
    const row = await findCase(context.params.id);
    assertWorker(row, auth);
    const form = await readFormData(context.req);
    const fieldKey = String(form.get("field_key") ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
    if (!fieldKey) throw ApiError.badRequest("field_key is required");
    const path = await saveImage(
      getFormFile(form, ["image"], "image"),
      row.investigation_id as string,
      "investigations",
      fieldKey,
      "visit photo",
    );
    const rows = await query(
      `INSERT INTO investigation_images(investigation_id,field_key,path,uploaded_by)
       VALUES($1,$2,$3,$4) RETURNING image_id, field_key, created_at`,
      [row.investigation_id, fieldKey, path, auth.user.user_id],
    );
    return created({ image: rows[0] });
  }),
);

router.get(
  "/investigations/:id/images/:image_id",
  withAuth(async (context, auth) => {
    const row = await findCase(context.params.id);
    await assertAccess(row, auth);
    const images = await query(
      "SELECT path FROM investigation_images WHERE image_id=$1 AND investigation_id=$2",
      [context.params.image_id, row.investigation_id],
    );
    if (!images[0]) throw ApiError.notFound("Image not found");
    const { bytes, contentType } = await readStoredFile(images[0].path as string);
    return new Response(new Uint8Array(bytes), {
      headers: { "Content-Type": contentType, "Cache-Control": "no-store" },
    });
  }),
);

router.delete(
  "/investigations/:id/images/:image_id",
  withAuth(async (context, auth) => {
    const row = await findCase(context.params.id);
    assertWorker(row, auth);
    const rows = await query(
      "DELETE FROM investigation_images WHERE image_id=$1 AND investigation_id=$2 RETURNING path",
      [context.params.image_id, row.investigation_id],
    );
    await deleteStoredFiles(rows.map((image) => image.path as string));
    return ok({ deleted: rows.length > 0 });
  }),
);

/**
 * At the start of every visit the app takes a selfie of the investigator and photos of both
 * sides of their own national ID; they are stored with the case under these keys.
 */
export const VISIT_PHOTOS = {
  visit_selfie: "صورة شخصية للمستعلم عند الزيارة",
  investigator_id_front: "بطاقة المستعلم — الوجه الأمامي",
  investigator_id_back: "بطاقة المستعلم — الوجه الخلفي",
} as const;
/** Cases accepted before the app asked for these photos are finished without them. */
const VISIT_PHOTOS_REQUIRED_FROM = new Date("2026-11-19T00:00:00+02:00");

async function assertVisitPhotos(row: Row): Promise<void> {
  const claimed = row.claimed_at ? new Date(row.claimed_at as string) : null;
  if (!claimed || claimed < VISIT_PHOTOS_REQUIRED_FROM) return;
  const present = await query(
    "SELECT DISTINCT field_key FROM investigation_images WHERE investigation_id=$1 AND field_key = ANY($2::text[])",
    [row.investigation_id, Object.keys(VISIT_PHOTOS)],
  );
  const have = new Set(present.map((image) => image.field_key as string));
  const missing = Object.entries(VISIT_PHOTOS).filter(([key]) => !have.has(key));
  if (missing.length) {
    throw new ApiError(
      400,
      "VISIT_PHOTOS_REQUIRED",
      "Take your selfie and both sides of your national ID before sending (update the app if it does not ask)",
      { details: missing.map(([key, label]) => ({ field: key, message: `${label} مطلوبة` })) },
    );
  }
}

router.post(
  "/investigations/:id/submit",
  withAuth(async (context, auth) => {
    const row = await findCase(context.params.id);
    assertWorker(row, auth);
    const body = await readJson(context.req);
    const definition = definitionOf(row.form_snapshot);
    const submitted = JSON.parse(answersOf(body)) as Record<string, unknown>;
    // Hidden or unknown answers never reach the report.
    const answers = JSON.stringify(cleanAnswers(definition, submitted));
    const negative = body.outcome === "negative";
    await assertVisitPhotos(row);
    let reasons: string[] = [];
    let note: string | null = null;
    let asked: string | null = null;
    if (negative) {
      // A negative report replaces the form: reasons from the list plus an explanation.
      reasons = Array.isArray(body.negative_reasons) ? [...new Set(body.negative_reasons.map(String))] : [];
      if (!reasons.length || reasons.some((reason) => !(NEGATIVE_REASONS as readonly string[]).includes(reason))) {
        throw ApiError.badRequest("Choose at least one reason from the list", { field: "negative_reasons" });
      }
      note = optionalText(body.negative_note, 2000);
      if (!note || note.length < 10) {
        throw ApiError.badRequest("Explain what happened in at least 10 characters", { field: "negative_note" });
      }
      asked = optionalText(body.negative_asked, 500);
      if (!asked || asked.length < 3) {
        throw ApiError.badRequest("Write whom you asked about the person", { field: "negative_asked" });
      }
      const [photos] = await query(
        "SELECT count(*)::int AS total FROM investigation_images WHERE investigation_id=$1 AND field_key=$2",
        [row.investigation_id, NEGATIVE_PHOTOS_KEY],
      );
      if (!Number(photos?.total ?? 0)) {
        throw new ApiError(400, "FORM_INCOMPLETE", "Take at least one photo of the place", {
          details: [{ field: NEGATIVE_PHOTOS_KEY, message: "صور المكان مطلوبة" }],
        });
      }
    } else {
      const lat = optionalNumber(body.lat, "lat");
      const lng = optionalNumber(body.lng, "lng");
      const issues = validateAnswers(
        definition,
        JSON.parse(answers),
        await evidenceFor(row, lat !== null && lng !== null ? { lat, lng } : null),
      );
      if (issues.length) {
        throw new ApiError(400, "FORM_INCOMPLETE", "Some answers are missing or not supported by evidence", {
          details: issues.map((issue) => ({ field: issue.key, message: issue.message })),
        });
      }
    }
    // The admin must know where the investigator was when the report was sent.
    if (!(await saveLocation(row.investigation_id as string, auth.user.user_id, "submitted", body))) {
      throw new ApiError(400, "LOCATION_REQUIRED", "Turn on location to submit the report", { details: { field: "lat" } });
    }
    await query(
      `UPDATE investigations SET answers=$2::text::jsonb, status='submitted', submitted_at=now(), submit_lat=$3,
         submit_lng=$4, review_note=NULL, outcome=$5, negative_reasons=$6::text::jsonb, negative_note=$7,
         negative_asked=$8, report_edited_at=NULL, updated_at=now() WHERE investigation_id=$1`,
      [
        row.investigation_id,
        answers,
        optionalNumber(body.lat, "lat"),
        optionalNumber(body.lng, "lng"),
        negative ? "negative" : "positive",
        negative ? JSON.stringify(reasons) : null,
        note,
        asked,
      ],
    );
    await recordAudit({
      event: "investigation.submitted",
      userId: auth.user.user_id,
      employeeNumber: auth.user.employee_number ?? null,
      success: true,
      context,
      metadata: { reference: row.reference },
    });
    // The report takes seconds; the investigator should not wait for it.
    // Filled without internet and sent by the app when it came back: the admin sees when.
    const filledOffline = typeof body.filled_offline_at === "string" ? new Date(body.filled_offline_at) : null;
    const offlineNote =
      filledOffline && !Number.isNaN(filledOffline.getTime()) && filledOffline.getTime() <= Date.now() + 60_000
        ? `عُبّئ دون إنترنت في ${filledOffline.toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })} وأُرسل عند عودة الاتصال`
        : null;
    await logEvent(
      row.investigation_id as string,
      row.submitted_at ? "resubmitted" : "submitted",
      auth.user.user_id,
      null,
      [negative ? "استعلام سلبي" : null, offlineNote].filter(Boolean).join(" — ") || null,
    );
    void buildReport(row.investigation_id as string);
    // This investigator may now be free for a waiting case.
    void resumeOpenCases();
    return ok({ status: "submitted" });
  }),
);

router.get(
  "/investigations/:id/pdf",
  withPermission(MANAGE, async (context) => {
    const row = await findCase(context.params.id);
    if (row.pdf_status !== "ready" || !row.pdf_path) throw ApiError.notFound("The report is not ready yet");
    const { bytes } = await readStoredFile(row.pdf_path as string);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${row.reference}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  }),
);
router.get(
  "/investigations/:id/report.docx",
  withPermission(MANAGE, async (context) => {
    const row = await findCase(context.params.id);
    if (row.pdf_status !== "ready" || !row.report_docx_path) throw ApiError.notFound("This report has no Word version");
    const { bytes } = await readStoredFile(row.report_docx_path as string);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${row.reference}.docx"`,
        "Cache-Control": "no-store",
      },
    });
  }),
);

/** What a reviewer should know before approving: gaps, unsupported statements, report notes. */
router.get(
  "/investigations/:id/check",
  withPermission(MANAGE, async (context) => {
    const row = await findCase(context.params.id);
    const definition = definitionOf(row.form_snapshot);
    const evidence = await evidenceFor(row);
    const issues = row.outcome === "negative" ? [] : validateAnswers(definition, row.answers as Record<string, unknown>, evidence);
    const [version] = row.template_version_id
      ? await query(
          `SELECT v.version_no, v.status, v.layout_mode, v.content_hash, t.title FROM template_versions v
           JOIN form_templates t ON t.template_id = v.template_id WHERE v.version_id = $1`,
          [row.template_version_id],
        )
      : [];
    return ok({
      issues,
      report_issues: row.report_issues ?? [],
      report_layout: row.report_layout,
      report_error: row.report_error,
      has_docx: Boolean(row.report_docx_path),
      edited: row.report_edited_at
        ? {
            at: row.report_edited_at,
            note: row.report_edited_note ?? null,
            by: ((await query("SELECT full_name FROM users WHERE user_id=$1", [row.report_edited_by]))[0]?.full_name as string) ?? null,
          }
        : null,
      template: version
        ? { ...version, matches: !row.template_hash || row.template_hash === version.content_hash }
        : { version_no: null, layout_mode: "standard", title: row.form_title, matches: true },
      evidence: { photos: evidence.photos, locations: evidence.locations.length },
    });
  }),
);

/**
 * The admin replaces the report with an edited file: a Word file (turned into the PDF too)
 * or a PDF (the Word version is then dropped, it would no longer match).
 */
router.post(
  "/investigations/:id/report",
  withPermission(MANAGE, async (context, auth) => {
    const row = await findCase(context.params.id);
    if (!row.submitted_at) throw ApiError.badRequest("This investigation has not been submitted");
    const form = await readFormData(context.req);
    const file = form.get("file");
    if (!(file instanceof File) || !file.size) throw ApiError.badRequest("Choose the edited PDF or Word file", { field: "file" });
    if (file.size > 25 * 1024 * 1024) throw ApiError.badRequest("The file must be at most 25 MB", { field: "file" });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const head = String.fromCharCode(...bytes.slice(0, 4));
    const isPdf = head === "%PDF";
    const isDocx = head.startsWith("PK") && /\.docx$/i.test(file.name || ".docx");
    if (!isPdf && !isDocx) throw ApiError.badRequest("Upload a PDF or a Word (.docx) file", { field: "file" });
    const note = optionalText(form.get("note"), 500);
    const stamp = Date.now();
    let pdf: Uint8Array;
    let docxPath: string | null = null;
    let pages: number | null = null;
    let engine = "upload";
    if (isDocx) {
      try {
        const converted = await docxToPdf(bytes);
        pdf = converted.bytes;
        pages = converted.pages;
        engine = converted.engine;
      } catch (error) {
        if (error instanceof ConverterUnavailable) {
          throw new ApiError(503, "CONVERTER_UNAVAILABLE", "Word files cannot be turned into PDF on the server right now; upload the PDF instead");
        }
        throw error;
      }
      docxPath = await storeReportFile(row.investigation_id as string, `report-edited-${stamp}.docx`, bytes);
    } else {
      pdf = bytes;
      try {
        pages = countPdfPages(bytes);
      } catch {
        pages = null;
      }
    }
    const pdfPath = await storeReportFile(row.investigation_id as string, `report-edited-${stamp}.pdf`, pdf);
    await query(
      `UPDATE investigations SET pdf_status='ready', pdf_path=$2, report_docx_path=$3, report_pages=$4, report_engine=$5,
         report_error=NULL, report_edited_at=now(), report_edited_by=$6, report_edited_note=$7, updated_at=now()
       WHERE investigation_id=$1`,
      [row.investigation_id, pdfPath, docxPath, pages, engine, auth.user.user_id, note],
    );
    await logEvent(row.investigation_id as string, "report_edited", null, auth.user.user_id, note ?? (isPdf ? "PDF" : "Word"));
    await recordAudit({
      event: "investigation.report_edited",
      userId: auth.user.user_id,
      employeeNumber: auth.user.employee_number ?? null,
      success: true,
      context,
      metadata: { reference: row.reference, kind: isPdf ? "pdf" : "docx", note },
    });
    return ok({ pdf_status: "ready", kind: isPdf ? "pdf" : "docx" });
  }),
);

router.post(
  "/investigations/:id/pdf",
  withPermission(MANAGE, async (context) => {
    const row = await findCase(context.params.id);
    if (!row.submitted_at) throw ApiError.badRequest("This investigation has not been submitted");
    void buildReport(row.investigation_id as string);
    return ok({ pdf_status: "generating" });
  }),
);

function reviewRoute(path: string, status: string, event: string, from: string[], noteRequired = false) {
  router.post(
    `/investigations/:id/${path}`,
    withPermission(MANAGE, async (context, auth) => {
      const body = await readJson(context.req);
      const note = noteRequired ? requiredText(body.note, "note", 1000) : optionalText(body.note, 1000);
      const rows = await query(
        `UPDATE investigations SET status=$2, review_note=$3, reviewed_at=now(), reviewed_by=$4, updated_at=now(),
           return_count = return_count + CASE WHEN $2 = 'returned' THEN 1 ELSE 0 END
         WHERE investigation_id=$1 AND status = ANY($5::text[]) RETURNING reference, assignee_id`,
        [context.params.id, status, note, auth.user.user_id, `{${from.join(",")}}`],
      );
      if (!rows[0]) throw new ApiError(409, "INVALID_STATUS_TRANSITION", "This action is not available now");
      await recordAudit({
        event: event as never,
        actorId: auth.user.user_id,
        success: true,
        context,
        metadata: { reference: rows[0].reference },
      });
      await logEvent(context.params.id ?? "", status, null, auth.user.user_id, note);
      const told = {
        approved: { title: "اعتُمد تقريرك", body: `اعتمدت الإدارة تقرير الاستعلام ${rows[0].reference}.` },
        returned: { title: "أُعيد إليك تقرير للتعديل", body: `${rows[0].reference}: ${note ?? "راجع ملاحظة المراجع"}` },
        cancelled: { title: "أُلغي استعلام", body: `ألغت الإدارة الاستعلام ${rows[0].reference}.` },
      }[status];
      if (told && rows[0].assignee_id) {
        await notify(rows[0].assignee_id as string, {
          kind: status as "approved" | "returned" | "cancelled",
          ...told,
          investigation_id: context.params.id ?? null,
        });
      }
      // The approved report carries the reviewer's name and the Golden Pay stamp.
      if (status === "approved") {
        const [edited] = await query("SELECT report_edited_at FROM investigations WHERE investigation_id=$1", [context.params.id]);
        if (!edited?.report_edited_at) void buildReport(context.params.id ?? "");
      }
      // The fairness ledger: an approved case is completed work; a cancelled one stops
      // counting only if the investigator had not started it.
      if (status === "approved") await endAssignment(context.params.id ?? "", "completed", auth.user.user_id);
      if (status === "cancelled") await endAssignment(context.params.id ?? "", "cancelled", auth.user.user_id, note);
      if (status === "cancelled") {
        await query(
          "UPDATE investigation_offers SET response='cancelled', responded_at=now() WHERE investigation_id=$1 AND response IS NULL",
          [context.params.id],
        );
      }
      return ok({ status });
    }),
  );
}
reviewRoute("approve", "approved", "investigation.approved", ["submitted"]);
reviewRoute("return", "returned", "investigation.returned", ["submitted"], true);
reviewRoute("cancel", "cancelled", "investigation.cancelled", ["open", "unassigned", "assigned", "in_progress", "returned"]);

await startService({
  name: "golden-pay-investigations",
  port: Number(process.env.INVESTIGATIONS_PORT ?? 4004),
  router,
  schema: join(import.meta.dir, "schema.sql"),
  healthPrefix: "/investigations",
  seed: seedServiceLevels,
});
startDispatcher();
startIntake(intakeDeps);
