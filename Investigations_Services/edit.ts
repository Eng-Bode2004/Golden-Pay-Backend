/**
 * An admin edits an investigation after it was sent: the subject's details, the area, the
 * type (normal/fast/appointment), the form. Approved and cancelled cases stay as they are.
 * The price follows head office's price list again when the client, area or type changes;
 * a new form keeps the answers whose fields it also has. Moving the case to a new area may
 * take it back from its investigator, but only before work started, and only when asked.
 */
import { query, transaction } from "../IdentityAcess_Services/Config/db.ts";
import { ApiError } from "../IdentityAcess_Services/Utils/http.ts";
import { optionalNumber, optionalText } from "../Shared/service.ts";
import { notify } from "../Shared/notifications.ts";
import { canonicalNames } from "../Shared/places.ts";
import { allFields, type TemplateDefinition } from "../Shared/templates/definition.ts";
import { endAssignment, logEvent, offerNext } from "./dispatch.ts";
import { findServiceLevel } from "./finance.ts";
import { quotePrice, type Quote } from "./pricing.ts";

type Row = Record<string, unknown>;

export const AREA_LEVELS = ["governorate", "district", "local_unit", "main_village", "sub_village"] as const;
/** Plain text the admin may change, with its length limit; null means required. */
const TEXT_FIELDS = {
  subject_name: 160,
  subject_phone: 30,
  client_reference: 80,
  address: 400,
  landmark: 300,
  admin_notes: 2000,
} as const;
/** Changes the investigator is not told about. */
const HIDDEN_FROM_INVESTIGATOR = /price|phone/;
const REQUIRED = new Set(["subject_name", "address"]);
/** Statuses an edit may touch: everything until the case is approved or cancelled. */
export const EDITABLE = ["open", "unassigned", "assigned", "in_progress", "submitted", "returned"] as const;
/** Statuses where «أعد الإرسال» may take the case back: nobody started working on it yet. */
export const RESENDABLE = ["open", "unassigned", "assigned"] as const;

export const FIELD_LABELS: Record<string, string> = {
  subject_name: "اسم العميل",
  subject_phone: "الهاتف",
  client_reference: "رقم العميل لدى الجهة",
  address: "العنوان",
  landmark: "علامة مميزة",
  admin_notes: "ملاحظات الإدارة",
  governorate: "المحافظة",
  district: "المركز/الحي",
  local_unit: "الوحدة المحلية",
  main_village: "القرية الأم",
  sub_village: "التابع",
  lat: "خط العرض",
  lng: "خط الطول",
  service_level: "نوع الاستعلام",
  appointment_at: "الموعد",
  customer_knowledge: "علم العميل",
  template_id: "النموذج",
  client_price: "سعر الجهة",
  investigator_price: "سعر المستعلم",
  due_at: "موعد التسليم",
};

export interface EditDeps {
  /** The form's active approved version (same lookup a new case uses). */
  activeTemplate: (templateId: string) => Promise<Row>;
  /** The investigators of an area who work for the client. */
  match: (filter: Row) => Promise<string[]>;
  /** The form definition stored on a case or a version (old layouts upgraded). */
  definitionOf: (snapshot: unknown) => TemplateDefinition;
}

export interface Change {
  field: string;
  label: string;
  before: unknown;
  after: unknown;
}

export interface EditResult {
  saved: boolean;
  changes: Change[];
  /** What happened beside the field changes, in Arabic, for the admin. */
  notes: string[];
  resent: boolean;
  dropped_answers: string[];
  reference: string;
}

const same = (a: unknown, b: unknown) => {
  if (a instanceof Date || b instanceof Date) {
    const x = a ? new Date(a as string).getTime() : null;
    const y = b ? new Date(b as string).getTime() : null;
    return x === y;
  }
  if (typeof a === "number" || typeof b === "number") return a === null || b === null ? a === b : Number(a) === Number(b);
  return (a ?? null) === (b ?? null);
};

/** Where a re-sent case goes: an area case's new area and its investigators (checked before saving). */
interface Resend {
  area: Row | null;
  recipients: string[];
}

/** The case's own type, even if head office has retired it since. */
async function currentLevel(code: string): Promise<Row> {
  const [row] = await query("SELECT * FROM service_levels WHERE code=$1", [code]);
  if (!row) throw ApiError.badRequest("Choose an investigation type", { field: "service_level" });
  return row;
}

