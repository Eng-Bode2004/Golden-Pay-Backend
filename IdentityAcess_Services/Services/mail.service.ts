import nodemailer from "nodemailer";
import { env } from "../Config/env.ts";
import { logger } from "../Utils/logger.ts";

export interface OutboundMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export async function sendMail(message: OutboundMail): Promise<boolean> {
  if (!env.smtpPass) {
    logger.warn("mail.skipped", { reason: "SMTP_PASS is not configured", to: message.to });
    return false;
  }

  const transport = nodemailer.createTransport({
    host: env.smtpHost,
    port: env.smtpPort,
    secure: env.smtpPort === 465,
    requireTLS: env.smtpPort !== 465,
    auth: {user: env.smtpUser, pass: env.smtpPass},
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });

  try {
    const result = await transport.sendMail({from: env.mailFrom, ...message});
    if (!result.accepted?.length) throw new Error("No recipients accepted");
    logger.info("mail.sent", { to: message.to, subject: message.subject });
    return true;
  } catch (error) {
    logger.error("mail.failed", {
      to: message.to,
      code: (error as {code?: string}).code ?? "SMTP_FAILED",
    });
    return false;
  } finally {
    transport.close();
  }
}

export function adminInviteEmail(input: {
  fullName?: string | null;
  inviteUrl: string;
  mfaRequired: boolean;
}): { subject: string; text: string; html: string } {
  const greeting = input.fullName ? `Hello ${input.fullName},` : "Hello,";
  const mfaLine = input.mfaRequired
    ? "After you set your password you will enrol Google Authenticator or Authy on first sign-in."
    : "You can sign in with email and password. The owner can later require Google Authenticator or Authy.";
  const subject = "You are invited to the Golden Pay dashboard";
  const text = [
    greeting,
    "",
    "You have been invited as a Golden Pay administrator.",
    `Open this link to set your password: ${input.inviteUrl}`,
    mfaLine,
    "",
    "This invitation was sent from goldenpayservices@gmail.com.",
  ].join("\n");
  const html = `<!doctype html>
<html><body style="margin:0;background:#0b0b0d;color:#f6e7c1;font-family:Georgia,serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0b0b0d;padding:32px 16px">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#16141a;border:1px solid #c6a15b;border-radius:18px;padding:36px">
        <tr><td>
          <p style="letter-spacing:.28em;font-size:12px;color:#c6a15b;margin:0 0 18px">GOLDEN PAY SERVICES</p>
          <h1 style="margin:0 0 16px;font-size:28px;color:#f3e1b6">Administrator invitation</h1>
          <p style="line-height:1.6;color:#ead9ad">${greeting}</p>
          <p style="line-height:1.6;color:#ead9ad">The primary administrator has invited you to operate the Golden Pay dashboard.</p>
          <p style="margin:28px 0" align="center">
            <a href="${input.inviteUrl}" style="background:linear-gradient(135deg,#e7c77a,#b7892e);color:#1a1408;text-decoration:none;padding:14px 28px;border-radius:999px;font-weight:700;letter-spacing:.04em">Accept invitation</a>
          </p>
          <p style="line-height:1.6;color:#d8c394;font-size:14px">${mfaLine}</p>
          <p style="line-height:1.6;color:#8f7d55;font-size:12px">Sent from goldenpayservices@gmail.com · Golden Pay Services</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  return { subject, text, html };
}
