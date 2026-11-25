import { ImapFlow } from "imapflow";
import { simpleParser, type AddressObject, type Attachment as MailPart } from "mailparser";
import nodemailer from "nodemailer";
import { query } from "../../IdentityAcess_Services/Config/db.ts";
import { putStoredFile } from "../../IdentityAcess_Services/Utils/files.ts";
import { cleanText, domainOf, senderVerified } from "./rules.ts";

/**
 * The company inboxes. Settings come from the environment only (never the database or git):
 *   MAIL_INBOXES=retail,info,sme
 *   MAIL_RETAIL_USER=retail@…   MAIL_RETAIL_PASS=…   (one pair per inbox)
 *   MAIL_IMAP_HOST (imap.secureserver.net)  MAIL_IMAP_PORT (993)
 *   MAIL_SMTP_HOST (smtpout.secureserver.net)  MAIL_SMTP_PORT (465)
 *
 * Reading opens the mailbox read-only: nothing is marked read, moved or deleted, so the
 * team's own mail clients see the inbox exactly as before. A report an administrator sends
 * is also saved to that inbox's Sent folder, as a mail client would.
 */
export interface Inbox {
  name: string;
  user: string;
  pass: string;
}

/** The company's three inboxes, also when set as RETAIL / RETAIL_PASS (the address, then its password). */
const SHORT_NAMES = ["retail", "info", "sme"];

