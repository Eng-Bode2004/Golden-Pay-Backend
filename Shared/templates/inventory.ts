/**
 * Identifies an uploaded template: which client it belongs to, which investigation it
 * is for and which revision it is, from the document itself. Folder and file names
 * are only weak hints, because they are often wrong (e.g. "One Fitness" is One Finance).
 * Also flags anything copied from a real report: names, dates, photos, signatures.
 */
import { attr, child, children, descendants, DocxPackage, type El, md5, NS, sha256, textOf } from "./docx.ts";

export interface ClientProfile {
  client_id: string;
  name: string;
  name_en?: string;
  client_type: "bank" | "company";
  /** Patterns (as strings) that name the client inside a document. */
  aliases: string[];
  /** MD5 prefixes (8 hex) of the client's logo pictures. */
  logo_hashes: string[];
  /** Folder names used for this client in the archive. */
  folders?: string[];
}

/** The clients found in the original archive, with what identifies each one. */
export const KNOWN_CLIENTS: ClientProfile[] = [
  { client_id: "abd-ellatif-gamel", name: "عبد اللطيف جميل للتمويل", name_en: "Abdul Latif Jameel Finance", client_type: "company", aliases: ["جميل", "JAMEEL", "عبد\\s*اللطيف", "Abd\\s*el\\s*latif"], logo_hashes: ["8b850c90"], folders: ["Abd el latif Gamel Company"] },
  { client_id: "alex-bank", name: "بنك الإسكندرية", name_en: "Bank of Alexandria (ALEXBANK)", client_type: "bank", aliases: ["بنك\\s*الإسكندرية", "بنك\\s*الاسكندرية", "ALEX\\s*BANK", "ALEXBANK"], logo_hashes: ["01ac0735", "4a920f69"], folders: ["Alex Bank"] },
  { client_id: "bedayty", name: "بدايتي", name_en: "Bedayti", client_type: "company", aliases: ["بدايتي", "بدايتى", "Bedayt[iy]"], logo_hashes: [], folders: ["Bedayty Company"] },
  { client_id: "cib", name: "البنك التجاري الدولي CIB", name_en: "Commercial International Bank (CIB)", client_type: "bank", aliases: ["\\bCIB\\b", "التجاري\\s*الدولي", "التجارى\\s*الدولى"], logo_hashes: ["b97fd94e"], folders: ["CIB Bank"] },
  { client_id: "credit-agricole", name: "كريدي أجريكول مصر", name_en: "Crédit Agricole Egypt", client_type: "bank", aliases: ["كريدي", "كريدى", "CR[ÉE]DIT\\s*AGRICOLE"], logo_hashes: ["c9b45c8d", "96298976", "e1a64e0b", "c1b7b7e9", "f63a17ed"], folders: ["Credit agricole Bank"] },
  { client_id: "ghabbour", name: "درايف — جي بي أوتو (غبور)", name_en: "Drive (GB Auto)", client_type: "company", aliases: ["غبور", "\\bDrive\\b", "Gaboor", "Ghabbour", "GB\\s*Auto"], logo_hashes: [], folders: ["Gaboor Company"] },
  { client_id: "global", name: "جلوبال", name_en: "Global", client_type: "company", aliases: ["جلوبال", "\\bGlobal\\b"], logo_hashes: [], folders: ["Global Company"] },
  { client_id: "hermes", name: "إي إف جي هيرميس", name_en: "EFG Hermes", client_type: "company", aliases: ["هيرميس", "هرمس", "إي\\s*إف\\s*جي", "\\bEFG\\b", "Hermes"], logo_hashes: [], folders: ["Hermes Company"] },
  { client_id: "idb", name: "بنك التنمية الصناعية", name_en: "Industrial Development Bank (IDB)", client_type: "bank", aliases: ["التنمية\\s*الصناعية", "Industrial\\s*Development\\s*Bank", "\\bIDB\\b", "مصرفنا"], logo_hashes: ["02e9d75d", "c5e6c126"], folders: ["Industrial Development Bank"] },
  { client_id: "med-bank", name: "ميد بنك", name_en: "MIDBANK", client_type: "bank", aliases: ["ميد\\s*بنك", "MIDBANK", "Med\\s*Bank"], logo_hashes: ["9dfb07d2"], folders: ["Med Bank"] },
  { client_id: "mogo", name: "موجو", name_en: "MOGO", client_type: "company", aliases: ["موجو", "\\bmogo\\b"], logo_hashes: ["ed693ab2"], folders: ["Mogo Company"] },
  { client_id: "one-finance", name: "وان فايننس", name_en: "One Finance", client_type: "company", aliases: ["وان\\s*فاي?ننس", "One\\s*Finance"], logo_hashes: [], folders: ["One Fitness Company"] },
  { client_id: "qnb", name: "بنك قطر الوطني QNB", name_en: "QNB", client_type: "bank", aliases: ["قطر\\s*الوطني", "قطر\\s*الوطنى", "كيو\\s*ان\\s*ب[يى]", "\\bQNB\\b"], logo_hashes: ["388520f4", "3b9d7c77"], folders: ["QNB Bank"] },
  { client_id: "rizk-allah", name: "رزق الله", name_en: "Rizk Allah", client_type: "company", aliases: ["رزق\\s*الله", "Rizk\\s*allah"], logo_hashes: [], folders: ["Rizk allah Company"] },
  { client_id: "tanmiya", name: "تنمية لخدمات المشروعات متناهية الصغر", name_en: "Tanmeyah", client_type: "company", aliases: ["تنمية\\s*لخدمات", "Tanm[ei]yah", "Tanmiya"], logo_hashes: ["796aaaed"], folders: ["Tanmiya Company"] },
];

