import { query } from "../../IdentityAcess_Services/Config/db.ts";
import { getStoredFile } from "../../IdentityAcess_Services/Utils/files.ts";
import { canonicalNames } from "../../Shared/places.ts";
import { nameKey } from "../../Shared/work-area.ts";
import { docxText, readXlsx } from "../../Shared/xlsx.ts";
import { aiConfigured, readWithAi, type AiInput } from "./ai.ts";
import {
  DEFAULT_FAST_WORDS,
  DEFAULT_IGNORE_WORDS,
  isForward,
  detectFast,
  detectKind,
  domainMatches,
  findNationalId,
  freshBody,
  isNationalId,
  isReplySubject,
  isSystemMail,
  KIND_LABELS,
  normalizeMobile,
  normalizeText,
  releaseTime,
  type CaseKind,
} from "./rules.ts";
import { casesFromGrid, htmlTables, looksComplete, type ExtractedCase } from "./tables.ts";

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
  ignore_words: string[];
}

export async function loadProfiles(): Promise<Profile[]> {
  return (await query(
    `SELECT p.client_id, c.name AS client_name, p.domains, p.templates, p.fast_words, p.normal_level, p.fast_level,
       p.auto_send, p.ignore_words
     FROM mail_client_profiles p JOIN form_clients c ON c.client_id = p.client_id WHERE p.active`,
  )) as unknown as Profile[];
}

/** How sure the AI reading must be before a case goes out without a person looking. */
const AUTO_CONFIDENCE = Number(process.env.MAIL_AUTO_CONFIDENCE || 0.85);

// ───────────── places inside a free-text address ─────────────

interface PlaceIndex {
  at: number;
  governorates: { key: string; name: string }[];
  districts: { key: string; name: string; governorate: string }[];
}
let places: PlaceIndex | null = null;

async function placeIndex(): Promise<PlaceIndex> {
  if (places && Date.now() - places.at < 10 * 60_000) return places;
  const rows = await query(
    `SELECT d.name, d.level, g.name AS governorate FROM geo_locations d
     LEFT JOIN geo_locations g ON g.location_id = d.parent_id WHERE d.level IN (1, 2)`,
  );
  places = {
    at: Date.now(),
    governorates: rows.filter((r) => r.level === 1).map((r) => ({ key: nameKey(r.name as string), name: r.name as string })),
    districts: rows
      .filter((r) => r.level === 2 && r.governorate)
      .map((r) => ({ key: nameKey(r.name as string), name: r.name as string, governorate: r.governorate as string })),
  };
  return places;
}

/** The governorate and district named inside an address, when the address names them. */
export async function placeOfAddress(address: string): Promise<{ governorate: string | null; district: string | null }> {
  const index = await placeIndex();
  const text = ` ${nameKey(address)} `;
  const contains = (key: string) => key.length >= 3 && text.includes(` ${key} `);
  const governorate = index.governorates.filter((g) => contains(g.key)).sort((a, b) => b.key.length - a.key.length)[0];
  const districts = index.districts
    .filter((d) => contains(d.key) && (!governorate || d.governorate === governorate.name))
    .sort((a, b) => b.key.length - a.key.length);
  const district = districts[0];
  // A district name shared by two governorates (and none named) is not a guess we make.
  if (district && !governorate && districts.some((d) => d.key === district.key && d.governorate !== district.governorate)) {
    return { governorate: null, district: null };
  }
  return { governorate: governorate?.name ?? district?.governorate ?? null, district: district?.name ?? null };
}

// ───────────── reading one email ─────────────

const IMAGE_TYPES: Record<string, AiInput["images"][number]["media_type"]> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/gif": "image/gif",
  "image/webp": "image/webp",
};

interface Attachment {
  index: number;
  name: string;
  type: string;
  bytes: number;
  path: string;
  inline?: boolean;
}

