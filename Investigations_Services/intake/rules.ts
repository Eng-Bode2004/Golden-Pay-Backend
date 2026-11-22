/**
 * Pure rules of the email intake: when a case goes out, what kind it is, whether it is fast.
 * No database or network here, so every rule is unit-tested (rules.test.ts).
 */

export type CaseKind = "home" | "work" | "home_work" | "business" | "finishing";

export const KIND_LABELS: Record<CaseKind, string> = {
  home: "سكن",
  work: "عمل",
  home_work: "سكن وعمل",
  business: "ميداني / منشأة",
  finishing: "تشطيب وحدة",
};

const TIME_ZONE = "Africa/Cairo";
/** Working window: from 08:00 (inclusive) to 16:00 (exclusive), Cairo time. */
export const WORK_START_HOUR = 8;
export const WORK_END_HOUR = 16;

/** Cairo wall-clock parts of an instant. */
export function cairoParts(at: Date): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

/** The instant of a Cairo wall-clock time (handles daylight saving by checking the offset). */
export function cairoInstant(year: number, month: number, day: number, hour: number, minute = 0): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  for (let i = 0; i < 2; i += 1) {
    const seen = cairoParts(guess);
    const seenUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute);
    const wantedUtc = Date.UTC(year, month - 1, day, hour, minute);
    guess.setTime(guess.getTime() + (wantedUtc - seenUtc));
  }
  return guess;
}

/**
 * When a case received at `receivedAt` goes to investigators:
 * 08:00–16:00 at once; 16:00–08:00 at 08:00 (the same morning, or the next one).
 */
export function releaseTime(receivedAt: Date): { at: Date; scheduled: boolean } {
  const local = cairoParts(receivedAt);
  if (local.hour >= WORK_START_HOUR && local.hour < WORK_END_HOUR) return { at: receivedAt, scheduled: false };
  let { year, month, day } = local;
  if (local.hour >= WORK_END_HOUR) {
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    year = next.getUTCFullYear();
    month = next.getUTCMonth() + 1;
    day = next.getUTCDate();
  }
  return { at: cairoInstant(year, month, day, WORK_START_HOUR), scheduled: true };
}