/** Investigation types, tested in order: the first match wins. */
export const INVESTIGATION_TYPES: { code: string; name: string; test: RegExp }[] = [
  { code: "follow_up", name: "متابعة", test: /متابع/ },
  { code: "finishing", name: "تشطيب", test: /تشطيب/ },
  { code: "site_visit", name: "زيارة ميدانية للشركة", test: /زيارة\s*(شركة|مفاج)|الزيارة\s*المفاجئة|زياره\s*مفاجئه/ },
  { code: "dealer_coding", name: "تكويد معرض", test: /تكويد\s*معرض|معرض\s*سيارات|Coding\s*Vendor/i },
  { code: "supplier", name: "موردين ووكلاء", test: /مورد|وكلاء|Vendor/i },
  { code: "merchant_coding", name: "تكويد تاجر", test: /تاجر|تجار/ },
  { code: "company_coding", name: "تكويد شركات وكيانات", test: /تكويد\s*(شرك|كيان)|كيان(ات)?\s*اعتبار|تكويد\)/ },
  { code: "clinic", name: "عيادات وصيدليات", test: /عياد|الأطباء|Doctors/i },
  { code: "sme", name: "مشروعات صغيرة ومتوسطة", test: /الصغيرة\s*والمتوسط|مشروعات|Small\s*(and\s*Medium|business)/i },
  { code: "company", name: "استعلام شركات", test: /شركات|شركة|Corporat/i },
  { code: "business_owner", name: "صاحب نشاط / مهن حرة", test: /صاحب\s*نشاط|أصحاب\s*الاعمال|اصحاب\s*الاعمال|مهن\s*حرة|مقر\s*نشاط/ },
  { code: "residence_employment", name: "سكن وعمل", test: /منزل\s*و\s*عمل|سكن\s*و\s*عمل/ },
  { code: "residence", name: "سكن", test: /سكن|منزل|Home/i },
  { code: "employment", name: "عمل", test: /عمل|موظف|Work/i },
];

export type WarningCode =
  | "sample_text"
  | "sample_date"
  | "site_photo"
  | "signature"
  | "qr_code"
  | "third_party_stamp"
  | "embedded_screenshot"
  | "unknown_image"
  | "legacy_format"
  | "folder_mismatch"
  | "client_uncertain"
  | "type_uncertain"
  | "tracked_changes"
  | "comments"
  | "sensitivity_label"
  | "shared_layout";

export interface InventoryWarning {
  code: WarningCode;
  message: string;
  severity: "info" | "review" | "block";
}

