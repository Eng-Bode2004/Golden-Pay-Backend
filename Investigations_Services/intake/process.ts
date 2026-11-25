import { query } from "../../IdentityAcess_Services/Config/db.ts";
import { getStoredFile } from "../../IdentityAcess_Services/Utils/files.ts";
import { canonicalNames } from "../../Shared/places.ts";
import { readXlsx } from "../../Shared/xlsx.ts";
import { addressWords, buildAddressIndex, findPlace, type AddressIndex, type PlaceName } from "./address-place.ts";
import { aiConfigured, readWithAi } from "./ai.ts";
import { gatherFiles, isCsv, isDecoration, isPdf, isXlsx, type Attachment } from "./files.ts";
import {
  aboutEarlierCases,
  cleanText,
  DEFAULT_FAST_WORDS,
  DEFAULT_IGNORE_WORDS,
  APPOINTMENT_NEEDED,
  detectFast,
  detectKnowledge,
  formFor,
  isBusinessKind,
  domainMatches,
  findNationalId,
  freshBody,
  isForward,
  isNationalId,
  isReplySubject,
  isSystemMail,
  KIND_LABELS,
  kindOfRow,
  kindsOverlap,
  normalizeMobile,
  normalizeText,
  requestKind,
  samePerson,
  sendTime,
  STALE_HOURS,
  visitsFor,
  type CaseKind,
} from "./rules.ts";
import { casesFromGrid, csvGrid, htmlTables, isTrackerGrid, looksComplete, type ExtractedCase } from "./tables.ts";

/**
 * One stored email → the people to investigate. A case goes out by itself only when nothing
 * is in doubt; everything else waits for an administrator with the reason in Arabic.
 */

type Row = Record<string, unknown>;

export interface Profile {
  client_id: string;
  client_name: string;
  domains: string[];
  templates: Partial<Record<CaseKind, string>>;
  fast_words: string[];
  normal_level: string;
  fast_level: string;
  auto_send: boolean;
  two_visits: boolean;
  ignore_words: string[];
  /** The type when the email says none, by inbox. */
  inbox_kinds: Record<string, CaseKind>;
}

export async function loadProfiles(): Promise<Profile[]> {
  return (await query(
    `SELECT p.client_id, c.name AS client_name, p.domains, p.templates, p.fast_words, p.normal_level, p.fast_level,
       p.auto_send, p.two_visits, p.ignore_words, p.inbox_kinds
     FROM mail_client_profiles p JOIN form_clients c ON c.client_id = p.client_id WHERE p.active`,
  )) as unknown as Profile[];
}

/** How sure the AI reading must be before a case goes out without a person looking. */
const AUTO_CONFIDENCE = Number(process.env.MAIL_AUTO_CONFIDENCE || 0.85);
/** More rows than any client's daily batch: a tracker or a monthly list, not new requests. */
const BATCH_LIMIT = 80;
/** A failed reading (AI or storage down) is tried again after these many minutes. */
const RETRY_MINUTES = [5, 30, 120];

// ───────────── places ─────────────

let places: { at: number; index: AddressIndex; governorates: Set<string> } | null = null;

async function placeIndex() {
  if (places && Date.now() - places.at < 10 * 60_000) return places;
  const rows = (await query(
    `SELECT d.name, d.level, g.name AS governorate FROM geo_locations d
     LEFT JOIN geo_locations g ON g.location_id = d.parent_id WHERE d.level IN (1, 2)`,
  )) as unknown as PlaceName[];
  places = {
    at: Date.now(),
    index: buildAddressIndex(rows),
    governorates: new Set(rows.filter((row) => row.level === 1).map((row) => row.name)),
  };
  return places;
}

// ───────────── reading one email ─────────────

const htmlToText = (value: string) =>
  value
    .replace(/<br\s*\/?>|<\/(p|div|tr|li)>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d{1,6});/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n");

