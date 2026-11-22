import { query } from "../../IdentityAcess_Services/Config/db.ts";
import { withPermission } from "../../IdentityAcess_Services/MIddlewares/auth.middleware.ts";
import { recordAudit } from "../../IdentityAcess_Services/Services/audit.service.ts";
import { PERMISSIONS } from "../../IdentityAcess_Services/Services/rbac.service.ts";
import { getStoredFile } from "../../IdentityAcess_Services/Utils/files.ts";
import { ApiError, ok, readJson } from "../../IdentityAcess_Services/Utils/http.ts";
import type { Router } from "../../IdentityAcess_Services/Utils/router.ts";
import { optionalText, requiredText } from "../../Shared/service.ts";
import { aiConfigured, AI_MODEL } from "./ai.ts";
import { configuredInboxes, pollAll, sendFromInbox } from "./inbox.ts";
import { loadProfiles, processMessage } from "./process.ts";
import { KIND_LABELS, releaseTime, safeInlineType, type CaseKind } from "./rules.ts";

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
    const templateId = profile.templates[item.kind as CaseKind];
    if (!templateId) throw new Error(`لا يوجد نموذج «${KIND_LABELS[item.kind as CaseKind] ?? item.kind}» لهذه الجهة`);
    const template = await deps.activeTemplate(templateId);
    const f = item.fields as Row;
    const [message] = await query("SELECT inbox, from_address, subject, received_at FROM mail_messages WHERE message_id=$1", [
      item.message_id,
    ]);
    const notes = [
      f.national_id ? `الرقم القومي: ${f.national_id}` : null,
      f.notes as string | null,
      `وارد بالبريد (${message?.inbox ?? ""}) من ${message?.from_address ?? ""}: ${message?.subject ?? ""}`,
    ]
      .filter(Boolean)
      .join("\n");
    const areas = [
      f.district ? { mode: "hierarchy", governorate: f.governorate, district: f.district } : null,
      { mode: "hierarchy", governorate: f.governorate },
    ].filter(Boolean) as Row[];
    let created: { investigation_id: string; reference: string } | null = null;
    let lastError: unknown = null;
    for (const area of areas) {
      try {
        created = await deps.insertCase(
          {
            target_mode: "area",
            area,
            subject_name: f.subject_name,
            subject_phone: f.phone,
            client_reference: f.client_reference ?? f.national_id ?? null,
            address: f.address,
            governorate: f.governorate,
            district: f.district,
            admin_notes: notes.slice(0, 2000),
            service_level: item.fast ? profile.fast_level : profile.normal_level,
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
    const reason = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    await query("UPDATE mail_cases SET status='failed', reason=$2, updated_at=now() WHERE case_id=$1", [caseId, reason]);
    return { ok: false, reason };
  }
}

let ticking = false;
async function tick(deps: IntakeDeps): Promise<void> {
  if (ticking) return;
  ticking = true;
  // What is due goes out first and between readings: a slow AI reading never holds back 08:00.
  const releaseDue = async () => {
    const due = await query("SELECT case_id FROM mail_cases WHERE status='ready' AND release_at <= now() ORDER BY release_at LIMIT 50");
    for (const row of due) await release(row.case_id as string, deps);
  };
  try {
    await releaseDue();
    await pollAll();
    // Read what arrived (one at a time: the AI reader is the slow part).
    const fresh = await query("SELECT message_id FROM mail_messages WHERE status='new' ORDER BY received_at LIMIT 20");
    for (const row of fresh) {
      await processMessage(row.message_id as string);
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

/** What still stops a case from going out, in Arabic (empty: it can go). */
async function blockers(item: Row): Promise<string[]> {
  const f = item.fields as Row;
  const out: string[] = [];
  if (!f.subject_name) out.push("لا يوجد اسم");
  if (!f.address) out.push("لا يوجد عنوان");
  if (!f.governorate) out.push("المحافظة غير معروفة");
  const profile = (await loadProfiles()).find((p) => p.client_id === item.client_id);
  if (!profile) out.push("الجهة غير مضبوطة");
  else if (!item.kind) out.push("نوع الاستعلام غير محدد");
  else if (!profile.templates[item.kind as CaseKind]) out.push(`لا يوجد نموذج «${KIND_LABELS[item.kind as CaseKind]}» لهذه الجهة`);
  return out;
}

export function registerIntakeRoutes(router: Router, deps: IntakeDeps): void {
  router.get(
    "/investigations/intake/overview",
    withPermission(MANAGE, async () => {
      const configured = configuredInboxes().map((inbox) => inbox.name);
      const [states, counts, unknown, today] = await Promise.all([
        query("SELECT inbox, last_poll_at, last_ok_at, last_error FROM mail_inbox_state ORDER BY inbox"),
        query(
          `SELECT status, count(*)::int AS count, min(release_at) AS next_release FROM mail_cases
           WHERE status IN ('review','ready','failed','sending') GROUP BY status`,
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
           FROM mail_messages WHERE received_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'Africa/Cairo'`,
        ),
      ]);
      const sentToday = await query(
        `SELECT count(*)::int AS count FROM mail_cases WHERE status='sent'
           AND updated_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'Africa/Cairo'`,
      );
      return ok({
        inboxes: [...new Set([...configured, ...states.map((s) => s.inbox as string)])].map((name) => ({
          name,
          configured: configured.includes(name),
          ...(states.find((s) => s.inbox === name) ?? {}),
        })),
        ai: { configured: aiConfigured(), model: AI_MODEL },
        cases: Object.fromEntries(counts.map((c) => [c.status, { count: c.count, next_release: c.next_release }])),
        today: { ...(today[0] ?? {}), sent: sentToday[0]?.count ?? 0 },
        unknown_domains: unknown,
        rule: "من 8 صباحًا إلى 4 مساءً تُرسل فورًا، ومن 4 مساءً إلى 8 صباحًا تُجدول للساعة 8 صباحًا",
      });
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
         WHERE ($1::text IS NULL OR m.status = $1)
           AND ($2::text IS NULL OR m.subject ILIKE '%' || $2 || '%' OR m.from_address ILIKE '%' || $2 || '%')
         ORDER BY m.received_at DESC LIMIT 200`,
        [status || null, search || null],
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
      const outcome = await processMessage(context.params.message_id ?? "");
      return ok(outcome);
    }),
  );

  router.post(
    "/investigations/intake/messages/:message_id/ignore",
    withPermission(MANAGE, async (context, auth) => {
      const body = await readJson(context.req).catch(() => ({}) as Row);
      await query("UPDATE mail_messages SET status='ignored', reason=$2 WHERE message_id=$1", [
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

  router.get(
    "/investigations/intake/cases",
    withPermission(MANAGE, async (context) => {
      const status = context.url.searchParams.get("status") || "review";
      const rows = await query(
        `SELECT x.case_id, x.message_id, x.kind, x.fast, x.fields, x.confidence, x.doubts, x.source, x.status, x.reason,
           x.release_at, x.investigation_id, x.updated_at, c.name AS client_name, m.subject, m.from_address, m.inbox,
           m.received_at, i.reference
         FROM mail_cases x JOIN mail_messages m ON m.message_id = x.message_id
         LEFT JOIN form_clients c ON c.client_id = x.client_id
         LEFT JOIN investigations i ON i.investigation_id = x.investigation_id
         WHERE x.status = ANY($1::text[]) ORDER BY COALESCE(x.release_at, x.created_at) LIMIT 300`,
        [status.split(",")],
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
      const rows = await query(
        `UPDATE mail_cases SET fields=$2::text::jsonb, kind=$3, fast=$4, updated_at=now() WHERE case_id=$1 RETURNING *`,
        [context.params.case_id, JSON.stringify(fields), kind, typeof body.fast === "boolean" ? body.fast : item.fast],
      );
      return ok({ case: rows[0], blockers: await blockers(rows[0]!) });
    }),
  );

  router.post(
    "/investigations/intake/cases/:case_id/approve",
    withPermission(MANAGE, async (context, auth) => {
      const body = await readJson(context.req).catch(() => ({}) as Row);
      const [item] = await query("SELECT * FROM mail_cases WHERE case_id=$1", [context.params.case_id]);
      if (!item) throw ApiError.notFound("Case not found");
      if (!["review", "failed"].includes(item.status as string)) {
        throw new ApiError(409, "INVALID_STATUS_TRANSITION", "This case is not waiting for review");
      }
      const missing = await blockers(item);
      if (missing.length) throw new ApiError(422, "CASE_INCOMPLETE", missing.join("، "));
      // «Send now» skips the night rule; otherwise the time rule of when the email arrived.
      const [message] = await query("SELECT received_at FROM mail_messages WHERE message_id=$1", [item.message_id]);
      const ruled = releaseTime(new Date(message?.received_at as string)).at;
      const at = body.send_now === true || ruled.getTime() < Date.now() ? new Date() : ruled;
      await query(
        `UPDATE mail_cases SET status='ready', release_at=$2, reason=NULL, reviewed_by=$3, reviewed_at=now(), updated_at=now()
         WHERE case_id=$1`,
        [context.params.case_id, at, auth.user.user_id],
      );
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
        const [t] = await query("SELECT client_id FROM form_templates WHERE template_id=$1", [id]);
        if (!t) throw ApiError.badRequest(`Unknown form for ${kind}`, { field: "templates" });
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
           ignore_words, notes, active, updated_by, updated_at)
         VALUES($1,$2,$3::text::jsonb,$4,$5,$6,$7,$8,$9,$10,$11,now())
         ON CONFLICT (client_id) DO UPDATE SET domains=$2, templates=$3::text::jsonb, fast_words=$4, normal_level=$5,
           fast_level=$6, auto_send=$7, ignore_words=$8, notes=$9, active=$10, updated_by=$11, updated_at=now()`,
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
        ],
      );
      // Emails from these domains that waited as «unknown sender» are read now.
      const waiting = await query(
        "SELECT message_id FROM mail_messages WHERE status='unknown_sender' AND from_domain = ANY($1::text[]) AND received_at > now() - interval '3 days'",
        [domains],
      );
      for (const row of waiting) await query("UPDATE mail_messages SET status='new' WHERE message_id=$1", [row.message_id]);
      await recordAudit({
        event: "mail.profile_updated",
        actorId: auth.user.user_id,
        success: true,
        context,
        metadata: { client_id: clientId, domains, auto_send: body.auto_send !== false },
      });
      return ok({ saved: true, requeued: waiting.length });
    }),
  );

  // ───────────── the report back to the client ─────────────

  router.get(
    "/investigations/:id/email-draft",
    withPermission(MANAGE, async (context) => {
      const [row] = await query(
        `SELECT i.investigation_id, i.reference, i.subject_name, i.client_id, i.client_name, i.client_reference, i.form_title,
           i.status, i.pdf_path, i.report_docx_path, i.mail_case_id, x.kind, x.fields, m.inbox, m.from_address, m.cc_addresses,
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
          to: row.from_address ? [row.from_address] : [],
          cc: ((row.cc_addresses as string[] | null) ?? []).filter((a) => !/goldenpayservice\.com$/i.test(a)),
          subject: row.request_subject ? `RE: ${row.request_subject}` : subject,
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
      let error: string | null = null;
      try {
        smtpId = await sendFromInbox({ inbox, to, cc, subject, text, inReplyTo, attachments });
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
      return ok({ sent: true });
    }),
  );
}