export interface InventoryRecord {
  sha256: string;
  file_name: string;
  source_path: string | null;
  format: "docx" | "doc" | "pdf";
  size: number;
  title: string;
  client: {
    client_id: string | null;
    confidence: number;
    evidence: string[];
    alternatives: { client_id: string; score: number }[];
    /** A guess from the folder or file name only; Head Office must confirm it. */
    suggested: string | null;
  };
  investigation_type: { code: string | null; name: string | null; confidence: number; evidence: string[] };
  version: { label: string; created_at: string | null; modified_at: string | null; revision: number | null; hints: string[] };
  layout_fingerprint: string;
  /** Distinct words of the fixed text, to find near-identical layouts across clients. */
  layout_words: string[];
  stats: {
    paragraphs: number;
    tables: number;
    checkboxes: number;
    text_boxes: number;
    images: number;
    headers: number;
    footers: number;
    page_breaks: number;
    fonts: string[];
  };
  images: { md5: string; role: string; bytes: number }[];
  warnings: InventoryWarning[];
}

// Pictures from the archive that are personal data from real reports, never template art.
const KNOWN_PERSONAL: Record<string, { code: WarningCode; message: string }> = {
  "37696797": { code: "signature", message: "توقيع موظف من تقرير سابق" },
  "8eecbb46": { code: "signature", message: "توقيع موظف من تقرير سابق" },
  f4809821: { code: "signature", message: "توقيع موظف من تقرير سابق" },
  d3a4a627: { code: "signature", message: "توقيع موظف من تقرير سابق" },
  "0024d323": { code: "site_photo", message: "صورة موقع من زيارة سابقة" },
  a0c3aa4f: { code: "site_photo", message: "صورة موقع من زيارة سابقة" },
  d76fb098: { code: "site_photo", message: "صورة موقع من زيارة سابقة" },
  ea947ec8: { code: "site_photo", message: "صورة موقع من زيارة سابقة" },
  "5cc4aed8": { code: "site_photo", message: "صورة موقع من زيارة سابقة" },
  d823fdf5: { code: "qr_code", message: "رمز QR من تقرير سابق" },
  adfd1972: { code: "third_party_stamp", message: "ختم جهة أخرى" },
  "0556c94d": { code: "embedded_screenshot", message: "لقطة شاشة لنموذج مملوء" },
};
const GOLDEN_PAY_ART = new Set([
  "bd6ec3ad", "c4d4bc45", "20bcdc72", "2495e36c", "2f7e9cda", "443e325b", "75402edd", "8b312f59",
  "b0005974", "cdd1d86f", "fd9f0fa2", "891b00ab", "9124c4c0", "5bdddd95", "a253bbe8", "e48700b1",
]);

const SAMPLE_PHRASES = /لم\s*نواف[ىقي]?|لم\s*(تتم|يتم)\s*الاف?اد[ةه]|فاطمة\s*وطني/;
const DATE = /\b\d{1,2}\s*\/\s*\d{1,2}\s*\/\s*20\d{2}\b|\b20\d{2}\s*\/\s*\d{1,2}\s*\/\s*\d{1,2}\b|-\d{1,2}-20\d{2}\b/g;

function coreProps(pkg: DocxPackage) {
  if (!pkg.has("docProps/core.xml")) return { created: null, modified: null, revision: null };
  const doc = pkg.xml("docProps/core.xml").documentElement as El;
  const pick = (name: string) => {
    for (const el of Array.from(doc.getElementsByTagName("*")) as El[]) {
      if ((el.localName ?? el.nodeName.replace(/^.*:/, "")) === name) return el.textContent?.trim() || null;
    }
    return null;
  };
  const revision = Number(pick("revision"));
  return { created: pick("created"), modified: pick("modified"), revision: Number.isFinite(revision) && revision > 0 ? revision : null };
}

function fonts(pkg: DocxPackage): string[] {
  if (!pkg.has("word/fontTable.xml")) return [];
  return descendants(pkg.xml("word/fontTable.xml").documentElement as El, "font")
    .map((font) => attr(font, "name") ?? "")
    .filter(Boolean)
    .sort();
}

