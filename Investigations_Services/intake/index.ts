import { query } from "../../IdentityAcess_Services/Config/db.ts";
import { withPermission } from "../../IdentityAcess_Services/MIddlewares/auth.middleware.ts";
import { recordAudit } from "../../IdentityAcess_Services/Services/audit.service.ts";
import { PERMISSIONS } from "../../IdentityAcess_Services/Services/rbac.service.ts";
import { getStoredFile } from "../../IdentityAcess_Services/Utils/files.ts";
import { ApiError, ok, readJson } from "../../IdentityAcess_Services/Utils/http.ts";
import type { Router } from "../../IdentityAcess_Services/Utils/router.ts";
import { optionalText, requiredText } from "../../Shared/service.ts";
import { aiConfigured, AI_MODEL } from "./ai.ts";
import { runSystemCheck } from "./check.ts";
import { configuredInboxes, pollAll, refetchMessage, sendFromInbox } from "./inbox.ts";
import { loadProfiles, placeOfAddress, processMessage } from "./process.ts";
import { setupClients } from "./setup.ts";
import {
  APPOINTMENT_NEEDED,
  domainMatches,
  findNationalId,
  KIND_LABELS,
  KNOWLEDGE_LABELS,
  safeInlineType,
  sendTime,
  type CaseKind,
  type CustomerKnowledge,
} from "./rules.ts";

type Row = Record<string, unknown>;
const MANAGE = PERMISSIONS.INVESTIGATIONS_MANAGE;
const KINDS = Object.keys(KIND_LABELS) as CaseKind[];

export interface IntakeDeps {
  activeTemplate: (templateId: string) => Promise<Row>;
  insertCase: (
    body: Row,
    template: Row,
    actorId: string,
    match: (filter: Row) => Promise<string[]>,
    extra?: { source?: string; mailCaseId?: string | null },
  ) => Promise<{ investigation_id: string; reference: string; recipients: number }>;
  matchInvestigators: (filter: Row) => Promise<Row[]>;
}

// ───────────── sending cases out ─────────────

const cairoTime = (at: Date) =>
  at.toLocaleString("ar-EG", { timeZone: "Africa/Cairo", dateStyle: "full", timeStyle: "short" });

/**
 * Creates the investigation for one ready case and offers it to the area's investigators.
 * District first; when nobody covers the district, the whole governorate.
 */
async function release(caseId: string, deps: IntakeDeps): Promise<{ ok: boolean; reason?: string }> {
  const [item] = await query(
    `UPDATE mail_cases SET status='sending', updated_at=now() WHERE case_id=$1 AND status='ready' RETURNING *`,
    [caseId],
  );
  if (!item) return { ok: false, reason: "not ready" };
  const alreadyCreated = async () => {
    const [existing] = await query("SELECT investigation_id FROM investigations WHERE mail_case_id=$1 LIMIT 1", [caseId]);
    if (!existing) return false;
    await query("UPDATE mail_cases SET status='sent', investigation_id=$2, reason=NULL, updated_at=now() WHERE case_id=$1", [
      caseId,
      existing.investigation_id,
    ]);
    return true;
  };
  try {
    // A retry after a crash or a double click never creates a second investigation.
    if (await alreadyCreated()) return { ok: true };
    const profile = (await loadProfiles()).find((p) => p.client_id === item.client_id);
    if (!profile) throw new Error("لم تعد هذه الجهة مضبوطة لاستقبال البريد");
    const templateId = (item.template_id as string | null) ?? profile.templates[item.kind as CaseKind];
    if (!templateId) throw new Error(`لا يوجد نموذج «${KIND_LABELS[item.kind as CaseKind] ?? item.kind}» لهذه الجهة`);
    const template = await deps.activeTemplate(templateId);
    const f = item.fields as Row;
    const [message] = await query("SELECT inbox, from_address, subject, received_at FROM mail_messages WHERE message_id=$1", [
      item.message_id,
    ]);
    const knowledge = (item.knowledge as CustomerKnowledge | null) ?? null;
    const appointment = item.appointment_at ? new Date(item.appointment_at as string) : null;
    const notes = [
      knowledge ? KNOWLEDGE_LABELS[knowledge] : null,
      appointment ? `موعد الزيارة المتفق عليه مع العميل: ${cairoTime(appointment)}` : null,
      f.national_id ? `الرقم القومي: ${f.national_id}` : null,
      f.notes as string | null,
      `وارد بالبريد (${message?.inbox ?? ""}) من ${message?.from_address ?? ""}: ${message?.subject ?? ""}`,
    ]
      .filter(Boolean)
      .join("\n");
    // Sent to a chosen investigator, or to everyone in the area.
    const targets: Row[] = item.assignee_id
      ? [{ target_mode: "person", assignee_id: item.assignee_id }]
      : ([
          f.district ? { target_mode: "area", area: { mode: "hierarchy", governorate: f.governorate, district: f.district } } : null,
          { target_mode: "area", area: { mode: "hierarchy", governorate: f.governorate } },
        ].filter(Boolean) as Row[]);
    let created: { investigation_id: string; reference: string } | null = null;
    let lastError: unknown = null;
    for (const target of targets) {
      try {
        created = await deps.insertCase(
          {
            ...target,
            subject_name: f.subject_name,
            subject_phone: f.phone,
            client_reference: f.client_reference ?? f.national_id ?? null,
            address: f.address,
            governorate: f.governorate,
            district: f.district,
            admin_notes: notes.slice(0, 2000),
            // The client's normal or fast price; an agreed appointment only moves the deadline.
            service_level: item.fast ? profile.fast_level : profile.normal_level,
            scheduled_at: appointment?.toISOString() ?? null,
            customer_knowledge: knowledge,
          },
          template,
          (item.reviewed_by as string | null) ?? "system",
          async (filter) => (await deps.matchInvestigators(filter)).map((person) => person.user_id as string),
          { source: "email", mailCaseId: caseId },
        );
        break;
      } catch (error) {
        lastError = error;
        if (!(error instanceof ApiError && error.code === "NO_INVESTIGATORS_IN_AREA")) throw error;
      }
    }
    if (!created) {
      const where = [f.governorate, f.district].filter(Boolean).join(" - ");
      throw lastError instanceof ApiError && lastError.code === "NO_INVESTIGATORS_IN_AREA"
        ? new Error(`لا يوجد مستعلم يعمل لهذه الجهة في ${where}`)
        : lastError;
    }
    await query("UPDATE mail_cases SET status='sent', investigation_id=$2, reason=NULL, updated_at=now() WHERE case_id=$1", [
      caseId,
      created.investigation_id,
    ]);
    return { ok: true };
  } catch (error) {
    // Saved, then offering it failed: the case exists, so it must not be offered for a retry.
    if (await alreadyCreated()) return { ok: true };
    const reason =
      error instanceof ApiError && error.code === "TEMPLATE_NOT_ACTIVE"
        ? "النموذج غير مفعّل: اختر نموذجًا آخر أو فعّله من الإدارة العليا"
        : (error instanceof Error ? error.message : String(error)).slice(0, 500);
    await query("UPDATE mail_cases SET status='failed', reason=$2, updated_at=now() WHERE case_id=$1", [caseId, reason]);
    return { ok: false, reason };
  }
}