/** The governorate and district an address names, for a visit an administrator adds. */
export async function placeOfAddress(address: string): Promise<{ governorate: string | null; district: string | null }> {
  const found = findPlace(address, (await placeIndex()).index);
  return { governorate: found.governorate ?? null, district: found.district ?? null };
}

/** The client's type for requests to this inbox that name none. */
export function inboxKind(profile: Pick<Profile, "inbox_kinds">, inbox: string | null): CaseKind | null {
  const kind = inbox ? profile.inbox_kinds?.[inbox] : undefined;
  return kind && kind in KIND_LABELS ? kind : null;
}

export interface ProcessOutcome {
  status: string;
  reason: string | null;
  cases: number;
}

/**
 * Turns one stored email into cases (or a clear reason why not). Safe to run again.
 * `rethrow` is for the system check, which needs the real error.
 */
export async function processMessage(messageId: string, options: { rethrow?: boolean } = {}): Promise<ProcessOutcome> {
  // One reader at a time: the timer and «read again» never work on the same email together.
  const [message] = await query(
    `UPDATE mail_messages SET status='processing', processing_since=now()
     WHERE message_id=$1 AND status <> 'processing' RETURNING *`,
    [messageId],
  );
  if (!message) return { status: "processing", reason: null, cases: 0 };
  try {
    const outcome = await read(message);
    await query(
      "UPDATE mail_messages SET status=$2, reason=$3, processed_at=now(), attempts=0, retry_at=NULL WHERE message_id=$1",
      [messageId, outcome.status, outcome.reason],
    );
    return outcome;
  } catch (error) {
    if (options.rethrow) throw error;
    const attempt = Number(message.attempts ?? 0);
    const wait = RETRY_MINUTES[attempt];
    const detail = error instanceof Error ? error.message : String(error);
    const next = wait === undefined ? "توقفت المحاولات: أضف الأشخاص يدويًا" : `تُعاد المحاولة بعد ${wait} دقيقة`;
    const reason = cleanText(`تعذّرت قراءة البريد (${next}): ${detail}`.slice(0, 500));
    await query(
      `UPDATE mail_messages SET status='failed', reason=$2, processed_at=now(), attempts=$3, retry_at=$4
       WHERE message_id=$1`,
      [messageId, reason, attempt + 1, wait === undefined ? null : new Date(Date.now() + wait * 60_000)],
    );
    return { status: "failed", reason, cases: 0 };
  }
}

type Found = ExtractedCase & { source: string };

