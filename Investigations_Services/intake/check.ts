import { query, transaction } from "../../IdentityAcess_Services/Config/db.ts";
import { getStoredFile, putStoredFile, removeStoredFile } from "../../IdentityAcess_Services/Utils/files.ts";
import { WORKS_FOR_CLIENT_SQL } from "../../Shared/investigator-clients.ts";
import { AI_MODEL, aiConfigured, readWithAi } from "./ai.ts";
import { configuredInboxes, testInbox } from "./inbox.ts";
import { loadProfiles, processMessage } from "./process.ts";
import { auditClientForms, type AuditForm } from "./setup.ts";
import { KIND_LABELS, type CaseKind } from "./rules.ts";

/**
 * «فحص التشغيل»: proves on the server itself that each link of the email chain works.
 * It sends no email, creates no investigation, notifies no one, and its database rows are
 * rolled back. The AI check reads one invented request.
 */

type Row = Record<string, unknown>;
export type CheckLevel = "ok" | "warn" | "fail";
export interface CheckLine {
  key: string;
  label: string;
  level: CheckLevel;
  detail: string;
}

const said = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

class Undo extends Error {}

/** A made-up request through the real reading code, in a transaction that is always undone. */
async function databaseRoundTrip(): Promise<string | null> {
  let problem: string | null = null;
  const id = crypto.randomUUID();
  const client = `mail-check-${id.slice(0, 8)}`;
  const domain = `${id.slice(0, 8)}.check.invalid`;
  try {
    await transaction(async () => {
      await query("INSERT INTO form_clients(client_id,name,client_type) VALUES($1,$2,'company')", [client, "فحص التشغيل"]);
      await query(
        "INSERT INTO mail_client_profiles(client_id, domains, templates, auto_send) VALUES($1,$2,$3::text::jsonb,true)",
        [client, [domain], JSON.stringify({ home: "check" })],
      );
      await query(
        `INSERT INTO mail_messages(message_id, inbox, uid, header_message_id, from_address, from_domain, subject, body_text,
           received_at, sender_verified, status)
         VALUES($1,'check',0,$2,$3,$4,$5,$6,now(),true,'new')`,
        [
          id,
          `<${id}@check.invalid>`,
          `check@${domain}`,
          domain,
          "استعلام سكن",
          "<table><tr><th>Customer Name</th><th>Address</th></tr><tr><td>عميل فحص التشغيل</td><td>1 شارع الفحص مدينة نصر القاهرة</td></tr></table>",
        ],
      );
      const outcome = await processMessage(id, { rethrow: true });
      const [item] = await query("SELECT status, reason, fields FROM mail_cases WHERE message_id=$1", [id]);
      if (!item) problem = `لم تُنشأ حالة الفحص (${outcome.status})`;
      else if (item.status !== "ready") problem = `حالة الفحص توقفت: ${item.reason}`;
      throw new Undo();
    });
  } catch (error) {
    if (!(error instanceof Undo)) return said(error);
  }
  return problem;
}

async function storageRoundTrip(): Promise<string | null> {
  const path = `mail/check/${crypto.randomUUID()}.bin`;
  try {
    const bytes = new TextEncoder().encode("check");
    await putStoredFile(path, bytes, "application/octet-stream");
    if ((await getStoredFile(path)).length !== bytes.length) return "الملف المحفوظ يختلف عن الأصل";
    await removeStoredFile(path);
    return null;
  } catch (error) {
    return said(error);
  }
}

async function aiRoundTrip(): Promise<string | null> {
  try {
    const result = await readWithAi({
      clientName: "Test client",
      subject: "استعلام سكن",
      body: "برجاء اجراء استعلام سكن للعميل: عميل فحص التشغيل، العنوان: 1 شارع الفحص، مدينة نصر، القاهرة.",
      images: [],
      pdfs: [],
      texts: [],
    });
    return result.cases.length === 1 && result.cases[0]!.subject_name ? null : "لم تستخرج القراءة الذكية طلب الفحص";
  } catch (error) {
    return said(error);
  }
}