let ticking = false;
let lastRun: Date | null = null;
async function tick(deps: IntakeDeps): Promise<void> {
  if (ticking) return;
  ticking = true;
  lastRun = new Date();
  // What is due goes out first and between readings: a slow AI reading never holds back 08:00.
  const releaseDue = async () => {
    const due = await query("SELECT case_id FROM mail_cases WHERE status='ready' AND release_at <= now() ORDER BY release_at LIMIT 50");
    for (const row of due) await release(row.case_id as string, deps);
  };
  try {
    await releaseDue();
    await pollAll();
    // Read what arrived (one at a time: the AI reader is the slow part).
    const fresh = await query(
      `SELECT message_id, raw_path FROM mail_messages
       WHERE status='new' OR (status='failed' AND retry_at <= now())
       ORDER BY (status='new') DESC, received_at LIMIT 20`,
    );
    for (const row of fresh) {
      if (row.raw_path || (await refetchMessage(row.message_id as string))) await processMessage(row.message_id as string);
      lastRun = new Date();
      await releaseDue();
    }
    // A worker that stopped mid-send leaves 'sending' rows: give them back after 10 minutes.
    await query("UPDATE mail_cases SET status='ready' WHERE status='sending' AND updated_at < now() - interval '10 minutes'");
    await query("UPDATE mail_messages SET status='new' WHERE status='processing' AND COALESCE(processing_since, created_at) < now() - interval '15 minutes'");
  } catch (error) {
    console.error(JSON.stringify({ level: "error", message: "mail.tick_failed", error: error instanceof Error ? error.message : String(error) }));
  } finally {
    ticking = false;
  }
}

/** Starts the intake loop when at least one inbox is configured (MAIL_INBOXES + credentials). */
export function startIntake(deps: IntakeDeps): void {
  if (process.env.MAIL_INTAKE === "off") return;
  const inboxes = configuredInboxes();
  // Without inboxes the loop still sends cases an administrator approved by hand.
  const seconds = Math.max(30, Number(process.env.MAIL_POLL_SECONDS || 60));
  console.log(JSON.stringify({ level: "info", message: "mail.intake_started", inboxes: inboxes.map((i) => i.name), every_seconds: seconds, ai: aiConfigured() }));
  setTimeout(() => void tick(deps), 15_000);
  setInterval(() => void tick(deps), seconds * 1000);
}

// ───────────── routes ─────────────

const CASE_FIELDS = ["subject_name", "national_id", "phone", "address", "home_address", "work_address", "company", "governorate", "district", "client_reference", "notes"] as const;

function cleanFields(input: unknown, current: Row): Row {
  const body = (input && typeof input === "object" ? input : {}) as Row;
  const out: Row = { ...current };
  for (const key of CASE_FIELDS) {
    if (key in body) out[key] = optionalText(body[key], key === "notes" ? 2000 : 400);
  }
  return out;
}

/** An appointment typed by an administrator: a real time, from now to 60 days ahead. */
function appointmentOf(value: unknown): Date | null {
  if (value === null || value === "") return null;
  const at = new Date(String(value));
  if (Number.isNaN(at.getTime())) throw ApiError.badRequest("موعد غير صحيح", { field: "appointment_at" });
  if (at.getTime() < Date.now() - 5 * 60_000) throw ApiError.badRequest("الموعد في الماضي", { field: "appointment_at" });
  if (at.getTime() > Date.now() + 60 * 86_400_000) throw ApiError.badRequest("الموعد بعد أكثر من 60 يومًا", { field: "appointment_at" });
  return at;
}

