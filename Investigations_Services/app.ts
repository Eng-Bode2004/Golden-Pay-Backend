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
import { logEvent, offerNext, resumeOpenCases, startDispatcher, TIER_LABELS } from "./dispatch.ts";
import { LOCATION_KINDS, NEGATIVE_REASONS } from "./outcome.ts";
import { renderStandardPdf } from "./pdf.ts";
import { storeReportFile } from "./reports.ts";
import { ConverterUnavailable } from "../Shared/templates/convert.ts";
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

    if (version?.layout_mode === "docx" && version.layout_path && row.outcome !== "negative") {
      try {
        const imageBytes: Record<string, { bytes: Uint8Array }[]> = {};
        for (const image of images) {
          const { bytes } = await readStoredFile(image.path as string);
          (imageBytes[image.field_key as string] ??= []).push({ bytes: new Uint8Array(bytes) });
        }
        const { bytes: layoutBytes } = await readStoredFile(version.layout_path as string);
        const report = await renderDocxReport({
          layout: new Uint8Array(layoutBytes),
          bindings: version.bindings as Binding[],
          slots: (version.slots as { anchor: string; kind: string }[] | null) ?? null,
          definition,
          answers: row.answers as Record<string, unknown>,
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
    } else if (version?.layout_mode === "docx" && row.outcome === "negative") {
      note = "استعلام سلبي: يُطبع بالتصميم الموحّد مع أسباب عدم العثور على الشخص.";
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
        negative_note: row.negative_note as string | null,
        trail: trail as never,
        evidence,
        approved,
      });
    }
    const path = await storeReportFile(id, "report.pdf", pdf);
    const docxPath = docx ? await storeReportFile(id, "report.docx", docx) : null;
    await query(
      `UPDATE investigations SET pdf_status='ready', pdf_path=$2, report_docx_path=$3, report_layout=$4, report_engine=$5,
         report_pages=$6, report_issues=$7::text::jsonb, report_error=$8, report_built_at=now() WHERE investigation_id=$1`,
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
    const { investigators } = await sibling<{ investigators: { user_id: string }[] }>(
      INVESTIGATORS_URL,
      "/investigators/match",
      context,
      { method: "POST", body: JSON.stringify(area ?? {}) },
    );
    recipients = investigators.map((person) => person.user_id);
    if (!recipients.length) {
      throw new ApiError(409, "NO_INVESTIGATORS_IN_AREA", "No available investigator works in this area");
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
  const money = (field: string, fallback: unknown) => {
    const value = optionalNumber(body[field], field);
    if (value !== null && value < 0) throw ApiError.badRequest(`${field} cannot be negative`, { field });
    return value ?? Number(fallback);
  };

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
        ...AREA_LEVELS.map((level) => optionalText(body[level], 120)),
        optionalText(body.landmark, 300),
        optionalNumber(body.lat, "lat"),
        optionalNumber(body.lng, "lng"),
        optionalText(body.admin_notes, 2000),
        template.client_id,
        template.client_name,
        template.template_id,
        template.title,
        JSON.stringify(template.definition),
        auth.user.user_id,
        null,
        level.code,
        level.name_ar,
        money("client_price", level.client_price),
        money("investigator_price", level.investigator_price),
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
    await logEvent(id, "created", null, auth.user.user_id);
  });
  await offerNext(id);
  await recordAudit({
    event: "investigation.created",
    actorId: auth.user.user_id,
    success: true,
    context,
    metadata: { reference, target_mode: mode, recipients: recipients.length, template_version: template.version_no },
  });
  return created({ investigation_id: id, reference, recipients: recipients.length });
}

