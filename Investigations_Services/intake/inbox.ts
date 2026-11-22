import { ImapFlow } from "imapflow";
import { simpleParser, type AddressObject } from "mailparser";
import nodemailer from "nodemailer";
import { query } from "../../IdentityAcess_Services/Config/db.ts";
import { putStoredFile } from "../../IdentityAcess_Services/Utils/files.ts";
import { domainOf } from "./rules.ts";

/**
 * The company inboxes. Settings come from the environment only (never the database or git):
 *   MAIL_INBOXES=retail,info,sme
 *   MAIL_RETAIL_USER=retail@…   MAIL_RETAIL_PASS=…   (one pair per inbox)
 *   MAIL_IMAP_HOST (imap.secureserver.net)  MAIL_IMAP_PORT (993)
 *   MAIL_SMTP_HOST (smtpout.secureserver.net)  MAIL_SMTP_PORT (465)
 *
 * Mailboxes are opened read-only: nothing is marked read, moved or deleted, so the team's
 * own mail clients see the inbox exactly as before.
 */
export interface Inbox {
  name: string;
  user: string;
  pass: string;
}

export function configuredInboxes(): Inbox[] {
  return (process.env.MAIL_INBOXES ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean)
    .map((name) => ({
      name,
      user: process.env[`MAIL_${name.toUpperCase()}_USER`]?.trim() ?? "",
      pass: process.env[`MAIL_${name.toUpperCase()}_PASS`] ?? "",
    }))
    .filter((inbox) => inbox.user && inbox.pass);
}

const imapHost = () => process.env.MAIL_IMAP_HOST || "imap.secureserver.net";
const imapPort = () => Number(process.env.MAIL_IMAP_PORT || 993);
const smtpHost = () => process.env.MAIL_SMTP_HOST || "smtpout.secureserver.net";
const smtpPort = () => Number(process.env.MAIL_SMTP_PORT || 465);

/** Emails larger than this are recorded but not stored (attachments over 25 MB are rare). */
const MAX_MESSAGE_BYTES = 40 * 1024 * 1024;
/** On the very first poll, only mail from the last few hours is taken (no history import). */
const FIRST_RUN_HOURS = Number(process.env.MAIL_FIRST_RUN_HOURS || 0);

const addresses = (field: AddressObject | AddressObject[] | undefined) =>
  (Array.isArray(field) ? field : field ? [field] : [])
    .flatMap((item) => item.value.map((value) => value.address?.toLowerCase() ?? ""))
    .filter(Boolean);

const safeName = (name: string) => name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").slice(0, 120) || "file";