/** A reason list («، »-joined) without one of its reasons. */
export function dropReason(reasons: string | null, drop: string): string | null {
  const kept = (reasons ?? "").split("، ").filter((reason) => reason && reason !== drop);
  return kept.length ? kept.join("، ") : null;
}

/** The companies and banks an administrator chose (?clients=a,b); null shows all. */
function chosenClients(params: URLSearchParams): string[] | null {
  const ids = (params.get("clients") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, 100);
  return ids.length ? ids : null;
}

/** What still stops a case from going out, in Arabic (empty: it can go). */
async function blockers(item: Row): Promise<string[]> {
  const f = item.fields as Row;
  const out: string[] = [];
  if (!f.subject_name) out.push("لا يوجد اسم");
  if (!f.address) out.push("لا يوجد عنوان");
  if (!f.governorate) out.push("المحافظة غير معروفة");
  if (item.knowledge === "with" && !item.appointment_at) out.push("حدد موعد الزيارة بعد الاتصال بالعميل");
  const profile = (await loadProfiles()).find((p) => p.client_id === item.client_id);
  if (!profile) out.push("الجهة غير مضبوطة");
  else if (item.template_id) return out;
  else if (!item.kind) out.push("نوع الاستعلام غير محدد");
  else if (!profile.templates[item.kind as CaseKind]) out.push(`لا يوجد نموذج «${KIND_LABELS[item.kind as CaseKind]}» لهذه الجهة`);
  return out;
}

/** An email waiting as «unknown sender» is read once its domain is linked (older ones go to review). */
async function requeueUnknown(domains: string[]): Promise<number> {
  if (!domains.length) return 0;
  const waiting = await query(
    `UPDATE mail_messages SET status='new'
     WHERE status='unknown_sender' AND received_at > now() - interval '3 days'
       AND EXISTS (SELECT 1 FROM unnest($1::text[]) d WHERE from_domain = d OR from_domain LIKE '%.' || d)
     RETURNING message_id`,
    [domains],
  );
  return waiting.length;
}

async function assertClientForm(templateId: string, clientId: string): Promise<void> {
  const [form] = await query("SELECT client_id FROM form_templates WHERE template_id=$1", [templateId]);
  if (!form || form.client_id !== clientId) throw ApiError.badRequest("النموذج ليس لهذه الجهة", { field: "template_id" });
}