async function listAll(context: RequestContext): Promise<Response> {
  const status = context.url.searchParams.get("status");
  const search = context.url.searchParams.get("search")?.trim();
  const rows = await query(
    `SELECT ${LIST_COLUMNS}, i.client_price::float8 AS client_price, (SELECT count(*)::int FROM investigation_recipients r
        WHERE r.investigation_id = i.investigation_id) AS recipients,
       o.expires_at AS offer_expires_at, ou.full_name AS offered_to
     FROM investigations i LEFT JOIN users u ON u.user_id = i.assignee_id
     LEFT JOIN investigation_offers o ON o.investigation_id = i.investigation_id AND o.response IS NULL
     LEFT JOIN users ou ON ou.user_id = o.user_id
     WHERE ($1::text IS NULL OR i.status = $1)
       AND ($2::text IS NULL OR i.subject_name ILIKE '%'||$2||'%' OR i.reference ILIKE '%'||$2||'%')
     ORDER BY i.created_at DESC LIMIT 200`,
    [status || null, search || null],
  );
  const counts = await query("SELECT status, count(*)::int AS total FROM investigations GROUP BY status");
  return ok({
    investigations: rows,
    counts: Object.fromEntries(counts.map((row) => [row.status, row.total])),
  });
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
router.get("/investigations", withPermission(MANAGE, listAll));
router.post("/investigations", withPermission(MANAGE, createInvestigation));

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
    return ok({
      investigation: {
        ...withImages(row, await imagesOf(row.investigation_id), manager),
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
    const reason = optionalText(body.reason, 300);
    const rows = await query(
      `UPDATE investigation_offers SET response='declined', responded_at=now(), reason=$3,
         seen_at=COALESCE(seen_at, now())
       WHERE investigation_id=$1 AND user_id=$2 AND response IS NULL RETURNING offer_id`,
      [context.params.id, auth.user.user_id, reason],
    );
    if (!rows.length) throw new ApiError(409, "OFFER_CLOSED", "This offer is no longer open");
    await logEvent(context.params.id ?? "", "declined", auth.user.user_id, null, reason);
    await offerNext(context.params.id ?? "");
    return ok({ declined: true });
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
    const [pending] = await query(
      "SELECT tier FROM investigation_offers WHERE investigation_id=$1 AND user_id=$2 AND response IS NULL",
      [context.params.id, auth.user.user_id],
    );
    if (pending && pending.tier !== 6) {
      const working = await query(
        "SELECT reference FROM investigations WHERE assignee_id=$1 AND status IN ('assigned','in_progress','returned') LIMIT 1",
        [auth.user.user_id],
      );
      if (working.length) {
        throw new ApiError(409, "INVESTIGATOR_BUSY", "Finish your current investigation before accepting another", {
          details: { reference: working[0]!.reference },
        });
      }
    }
    const body = await readJson(context.req).catch(() => ({}) as Row);
    const rows = await transaction(async () => {
      const offer = await query(
        `UPDATE investigation_offers SET response='accepted', responded_at=now(), seen_at=COALESCE(seen_at, now())
         WHERE investigation_id=$1 AND user_id=$2 AND response IS NULL AND expires_at > now() RETURNING offer_id`,
        [context.params.id, auth.user.user_id],
      );
      if (!offer.length) return [];
      return query(
        `UPDATE investigations SET status='assigned', assignee_id=$2, claimed_at=now(), updated_at=now()
         WHERE investigation_id=$1 AND status='open' RETURNING investigation_id`,
        [context.params.id, auth.user.user_id],
      );
    });
    if (!rows[0]) throw new ApiError(409, "INVESTIGATION_TAKEN", "This offer has expired or moved to another investigator");
    await logEvent(context.params.id ?? "", "accepted", auth.user.user_id);
    await saveLocation(context.params.id ?? "", auth.user.user_id, "accepted", body);
    // Now busy: other offers this investigator holds go to someone free.
    const released = await query(
      `UPDATE investigation_offers SET response='cancelled', responded_at=now()
       WHERE user_id=$1 AND response IS NULL AND tier <> 6 AND investigation_id <> $2 RETURNING investigation_id`,
      [auth.user.user_id, context.params.id],
    );
    for (const offer of released) await offerNext(offer.investigation_id as string);
    await recordAudit({
      event: "investigation.claimed",
      userId: auth.user.user_id,
      success: true,
      context,
      metadata: { investigation_id: context.params.id },
    });
    return ok({ investigation_id: rows[0].investigation_id, status: "assigned" });
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
    let reasons: string[] = [];
    let note: string | null = null;
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
         updated_at=now() WHERE investigation_id=$1`,
      [
        row.investigation_id,
        answers,
        optionalNumber(body.lat, "lat"),
        optionalNumber(body.lng, "lng"),
        negative ? "negative" : "positive",
        negative ? JSON.stringify(reasons) : null,
        note,
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
    await logEvent(
      row.investigation_id as string,
      row.submitted_at ? "resubmitted" : "submitted",
      auth.user.user_id,
      null,
      negative ? "استعلام سلبي" : null,
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
      template: version
        ? { ...version, matches: !row.template_hash || row.template_hash === version.content_hash }
        : { version_no: null, layout_mode: "standard", title: row.form_title, matches: true },
      evidence: { photos: evidence.photos, locations: evidence.locations.length },
    });
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
         WHERE investigation_id=$1 AND status = ANY($5::text[]) RETURNING reference`,
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
      // The approved report carries the reviewer's name and the Golden Pay stamp.
      if (status === "approved") void buildReport(context.params.id ?? "");
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
