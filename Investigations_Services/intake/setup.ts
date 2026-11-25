import { query } from "../../IdentityAcess_Services/Config/db.ts";
import { ApiError } from "../../IdentityAcess_Services/Utils/http.ts";
import { INVESTIGATION_TYPES } from "../../Shared/templates/inventory.ts";
import { isBusinessKind, KIND_FORM_TYPE, KIND_LABELS, normalizeText, type CaseKind } from "./rules.ts";

/**
 * Linking every client in one step: an administrator uploads the private list of which
 * client writes from which domain, and each client's active forms are picked by their type.
 * The list never lives in the code (this repository is public).
 */

type Row = Record<string, unknown>;

interface FormRow {
  template_id: string;
  title: string;
  investigation_type?: string | null;
}

const ONE_VISIT: [kind: CaseKind, type: string, plainTitle: RegExp][] = [
  ["home", "residence", /^(استعلام |تقرير |نموذج )?(ال)?(سكن|منزل)$/],
  ["work", "employment", /^(استعلام |تقرير |نموذج )?(ال)?عمل$/],
  ["home_work", "residence_employment", /^(استعلام |تقرير |نموذج )?(ال)?(سكن|منزل) ?و ?(ال)?عمل$/],
  ["finishing", "finishing", /^(استعلام |تقرير |نموذج )?(ال)?تشطيب( وحده)?$/],
];

/** Whether a form of this type belongs in a slot (the general «ميداني» slot takes any business form). */
export function slotFits(kind: CaseKind, formType: string | null): boolean {
  if (!formType || kind === "business") return true;
  return !KIND_FORM_TYPE[kind] || KIND_FORM_TYPE[kind] === formType;
}

export interface AuditForm {
  template_id: string;
  title: string;
  investigation_type: string | null;
  /** An approved version is active: new investigations (and the email) can use it. */
  available: boolean;
}

const TYPE_NAME = new Map(INVESTIGATION_TYPES.map((type) => [type.code, type.name]));
const typeName = (code: string | null | undefined) => (code ? (TYPE_NAME.get(code) ?? code) : "غير مصنف");

/**
 * What to look at in one client's forms and email links, in Arabic. Nothing is changed:
 * a type that looks wrong is reported for head office to correct.
 */
export function auditClientForms(
  forms: AuditForm[],
  templates: Partial<Record<CaseKind, string>>,
  twoVisits: boolean,
): { problems: string[]; notes: string[] } {
  const problems: string[] = [];
  const notes: string[] = [];
  const byId = new Map(forms.map((form) => [form.template_id, form]));
  for (const form of forms) {
    const fromTitle = INVESTIGATION_TYPES.find((type) => type.test.test(form.title))?.code ?? null;
    if (!form.investigation_type) problems.push(`«${form.title}» غير مصنف`);
    else if (fromTitle && fromTitle !== form.investigation_type) {
      problems.push(`«${form.title}» مصنف «${typeName(form.investigation_type)}» والعنوان يقول «${typeName(fromTitle)}»`);
    }
    if (!form.available) problems.push(`«${form.title}» لا يوجد له إصدار معتمد مفعّل، فلا يصل إليه البريد`);
  }
  const available = forms.filter((form) => form.available);
  for (const [code, name] of TYPE_NAME) {
    const same = available.filter((form) => form.investigation_type === code);
    if (same.length > 1) problems.push(`نموذجان أو أكثر من نوع «${name}»: ${same.map((form) => `«${form.title}»`).join(" و")}؛ اختر واحدًا في الإعدادات`);
  }
  for (const [kind, id] of Object.entries(templates) as [CaseKind, string][]) {
    const form = byId.get(id);
    if (!form) problems.push(`«${KIND_LABELS[kind]}» مربوط بنموذج غير موجود أو متوقف`);
    else if (!form.available) problems.push(`«${KIND_LABELS[kind]}» مربوط بـ«${form.title}» بلا إصدار معتمد`);
    else if (!slotFits(kind, form.investigation_type)) {
      problems.push(`«${KIND_LABELS[kind]}» مربوط بـ«${form.title}» ونوعه «${typeName(form.investigation_type)}»`);
    }
  }
  const linked = new Set(Object.values(templates));
  for (const form of available) if (!linked.has(form.template_id)) problems.push(`«${form.title}» معتمد وغير مربوط بأي نوع طلب في البريد`);
  // «سكن وعمل»: one form for both, or two investigations.
  if (templates.home_work) notes.push("سكن وعمل: نموذج واحد واستعلام واحد");
  else if (templates.home && templates.work) {
    notes.push(twoVisits ? "سكن وعمل: استعلامان (سكن وعمل) يُرسلان معًا" : "سكن وعمل: استعلامان، وينتظران المراجعة حتى تُفعَّل «زيارتان»");
  } else if (templates.home || templates.work) {
    problems.push(`سكن وعمل: لا يوجد نموذج «${templates.home ? "عمل" : "سكن"}»، فتنتظر زيارته المراجعة`);
  }
  return { problems, notes };
}

/**
 * The form for each kind of request, only where there is no doubt which one it is. The others
 * are chosen by an administrator (in the settings or on the case).
 */