/** Arabic-Indic and Persian digits to ASCII; Arabic letters that are written several ways unified. */
export function normalizeText(value: string): string {
  return value
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[ً-ْـ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** An Egyptian national ID: 14 digits, century 2/3, a real birth date and a governorate code. */
export function isNationalId(value: string): boolean {
  const digits = normalizeText(value).replace(/\D/g, "");
  if (!/^[23]\d{13}$/.test(digits)) return false;
  const century = digits[0] === "2" ? 1900 : 2000;
  const year = century + Number(digits.slice(1, 3));
  const month = Number(digits.slice(3, 5));
  const day = Number(digits.slice(5, 7));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return false;
  const governorate = Number(digits.slice(7, 9));
  return (governorate >= 1 && governorate <= 35) || governorate === 88;
}

/** The first valid national ID in a text, or null. */
export function findNationalId(text: string): string | null {
  for (const match of normalizeText(text).matchAll(/\d{14}/g)) {
    if (isNationalId(match[0])) return match[0];
  }
  return null;
}

/** An Egyptian mobile number in 01XXXXXXXXX form, or null. */
export function normalizeMobile(value: string): string | null {
  let digits = normalizeText(value).replace(/\D/g, "");
  if (digits.startsWith("20") && digits.length === 12) digits = `0${digits.slice(2)}`;
  if (digits.length === 10 && digits.startsWith("1")) digits = `0${digits}`;
  return /^01[0125]\d{8}$/.test(digits) ? digits : null;
}

/** Words in every email whatever is asked: form labels and job titles in signatures. */
const NOT_THE_REQUEST =
  /home address|company address|business address|work address|head office|field investigation (officer|unit|department)|عنوان (ال)?(سكن|عمل|منزل)|(عنوان |اسم )?جهه (ال)?عمل/g;

/**
 * What is being asked for, from the words the client uses. Null when nothing says: the case
 * then waits for a person. A wrong guess sends the wrong form, so only whole words count.
 */
export function detectKind(text: string): CaseKind | null {
  const t = normalizeText(text).replace(NOT_THE_REQUEST, " ");
  const word = (pattern: string) => new RegExp(`(^|[^\\p{L}])(${pattern})($|[^\\p{L}])`, "u").test(t);
  if (word("(ال)?تشطيب")) return "finishing";
  if (/سكن\s*و\s*(ال)?عمل|home\s*(and|&)\s*work|work\s*(and|&)\s*home/.test(t)) return "home_work";
  if (word("(ال)?ميداني|(ال)?ميدانيه|(ال)?منشاه|(ال)?مصنع|موردين|field visit|زياره (المقر|جميع المقرات)")) return "business";
  const home = word("(ال)?سكن|(ال)?منزل|محل الاقامه|home|residence");
  const work = word("(ال)?عمل|work");
  if (home && work) return "home_work";
  if (home) return "home";
  if (work) return "work";
  return null;
}

/** The words that mean "fast" when a client does not set its own. */
export const DEFAULT_FAST_WORDS = ["fast track", "urgent", "عاجل", "استعجال", "مستعجل", "سريع"];

/**
 * Whether the client marked the case fast. Only the request itself is read (subject and the
 * new part of the body), so a legal footer saying "expressly" never counts.
 */
export function detectFast(text: string, words: string[]): boolean {
  const t = normalizeText(text);
  return (words.length ? words : DEFAULT_FAST_WORDS).some((word) => {
    const w = normalizeText(word);
    return w && new RegExp(`(^|[^\\p{L}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}])`, "u").test(t);
  });
}

/** A reply in a thread (RE:/رد:), not a new request. */
export function isReplySubject(subject: string): boolean {
  return /^\s*(re|رد|aw)\s*[:：]/i.test(subject);
}

/** Bounces, auto-replies and system notices: never cases. */
export function isSystemMail(from: string | null, subject: string): boolean {
  const sender = (from ?? "").toLowerCase();
  return (
    /^(mailer-daemon|postmaster|no-?reply|donotreply|do-not-reply)@/.test(sender) ||
    /^(undeliverable|delivery (status|has failed)|message delivery failure|automatic reply|auto(matic)?[- ]reply|out of office|recall|accepted|declined)\b/i.test(
      subject.trim(),
    )
  );
}

/** A forwarded request (FW:): the request itself is in the forwarded part, so nothing is cut. */
export function isForward(subject: string): boolean {
  return /^\s*(fw|fwd|tr|إعادة توجيه)\s*[:：]/i.test(subject);
}

/** Not case requests whatever the client: invoices, statements, account notices. */
export const DEFAULT_IGNORE_WORDS = ["فاتوره", "فاتورة", "مطالبه شهر", "invoice", "statement of account", "كشف حساب"];

/** The new part of an email body: quoted history and signatures cut off. */
export function freshBody(text: string): string {
  const cut = text.split(/\n\s*(From:|من:|-----Original Message|________________|On .+ wrote:|Sent from my)/i)[0] ?? text;
  return cut.replace(/\[cid:[^\]]+\]/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function domainOf(address: string | null | undefined): string | null {
  const at = (address ?? "").lastIndexOf("@");
  return at > 0 ? address!.slice(at + 1).trim().toLowerCase() : null;
}

/** A sender domain belongs to a profile when it is one of its domains or a subdomain of one. */
export function domainMatches(domain: string, domains: string[]): boolean {
  return domains.some((d) => {
    const want = d.trim().toLowerCase().replace(/^@/, "");
    return want && (domain === want || domain.endsWith(`.${want}`));
  });
}

/**
 * Whether the receiving server confirmed the From domain. Only the top Authentication-Results
 * header counts: our mail server writes that one, lower ones could arrive with the email.
 */
export function senderVerified(topAuthenticationResults: string | null | undefined): boolean {
  return /(^|;)\s*dmarc=pass\b/i.test((topAuthenticationResults ?? "").replace(/"[^"]*"/g, ""));
}

interface Person {
  subject_name?: unknown;
  national_id?: unknown;
}

/** The same applicant: by national ID when both have one, otherwise by the full name. */
export function samePerson(a: Person, b: Person): boolean {
  if (a.national_id && b.national_id) return a.national_id === b.national_id;
  const name = normalizeText(String(a.subject_name ?? ""));
  return name !== "" && name === normalizeText(String(b.subject_name ?? ""));
}

/** Two requests for one person that would send investigators to the same place twice. */
export function kindsOverlap(a: CaseKind | null, b: CaseKind | null): boolean {
  if (!a || !b || a === b) return true;
  const both = [a, b];
  return both.includes("home_work") && (both.includes("home") || both.includes("work"));
}

/** Types a browser may show. Anything else from an email is only ever downloaded. */
export function safeInlineType(type: string): string | null {
  const t = type.split(";")[0]!.trim().toLowerCase();
  if (t === "image/jpg") return "image/jpeg";
  return ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"].includes(t) ? t : null;
}

/**
 * The kind a whole email asks for. In a forward the sender's own line at the top decides;
 * the older email underneath only counts when that line says nothing.
 */
export function requestKind(subject: string, body: string): CaseKind | null {
  const own = freshBody(body);
  return detectKind(own) ?? detectKind(`${subject}\n${isForward(subject) ? body : own}`);
}

/** A request older than this was probably booked by hand already: it waits for a person. */
export const STALE_HOURS = 20;

/**
 * When a case that is ready (or approved) at `now` goes out. It follows the time of arrival;
 * one that only became ready later never wakes investigators at night because it arrived
 * in the day. A few minutes between arrival and reading do not move it to the next morning.
 */
export function sendTime(receivedAt: Date, now: Date): Date {
  const byArrival = releaseTime(receivedAt);
  if (byArrival.at.getTime() > now.getTime()) return byArrival.at;
  if (!byArrival.scheduled && now.getTime() - receivedAt.getTime() <= 30 * 60_000) return now;
  return releaseTime(now).at;
}

/** Text PostgreSQL accepts: no NUL, no half of an emoji left by cutting a string. */
export function cleanText(value: string): string {
  return value.replace(/\u0000/g, "").toWellFormed();
}

/**
 * The kind a table row itself implies when neither a type column nor the email says: an
 * address for each visit means both, unless the row says there is no work visit.
 */
export function kindOfRow(row: {
  home_address: string | null;
  work_address: string | null;
  company?: string | null;
  notes?: string | null;
}): CaseKind | null {
  const said = normalizeText([row.company, row.work_address, row.notes].filter(Boolean).join(" "));
  if (row.home_address && /بدون (استعلام )?(ال)?عمل|سكن فقط/.test(said)) return "home";
  if (row.home_address && row.work_address) return "home_work";
  if (row.home_address) return "home";
  if (row.work_address) return "work";
  return null;
}

/**
 * «سكن وعمل» is two visits with two reports when the client has no single form for both
 * (each bank form is one visit), so it becomes one case for each.
 */
export function visitsFor(kind: CaseKind | null, templates: Partial<Record<CaseKind, string>>): (CaseKind | null)[] {
  if (kind === "home_work" && !templates.home_work && templates.home && templates.work) return ["home", "work"];
  return [kind];
}

/** A subject about cases already sent (reminder, correction, cancellation, samples). */
export function aboutEarlierCases(subject: string): boolean {
  const s = normalizeText(subject).replace(/^((fw|fwd)\s*:\s*)+/, "");
  return (
    /reminder|pending|follow[ -]?up|cancel|تذكير|متابعه|الغاء|لتعديل|تعديل (اسم|عنوان|بيانات)|اعاده (ال)?استعلام|عينات|لم يستدل|توضيح/.test(s) ||
    /^استعجال/.test(s)
  );
}

/** What a file really is, from its first bytes (the declared type is often wrong). */
export function sniffType(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "application/pdf" | null {
  const head = String.fromCharCode(...bytes.subarray(0, 12));
  if (head.startsWith("\u0089PNG")) return "image/png";
  if (head.startsWith("\u00ff\u00d8\u00ff")) return "image/jpeg";
  if (head.startsWith("GIF8")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8) === "WEBP") return "image/webp";
  if (head.startsWith("%PDF")) return "application/pdf";
  return null;
}