export function configuredInboxes(env: Record<string, string | undefined> = process.env): Inbox[] {
  const listed = (env.MAIL_INBOXES ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  return (listed.length ? listed : SHORT_NAMES)
    .map((name) => {
      const upper = name.toUpperCase();
      return {
        name,
        user: (env[`MAIL_${upper}_USER`] ?? env[upper] ?? "").trim(),
        pass: env[`MAIL_${upper}_PASS`] ?? env[`${upper}_PASS`] ?? "",
      };
    })
    // Only a real address: a short variable that holds something else is not an inbox.
    .filter((inbox) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(inbox.user) && inbox.pass);
}

const imapHost = () => process.env.MAIL_IMAP_HOST || "imap.secureserver.net";
const imapPort = () => Number(process.env.MAIL_IMAP_PORT || 993);
const smtpHost = () => process.env.MAIL_SMTP_HOST || "smtpout.secureserver.net";
const smtpPort = () => Number(process.env.MAIL_SMTP_PORT || 465);

const MAX_MESSAGE_BYTES = 40 * 1024 * 1024;
/** On the very first poll, only mail from the last few hours is taken (no history import). */
const FIRST_RUN_HOURS = Number(process.env.MAIL_FIRST_RUN_HOURS || 0);
/** Polls (about a minute apart) before one email that will not save stops holding up the inbox. */
const STORE_ATTEMPTS = 5;
const storeFailures = new Map<string, number>();

const addresses = (field: AddressObject | AddressObject[] | undefined) =>
  (Array.isArray(field) ? field : field ? [field] : [])
    .flatMap((item) => item.value.map((value) => cleanText(value.address?.toLowerCase() ?? "")))
    .filter(Boolean);

const safeName = (name: string) =>
  cleanText(name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").slice(0, 120)) || "file";

function connection(inbox: Inbox): ImapFlow {
  const client = new ImapFlow({
    host: imapHost(),
    port: imapPort(),
    secure: true,
    auth: { user: inbox.user, pass: inbox.pass },
    logger: false,
    socketTimeout: 120_000,
  });
  // A dropped or timed-out connection emits 'error': log it with the inbox's name instead of
  // leaving it to keepServiceAlive as an uncaught exception. The poll is retried either way.
  client.on("error", (error: Error) =>
    console.error(JSON.stringify({ level: "warn", message: "mail.connection_error", inbox: inbox.name, error: error.message })),
  );
  return client;
}

/** When the email reached our server. The Date header is the sender's clock and can be anything. */
function arrival(value: Date | string | undefined): Date {
  const at = value ? new Date(value) : new Date();
  return Number.isNaN(at.getTime()) || at.getTime() > Date.now() ? new Date() : at;
}

/** New messages in one inbox since the last poll; each is stored and recorded as `new`. */
export async function pollInbox(inbox: Inbox): Promise<number> {
  const client = connection(inbox);
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
        const message = await client.fetchOne(String(uid), { source: true, size: true, internalDate: true }, { uid: true });
        // No message: it was moved or deleted before we got to it.
        if (message && message.source) {
          const received = arrival(message.internalDate);
          const key = `${inbox.name}:${validity}:${uid}`;
          if (message.source.length > MAX_MESSAGE_BYTES) {
            await recordUnsaved(inbox.name, uid, received, "بريد أكبر من 40 ميجا: افتحه من برنامج البريد وأضف الأشخاص", null);
          } else {
            try {
              await storeMessage(inbox.name, uid, message.source, received);
              storeFailures.delete(key);
              added += 1;
            } catch (error) {
              const tries = (storeFailures.get(key) ?? 0) + 1;
              storeFailures.set(key, tries);
              if (tries < STORE_ATTEMPTS) throw error;
              // It stays visible and is fetched again later; the emails behind it carry on.
              const detail = error instanceof Error ? error.message : String(error);
              await recordUnsaved(inbox.name, uid, received, `تعذّر حفظ البريد: ${detail}`, new Date(Date.now() + 30 * 60_000));
              storeFailures.delete(key);
            }
          }
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

async function recordUnsaved(inbox: string, uid: number, received: Date, reason: string, retryAt: Date | null): Promise<void> {
  await query(
    `INSERT INTO mail_messages(message_id, inbox, uid, subject, received_at, status, reason, retry_at)
     VALUES($1,$2,$3,$4,$5,'failed',$6,$7) ON CONFLICT DO NOTHING`,
    [crypto.randomUUID(), inbox, uid, "بريد لم يُحفظ", received, cleanText(reason.slice(0, 500)), retryAt],
  );
}

/** Saves an email that could not be saved when it arrived, in the same row. */
export async function refetchMessage(messageId: string): Promise<boolean> {
  const [row] = await query("SELECT inbox, uid, received_at, attempts FROM mail_messages WHERE message_id=$1 AND raw_path IS NULL", [
    messageId,
  ]);
  if (!row) return true;
  const inbox = configuredInboxes().find((item) => item.name === row.inbox);
  try {
    if (!inbox) throw new Error("البريد غير مضبوط على الخادم");
    const client = connection(inbox);
    await client.connect();
    try {
      const lock = await client.getMailboxLock("INBOX", { readOnly: true });
      try {
        const message = await client.fetchOne(String(row.uid), { source: true }, { uid: true });
        if (!message || !message.source) throw new Error("لم يعد البريد موجودًا في صندوق الوارد");
        if (message.source.length > MAX_MESSAGE_BYTES) throw new Error("البريد أكبر من 40 ميجا");
        await storeMessage(inbox.name, Number(row.uid), message.source, new Date(row.received_at as string), messageId);
        return true;
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
  } catch (error) {
    const attempts = Number(row.attempts ?? 0) + 1;
    const detail = error instanceof Error ? error.message : String(error);
    await query("UPDATE mail_messages SET status='failed', reason=$2, attempts=$3, retry_at=$4 WHERE message_id=$1", [
      messageId,
      cleanText(`تعذّر حفظ البريد: ${detail}`.slice(0, 500)),
      attempts,
      attempts < 6 ? new Date(Date.now() + 30 * 60_000) : null,
    ]);
    return false;
  }
}

async function storeMessage(inbox: string, uid: number, source: Buffer, received: Date, replace?: string): Promise<void> {
  const parsed = await simpleParser(source);
  const headerId = parsed.messageId ? cleanText(parsed.messageId) : null;
  if (!replace) {
    const [existing] = await query(
      "SELECT 1 FROM mail_messages WHERE inbox=$1 AND uid=$2 AND COALESCE(header_message_id,'')=COALESCE($3,'')",
      [inbox, uid, headerId],
    );
    if (existing) return;
  }

  // An email forwarded as an attachment: its text and files are the request.
  const parts: MailPart[] = [...parsed.attachments];
  const carried: { text: string; html: string }[] = [];
  for (const part of parsed.attachments) {
    if (part.contentType !== "message/rfc822") continue;
    try {
      const inner = await simpleParser(part.content);
      carried.push({ text: [inner.subject, inner.text].filter(Boolean).join("\n"), html: inner.html || "" });
      parts.push(...inner.attachments);
    } catch {
      // the attached email stays downloadable as it is
    }
  }

  const id = replace ?? crypto.randomUUID();
  const folder = `mail/${inbox}/${id}`;
  const rawPath = await putStoredFile(`${folder}/message.eml`, new Uint8Array(source), "message/rfc822");
  const attachments = [];
  for (const [index, file] of parts.entries()) {
    const name = safeName(file.filename || `attachment-${index + 1}`);
    // The stored key is plain ASCII; the name people see is kept beside it.
    const ext = /\.([a-z0-9]{1,6})$/i.exec(name)?.[1]?.toLowerCase() ?? "bin";
    const path = await putStoredFile(`${folder}/${index}.${ext}`, new Uint8Array(file.content), file.contentType);
    attachments.push({
      index,
      name,
      type: cleanText(file.contentType),
      bytes: file.size,
      path,
      inline: file.contentDisposition === "inline" || Boolean(file.cid),
    });
  }

  const from = parsed.from?.value[0];
  const columns = [
    "header_message_id",
    "from_address",
    "from_name",
    "from_domain",
    "to_addresses",
    "cc_addresses",
    "subject",
    "body_text",
    "received_at",
    "raw_path",
    "sender_verified",
  ];
  const fromAddress = from?.address ? cleanText(from.address.toLowerCase()) : null;
  const values = [
    headerId,
    fromAddress,
    from?.name ? cleanText(from.name) : null,
    domainOf(fromAddress),
    addresses(parsed.to),
    addresses(parsed.cc),
    cleanText((parsed.subject ?? "").slice(0, 500)),
    cleanText(bodyOf(parsed.text, parsed.html, carried)),
    received,
    rawPath,
    senderVerified(parsed.headerLines.find((header) => header.key === "authentication-results")?.line.replace(/^[^:]+:/, "")),
  ];
  if (replace) {
    await query(
      `UPDATE mail_messages SET ${columns.map((column, i) => `${column}=$${i + 2}`).join(", ")},
         attachments=$${columns.length + 2}::text::jsonb, status='new', reason=NULL, retry_at=NULL
       WHERE message_id=$1`,
      [id, ...values, JSON.stringify(attachments)],
    );
    return;
  }
  await query(
    `INSERT INTO mail_messages(message_id, inbox, uid, ${columns.join(", ")}, attachments, status)
     VALUES($1,$2,$3,${columns.map((_, i) => `$${i + 4}`).join(",")},$${columns.length + 4}::text::jsonb,'new')`,
    [id, inbox, uid, ...values, JSON.stringify(attachments)],
  );
}

/** The body as text, or as HTML when it has tables (the reader parses them). Attached emails come first. */
function bodyOf(text: string | undefined, html: string | false | undefined, carried: { text: string; html: string }[]): string {
  const bare = (value: string) =>
    value.replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  const escaped = (value: string) => escapeHtml(value).replace(/\n/g, "<br>");
  const outer = typeof html === "string" ? html : "";
  if (/<table/i.test(outer) || carried.some((part) => /<table/i.test(part.html))) {
    const before = carried.map((part) => (part.html ? bare(part.html) : escaped(part.text)));
    return [...before, outer ? bare(outer) : escaped(text ?? "")].join("\n<br>").slice(0, 400_000);
  }
  return [...carried.map((part) => part.text), text ?? ""].join("\n").slice(0, 200_000);
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
        await query("UPDATE mail_inbox_state SET last_error=$2 WHERE inbox=$1", [inbox.name, cleanText(message.slice(0, 500))]);
        console.error(JSON.stringify({ level: "error", message: "mail.poll_failed", inbox: inbox.name, error: message }));
      }
    }
  } finally {
    running = false;
  }
}

// ───────────── sending ─────────────

export interface OutgoingMail {
  inbox: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  inReplyTo?: string | null;
  attachments: { filename: string; content: Uint8Array; contentType?: string }[];
}

const smtp = (inbox: Inbox) =>
  nodemailer.createTransport({
    host: smtpHost(),
    port: smtpPort(),
    secure: smtpPort() === 465,
    requireTLS: smtpPort() !== 465,
    auth: { user: inbox.user, pass: inbox.pass },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 60_000,
  });

/**
 * Sends from the company inbox itself, so replies thread with the client's request, and
 * saves the same bytes to that inbox's Sent folder. Failing to save never fails the send.
 */
export async function sendFromInbox(mail: OutgoingMail): Promise<{ messageId: string | null; savedToSent: boolean }> {
  const inbox = configuredInboxes().find((item) => item.name === mail.inbox);
  if (!inbox) throw new Error(`The ${mail.inbox} inbox is not configured`);
  const built = await nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" }).sendMail({
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
  const raw = built.message as Buffer;
  await smtp(inbox).sendMail({ envelope: { from: inbox.user, to: [...mail.to, ...mail.cc] }, raw });
  return { messageId: built.messageId ?? null, savedToSent: await saveToSent(inbox, raw) };
}

async function saveToSent(inbox: Inbox, raw: Buffer): Promise<boolean> {
  const client = connection(inbox);
  try {
    await client.connect();
    const folders = await client.list();
    // «Sent» is where the team's own mail lands; some inboxes also have an unused «Sent Items».
    const folder =
      folders.find((item) => item.path === "Sent") ??
      folders.find((item) => item.specialUse === "\\Sent") ??
      folders.find((item) => item.path === "Sent Items");
    if (!folder) return false;
    return Boolean(await client.append(folder.path, raw, ["\\Seen"]));
  } catch (error) {
    console.error(
      JSON.stringify({ level: "warn", message: "mail.sent_copy_failed", inbox: inbox.name, error: error instanceof Error ? error.message : String(error) }),
    );
    return false;
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/** Signs in to read and to send without doing either. Null means it works; otherwise the error. */
export async function testInbox(inbox: Inbox): Promise<{ read: string | null; send: string | null }> {
  const said = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);
  let read: string | null = null;
  const client = connection(inbox);
  try {
    await client.connect();
    await client.status("INBOX", { messages: true, uidNext: true });
  } catch (error) {
    read = said(error);
  } finally {
    await client.logout().catch(() => undefined);
  }
  let send: string | null = null;
  try {
    await smtp(inbox).verify();
  } catch (error) {
    send = said(error);
  }
  return { read, send };
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