export function pickForms(forms: FormRow[]): Partial<Record<CaseKind, string>> {
  const typed = forms.map((form) => ({
    ...form,
    type: form.investigation_type ?? INVESTIGATION_TYPES.find((type) => type.test.test(form.title))?.code ?? null,
  }));
  const picked: Partial<Record<CaseKind, string>> = {};
  for (const [kind, type, plainTitle] of ONE_VISIT) {
    const options = typed.filter((form) => form.type === type);
    const plain = options.filter((form) => plainTitle.test(normalizeText(form.title)));
    const choice = options.length === 1 ? options[0] : plain.length === 1 ? plain[0] : undefined;
    if (choice) picked[kind] = choice.template_id;
  }
  // Each business visit gets the client's one form of that type (two of a type: chosen by hand).
  for (const kind of Object.keys(KIND_LABELS) as CaseKind[]) {
    if (!isBusinessKind(kind) || !KIND_FORM_TYPE[kind]) continue;
    const options = typed.filter((form) => form.type === KIND_FORM_TYPE[kind]);
    if (options.length === 1) picked[kind] = options[0]!.template_id;
  }
  const business = typed.filter((form) => ["company", "sme", "site_visit"].includes(form.type ?? ""));
  // A client with no company form but one merchant form («استعلام تجار» is filed as «تكويد تاجر»).
  const merchant = typed.filter((form) => ["merchant_coding", "business_owner"].includes(form.type ?? ""));
  if (business.length === 1) picked.business = business[0]!.template_id;
  else if (!business.length && merchant.length === 1) picked.business = merchant[0]!.template_id;
  return picked;
}

export interface SetupResult {
  client: string;
  name: string | null;
  linked: boolean;
  domains: string[];
  kinds: CaseKind[];
  problem: string | null;
}

export async function setupClients(
  input: unknown,
  autoSend: boolean,
  twoVisits: boolean,
  actorId: string,
): Promise<{ results: SetupResult[]; domains: string[] }> {
  if (!Array.isArray(input) || !input.length || input.length > 100) {
    throw ApiError.badRequest("الملف يجب أن يحتوي على قائمة clients", { field: "clients" });
  }
  const results: SetupResult[] = [];
  const linked: string[] = [];
  for (const entry of input as Row[]) {
    const client = String(entry?.client ?? "").trim().slice(0, 64);
    const domains = [
      ...new Set(
        (Array.isArray(entry?.domains) ? entry.domains : [])
          .map((domain) => String(domain).trim().toLowerCase().replace(/^.*@/, ""))
          // A public suffix («com.eg») would claim every company under it.
          .filter((domain) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) && !/^(com|co|org|net|gov|edu)\.[a-z]{2}$/.test(domain)),
      ),
    ].slice(0, 40);
    // The type for requests to an inbox that name none, e.g. {"sme": "sme"}.
    const inboxKinds = Object.fromEntries(
      Object.entries((entry?.inbox_kinds as Row | undefined) ?? {})
        .map(([inbox, kind]): [string, string] => [inbox.trim().toLowerCase(), String(kind)])
        .filter(([inbox, kind]) => /^[a-z0-9_-]{1,20}$/.test(inbox) && kind in KIND_LABELS),
    );
    const result: SetupResult = { client, name: null, linked: false, domains, kinds: [], problem: null };
    results.push(result);

    const [found] = await query("SELECT name FROM form_clients WHERE client_id=$1", [client]);
    if (!found) {
      result.problem = "الجهة غير موجودة في النظام";
      continue;
    }
    result.name = found.name as string;
    if (!domains.length) {
      result.problem = "لا يوجد دومين صحيح";
      continue;
    }
    const taken = await query(
      `SELECT c.name, d FROM mail_client_profiles p JOIN form_clients c ON c.client_id = p.client_id, unnest(p.domains) d
       WHERE p.client_id <> $1 AND d = ANY($2::text[])`,
      [client, domains],
    );
    if (taken.length) {
      result.problem = `الدومين ${taken[0]!.d} مربوط بـ ${taken[0]!.name}`;
      continue;
    }
    const forms = (await query(
      `SELECT t.template_id, t.title, t.investigation_type FROM form_templates t
       JOIN template_versions v ON v.version_id = t.active_version_id AND v.status = 'active'
       WHERE t.active AND t.client_id = $1 ORDER BY t.title`,
      [client],
    )) as unknown as FormRow[];
    const [existing] = await query("SELECT domains, templates, inbox_kinds FROM mail_client_profiles WHERE client_id=$1", [client]);
    const active = new Set(forms.map((form) => form.template_id));
    // A form already chosen stays while it is active and still of that slot's type: after head
    // office corrects a form's type, its old link (QNB «تقرير عمل» as «تكويد شركات») goes.
    const typeOf = new Map(forms.map((form) => [form.template_id, form.investigation_type ?? null]));
    const chosen = Object.fromEntries(
      Object.entries((existing?.templates as Record<string, string> | undefined) ?? {}).filter(
        ([kind, id]) => active.has(id) && slotFits(kind as CaseKind, typeOf.get(id) ?? null),
      ),
    );
    const templates = { ...pickForms(forms), ...chosen };
    const merged = [...new Set([...((existing?.domains as string[] | undefined) ?? []), ...domains])];
    await query(
      `INSERT INTO mail_client_profiles(client_id, domains, templates, auto_send, two_visits, active, updated_by, inbox_kinds, updated_at)
       VALUES($1,$2,$3::text::jsonb,$4,$5,true,$6,$7::text::jsonb,now())
       ON CONFLICT (client_id) DO UPDATE SET domains=$2, templates=$3::text::jsonb, auto_send=$4, two_visits=$5, active=true,
         updated_by=$6, inbox_kinds=$7::text::jsonb, updated_at=now()`,
      [
        client,
        merged,
        JSON.stringify(templates),
        autoSend,
        twoVisits,
        actorId,
        JSON.stringify({ ...((existing?.inbox_kinds as Row | undefined) ?? {}), ...inboxKinds }),
      ],
    );
    result.linked = true;
    result.domains = merged;
    result.kinds = Object.keys(templates) as CaseKind[];
    if (!result.kinds.length) result.problem = "لا يوجد نموذج معتمد مناسب: يُختار لكل حالة";
    linked.push(...merged);
  }
  return { results, domains: linked };
}