export function registerIntakeRoutes(router: Router, deps: IntakeDeps): void {
  router.get(
    "/investigations/intake/overview",
    withPermission(MANAGE, async (context) => {
      const configured = configuredInboxes().map((inbox) => inbox.name);
      const clients = chosenClients(context.url.searchParams);
      const [states, counts, unknown, today, linked] = await Promise.all([
        query("SELECT inbox, last_poll_at, last_ok_at, last_error FROM mail_inbox_state ORDER BY inbox"),
        query(
          `SELECT status, count(*)::int AS count, min(release_at) AS next_release FROM mail_cases
           WHERE status IN ('review','ready','failed','sending') AND ($1::text[] IS NULL OR client_id = ANY($1))
           GROUP BY status`,
          [clients],
        ),
        query(
          `SELECT from_domain AS domain, count(*)::int AS count, max(received_at) AS last_at,
             (array_agg(subject ORDER BY received_at DESC))[1] AS last_subject
           FROM mail_messages WHERE status='unknown_sender' AND from_domain IS NOT NULL
           GROUP BY from_domain ORDER BY count(*) DESC LIMIT 30`,
        ),
        query(
          `SELECT count(*)::int AS received,
             count(*) FILTER (WHERE status IN ('cases','review'))::int AS requests,
             count(*) FILTER (WHERE ai_used)::int AS ai_read
           FROM mail_messages WHERE received_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'Africa/Cairo'
             AND ($1::text[] IS NULL OR client_id = ANY($1))`,
          [clients],
        ),
        // The filter's list: every linked company and bank, with what waits for review there.
        query(
          `SELECT p.client_id, c.name, c.client_type,
             (SELECT count(*)::int FROM mail_cases x WHERE x.client_id = p.client_id) AS total,
             (SELECT count(*)::int FROM mail_cases x WHERE x.client_id = p.client_id AND x.status IN ('review','failed')) AS to_review
           FROM mail_client_profiles p JOIN form_clients c ON c.client_id = p.client_id ORDER BY c.name`,
        ),
      ]);
      const sentToday = await query(
        `SELECT count(*)::int AS count FROM mail_cases WHERE status='sent'
           AND updated_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'Africa/Cairo'
           AND ($1::text[] IS NULL OR client_id = ANY($1))`,
        [clients],
      );
      const [attention] = await query(
        `SELECT count(*)::int AS count FROM mail_messages m
         WHERE m.status IN ('review','failed') AND NOT EXISTS (SELECT 1 FROM mail_cases n WHERE n.message_id = m.message_id)
           AND ($1::text[] IS NULL OR m.client_id = ANY($1))`,
        [clients],
      );
      return ok({
        attention: attention?.count ?? 0,
        inboxes: [...new Set([...configured, ...states.map((s) => s.inbox as string)])].map((name) => ({
          name,
          configured: configured.includes(name),
          ...(states.find((s) => s.inbox === name) ?? {}),
        })),
        ai: { configured: aiConfigured(), model: AI_MODEL },
        intake_off: process.env.MAIL_INTAKE === "off",
        cases: Object.fromEntries(counts.map((c) => [c.status, { count: c.count, next_release: c.next_release }])),
        today: { ...(today[0] ?? {}), sent: sentToday[0]?.count ?? 0 },
        unknown_domains: unknown,
        clients: linked,
        rule: "من 8 صباحًا إلى 4 مساءً تُرسل فورًا، ومن 4 مساءً إلى 8 صباحًا تُجدول للساعة 8 صباحًا",
      });
    }),
  );

  /** The whole chain tested on the server: nothing is sent, created or notified. */
  router.post(
    "/investigations/intake/check",
    withPermission(MANAGE, async () =>
      ok(
        await runSystemCheck({
          activeTemplate: deps.activeTemplate,
          matchInvestigators: deps.matchInvestigators,
          loopRanAt: () => lastRun,
        }),
      ),
    ),
  );

  /** Links every client at once from the private list the administrator uploads. */
  router.post(
    "/investigations/intake/setup",
    withPermission(MANAGE, async (context, auth) => {
      const body = await readJson(context.req);
      const { results, domains } = await setupClients(body.clients, body.auto_send === true, body.two_visits === true, auth.user.user_id);
      const requeued = await requeueUnknown(domains);
      await recordAudit({
        event: "mail.profile_updated",
        actorId: auth.user.user_id,
        success: true,
        context,
        metadata: { setup: results.filter((item) => item.linked).map((item) => item.client), auto_send: body.auto_send === true },
      });
      return ok({ results, requeued });
    }),
  );

  router.get(
    "/investigations/intake/messages",
    withPermission(MANAGE, async (context) => {
      const params = context.url.searchParams;
      const status = params.get("status");
      const search = params.get("search")?.trim();
      const rows = await query(
        `SELECT m.message_id, m.inbox, m.from_address, m.from_name, m.from_domain, m.subject, m.received_at, m.status,
           m.reason, m.ai_used, m.client_id, c.name AS client_name, jsonb_array_length(m.attachments)::int AS attachments,
           (SELECT count(*)::int FROM mail_cases x WHERE x.message_id = m.message_id) AS cases,
           (SELECT count(*)::int FROM mail_cases x WHERE x.message_id = m.message_id AND x.status IN ('review','failed')) AS waiting
         FROM mail_messages m LEFT JOIN form_clients c ON c.client_id = m.client_id
         WHERE ($1::text IS NULL OR m.status = $1
             OR ($1 = 'attention' AND m.status IN ('review','failed')
                 AND NOT EXISTS (SELECT 1 FROM mail_cases n WHERE n.message_id = m.message_id)))
           AND ($2::text IS NULL OR m.subject ILIKE '%' || $2 || '%' OR m.from_address ILIKE '%' || $2 || '%')
           AND ($3::text[] IS NULL OR m.client_id = ANY($3))
         ORDER BY m.received_at DESC LIMIT 200`,
        [status || null, search || null, chosenClients(params)],
      );
      return ok({ messages: rows });
    }),
  );

  router.get(
    "/investigations/intake/messages/:message_id",
    withPermission(MANAGE, async (context) => {
      const [message] = await query(
        `SELECT m.*, c.name AS client_name FROM mail_messages m LEFT JOIN form_clients c ON c.client_id = m.client_id
         WHERE m.message_id=$1`,
        [context.params.message_id],
      );
      if (!message) throw ApiError.notFound("Email not found");
      const cases = await query(
        `SELECT x.*, i.reference, i.status AS investigation_status FROM mail_cases x
         LEFT JOIN investigations i ON i.investigation_id = x.investigation_id
         WHERE x.message_id=$1 ORDER BY x.created_at`,
        [context.params.message_id],
      );
      const { raw_path: _raw, ...rest } = message;
      return ok({ message: rest, cases });
    }),
  );

  router.get(
    "/investigations/intake/messages/:message_id/files/:index",
    withPermission(MANAGE, async (context) => {
      const [message] = await query("SELECT attachments FROM mail_messages WHERE message_id=$1", [context.params.message_id]);
      const file = ((message?.attachments as Row[]) ?? []).find((a) => String(a.index) === context.params.index);
      if (!file) throw ApiError.notFound("Attachment not found");
      const bytes = await getStoredFile(file.path as string);
      // Anyone can email us: HTML or SVG shown in the dashboard's origin could take the admin's session.
      const shown = safeInlineType(String(file.type ?? ""));
      return new Response(bytes as unknown as BodyInit, {
        headers: {
          "Content-Type": shown ?? "application/octet-stream",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "sandbox; default-src 'none'",
          "Content-Disposition": `${shown ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name as string)}`,
          "Cache-Control": "private, max-age=300",
        },
      });
    }),
  );

  router.post(
    "/investigations/intake/messages/:message_id/reprocess",
    withPermission(MANAGE, async (context) => {
      const id = context.params.message_id ?? "";
      const [row] = await query("UPDATE mail_messages SET attempts=0 WHERE message_id=$1 RETURNING raw_path", [id]);
      if (!row) throw ApiError.notFound("Email not found");
      if (!row.raw_path && !(await refetchMessage(id))) {
        const [after] = await query("SELECT status, reason FROM mail_messages WHERE message_id=$1", [id]);
        return ok({ status: after?.status, reason: after?.reason, cases: 0 });
      }
      return ok(await processMessage(id));
    }),
  );

  router.post(
    "/investigations/intake/messages/:message_id/ignore",
    withPermission(MANAGE, async (context, auth) => {
      const body = await readJson(context.req).catch(() => ({}) as Row);
      await query("UPDATE mail_messages SET status='ignored', reason=$2, retry_at=NULL WHERE message_id=$1", [
        context.params.message_id,
        optionalText(body.reason, 300) ?? "تجاهلها مسؤول",
      ]);
      await query("UPDATE mail_cases SET status='rejected', reviewed_by=$2, reviewed_at=now() WHERE message_id=$1 AND status IN ('review','ready','failed')", [
        context.params.message_id,
        auth.user.user_id,
      ]);
      return ok({ ignored: true });
    }),
  );

  /** The manual way when reading fails: a person typed in from the email. */
  router.post(
    "/investigations/intake/messages/:message_id/cases",
    withPermission(MANAGE, async (context, auth) => {
      const [message] = await query("SELECT message_id, subject, from_domain, client_id, status FROM mail_messages WHERE message_id=$1", [
        context.params.message_id,
      ]);
      if (!message) throw ApiError.notFound("Email not found");
      if (message.status === "processing") throw new ApiError(409, "INVALID_STATUS_TRANSITION", "البريد تتم قراءته الآن");
      const profile = (await loadProfiles()).find((item) =>
        message.client_id ? item.client_id === message.client_id : domainMatches(String(message.from_domain ?? ""), item.domains),
      );
      if (!profile) throw new ApiError(422, "CLIENT_NOT_LINKED", "اربط دومين المرسل بجهة أولًا من «جهات البريد»");
      const fields = cleanFields({ national_id: findNationalId(String(message.subject ?? "")) }, {});
      const [item] = await query(
        `INSERT INTO mail_cases(message_id, client_id, fields, confidence, source, status, reason, reviewed_by)
         VALUES($1,$2,$3::text::jsonb,1,'manual','review',$4,$5) RETURNING case_id`,
        [message.message_id, profile.client_id, JSON.stringify(fields), "أُضيف يدويًا: أكمل البيانات", auth.user.user_id],
      );
      // No more automatic readings: a person has taken this email over.
      await query("UPDATE mail_messages SET status='review', retry_at=NULL, client_id=$2 WHERE message_id=$1", [
        message.message_id,
        profile.client_id,
      ]);
      return ok({ case_id: item?.case_id });
    }),
  );

  router.get(
    "/investigations/intake/cases",
    withPermission(MANAGE, async (context) => {
      const status = context.url.searchParams.get("status") || "review";
      const rows = await query(
        `SELECT x.case_id, x.message_id, x.kind, x.fast, x.fields, x.confidence, x.doubts, x.source, x.status, x.reason,
           x.release_at, x.investigation_id, x.updated_at, x.template_id, x.assignee_id, x.knowledge, x.appointment_at, c.name AS client_name, m.subject, m.from_address, m.inbox,
           m.received_at, i.reference
         FROM mail_cases x JOIN mail_messages m ON m.message_id = x.message_id
         LEFT JOIN form_clients c ON c.client_id = x.client_id
         LEFT JOIN investigations i ON i.investigation_id = x.investigation_id
         WHERE x.status = ANY($1::text[]) AND ($2::text[] IS NULL OR x.client_id = ANY($2))
         ORDER BY COALESCE(x.release_at, x.created_at) LIMIT 300`,
        [status.split(","), chosenClients(context.url.searchParams)],
      );
      return ok({ cases: rows });
    }),
  );

  router.patch(
    "/investigations/intake/cases/:case_id",
    withPermission(MANAGE, async (context) => {
      const body = await readJson(context.req);
      const [item] = await query("SELECT * FROM mail_cases WHERE case_id=$1", [context.params.case_id]);
      if (!item) throw ApiError.notFound("Case not found");
      if (!["review", "failed", "ready"].includes(item.status as string)) {
        throw new ApiError(409, "INVALID_STATUS_TRANSITION", "This case has already been sent");
      }
      const kind = body.kind === undefined ? item.kind : body.kind;
      if (kind !== null && !KINDS.includes(kind as CaseKind)) throw ApiError.badRequest("Unknown kind", { field: "kind" });
      const fields = cleanFields(body.fields, item.fields as Row);
      const templateId = body.template_id === undefined ? item.template_id : optionalText(body.template_id, 64);
      if (templateId) await assertClientForm(templateId as string, item.client_id as string);
      const assigneeId = body.assignee_id === undefined ? item.assignee_id : optionalText(body.assignee_id, 64);
      const knowledge = body.knowledge === undefined ? item.knowledge : body.knowledge;
      if (knowledge !== null && knowledge !== "with" && knowledge !== "without") {
        throw ApiError.badRequest("knowledge must be with, without or null", { field: "knowledge" });
      }
      const appointment = body.appointment_at === undefined ? item.appointment_at : appointmentOf(body.appointment_at);
      // Set after the call: the case no longer waits for it.
      const reason =
        knowledge === "with" && !appointment ? item.reason : dropReason(item.reason as string | null, APPOINTMENT_NEEDED);
      const rows = await query(
        `UPDATE mail_cases SET fields=$2::text::jsonb, kind=$3, fast=$4, template_id=$5, assignee_id=$6, knowledge=$7,
           appointment_at=$8, reason=$9, updated_at=now()
         WHERE case_id=$1 AND status IN ('review','failed','ready') RETURNING *`,
        [
          context.params.case_id,
          JSON.stringify(fields),
          kind,
          typeof body.fast === "boolean" ? body.fast : item.fast,
          templateId ?? null,
          assigneeId ?? null,
          knowledge,
          knowledge === "with" ? (appointment ?? null) : null,
          reason,
        ],
      );
      if (!rows.length) throw new ApiError(409, "INVALID_STATUS_TRANSITION", "This case has already been sent");
      return ok({ case: rows[0], blockers: await blockers(rows[0]!) });
    }),
  );

  router.post(
    "/investigations/intake/cases/:case_id/approve",
    withPermission(MANAGE, async (context, auth) => {
      const body = await readJson(context.req).catch(() => ({}) as Row);
      const [item] = await query("SELECT * FROM mail_cases WHERE case_id=$1", [context.params.case_id]);
      if (!item) throw ApiError.notFound("Case not found");
      if (!["review", "failed", "ready"].includes(item.status as string)) {
        throw new ApiError(409, "INVALID_STATUS_TRANSITION", "This case is not waiting for review");
      }
      const missing = await blockers(item);
      if (missing.length) throw new ApiError(422, "CASE_INCOMPLETE", missing.join("، "));
      // «Send now» skips the night rule. Otherwise the time rules, and never at night by accident.
      const [message] = await query("SELECT received_at FROM mail_messages WHERE message_id=$1", [item.message_id]);
      const now = new Date();
      let at = body.send_now === true ? now : sendTime(new Date(message?.received_at as string), now);
      // An agreed visit is offered in time for it, even when the night rule would wait.
      if (item.appointment_at && new Date(item.appointment_at as string) <= at) at = now;
      const approved = await query(
        `UPDATE mail_cases SET status='ready', release_at=$2, reason=NULL, reviewed_by=$3, reviewed_at=now(), updated_at=now()
         WHERE case_id=$1 AND status IN ('review','failed','ready') RETURNING case_id`,
        [context.params.case_id, at, auth.user.user_id],
      );
      if (!approved.length) throw new ApiError(409, "INVALID_STATUS_TRANSITION", "This case has already been sent");
      await recordAudit({
        event: "mail.case_approved",
        actorId: auth.user.user_id,
        success: true,
        context,
        metadata: { mail_case: context.params.case_id, approved: true, release_at: at },
      });
      const result = at.getTime() <= Date.now() ? await release(context.params.case_id ?? "", deps) : { ok: true };
      const [after] = await query(
        `SELECT x.status, x.reason, x.release_at, i.reference FROM mail_cases x
         LEFT JOIN investigations i ON i.investigation_id = x.investigation_id WHERE x.case_id=$1`,
        [context.params.case_id],
      );
      return ok({ ...after, sent: result.ok && after?.status === "sent" });
    }),
  );

  /**
   * One email asks for two visits to the same person (work and home) but was read as one:
   * a copy for the other visit, with that visit's address when the email gave it.
   */
  router.post(
    "/investigations/intake/cases/:case_id/visit",
    withPermission(MANAGE, async (context, auth) => {
      const body = await readJson(context.req).catch(() => ({}) as Row);
      const kind = body.kind as CaseKind;
      if (!["home", "work", "business"].includes(kind)) throw ApiError.badRequest("Choose home, work or business", { field: "kind" });
      const [item] = await query("SELECT * FROM mail_cases WHERE case_id=$1", [context.params.case_id]);
      if (!item) throw ApiError.notFound("Case not found");
      if (item.status === "rejected") throw new ApiError(409, "INVALID_STATUS_TRANSITION", "هذه الحالة مرفوضة");
      const [same] = await query(
        "SELECT 1 FROM mail_cases WHERE message_id=$1 AND kind=$2 AND status <> 'rejected' AND fields->>'subject_name' IS NOT DISTINCT FROM $3",
        [item.message_id, kind, (item.fields as Row).subject_name ?? null],
      );
      if (same) throw new ApiError(409, "ALREADY_EXISTS", `توجد زيارة «${KIND_LABELS[kind]}» لهذا الشخص في هذا البريد`);
      const f = { ...(item.fields as Row) };
      const own = (kind === "home" ? f.home_address : f.work_address) as string | null | undefined;
      if (own && own !== f.address) {
        f.address = own;
        Object.assign(f, await placeOfAddress(own));
      }
      const [copy] = await query(
        `INSERT INTO mail_cases(message_id, client_id, kind, fast, fields, confidence, doubts, source, status, reason, release_at,
           knowledge, appointment_at, reviewed_by)
         VALUES($1,$2,$3,$4,$5::text::jsonb,$6,$7,'manual','review',$8,$9,$10,$11,$12) RETURNING case_id`,
        [
          item.message_id,
          item.client_id,
          kind,
          item.fast,
          JSON.stringify(f),
          item.confidence,
          item.doubts ?? [],
          own ? "زيارة ثانية أضافها مسؤول: راجع البيانات" : "زيارة ثانية أضافها مسؤول: اكتب عنوان هذه الزيارة",
          item.release_at,
          item.knowledge ?? null,
          item.appointment_at ?? null,
          auth.user.user_id,
        ],
      );
      await recordAudit({
        event: "mail.case_visit_added",
        actorId: auth.user.user_id,
        success: true,
        context,
        metadata: { mail_case: copy?.case_id, copied_from: context.params.case_id, added_visit: kind },
      });
      return ok({ case_id: copy?.case_id });
    }),
  );

  router.post(
    "/investigations/intake/cases/:case_id/reject",
    withPermission(MANAGE, async (context, auth) => {
      const body = await readJson(context.req).catch(() => ({}) as Row);
      const rows = await query(
        `UPDATE mail_cases SET status='rejected', reason=$2, reviewed_by=$3, reviewed_at=now(), updated_at=now()
         WHERE case_id=$1 AND status IN ('review','ready','failed') RETURNING case_id`,
        [context.params.case_id, optionalText(body.reason, 300) ?? "رفضها مسؤول", auth.user.user_id],
      );
      if (!rows.length) throw new ApiError(409, "INVALID_STATUS_TRANSITION", "This case has already been sent");
      return ok({ rejected: true });
    }),
  );

  router.get(
    "/investigations/intake/profiles",
    withPermission(MANAGE, async () => {
      const [profiles, clients, templates, levels] = await Promise.all([
        query(
          `SELECT p.*, c.name AS client_name FROM mail_client_profiles p JOIN form_clients c ON c.client_id = p.client_id
           ORDER BY c.name`,
        ),
        query("SELECT client_id, name, client_type FROM form_clients WHERE active ORDER BY name"),
        query(
          `SELECT t.template_id, t.title, t.client_id, it.name AS type_name FROM form_templates t
           JOIN template_versions v ON v.version_id = t.active_version_id AND v.status = 'active'
           LEFT JOIN investigation_types it ON it.code = t.investigation_type
           WHERE t.active ORDER BY t.title`,
        ),
        query("SELECT code, name_ar FROM service_levels WHERE active AND delivery_hours IS NOT NULL ORDER BY sort"),
      ]);
      return ok({ profiles, clients, templates, levels, kinds: KIND_LABELS });
    }),
  );

  router.post(
    "/investigations/intake/profiles/:client_id",
    withPermission(MANAGE, async (context, auth) => {
      const body = await readJson(context.req);
      const clientId = context.params.client_id ?? "";
      const [client] = await query("SELECT 1 FROM form_clients WHERE client_id=$1", [clientId]);
      if (!client) throw ApiError.notFound("Client not found");
      const list = (value: unknown, max = 40) =>
        (Array.isArray(value) ? value : String(value ?? "").split(/[,\n،]/))
          .map((v) => String(v).trim())
          .filter(Boolean)
          .slice(0, max);
      const domains = list(body.domains).map((d) => d.toLowerCase().replace(/^.*@/, ""));
      if (!domains.length) throw ApiError.badRequest("Add at least one email domain", { field: "domains" });
      const taken = await query(
        "SELECT c.name, d FROM mail_client_profiles p JOIN form_clients c ON c.client_id = p.client_id, unnest(p.domains) d WHERE p.client_id <> $1 AND d = ANY($2::text[])",
        [clientId, domains],
      );
      if (taken.length) throw ApiError.badRequest(`الدومين ${taken[0]!.d} مربوط بـ ${taken[0]!.name}`, { field: "domains" });
      const templates: Row = {};
      const given = (body.templates ?? {}) as Row;
      for (const kind of KINDS) {
        const id = optionalText(given[kind], 64);
        if (!id) continue;
        await assertClientForm(id, clientId);
        templates[kind] = id;
      }
      const level = async (code: unknown, fallback: string) => {
        const value = optionalText(code, 40) ?? fallback;
        const [found] = await query("SELECT 1 FROM service_levels WHERE code=$1", [value]);
        if (!found) throw ApiError.badRequest("Unknown investigation type", { field: "level" });
        return value;
      };
      await query(
        `INSERT INTO mail_client_profiles(client_id, domains, templates, fast_words, normal_level, fast_level, auto_send,
           ignore_words, notes, active, updated_by, two_visits, updated_at)
         VALUES($1,$2,$3::text::jsonb,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
         ON CONFLICT (client_id) DO UPDATE SET domains=$2, templates=$3::text::jsonb, fast_words=$4, normal_level=$5,
           fast_level=$6, auto_send=$7, ignore_words=$8, notes=$9, active=$10, updated_by=$11, two_visits=$12, updated_at=now()`,
        [
          clientId,
          domains,
          JSON.stringify(templates),
          list(body.fast_words),
          await level(body.normal_level, "normal"),
          await level(body.fast_level, "urgent"),
          body.auto_send !== false,
          list(body.ignore_words),
          optionalText(body.notes, 1000),
          body.active !== false,
          auth.user.user_id,
          body.two_visits === true,
        ],
      );
      // Emails from these domains that waited as «unknown sender» are read now.
      const requeued = await requeueUnknown(domains);
      await recordAudit({
        event: "mail.profile_updated",
        actorId: auth.user.user_id,
        success: true,
        context,
        metadata: { client_id: clientId, domains, auto_send: body.auto_send !== false },
      });
      return ok({ saved: true, requeued });
    }),
  );

  // ───────────── the report back to the client ─────────────

  router.get(
    "/investigations/:id/email-draft",
    withPermission(MANAGE, async (context) => {
      const [row] = await query(
        `SELECT i.investigation_id, i.reference, i.subject_name, i.client_id, i.client_name, i.client_reference, i.form_title,
           i.status, i.pdf_path, i.report_docx_path, i.mail_case_id, x.kind, x.fields, m.inbox, m.from_address, m.from_domain, m.to_addresses, m.cc_addresses, m.sender_verified,
           m.subject AS request_subject, m.header_message_id
         FROM investigations i LEFT JOIN mail_cases x ON x.case_id = i.mail_case_id
         LEFT JOIN mail_messages m ON m.message_id = x.message_id WHERE i.investigation_id=$1`,
        [context.params.id],
      );
      if (!row) throw ApiError.notFound("Investigation not found");
      const contacts = await query(
        "SELECT address, name, seen_count FROM mail_client_contacts WHERE client_id=$1 ORDER BY seen_count DESC, last_seen_at DESC LIMIT 60",
        [row.client_id],
      );
      const kind = row.kind ? KIND_LABELS[row.kind as CaseKind] : row.form_title;
      const nid = (row.fields as Row | null)?.national_id ?? row.client_reference;
      const subject = [row.subject_name, nid, kind].filter(Boolean).join(" - ");
      const sent = await query(
        "SELECT sent_id, to_addresses, cc_addresses, subject, status, error, sent_at FROM mail_sent WHERE investigation_id=$1 ORDER BY sent_at DESC",
        [context.params.id],
      );
      return ok({
        draft: {
          inbox: row.inbox ?? configuredInboxes()[0]?.name ?? null,
          // Addresses come from the email only when the mail server confirmed who sent it.
          to: row.sender_verified === true && row.from_address ? [row.from_address] : [],
          // Colleagues of the sender who were on the request (never our own inboxes or strangers).
          cc:
            row.sender_verified === true
              ? [...new Set([...((row.to_addresses as string[] | null) ?? []), ...((row.cc_addresses as string[] | null) ?? [])])].filter(
                  (a) => a !== row.from_address && domainMatches(a.split("@")[1] ?? "", [String(row.from_domain ?? "")]),
                )
              : [],
          // One report per email, named as the team does; In-Reply-To keeps it in the request's thread.
          subject,
          body: `السادة / ${row.client_name ?? ""}\nتحية طيبة وبعد،\n\nمرفق تقرير الاستعلام عن العميل/ ${row.subject_name}${nid ? ` (${nid})` : ""}.\n\nوتفضلوا بقبول فائق الاحترام،\nجولدن باي للخدمات`,
          in_reply_to: row.header_message_id ?? null,
          attachments: [
            row.pdf_path ? { kind: "pdf", name: `${subject || row.reference}.pdf` } : null,
            row.report_docx_path ? { kind: "docx", name: `${subject || row.reference}.docx` } : null,
          ].filter(Boolean),
        },
        inboxes: configuredInboxes().map((inbox) => inbox.name),
        contacts,
        sent,
        report_ready: Boolean(row.pdf_path),
        approved: row.status === "approved",
      });
    }),
  );

  router.post(
    "/investigations/:id/email",
    withPermission(MANAGE, async (context, auth) => {
      const body = await readJson(context.req);
      const [row] = await query("SELECT investigation_id, reference, status, pdf_path, report_docx_path FROM investigations WHERE investigation_id=$1", [
        context.params.id,
      ]);
      if (!row) throw ApiError.notFound("Investigation not found");
      if (row.status !== "approved") throw new ApiError(409, "NOT_APPROVED", "Approve the report before sending it");
      const emails = (value: unknown) =>
        (Array.isArray(value) ? value : [])
          .map((v) => String(v).trim().toLowerCase())
          .filter((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))
          .slice(0, 30);
      const to = emails(body.to);
      const cc = emails(body.cc);
      if (!to.length) throw ApiError.badRequest("Choose at least one recipient", { field: "to" });
      const inbox = requiredText(body.inbox, "inbox", 40);
      const subject = requiredText(body.subject, "subject", 300);
      const text = requiredText(body.body, "body", 20_000);
      const wanted = new Set(Array.isArray(body.attachments) ? body.attachments.map(String) : ["pdf"]);
      const attachments: { filename: string; content: Uint8Array; contentType: string }[] = [];
      const baseName = (optionalText(body.file_name, 150) ?? row.reference) as string;
      if (wanted.has("pdf") && row.pdf_path) {
        attachments.push({ filename: `${baseName}.pdf`, content: await getStoredFile(row.pdf_path as string), contentType: "application/pdf" });
      }
      if (wanted.has("docx") && row.report_docx_path) {
        attachments.push({
          filename: `${baseName}.docx`,
          content: await getStoredFile(row.report_docx_path as string),
          contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        });
      }
      if (!attachments.length) throw new ApiError(409, "REPORT_NOT_READY", "The report file is not ready yet");
      const inReplyTo = optionalText(body.in_reply_to, 500);
      let smtpId: string | null = null;
      let savedToSent = false;
      let error: string | null = null;
      try {
        const sent = await sendFromInbox({ inbox, to, cc, subject, text, inReplyTo, attachments });
        smtpId = sent.messageId;
        savedToSent = sent.savedToSent;
      } catch (err) {
        error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      }
      await query(
        `INSERT INTO mail_sent(investigation_id, inbox, to_addresses, cc_addresses, subject, body, attachments, in_reply_to,
           smtp_message_id, status, error, sent_by)
         VALUES($1,$2,$3,$4,$5,$6,$7::text::jsonb,$8,$9,$10,$11,$12)`,
        [
          context.params.id,
          inbox,
          to,
          cc,
          subject,
          text,
          JSON.stringify(attachments.map((a) => ({ name: a.filename, bytes: a.content.length }))),
          inReplyTo,
          smtpId,
          error ? "failed" : "sent",
          error,
          auth.user.user_id,
        ],
      );
      await recordAudit({
        event: "mail.report_sent",
        actorId: auth.user.user_id,
        success: !error,
        context,
        metadata: { investigation_id: context.params.id, emailed_to: to.length, cc: cc.length, inbox },
      });
      if (error) throw new ApiError(502, "MAIL_SEND_FAILED", `لم يُرسل البريد: ${error}`);
      return ok({ sent: true, saved_to_sent: savedToSent });
    }),
  );
}