export async function runSystemCheck(deps: {
  activeTemplate: (templateId: string) => Promise<Row>;
  matchInvestigators: (filter: Row) => Promise<Row[]>;
  loopRanAt: () => Date | null;
}): Promise<{ lines: CheckLine[] }> {
  const lines: CheckLine[] = [];
  const add = (key: string, label: string, level: CheckLevel, detail: string) => lines.push({ key, label, level, detail });

  const ran = deps.loopRanAt();
  if (process.env.MAIL_INTAKE === "off") add("loop", "الاستقبال التلقائي", "fail", "متوقف: احذف MAIL_INTAKE=off من الخادم");
  else if (!ran) add("loop", "الاستقبال التلقائي", "warn", "لم تبدأ أول دورة بعد: أعد الفحص بعد دقيقة");
  else if (Date.now() - ran.getTime() > 15 * 60_000) add("loop", "الاستقبال التلقائي", "fail", "لم يعمل منذ أكثر من 15 دقيقة");
  else add("loop", "الاستقبال التلقائي", "ok", "يعمل");

  const inboxes = configuredInboxes();
  if (!inboxes.length) add("inboxes", "صناديق البريد", "fail", "لا يوجد صندوق بريد مضبوط: RETAIL و RETAIL_PASS (وكذلك INFO و SME) أو MAIL_INBOXES");
  for (const { inbox, result } of await Promise.all(inboxes.map(async (inbox) => ({ inbox, result: await testInbox(inbox) })))) {
    add(`read:${inbox.name}`, `استقبال ${inbox.name}`, result.read ? "fail" : "ok", result.read ?? "تم الدخول");
    add(`send:${inbox.name}`, `إرسال ${inbox.name}`, result.send ? "fail" : "ok", result.send ?? "جاهز للإرسال، ولم يُرسل شيء");
  }

  const database = await databaseRoundTrip();
  add("database", "قراءة طلب وحفظه", database ? "fail" : "ok", database ?? "طلب تجريبي قُرئ وحُفظ ثم أُلغي");
  const storage = await storageRoundTrip();
  add("storage", "حفظ المرفقات", storage ? "fail" : "ok", storage ?? "الحفظ والقراءة يعملان");
  if (!aiConfigured()) add("ai", "القراءة الذكية", "fail", "ANTHROPIC_API_KEY غير مضبوط على الخادم");
  else {
    const ai = await aiRoundTrip();
    add("ai", "القراءة الذكية", ai ? "fail" : "ok", ai ?? `${AI_MODEL} قرأ طلبًا تجريبيًا`);
  }

  try {
    const profiles = await loadProfiles();
    if (!profiles.length) add("clients", "ربط الجهات", "fail", "لا توجد جهة مربوطة: ارفع ملف ربط الجهات");
    for (const profile of profiles) {
      const problems: string[] = [];
      for (const [kind, templateId] of Object.entries(profile.templates)) {
        try {
          const template = await deps.activeTemplate(templateId as string);
          if (!template.version_id || template.active === false) throw new Error("inactive");
        } catch {
          problems.push(`نموذج «${KIND_LABELS[kind as CaseKind] ?? kind}» غير مفعّل`);
        }
      }
      if (!Object.keys(profile.templates).length) problems.push("لا يوجد نموذج: كل طلب ينتظر المراجعة");
      const [staff] = await query(
        `SELECT count(*)::int AS n FROM users u
         WHERE u.status = 'active' AND u.deleted_at IS NULL AND ${WORKS_FOR_CLIENT_SQL("u.user_id", "$1")}
           AND EXISTS (SELECT 1 FROM investigator_service_areas a WHERE a.user_id = u.user_id AND a.active)`,
        [profile.client_id],
      );
      const people = Number(staff?.n ?? 0);
      if (!people) problems.push("لا يوجد مستعلم يعمل لهذه الجهة، فلن يصل طلب لأحد");
      if (!profile.auto_send) problems.push("الإرسال التلقائي مغلق: كل طلب ينتظر المراجعة");
      // Every form of the client: its type, whether the email can use it, and how it is linked.
      const forms = (await query(
        `SELECT t.template_id, t.title, t.investigation_type,
           EXISTS (SELECT 1 FROM template_versions v WHERE v.version_id = t.active_version_id AND v.status = 'active') AS available
         FROM form_templates t WHERE t.active AND t.client_id = $1 ORDER BY t.title`,
        [profile.client_id],
      )) as unknown as AuditForm[];
      const audit = auditClientForms(forms, profile.templates, profile.two_visits);
      add(
        `forms:${profile.client_id}`,
        `نماذج: ${profile.client_name}`,
        audit.problems.length ? "warn" : "ok",
        [...audit.problems, ...audit.notes].join("؛ ") || "كل النماذج مصنفة ومربوطة",
      );
      const label = `جهة: ${profile.client_name}`;
      if (problems.length) add(`client:${profile.client_id}`, label, people ? "warn" : "fail", problems.join("، "));
      else add(`client:${profile.client_id}`, label, "ok", `تلقائي، ويعمل لها ${people} مستعلم`);
    }
    // The same lookup that sending a case uses, without creating one.
    await deps.matchInvestigators({ mode: "hierarchy", governorate: "القاهرة", client_id: profiles[0]?.client_id ?? null });
    await query("SELECT investigation_id FROM investigations WHERE mail_case_id=$1 LIMIT 1", ["system-check"]);
    add("dispatch", "البحث عن المستعلمين", "ok", "يعمل، ولم يُنشأ استعلام");
  } catch (error) {
    add("dispatch", "الجهات والمستعلمون", "fail", said(error));
  }
  return { lines };
}