/** The answers a new form can keep: those whose field key the new form also has. */
export function carryAnswers(answers: Row | null, keys: Set<string>): { kept: Row; dropped: string[] } {
  const kept: Row = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(answers ?? {})) {
    if (keys.has(key)) kept[key] = value;
    else if (value !== null && value !== "" && !(Array.isArray(value) && !value.length)) dropped.push(key);
  }
  return { kept, dropped };
}

/** The deadline for a type: the appointment if any, otherwise from when the case was sent. */
export function deadlineFor(level: Row, appointment: Date | null, createdAt: Date): Date {
  if (appointment) return appointment;
  if (level.delivery_hours === null || level.delivery_hours === undefined) {
    throw ApiError.badRequest("Choose the appointment for a scheduled investigation", { field: "appointment_at" });
  }
  return new Date(createdAt.getTime() + Number(level.delivery_hours) * 3_600_000);
}

function dateOrNull(value: unknown, field: string): Date | null {
  const text = optionalText(value, 40);
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw ApiError.badRequest(`${field} must be a date`, { field });
  return date;
}

/**
 * Edits one case. With `preview` nothing is saved: the answer lists what would change
 * (prices and deadline included) so the admin sees it before pressing save.
 */
export async function editCase(
  investigationId: string,
  body: Row,
  actorId: string,
  deps: EditDeps,
  preview: boolean,
): Promise<EditResult> {
  const result = await transaction(async () => {
    const [item] = await query("SELECT * FROM investigations WHERE investigation_id=$1 FOR UPDATE", [investigationId]);
    if (!item) throw ApiError.notFound("Investigation not found");
    if (!(EDITABLE as readonly string[]).includes(item.status as string)) {
      throw new ApiError(409, "INVESTIGATION_LOCKED", "An approved or cancelled investigation cannot be edited");
    }
    const next: Row = {};
    const notes: string[] = [];

    for (const [field, max] of Object.entries(TEXT_FIELDS)) {
      if (!(field in body)) continue;
      const value = optionalText(body[field], max);
      if (REQUIRED.has(field) && !value) throw ApiError.badRequest(`${field} is required`, { field });
      next[field] = value;
    }
    for (const field of ["lat", "lng"] as const) {
      if (field in body) next[field] = optionalNumber(body[field], field);
    }
    const lat = ("lat" in next ? next.lat : item.lat) as number | null;
    const lng = ("lng" in next ? next.lng : item.lng) as number | null;
    if ((lat === null) !== (lng === null) || (lat !== null && (Math.abs(lat) > 90 || Math.abs(lng!) > 180))) {
      throw ApiError.badRequest("Give both lat and lng, or neither", { field: "lat" });
    }

    // The area: each name snapped to the existing place, like a new case.
    if (AREA_LEVELS.some((level) => level in body)) {
      const typed = Object.fromEntries(
        AREA_LEVELS.map((level) => [level, level in body ? optionalText(body[level], 120) : ((item[level] as string | null) ?? null)]),
      ) as Record<(typeof AREA_LEVELS)[number], string | null>;
      if (!typed.governorate) throw ApiError.badRequest("Choose the governorate", { field: "governorate" });
      const place = await canonicalNames(typed, { strictGovernorate: false });
      for (const level of AREA_LEVELS) next[level] = place[level] ?? null;
    }

    // The form: its active approved version; the client follows the form.
    let template: Row | null = null;
    const templateId = optionalText(body.template_id, 64);
    if (templateId && templateId !== item.template_id) {
      template = await deps.activeTemplate(templateId);
      if (!template.version_id || template.active === false) {
        throw new ApiError(409, "TEMPLATE_NOT_ACTIVE", "This form has no approved version for new investigations");
      }
      next.template_id = template.template_id;
    }
    const clientId = (template ? template.client_id : item.client_id) as string | null;

    // The type, the appointment and the customer's knowledge.
    const levelCode = optionalText(body.service_level, 40);
    const levelChanged = Boolean(levelCode && levelCode !== item.service_level);
    // A new type must be active; the case's own type is kept even if head office retired it since.
    const level = levelChanged ? await findServiceLevel(levelCode!) : await currentLevel(item.service_level as string);
    if (levelChanged) next.service_level = level.code;
    if ("appointment_at" in body) next.appointment_at = dateOrNull(body.appointment_at, "appointment_at");
    if ("customer_knowledge" in body) {
      const knowledge = body.customer_knowledge;
      next.customer_knowledge = knowledge === "with" || knowledge === "without" ? knowledge : null;
    }
    const appointment = ("appointment_at" in next ? next.appointment_at : item.appointment_at) as Date | null;
    if ("appointment_at" in next || levelChanged) {
      next.due_at = deadlineFor(level, appointment ? new Date(appointment) : null, new Date(item.created_at as string));
    }

    // Prices again from head office's list when what they depend on changed.
    const governorate = (next.governorate ?? item.governorate) as string | null;
    const district = ("district" in next ? next.district : item.district) as string | null;
    const pricing =
      levelChanged ||
      (template && template.client_id !== item.client_id) ||
      ("governorate" in next && !same(next.governorate, item.governorate)) ||
      ("district" in next && !same(next.district, item.district));
    let quote: Quote | null = null;
    if (pricing) {
      quote = await quotePrice(level, clientId, governorate, district);
      next.client_price = quote.client_price;
      next.investigator_price = quote.investigator_price;
    }

    const changes: Change[] = Object.entries(next)
      .filter(([field, value]) => !same(value, item[field]))
      .map(([field, value]) => ({
        field,
        label: FIELD_LABELS[field] ?? field,
        before: field === "template_id" ? item.form_title : item[field],
        after: field === "template_id" ? template?.title : value,
      }));

    // A new form keeps what the investigator typed for the fields it also has.
    let dropped: string[] = [];
    let keptAnswers: Row | null = null;
    if (template) {
      const keys = new Set(allFields(deps.definitionOf(template.definition)).map((field) => field.key));
      const carried = carryAnswers(item.answers as Row | null, keys);
      keptAnswers = carried.kept;
      dropped = carried.dropped;
      if (dropped.length) notes.push(`تُحذف ${dropped.length} إجابة ليست في النموذج الجديد؛ الصور تبقى.`);
    }

    // Re-sending to the new area, only when asked and only before work started.
    const placeMoved = changes.some((change) => (AREA_LEVELS as readonly string[]).includes(change.field) || change.field === "address");
    const resend = body.resend === true;
    let target: Resend | null = null;
    if (resend) {
      if (!(RESENDABLE as readonly string[]).includes(item.status as string)) {
        throw new ApiError(
          409,
          "INVESTIGATION_STARTED",
          "The investigator already started this case; it stays with them (use reassign to move it)",
        );
      }
      target = { area: null, recipients: [] };
      // An area case is offered only to the new area's investigators: there must be some.
      if (item.target_mode === "area") {
        const area = {
          mode: "hierarchy",
          ...Object.fromEntries(AREA_LEVELS.map((level) => [level, level in next ? next[level] : item[level]])),
        };
        const recipients = await deps.match({ ...area, client_id: clientId });
        if (!recipients.length) {
          throw new ApiError(409, "NO_INVESTIGATORS_IN_AREA", "No investigator in the new area works for this company or bank");
        }
        target = { area, recipients };
        notes.push(`يُعرض على ${recipients.length} مستعلم في المنطقة الجديدة.`);
      }
      if (item.assignee_id) notes.push("يُسحب الاستعلام من المستعلم الحالي ويُعرض في المنطقة الجديدة.");
      else notes.push("تُغلق العروض الحالية ويُعرض في المنطقة الجديدة.");
    } else if (placeMoved && item.assignee_id) {
      notes.push("يبقى الاستعلام مع المستعلم الحالي، ويُنبَّه بالتعديل.");
    }
    if (item.pdf_path && changes.length) {
      notes.push(item.report_edited_at ? "التقرير معدَّل يدويًا فلن يُعاد بناؤه؛ ابنه من جديد إن أردت." : "يُعاد بناء التقرير بالبيانات الجديدة.");
    }

    if (!changes.length && !resend) {
      return { saved: false, changes, notes, resent: false, dropped_answers: dropped, reference: item.reference as string, item, target };
    }
    if (preview) {
      return { saved: false, changes, notes, resent: resend, dropped_answers: dropped, reference: item.reference as string, item, target };
    }

    // Save the fields (the case keeps its own copy of the new form, like a new case).
    const columns: Row = { ...next };
    delete columns.template_id;
    if (template) {
      Object.assign(columns, {
        template_id: template.template_id,
        client_id: template.client_id,
        client_name: template.client_name,
        form_title: template.title,
        form_snapshot: JSON.stringify(template.definition),
        template_version_id: template.version_id,
        template_version_no: template.version_no,
        template_hash: template.content_hash ?? null,
        investigation_type: template.investigation_type ?? null,
        answers: JSON.stringify(keptAnswers ?? {}),
      });
    }
    if (quote) columns.price_rule_id = quote.rule_id;
    if (levelChanged) {
      columns.service_name = level.name_ar;
      columns.accept_minutes = level.accept_minutes;
    }
    const names = Object.keys(columns);
    if (names.length) {
      const sets = names.map((name, index) =>
        ["form_snapshot", "answers"].includes(name) ? `${name}=$${index + 2}::text::jsonb` : `${name}=$${index + 2}`,
      );
      await query(`UPDATE investigations SET ${sets.join(", ")}, updated_at=now() WHERE investigation_id=$1`, [
        investigationId,
        ...names.map((name) => columns[name]),
      ]);
    }
    const summary = changes.map((change) => change.label).join("، ");
    await logEvent(investigationId, "edited", null, actorId, summary ? `عدّلت الإدارة: ${summary}` : null);
    return { saved: true, changes, notes, resent: resend, dropped_answers: dropped, reference: item.reference as string, item, target };
  });

  const { item, target, ...answer } = result;
  if (!result.saved) return answer;

  if (result.resent && target) await resendCase(investigationId, item, actorId, target);
  else if (item.assignee_id && result.changes.some((change) => !HIDDEN_FROM_INVESTIGATOR.test(change.field))) {
    // The investigator is told what changed, never the client's price or the customer's phone.
    const told = result.changes.filter((change) => !HIDDEN_FROM_INVESTIGATOR.test(change.field));
    await notify(item.assignee_id as string, {
      kind: "case_edited",
      title: "عُدّلت بيانات استعلام",
      body: `عدّلت الإدارة ${told.map((change) => change.label).join("، ")} في الاستعلام ${item.reference}.`,
      investigation_id: investigationId,
    });
  }
  return answer;
}