/** Logos, social icons and signatures: small images, or the same picture every email carries. */
function isDecoration(file: Attachment): boolean {
  if (!IMAGE_TYPES[file.type]) return false;
  if (file.bytes < 15_000) return true;
  return /^(facebook|fb_|youtube|linkedin|instagram|twitter|logo|.*_logo)/i.test(file.name);
}

const htmlToText = (value: string) =>
  value
    .replace(/<br\s*\/?>|<\/(p|div|tr|li)>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n");

export interface ProcessOutcome {
  status: string;
  reason: string | null;
  cases: number;
}

/** Turns one stored email into cases (or a clear reason why not). Safe to run again. */
export async function processMessage(messageId: string): Promise<ProcessOutcome> {
  const [message] = await query("SELECT * FROM mail_messages WHERE message_id=$1", [messageId]);
  if (!message) throw new Error("Email not found");
  await query("UPDATE mail_messages SET status='processing' WHERE message_id=$1", [messageId]);
  try {
    const outcome = await read(message);
    await query("UPDATE mail_messages SET status=$2, reason=$3, processed_at=now() WHERE message_id=$1", [
      messageId,
      outcome.status,
      outcome.reason,
    ]);
    return outcome;
  } catch (error) {
    const reason = `تعذّرت قراءة البريد: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500);
    await query("UPDATE mail_messages SET status='failed', reason=$2, processed_at=now() WHERE message_id=$1", [messageId, reason]);
    return { status: "failed", reason, cases: 0 };
  }
}

async function read(message: Row): Promise<ProcessOutcome> {
  const subject = String(message.subject ?? "");
  const from = (message.from_address as string | null) ?? null;
  if (isSystemMail(from, subject)) return { status: "ignored", reason: "رسالة نظام (فشل توصيل أو رد آلي)", cases: 0 };

  const profiles = await loadProfiles();
  const domain = (message.from_domain as string | null) ?? "";
  const profile = profiles.find((p) => domainMatches(domain, p.domains)) ?? null;
  if (profile) {
    await query("UPDATE mail_messages SET client_id=$2 WHERE message_id=$1", [message.message_id, profile.client_id]);
    await learnContacts(profile.client_id, message);
  }
  if (!profile) return { status: "unknown_sender", reason: `الدومين ${domain || "—"} غير مربوط بأي جهة`, cases: 0 };
  // Replies in a thread are conversation (questions, reminders, complaints), never new cases.
  if (isReplySubject(subject)) return { status: "reply", reason: "رد على رسالة سابقة", cases: 0 };

  const rawBody = String(message.body_text ?? "");
  const isHtml = /<table/i.test(rawBody);
  const forwarded = isForward(subject);
  const plain = isHtml ? htmlToText(rawBody) : rawBody;
  // A forwarded request lives below the forward line; a direct one above any quoted history.
  const bodyText = forwarded ? plain.trim() : freshBody(plain);
  const requestText = `${subject}\n${bodyText}`;
  const ignoreWords = [...DEFAULT_IGNORE_WORDS, ...profile.ignore_words];
  if (ignoreWords.some((word) => normalizeText(subject).includes(normalizeText(word)))) {
    return { status: "ignored", reason: "يحتوي على كلمة تجاهل لهذه الجهة", cases: 0 };
  }

  const emailKind = detectKind(requestText);
  const emailFast = detectFast(requestText, profile.fast_words.length ? profile.fast_words : DEFAULT_FAST_WORDS);
  const attachments = ((message.attachments as Attachment[]) ?? []).filter((file) => !isDecoration(file));

  // 1. Tables: Excel files and tables in the body are read exactly, without AI.
  let cases: (ExtractedCase & { source: string })[] = [];
  for (const file of attachments) {
    if (!/\.xlsx$/i.test(file.name) && !file.type.includes("spreadsheetml")) continue;
    try {
      const bytes = await getStoredFile(file.path);
      for (const sheet of readXlsx(bytes)) {
        cases.push(...casesFromGrid(sheet.rows).map((item) => ({ ...item, source: `excel:${file.name}` })));
      }
    } catch (error) {
      console.error("mail.xlsx_failed", file.name, error instanceof Error ? error.message : error);
    }
  }
  if (isHtml) {
    for (const grid of htmlTables(forwarded ? rawBody : freshBodyHtml(rawBody))) {
      cases.push(...casesFromGrid(grid).map((item) => ({ ...item, source: "body-table" })));
    }
  }
  let aiUsed = false;

  // 2. Everything else (handwritten photos, scans, PDFs, free text): the AI reader.
  const tablesComplete = cases.length > 0 && cases.every(looksComplete);
  if (!tablesComplete) {
    if (!aiConfigured()) {
      if (!cases.length) return { status: "review", reason: "يحتاج قراءة يدوية (القراءة الذكية غير مفعّلة)", cases: 0 };
    } else {
      const input: AiInput = { clientName: profile.client_name, subject, body: bodyText, images: [], pdfs: [], texts: [] };
      for (const file of attachments) {
        const bytes = await getStoredFile(file.path).catch(() => null);
        if (!bytes) continue;
        const mediaType = IMAGE_TYPES[file.type.toLowerCase()];
        if (mediaType && input.images.length < 12) input.images.push({ media_type: mediaType, data: bytes, name: file.name });
        else if ((file.type === "application/pdf" || /\.pdf$/i.test(file.name)) && input.pdfs.length < 6 && bytes.length < 20_000_000) {
          input.pdfs.push({ data: bytes, name: file.name });
        } else if (/\.docx$/i.test(file.name)) {
          try {
            input.texts.push({ name: file.name, text: docxText(bytes) });
          } catch {
            // an unreadable Word file is listed for the reviewer, not fatal
          }
        }
      }
      // Tables already read are given to the model as text, so it does not read them twice.
      if (cases.length) {
        input.texts.push({ name: "rows already read from tables", text: JSON.stringify(cases.map(({ source: _s, ...c }) => c)) });
      }
      const result = await readWithAi(input);
      aiUsed = true;
      await query("UPDATE mail_messages SET ai_used=true WHERE message_id=$1", [message.message_id]);
      if (!result.is_case_request && !cases.length) {
        return { status: "ignored", reason: result.not_case_reason || "ليست طلب استعلام", cases: 0 };
      }
      if (result.cases.length) {
        cases = result.cases.map((item) => ({
          ...item,
          doubts: item.doubts ?? [],
          source: "ai",
        }));
      }
    }
  }
  if (!cases.length) return { status: "review", reason: "لم يُعثر على أشخاص في البريد", cases: 0 };

  // 3. Each person becomes a case: checked, placed, timed.
  await query("DELETE FROM mail_cases WHERE message_id=$1 AND status IN ('review','ready')", [message.message_id]);
  const received = new Date(message.received_at as string);
  let ready = 0;
  for (const item of cases) {
    const kind = item.kind ?? emailKind;
    const fast = item.fast || emailFast;
    const fields = await placed(item, kind);
    const reasons = [...item.doubts];
    if (aiUsed && item.source === "ai" && item.confidence < AUTO_CONFIDENCE) reasons.push("القراءة غير مؤكدة");
    if (!fields.subject_name) reasons.push("لا يوجد اسم");
    if (!fields.address) reasons.push("لا يوجد عنوان");
    if (fields.national_id && !isNationalId(fields.national_id)) reasons.push("الرقم القومي غير صحيح");
    if (!fields.governorate) reasons.push("المحافظة غير معروفة");
    if (!kind) reasons.push("نوع الاستعلام غير محدد");
    else if (!profile.templates[kind]) reasons.push(`لا يوجد نموذج «${KIND_LABELS[kind]}» لهذه الجهة`);
    if (!profile.auto_send) reasons.push("هذه الجهة مضبوطة على المراجعة اليدوية");
    const unique = [...new Set(reasons)];
    const status = unique.length ? "review" : "ready";
    const release = releaseTime(received);
    await query(
      `INSERT INTO mail_cases(message_id, client_id, kind, fast, fields, confidence, doubts, source, status, reason, release_at)
       VALUES($1,$2,$3,$4,$5::text::jsonb,$6,$7,$8,$9,$10,$11)`,
      [
        message.message_id,
        profile.client_id,
        kind,
        fast,
        JSON.stringify(fields),
        Math.max(0, Math.min(1, item.confidence ?? 0)),
        item.doubts,
        item.source,
        status,
        unique.join("، ") || null,
        release.at,
      ],
    );
    if (status === "ready") ready += 1;
  }
  const waiting = cases.length - ready;
  return {
    status: waiting ? "review" : "cases",
    reason: waiting ? `${waiting} من ${cases.length} تحتاج مراجعة` : null,
    cases: cases.length,
  };
}

/** The new part of an HTML body (Outlook's quoted history starts at its divider). */
function freshBodyHtml(html: string): string {
  const cut = html.search(/<div[^>]+border-top:\s*solid[^>]*>|<hr\b|id="divRplyFwdMsg"|class="gmail_quote"/i);
  return cut > 0 ? html.slice(0, cut) : html;
}

/** The fields an investigation needs, with the place snapped to the place list. */
async function placed(item: ExtractedCase, kind: CaseKind | null) {
  const visitAddress =
    kind === "work" || kind === "business" ? (item.work_address ?? item.home_address) : (item.home_address ?? item.work_address);
  let governorate = item.governorate;
  let district = item.district;
  if ((!governorate || !district) && visitAddress) {
    const found = await placeOfAddress(`${visitAddress} ${governorate ?? ""} ${district ?? ""}`);
    governorate ??= found.governorate;
    district ??= found.district;
  }
  if (governorate) {
    const snapped = await canonicalNames({ governorate, district: district ?? null } as never, { strictGovernorate: false });
    const known = (await placeIndex()).governorates.some((g) => g.name === snapped.governorate);
    governorate = known ? (snapped.governorate ?? null) : null;
    district = known ? (snapped.district ?? district) : district;
  }
  const extra: string[] = [];
  if (kind === "home_work" && item.home_address && item.work_address) extra.push(`عنوان العمل: ${item.work_address}`);
  if (item.company) extra.push(`جهة العمل: ${item.company}`);
  return {
    subject_name: item.subject_name?.trim() || null,
    national_id: item.national_id ? (findNationalId(item.national_id) ?? item.national_id) : null,
    phone: item.phone ? (normalizeMobile(item.phone) ?? item.phone) : null,
    address: visitAddress?.trim() || null,
    home_address: item.home_address,
    work_address: item.work_address,
    company: item.company,
    governorate,
    district,
    client_reference: item.client_reference,
    notes: [item.notes, ...extra].filter(Boolean).join("\n") || null,
  };
}

/** The sender and CC addresses at the client, for the reply screen's address list. */
async function learnContacts(clientId: string, message: Row): Promise<void> {
  const domain = (message.from_domain as string | null) ?? "";
  const all = [message.from_address as string | null, ...((message.cc_addresses as string[]) ?? []), ...((message.to_addresses as string[]) ?? [])]
    .filter((a): a is string => Boolean(a))
    .filter((a) => {
      const d = a.split("@")[1] ?? "";
      return d && (d === domain || d.endsWith(`.${domain}`) || domain.endsWith(`.${d}`));
    });
  for (const address of new Set(all)) {
    await query(
      `INSERT INTO mail_client_contacts(client_id, address, name) VALUES($1,$2,$3)
       ON CONFLICT (client_id, address) DO UPDATE SET seen_count = mail_client_contacts.seen_count + 1, last_seen_at = now()`,
      [clientId, address, address === message.from_address ? (message.from_name as string | null) : null],
    );
  }
}