/** The document's own title: its first heading-like paragraph. */
function documentTitle(pkg: DocxPackage): string {
  const body = child(pkg.xml("word/document.xml").documentElement as El, "body");
  if (!body) return "";
  for (const paragraph of descendants(body, "p")) {
    const text = textOf(paragraph).replace(/\s+/g, " ").trim();
    if (text.length >= 6 && text.length <= 90 && /(تقرير|نموذج|استعلام|إستعلام|أستعلام|طلب|Report|Form)/i.test(text)) {
      return text.replace(/^(Public\s*)+/i, "").trim();
    }
  }
  return "";
}

/** Classifies a .docx (convert .doc and .pdf first). */
export async function inventoryDocx(
  bytes: Uint8Array,
  options: { fileName: string; sourcePath?: string | null; format?: "docx" | "doc" | "pdf"; originalSize?: number; originalSha?: string; clients?: ClientProfile[] },
): Promise<InventoryRecord> {
  const clients = options.clients ?? KNOWN_CLIENTS;
  const pkg = DocxPackage.open(bytes);
  const parts = pkg.textParts();
  const bodyText = textOf(pkg.xml("word/document.xml").documentElement as El).replace(/\s+/g, " ");
  const headerText = parts.slice(1).map((part) => textOf(pkg.xml(part).documentElement as El)).join(" ").replace(/\s+/g, " ");
  const title = documentTitle(pkg);
  const warnings: InventoryWarning[] = [];

  // Pictures: client logos identify the client; personal pictures must be removed.
  const images: InventoryRecord["images"] = [];
  for (const name of pkg.names().filter((item) => item.startsWith("word/media/") && !item.endsWith("/"))) {
    const data = pkg.bytes(name)!;
    const hash = md5(data).slice(0, 8);
    const client = clients.find((item) => item.logo_hashes.includes(hash));
    const personal = KNOWN_PERSONAL[hash];
    const role = GOLDEN_PAY_ART.has(hash) ? "golden_pay" : client ? `client_logo:${client.client_id}` : personal ? personal.code : "unknown";
    images.push({ md5: hash, role, bytes: data.length });
    if (personal) warnings.push({ code: personal.code, message: `${personal.message} — يجب حذفها قبل الاعتماد`, severity: "block" });
    else if (role === "unknown" && !/\.(wmf|emf)$/i.test(name)) {
      warnings.push({
        code: data.length > 40_000 && /\.jpe?g$/i.test(name) ? "site_photo" : "unknown_image",
        message: data.length > 40_000 && /\.jpe?g$/i.test(name) ? "صورة كبيرة قد تكون من زيارة سابقة" : "صورة غير معروفة؛ حدّد دورها (شعار، ختم، أو تُحذف)",
        severity: "review",
      });
    }
  }

  // Client: content signals outweigh folder and file names.
  const scores = new Map<string, { score: number; evidence: string[] }>();
  const add = (id: string, score: number, evidence: string) => {
    const entry = scores.get(id) ?? { score: 0, evidence: [] };
    entry.score += score;
    entry.evidence.push(evidence);
    scores.set(id, entry);
  };
  for (const client of clients) {
    if (images.some((image) => image.role === `client_logo:${client.client_id}`)) add(client.client_id, 0.6, "شعار العميل داخل المستند");
    for (const alias of client.aliases) {
      const re = new RegExp(alias, "i");
      if (re.test(title)) add(client.client_id, 0.5, `اسم العميل في عنوان المستند (${alias.replace(/\\[sb]\*?/g, " ").trim()})`);
      else if (re.test(headerText)) add(client.client_id, 0.4, "اسم العميل في رأس/تذييل الصفحة");
      else if (re.test(bodyText)) add(client.client_id, 0.3, "اسم العميل في نص المستند");
    }
    const path = `${options.sourcePath ?? ""}/${options.fileName}`;
    if (client.folders?.some((folder) => path.includes(folder))) add(client.client_id, 0.15, "اسم المجلد");
    if (client.aliases.some((alias) => new RegExp(alias, "i").test(options.fileName))) add(client.client_id, 0.1, "اسم الملف");
  }
  const ranked = [...scores].sort((a, b) => b[1].score - a[1].score);
  const best = ranked[0];
  const confidence = best ? Math.min(1, best[1].score) : 0;
  const content = best ? best[1].evidence.filter((item) => item !== "اسم المجلد" && item !== "اسم الملف") : [];
  if (!best || confidence < 0.3 || !content.length) {
    warnings.push({ code: "client_uncertain", message: "لم يُعرف العميل من محتوى المستند؛ يجب أن تحدده الإدارة", severity: "block" });
  } else if (ranked[1] && ranked[1][1].score >= best[1].score * 0.8) {
    warnings.push({ code: "client_uncertain", message: `المستند يشير إلى أكثر من عميل (${ranked.slice(0, 2).map(([id]) => id).join("، ")})`, severity: "review" });
  }
  const folderClient = clients.find((client) => client.folders?.some((folder) => (options.sourcePath ?? "").includes(folder)));
  if (folderClient && best && folderClient.client_id !== best[0] && content.length) {
    warnings.push({ code: "folder_mismatch", message: `المجلد يخص ${folderClient.name} لكن المحتوى يشير إلى عميل آخر`, severity: "review" });
  }

  // Investigation type: the page header and the document title, without client names
  // ("تنمية لخدمات المشروعات…" is a company name, not an SME form), then the folder.
  const withoutClients = (text: string) =>
    text
      .replace(/(تنمي[ةه]\s*)?(لخدمات\s*)?المشروعات\s*متناهية\s*الصغر/g, " ")
      .replace(new RegExp(clients.flatMap((client) => client.aliases).join("|"), "gi"), " ");
  const typeFrom = (text: string) => INVESTIGATION_TYPES.find((type) => type.test.test(withoutClients(text)));
  const pageHeaders = parts
    .filter((part) => part.includes("header"))
    .map((part) => textOf(pkg.xml(part).documentElement as El))
    .join(" ")
    .replace(/\s+/g, " ");
  const fromHeader = /نموذج|تقرير|استعلام|إستعلام/.test(pageHeaders) ? typeFrom(pageHeaders.slice(0, 200)) : undefined;
  const fromTitle = fromHeader ?? typeFrom(title);
  const fromPath = typeFrom(`${(options.sourcePath ?? "").split("/").slice(1).join(" ")} ${options.fileName.replace(/\.[^.]+$/, "")}`);
  const type = fromTitle ?? fromPath ?? typeFrom(bodyText.slice(0, 400));
  const typeEvidence = fromHeader ? ["رأس الصفحة"] : fromTitle ? ["عنوان المستند"] : fromPath ? ["اسم المجلد أو الملف"] : type ? ["نص المستند"] : [];
  if (!type) warnings.push({ code: "type_uncertain", message: "لم يُعرف نوع الاستعلام؛ يجب أن تحدده الإدارة", severity: "block" });
  else if (fromTitle && fromPath && fromTitle.code !== fromPath.code) {
    typeEvidence.push(`اسم المجلد يشير إلى «${fromPath.name}»`);
    warnings.push({
      code: "type_uncertain",
      message: `عنوان المستند يقول «${fromTitle.name}» بينما اسم المجلد يقول «${fromPath.name}»؛ أكّد النوع`,
      severity: "review",
    });
  }

  // Leftovers from real reports.
  const dates = [...new Set([...`${bodyText} ${headerText}`.matchAll(DATE)].map((match) => match[0]))];
  if (dates.length) warnings.push({ code: "sample_date", message: `تواريخ من تقرير سابق: ${dates.slice(0, 4).join("، ")}`, severity: "review" });
  const phrase = SAMPLE_PHRASES.exec(`${bodyText} ${headerText}`);
  if (phrase) warnings.push({ code: "sample_text", message: `نص من تقرير سابق: «${phrase[0]}»`, severity: "review" });
  if (/\bPublic\b/.test(`${bodyText} ${headerText}`)) {
    warnings.push({ code: "sensitivity_label", message: "المستند يحمل وسم تصنيف «Public» من نظام العميل", severity: "info" });
  }
  const docXml = pkg.xml("word/document.xml").documentElement as El;
  if (descendants(docXml, "ins").length + descendants(docXml, "del").length) {
    warnings.push({ code: "tracked_changes", message: "المستند يحتوي تعديلات متعقَّبة لم تُقبل", severity: "review" });
  }
  if (pkg.has("word/comments.xml")) warnings.push({ code: "comments", message: "المستند يحتوي تعليقات", severity: "info" });
  if (options.format === "doc") warnings.push({ code: "legacy_format", message: "ملف Word قديم (.doc) حُوّل إلى .docx", severity: "info" });

  // A fingerprint of the layout's fixed text, to find templates shared between clients.
  const skeleton = bodyText
    .replace(DATE, "")
    .replace(/[\d٠-٩]+/g, "")
    .replace(/[.…_ـ\-☐☑☒□■\s]+/g, "")
    .replace(new RegExp(clients.flatMap((client) => client.aliases).join("|"), "gi"), "");
  const fingerprint = (await sha256(skeleton)).slice(0, 16);
  const words = [
    ...new Set(
      bodyText
        .replace(DATE, " ")
        .replace(SAMPLE_PHRASES, " ")
        .split(/[\s:：.…_ـ\-☐☑☒□■()،,/]+/)
        .filter((word) => word.length >= 3 && !/\d/.test(word)),
    ),
  ].sort();

  const props = coreProps(pkg);
  const hints: string[] = [];
  if (/\(جديد\)|جديد/.test(options.fileName + title)) hints.push("يحمل اسمه كلمة «جديد»");
  if (/الموحد/.test(options.fileName + title)) hints.push("النموذج الموحد");
  const label = props.modified ? `مراجعة ${props.revision ?? "?"} — ${props.modified.slice(0, 10)}` : `مراجعة ${props.revision ?? "?"}`;

  return {
    sha256: options.originalSha ?? (await sha256(bytes)),
    file_name: options.fileName,
    source_path: options.sourcePath ?? null,
    format: options.format ?? "docx",
    size: options.originalSize ?? bytes.length,
    title,
    client: {
      client_id: best && content.length ? best[0] : null,
      confidence: content.length ? Number(confidence.toFixed(2)) : 0,
      evidence: best?.[1].evidence ?? [],
      alternatives: ranked.slice(1, 4).map(([client_id, entry]) => ({ client_id, score: Number(entry.score.toFixed(2)) })),
      suggested: best && content.length ? best[0] : (best?.[0] ?? folderClient?.client_id ?? null),
    },
    investigation_type: { code: type?.code ?? null, name: type?.name ?? null, confidence: fromTitle ? 0.9 : fromPath ? 0.6 : type ? 0.4 : 0, evidence: typeEvidence },
    version: { label, created_at: props.created, modified_at: props.modified, revision: props.revision, hints },
    layout_fingerprint: fingerprint,
    layout_words: words,
    stats: {
      paragraphs: descendants(docXml, "p").length,
      tables: descendants(docXml, "tbl").length,
      checkboxes: descendants(docXml, "checkbox", NS.w14).length + (bodyText.match(/[☐☑☒□]/g) ?? []).length,
      text_boxes: descendants(docXml, "txbxContent").length,
      images: images.length,
      headers: parts.filter((part) => part.includes("header")).length,
      footers: parts.filter((part) => part.includes("footer")).length,
      page_breaks: descendants(docXml, "br").filter((br) => attr(br, "type") === "page").length +
        descendants(docXml, "pageBreakBefore").length,
      fonts: fonts(pkg),
    },
    images,
    warnings,
  };
}

/** Share of distinct words two layouts have in common (Jaccard similarity). */
export function layoutSimilarity(a: InventoryRecord, b: InventoryRecord): number {
  const left = new Set(a.layout_words);
  const right = new Set(b.layout_words);
  if (!left.size || !right.size) return a.layout_fingerprint === b.layout_fingerprint ? 1 : 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** Marks templates whose layout is (nearly) identical across clients, e.g. Bedayty, Global and MIDBANK. */
export function markSharedLayouts(records: InventoryRecord[], threshold = 0.88): void {
  for (const record of records) {
    const twins = records.filter(
      (other) =>
        other !== record &&
        (other.client.client_id ?? other.client.suggested) !== (record.client.client_id ?? record.client.suggested) &&
        layoutSimilarity(record, other) >= threshold,
    );
    if (!twins.length) continue;
    record.warnings.push({
      code: "shared_layout",
      message: `نفس التصميم تقريبًا مستخدم لدى: ${[...new Set(twins.map((item) => item.client.client_id ?? item.client.suggested ?? "?"))].join("، ")}`,
      severity: "info",
    });
  }
}

export { children };