async function read(message: Row): Promise<ProcessOutcome> {
  const subject = String(message.subject ?? "");
  const from = (message.from_address as string | null) ?? null;
  if (isSystemMail(from, subject)) return { status: "ignored", reason: "رسالة نظام (فشل توصيل أو رد آلي)", cases: 0 };

  const profiles = await loadProfiles();
  const domain = (message.from_domain as string | null) ?? "";
  const profile = profiles.find((p) => domainMatches(domain, p.domains)) ?? null;
  if (!profile) return { status: "unknown_sender", reason: `الدومين ${domain || "—"} غير مربوط بأي جهة`, cases: 0 };
  await query("UPDATE mail_messages SET client_id=$2 WHERE message_id=$1", [message.message_id, profile.client_id]);
  // A forged sender never becomes an address that reports are sent to.
  if (message.sender_verified === true) await learnContacts(profile.client_id, message);

  // One email sent to two of our inboxes is one request.
  if (message.header_message_id) {
    const [copy] = await query(
      `SELECT inbox FROM mail_messages WHERE header_message_id=$1 AND from_address=$2 AND message_id <> $3 AND created_at < $4 LIMIT 1`,
      [message.header_message_id, from, message.message_id, message.created_at],
    );
    if (copy) return { status: "ignored", reason: `نسخة من بريد وصل على ${copy.inbox}`, cases: 0 };
  }
  // Replies are conversation, except that some clients send each day's batch as a reply in
  // their monthly thread: a spreadsheet in a reply is read, and a person confirms it is new.
  const replied = isReplySubject(subject);

  const rawBody = String(message.body_text ?? "");
  const isHtml = /<table/i.test(rawBody);
  const forwarded = isForward(subject);
  const plain = isHtml ? htmlToText(rawBody) : rawBody;
  // A forwarded request lives below the forward line; a direct one above any quoted history.
  const bodyText = forwarded ? plain.trim() : freshBody(plain);
  const ignoreWords = [...DEFAULT_IGNORE_WORDS, ...profile.ignore_words];
  if (ignoreWords.some((word) => normalizeText(subject).includes(normalizeText(word)))) {
    return { status: "ignored", reason: "يحتوي على كلمة تجاهل لهذه الجهة", cases: 0 };
  }

  const emailKind = requestKind(subject, plain);
  const emailKnowledge = detectKnowledge(`${subject}
${bodyText}`);
  const emailFast = detectFast(`${subject}\n${bodyText}`, profile.fast_words.length ? profile.fast_words : DEFAULT_FAST_WORDS);
  const attachments = ((message.attachments as Attachment[]) ?? []).filter((file) => !isDecoration(file));
  if (replied && !attachments.some((file) => isXlsx(file) || isCsv(file) || isPdf(file) || /\.docx?$/i.test(file.name))) {
    return { status: "reply", reason: "رد على رسالة سابقة", cases: 0 };
  }
  // Reasons that hold every case of this email for a person.
  const holds: string[] = [];

  // 1. Tables: Excel, CSV and tables in the body are read exactly, without AI.
  let cases: Found[] = [];
  for (const file of attachments.filter((item) => isXlsx(item) || isCsv(item))) {
    const bytes = await getStoredFile(file.path);
    try {
      const grids = isXlsx(file) ? readXlsx(bytes).map((sheet) => sheet.rows) : [csvGrid(new TextDecoder().decode(bytes))];
      for (const grid of grids) {
        const found = casesFromGrid(grid);
        if (found.length && isTrackerGrid(grid)) holds.push("جدول متابعة أو حساب لطلبات سابقة");
        cases.push(...found.map((item) => ({ ...item, source: `excel:${file.name}` })));
      }
    } catch {
      holds.push(`تعذّرت قراءة ملف ${file.name}`);
    }
  }
  // A reply's tables are the quoted history; only the spreadsheets it attaches can be new.
  if (isHtml && !replied) {
    for (const grid of htmlTables(forwarded ? rawBody : freshBodyHtml(rawBody))) {
      cases.push(...casesFromGrid(grid).map((item) => ({ ...item, source: "body-table" })));
    }
  }

  // 2. Everything else (handwritten photos, scans, PDFs, free text): the AI reader.
  // Rows read exactly are never replaced by a model's reading: incomplete rows go to review.
  if (replied) {
    if (!cases.length) return { status: "review", reason: "رد فيه مرفق: إن كان طلبًا جديدًا أضف الشخص", cases: 0 };
    holds.push("وصل داخل رد: تأكد أنه طلب جديد");
  } else if (cases.some(looksComplete)) {
    if (attachments.some(isPdf)) holds.push("في البريد ملفات PDF لم تُقرأ مع الجدول");
  } else if (!aiConfigured()) {
    if (!cases.length) return { status: "review", reason: "يحتاج قراءة يدوية (القراءة الذكية غير مفعّلة): أضف الأشخاص", cases: 0 };
  } else if (cases.length <= BATCH_LIMIT) {
    const { unread, ...files } = await gatherFiles(attachments, getStoredFile);
    if (unread.length) holds.push(`مرفقات لم تُقرأ: ${unread.slice(0, 4).join(" / ")}`);
    const texts = [...files.texts];
    // Tables already read are given to the model as text, so it does not read them twice.
    if (cases.length) {
      texts.push({ name: "rows already read from tables", text: JSON.stringify(cases.map(({ source: _s, ...row }) => row)) });
    }
    const result = await readWithAi({ clientName: profile.client_name, subject, body: bodyText, ...files, texts });
    await query("UPDATE mail_messages SET ai_used=true WHERE message_id=$1", [message.message_id]);
    if (!result.is_case_request && !cases.length) {
      // Dropping a request is worse than one extra look, so an unread file always gets one.
      return unread.length
        ? { status: "review", reason: holds.join("، "), cases: 0 }
        : { status: "ignored", reason: result.not_case_reason || "ليست طلب استعلام", cases: 0 };
    }
    if (result.cases.length) cases = result.cases.map((item) => ({ ...item, doubts: [...(item.doubts ?? [])], source: "ai" }));
    // Clients that type the ID in the subject: the typed one beats a reading of handwriting.
    const typedId = findNationalId(subject);
    const only = cases.length === 1 ? cases[0]! : null;
    if (only?.source === "ai" && typedId) {
      if (only.national_id && findNationalId(only.national_id) !== typedId) {
        only.doubts.push("الرقم القومي في الصورة يختلف عن الموضوع");
      }
      only.national_id = typedId;
    }
  }
  if (!cases.length) {
    return { status: "review", reason: [...holds, "لم يُعثر على أشخاص في البريد: أضفهم يدويًا"].join("، "), cases: 0 };
  }

  if (cases.length > BATCH_LIMIT) holds.push(`قائمة كبيرة (${cases.length}): غالبًا ليست طلبات جديدة`);
  if (aboutEarlierCases(subject)) holds.push("الموضوع عن طلبات سابقة (تذكير أو تعديل أو متابعة)");
  if (message.sender_verified !== true) holds.push("لم يؤكد خادم البريد هوية المرسل");
  if (!profile.auto_send) holds.push("هذه الجهة مضبوطة على المراجعة اليدوية");
  const now = new Date();
  const received = new Date(message.received_at as string);
  if (now.getTime() - received.getTime() > STALE_HOURS * 3_600_000) {
    holds.push("بريد قديم: تأكد أنه لم يُسجَّل يدويًا");
  }
  const releaseAt = sendTime(received, now);

  // 3. Each visit becomes a case: checked, placed, timed.
  await query("DELETE FROM mail_cases WHERE message_id=$1 AND status IN ('review','ready','failed') AND source IS DISTINCT FROM 'manual'", [message.message_id]);
  // Reading again never repeats a person already sent or rejected from this email.
  const handled = await query("SELECT kind, fields FROM mail_cases WHERE message_id=$1", [message.message_id]);
  const earlier = await query(
    `SELECT kind, fields FROM mail_cases WHERE client_id=$1 AND message_id <> $2 AND status <> 'rejected'
       AND created_at > now() - interval '30 days'`,
    [profile.client_id, message.message_id],
  );
  // While the team still books some requests by hand, those must not be sent a second time.
  const byHand = await query(
    `SELECT subject_name FROM investigations WHERE client_id=$1 AND source <> 'email' AND status <> 'cancelled'
       AND created_at > now() - interval '30 days'`,
    [profile.client_id],
  );
  const inThisEmail: { kind: CaseKind | null; fields: CaseFields }[] = [];
  let added = 0;
  let ready = 0;
  for (const item of cases) {
    const fromTable = item.source !== "ai";
    // The email's words, else the client's rule for this inbox (QNB's SME inbox: the SME form).
    const stated = item.kind ?? emailKind ?? inboxKind(profile, message.inbox as string | null);
    const asked = stated ?? (fromTable ? kindOfRow(item) : null);
    const visits = visitsFor(asked, profile.templates);
    for (const kind of visits) {
      const split = visits.length > 1;
      const { fields, doubts } = await placed(item, kind, split);
      const repeats = (other: { kind?: unknown; fields?: unknown }) =>
        samePerson(fields, other.fields as Record<string, unknown>) &&
        kindsOverlap(kind, (other.kind as CaseKind | null) ?? null);
      if (handled.some(repeats)) continue;
      const twin = inThisEmail.filter(repeats);
      // The same row twice (the body table and its Excel copy) is one case.
      const sameAddress = (other: string | null) => addressWords(other ?? "").join(" ") === addressWords(fields.address ?? "").join(" ");
      if (twin.some((other) => other.kind === kind && sameAddress(other.fields.address))) continue;
      inThisEmail.push({ kind, fields });
      added += 1;

      // In a split, «no address» is judged for each visit on its own.
      const own = split ? item.doubts.filter((doubt) => doubt !== "لا يوجد عنوان") : item.doubts;
      const reasons = [...holds, ...own, ...doubts];
      // What to visit decides the form and the price, so a guess is always confirmed by a person.
      if (!stated && kind) reasons.push("النوع مستنتج من العناوين: تأكد منه");
      if (split && !profile.two_visits) reasons.push("زيارتان بسعرين: تأكد أنهما مطلوبتان");
      if (twin.length) reasons.push("الشخص مكرر في نفس البريد");
      if (earlier.some(repeats)) reasons.push("طلب مكرر محتمل: وصل لنفس الشخص خلال 30 يومًا");
      if (byHand.some((other) => samePerson({ subject_name: fields.subject_name }, other))) {
        reasons.push("مسجّل يدويًا لنفس الجهة خلال 30 يومًا");
      }
      if (!fromTable && !(item.confidence >= AUTO_CONFIDENCE)) reasons.push("القراءة غير مؤكدة");
      if (!fields.subject_name) reasons.push("لا يوجد اسم");
      else if (!isBusinessKind(kind) && fields.subject_name.trim().split(/\s+/).length < 2) reasons.push("الاسم غير كامل");
      if (!fields.address) reasons.push(split && kind === "work" ? "لا يوجد عنوان عمل" : "لا يوجد عنوان");
      else if (fields.address.length < 8) reasons.push("العنوان غير كافٍ");
      if (fields.national_id && !isNationalId(fields.national_id)) reasons.push("الرقم القومي غير صحيح");
      if (!fields.governorate) reasons.push("المحافظة غير معروفة");
      if (!kind) reasons.push("نوع الاستعلام غير محدد");
      else {
        const form = formFor(profile.templates, kind);
        if (!form) reasons.push(`لا يوجد نموذج «${KIND_LABELS[kind]}» لهذه الجهة`);
        else if (form.fallback) reasons.push(`لا يوجد نموذج «${KIND_LABELS[kind]}» لهذه الجهة: سيُستخدم نموذج «${KIND_LABELS.business}»، تأكد منه`);
      }
      // The customer expects the visit: an administrator calls them and sets the time first.
      if (emailKnowledge === "with") reasons.push(APPOINTMENT_NEEDED);

      const unique = [...new Set(reasons.map(cleanText))];
      const status = unique.length ? "review" : "ready";
      await query(
        `INSERT INTO mail_cases(message_id, client_id, kind, fast, fields, confidence, doubts, source, status, reason, release_at, knowledge)
         VALUES($1,$2,$3,$4,$5::text::jsonb,$6,$7,$8,$9,$10,$11,$12)`,
        [
          message.message_id,
          profile.client_id,
          kind,
          item.fast || emailFast,
          JSON.stringify(fields),
          Math.max(0, Math.min(1, Number(item.confidence) || 0)),
          item.doubts.map(cleanText),
          cleanText(item.source),
          status,
          unique.join("، ") || null,
          releaseAt,
          emailKnowledge,
        ],
      );
      if (status === "ready") ready += 1;
    }
  }
  const waiting = added - ready;
  return {
    status: waiting ? "review" : "cases",
    reason: waiting ? `${waiting} من ${added} تحتاج مراجعة` : null,
    cases: added,
  };
}