/** New messages in one inbox since the last poll; each is stored and recorded as `new`. */
export async function pollInbox(inbox: Inbox): Promise<number> {
  const client = new ImapFlow({
    host: imapHost(),
    port: imapPort(),
    secure: true,
    auth: { user: inbox.user, pass: inbox.pass },
    logger: false,
    socketTimeout: 120_000,
  });
  await client.connect();
  let added = 0;
  try {
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      const mailbox = client.mailbox;
      const validity = mailbox ? String(mailbox.uidValidity) : "";
      const uidNext = mailbox ? Number(mailbox.uidNext) : 0;
      const [state] = await query("SELECT uid_validity, last_uid FROM mail_inbox_state WHERE inbox=$1", [inbox.name]);
      let lastUid = Number(state?.last_uid ?? 0);
      if (!state || state.uid_validity !== validity) {
        // First run (or the server renumbered the mailbox): start from now, never import history.
        lastUid = uidNext - 1;
        if (FIRST_RUN_HOURS > 0) {
          const since = new Date(Date.now() - FIRST_RUN_HOURS * 3_600_000);
          const recent = ((await client.search({ since }, { uid: true })) || []) as number[];
          if (recent.length) lastUid = Math.min(...recent) - 1;
        }
        await query(
          `INSERT INTO mail_inbox_state(inbox, uid_validity, last_uid) VALUES($1,$2,$3)
           ON CONFLICT (inbox) DO UPDATE SET uid_validity=$2, last_uid=$3`,
          [inbox.name, validity, lastUid],
        );
      }
      if (uidNext - 1 <= lastUid) return 0;
      const uids = (((await client.search({ uid: `${lastUid + 1}:*` }, { uid: true })) || []) as number[])
        .filter((uid) => uid > lastUid)
        .sort((a, b) => a - b);
      for (const uid of uids) {
        const message = await client.fetchOne(String(uid), { source: true, size: true }, { uid: true });
        if (message && message.source && message.source.length <= MAX_MESSAGE_BYTES) {
          await storeMessage(inbox.name, uid, message.source);
          added += 1;
        }
        await query("UPDATE mail_inbox_state SET last_uid=$2 WHERE inbox=$1", [inbox.name, uid]);
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
  return added;
}

async function storeMessage(inbox: string, uid: number, source: Buffer): Promise<void> {
  const parsed = await simpleParser(source);
  const headerId = parsed.messageId ?? null;
  const [existing] = await query(
    "SELECT 1 FROM mail_messages WHERE inbox=$1 AND uid=$2 AND COALESCE(header_message_id,'')=COALESCE($3,'')",
    [inbox, uid, headerId],
  );
  if (existing) return;
  const id = crypto.randomUUID();
  const folder = `mail/${inbox}/${id}`;
  const rawPath = await putStoredFile(`${folder}/message.eml`, new Uint8Array(source), "message/rfc822");
  const attachments = [];
  for (const [index, file] of parsed.attachments.entries()) {
    const name = safeName(file.filename || `attachment-${index + 1}`);
    const path = await putStoredFile(`${folder}/${index}-${name}`, new Uint8Array(file.content), file.contentType);
    attachments.push({
      index,
      name,
      type: file.contentType,
      bytes: file.size,
      path,
      inline: file.contentDisposition === "inline" || Boolean(file.cid),
    });
  }
  const from = parsed.from?.value[0];
  await query(
    `INSERT INTO mail_messages(message_id, inbox, uid, header_message_id, from_address, from_name, from_domain,
       to_addresses, cc_addresses, subject, body_text, received_at, raw_path, attachments, status)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::text::jsonb,'new')`,
    [
      id,
      inbox,
      uid,
      headerId,
      from?.address?.toLowerCase() ?? null,
      from?.name || null,
      domainOf(from?.address),
      addresses(parsed.to),
      addresses(parsed.cc),
      (parsed.subject ?? "").slice(0, 500),
      htmlOrText(parsed.text, parsed.html),
      parsed.date ?? new Date(),
      rawPath,
      JSON.stringify(attachments),
    ],
  );
}

/** The body as text, keeping HTML tables (the reader parses them) as `<table>` markup. */
function htmlOrText(text: string | undefined, html: string | false | undefined): string {
  if (html && /<table/i.test(html)) {
    return html
      .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .slice(0, 400_000);
  }
  return (text ?? "").slice(0, 200_000);
}

let running = false;
/** Polls every configured inbox; errors are kept per inbox for the status screen. */
export async function pollAll(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const inbox of configuredInboxes()) {
      try {
        await query(
          `INSERT INTO mail_inbox_state(inbox, last_poll_at) VALUES($1, now())
           ON CONFLICT (inbox) DO UPDATE SET last_poll_at = now()`,
          [inbox.name],
        );
        const added = await pollInbox(inbox);
        await query("UPDATE mail_inbox_state SET last_ok_at=now(), last_error=NULL WHERE inbox=$1", [inbox.name]);
        if (added) console.log(JSON.stringify({ level: "info", message: "mail.received", inbox: inbox.name, added }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await query("UPDATE mail_inbox_state SET last_error=$2 WHERE inbox=$1", [inbox.name, message.slice(0, 500)]);
        console.error(JSON.stringify({ level: "error", message: "mail.poll_failed", inbox: inbox.name, error: message }));
      }
    }
  } finally {
    running = false;
  }
}

export interface OutgoingMail {
  inbox: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  inReplyTo?: string | null;
  attachments: { filename: string; content: Uint8Array; contentType?: string }[];
}

/** Sends from the company inbox itself, so replies thread with the client's request. */
export async function sendFromInbox(mail: OutgoingMail): Promise<string | null> {
  const inbox = configuredInboxes().find((item) => item.name === mail.inbox);
  if (!inbox) throw new Error(`The ${mail.inbox} inbox is not configured`);
  const transport = nodemailer.createTransport({
    host: smtpHost(),
    port: smtpPort(),
    secure: smtpPort() === 465,
    requireTLS: smtpPort() !== 465,
    auth: { user: inbox.user, pass: inbox.pass },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 60_000,
  });
  const result = await transport.sendMail({
    from: inbox.user,
    to: mail.to,
    cc: mail.cc.length ? mail.cc : undefined,
    subject: mail.subject,
    text: mail.text,
    html: `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:14px;white-space:pre-wrap">${escapeHtml(mail.text)}</div>`,
    inReplyTo: mail.inReplyTo ?? undefined,
    references: mail.inReplyTo ? [mail.inReplyTo] : undefined,
    attachments: mail.attachments.map((file) => ({
      filename: file.filename,
      content: Buffer.from(file.content),
      contentType: file.contentType,
    })),
  });
  return result.messageId ?? null;
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
