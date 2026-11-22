import { docxText } from "../../Shared/xlsx.ts";
import type { AiInput } from "./ai.ts";
import { sniffType } from "./rules.ts";

/** What an email's attachments give the AI reader, within the API's limits, and what they don't. */

export interface Attachment {
  index: number;
  name: string;
  type: string;
  bytes: number;
  path: string;
  inline?: boolean;
}

/** One request may be 32 MB as base64, which is 24 MB of files; leave room for the text. */
const TOTAL_BYTES = 20_000_000;
/** One image may be 5 MB as base64. */
const IMAGE_BYTES = 3_750_000;
const MAX_IMAGES = 20;
const MAX_PDFS = 30;

const extension = (name: string) => /\.([a-z0-9]{1,6})$/i.exec(name)?.[1]?.toLowerCase() ?? "";

export const isXlsx = (file: Attachment) =>
  extension(file.name) === "xlsx" || extension(file.name) === "xlsm" || file.type.includes("spreadsheetml");
export const isCsv = (file: Attachment) => extension(file.name) === "csv" || file.type === "text/csv";
export const isPdf = (file: Attachment) => extension(file.name) === "pdf" || file.type === "application/pdf";

/** Logos, social icons and signature images: never a request. */
export function isDecoration(file: Attachment): boolean {
  if (!file.type.toLowerCase().startsWith("image/")) return false;
  if (file.bytes < 15_000) return true;
  return /^(facebook|fb_|youtube|linkedin|instagram|twitter|logo|.*_logo)/i.test(file.name);
}

/** Parts of the email itself (headers of a bounce, the message already unpacked at storage). */
const isEnvelope = (file: Attachment) =>
  /^(message\/rfc822|text\/rfc822-headers|message\/delivery-status|text\/calendar)/i.test(file.type) ||
  ["emz", "wmz", "mso", "ics", "p7s"].includes(extension(file.name));

export interface GatheredFiles {
  images: AiInput["images"];
  pdfs: AiInput["pdfs"];
  texts: AiInput["texts"];
  /** Files no one read: the case then waits for a person instead of silently losing them. */
  unread: string[];
}

export async function gatherFiles(
  attachments: Attachment[],
  read: (path: string) => Promise<Uint8Array>,
): Promise<GatheredFiles> {
  const out: GatheredFiles = { images: [], pdfs: [], texts: [], unread: [] };
  let total = 0;
  for (const file of attachments) {
    // Spreadsheets are read as tables; the envelope is not a document.
    if (isXlsx(file) || isCsv(file) || isEnvelope(file)) continue;
    const image = file.type.toLowerCase().startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp"].includes(extension(file.name));
    const docx = extension(file.name) === "docx";
    if (!image && !docx && !isPdf(file)) {
      out.unread.push(file.name);
      continue;
    }
    // A storage outage is not an unreadable file: it throws, and the email is read again later.
    const bytes = await read(file.path);
    if (docx) {
      try {
        const text = docxText(bytes);
        if (text.trim()) out.texts.push({ name: file.name, text });
        else out.unread.push(file.name);
      } catch {
        out.unread.push(file.name);
      }
      continue;
    }
    const type = sniffType(bytes);
    if (!type || total + bytes.length > TOTAL_BYTES) {
      out.unread.push(file.name);
    } else if (type === "application/pdf") {
      if (out.pdfs.length >= MAX_PDFS) out.unread.push(file.name);
      else {
        out.pdfs.push({ data: bytes, name: file.name });
        total += bytes.length;
      }
    } else if (bytes.length > IMAGE_BYTES || out.images.length >= MAX_IMAGES) {
      out.unread.push(file.name);
    } else {
      out.images.push({ media_type: type, data: bytes, name: file.name });
      total += bytes.length;
    }
  }
  return out;
}