/** Closes the case's offers or takes it back from its investigator, then offers it in its (new) area. */
async function resendCase(investigationId: string, before: Row, actorId: string, target: Resend): Promise<void> {
  const person = await transaction(async () => {
    const [item] = await query("SELECT * FROM investigations WHERE investigation_id=$1 FOR UPDATE", [investigationId]);
    if (!item || !(RESENDABLE as readonly string[]).includes(item.status as string)) {
      throw new ApiError(409, "INVESTIGATION_STARTED", "The case changed meanwhile; open it again");
    }
    if (target.area) {
      const { area, recipients } = target;
      await query("DELETE FROM investigation_recipients WHERE investigation_id=$1", [investigationId]);
      for (const user of recipients) {
        await query("INSERT INTO investigation_recipients(investigation_id,user_id) VALUES($1,$2)", [investigationId, user]);
      }
      await query("UPDATE investigations SET area_filter=$2::text::jsonb WHERE investigation_id=$1", [
        investigationId,
        JSON.stringify(area),
      ]);
    }
    const previous = (item.assignee_id as string | null) ?? null;
    if (previous) await endAssignment(investigationId, "reassigned", actorId, "نُقل لمنطقة جديدة بعد تعديل البيانات");
    const closed = await query(
      `UPDATE investigation_offers SET response='cancelled', responded_at=now(), reason='case_edited'
       WHERE investigation_id=$1 AND response IS NULL RETURNING user_id`,
      [investigationId],
    );
    const [moved] = await query(
      `UPDATE investigations SET status='open', assignee_id=NULL, claimed_at=NULL, started_at=NULL,
         dispatch_round = dispatch_round + 1, updated_at=now() WHERE investigation_id=$1 RETURNING dispatch_round`,
      [investigationId],
    );
    const told = [...closed.map((row) => row.user_id as string), ...(previous ? [previous] : [])];
    for (const user of new Set(told)) {
      await query(
        `INSERT INTO dispatch_outbox(user_id, investigation_id, kind, round) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [user, investigationId, user === previous ? "taken_back" : "offer_closed", moved?.dispatch_round],
      );
    }
    await logEvent(investigationId, "redispatched", null, actorId, "أُعيد الإرسال بعد تعديل البيانات");
    return previous;
  });
  if (person) {
    await notify(person, {
      kind: "taken_back",
      title: "سُحب منك الاستعلام",
      body: `عدّلت الإدارة عنوان الاستعلام ${before.reference} فأُرسل لمنطقته الجديدة.`,
      investigation_id: investigationId,
    });
  }
  await offerNext(investigationId);
}