/** The new part of an HTML body (Outlook's quoted history starts at its divider). */
function freshBodyHtml(html: string): string {
  const cut = html.search(/<div[^>]+border-top:\s*solid[^>]*>|<hr\b|id="divRplyFwdMsg"|class="gmail_quote"/i);
  return cut > 0 ? html.slice(0, cut) : html;
}

type CaseFields = Awaited<ReturnType<typeof placed>>["fields"];

/** The fields an investigation needs, with the place taken from the address being visited. */
async function placed(item: ExtractedCase, kind: CaseKind | null, split: boolean) {
  const atWork = kind === "work" || isBusinessKind(kind);
  // A single «Address» column is the place to visit, whatever the kind; in a split each visit
  // has only its own address (an investigator is never sent home to ask about a job).
  const visit = split
    ? atWork
      ? item.work_address
      : item.home_address
    : atWork
      ? (item.work_address ?? item.home_address)
      : (item.home_address ?? item.work_address);

  const { index, governorates } = await placeIndex();
  const found = findPlace(visit ?? "", index);
  const doubts: string[] = [];
  let governorate: string | null = null;
  let district: string | null = null;
  if (item.governorate) {
    const snapped = await canonicalNames({ governorate: item.governorate } as never, { strictGovernorate: false });
    governorate = governorates.has(snapped.governorate as string)
      ? (snapped.governorate as string)
      : findPlace(item.governorate, index).governorate;
  }
  if (found.conflict) doubts.push("العنوان يذكر أكثر من محافظة: تأكد منها");
  // The client's column describes the home; a work visit in a split follows its own address.
  if (split && atWork && found.governorate) governorate = found.governorate;
  else if (!governorate) governorate = found.governorate;
  else if (found.governorate && found.governorate !== governorate) {
    doubts.push(`المحافظة المكتوبة (${governorate}) تختلف عن العنوان (${found.governorate})`);
    if (found.stated) governorate = found.governorate;
  }
  if (governorate) {
    const typed = split && atWork ? null : item.district;
    const snapped = typed ? await canonicalNames({ governorate, district: typed } as never, { strictGovernorate: false }) : null;
    district = snapped?.district ?? (found.governorate === governorate ? found.district : null);
  }

  const extra: string[] = [];
  if (kind === "home_work" && item.home_address && item.work_address) extra.push(`عنوان العمل: ${item.work_address}`);
  if (item.company) extra.push(`جهة العمل: ${item.company}`);
  const text = (value: string | null | undefined) => (value ? cleanText(value).trim() || null : null);
  const fields = {
    subject_name: text(item.subject_name),
    national_id: text(item.national_id ? (findNationalId(item.national_id) ?? item.national_id) : null),
    phone: text(item.phone ? (normalizeMobile(item.phone) ?? item.phone) : null),
    address: text(visit),
    home_address: text(item.home_address),
    work_address: text(item.work_address),
    company: text(item.company),
    governorate,
    district: text(district),
    client_reference: text(item.client_reference),
    notes: text([item.notes, ...extra].filter(Boolean).join("\n")),
  };
  return { fields, doubts };
}

/** The sender and colleagues at the client, for the reply screen's address list. */
async function learnContacts(clientId: string, message: Row): Promise<void> {
  const domain = (message.from_domain as string | null) ?? "";
  const all = [message.from_address as string | null, ...((message.cc_addresses as string[]) ?? []), ...((message.to_addresses as string[]) ?? [])]
    .filter((address): address is string => Boolean(address))
    .filter((address) => domainMatches(address.split("@")[1] ?? "", [domain]));
  for (const address of new Set(all)) {
    await query(
      `INSERT INTO mail_client_contacts(client_id, address, name) VALUES($1,$2,$3)
       ON CONFLICT (client_id, address) DO UPDATE SET seen_count = mail_client_contacts.seen_count + 1, last_seen_at = now()`,
      [clientId, address, address === message.from_address ? (message.from_name as string | null) : null],
    );
  }
}
