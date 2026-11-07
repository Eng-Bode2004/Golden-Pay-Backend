import { createHmac, randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { env } from "../Config/env.ts";
import { query, transaction } from "../Config/db.ts";
import { encryptString, decryptString, newId, randomToken, sha256Hex, constantTimeEqual } from "../Utils/crypto.ts";
import { ApiError, type RequestContext } from "../Utils/http.ts";
import { recordAudit } from "./audit.service.ts";
import { revokeAllUserSessions } from "./session.service.ts";
import { adminInviteEmail, sendMail } from "./mail.service.ts";
import { beginEmailOtp, finishEmailOtp } from "./email-otp.service.ts";

export function base32(bytes: Buffer): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0, result = "";
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { result += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31];
  return result;
}
export function totp(secret: string, step: number): string {
  let bits = 0, value = 0; const bytes: number[] = [];
  for (const c of secret) {
    value = (value << 5) | "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c); bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, "0");
}
export async function security(userId: string) {
  return (await query("SELECT * FROM admin_security WHERE user_id=$1", [userId]))[0];
}
export async function requireOwner(userId: string) {
  if (!(await security(userId))?.is_owner) throw ApiError.forbidden("Only the primary administrator can manage administrators");
}

const TOTP_ISSUER = "Golden Pay";
function recoveryHashes(config: Record<string, unknown>): string[] {
  const value = config.recovery_hashes;
  if (typeof value === "string") {
    try { return JSON.parse(value) as string[]; } catch { return []; }
  }
  return Array.isArray(value) ? (value as string[]) : [];
}
export async function securitySummary(userId: string) {
  const config = await security(userId);
  if (!config) return null;
  return {
    is_owner: !!config.is_owner,
    mfa_required: !!config.mfa_required,
    mfa_method: (config.mfa_method as string | undefined) ?? "totp",
    enrolled: config.mfa_method === "email" ? true : !!config.secret,
    pending_enrollment: !!config.pending_secret,
    recovery_codes_remaining: recoveryHashes(config).length,
  };
}
export async function beginTotpEnrollment(userId: string, accountLabel: string) {
  const config = await security(userId);
  if (!config) throw ApiError.forbidden("Administrator account required");
  const secret = base32(randomBytes(20));
  await query("UPDATE admin_security SET pending_secret=$2 WHERE user_id=$1", [userId, encryptString(secret)]);
  const uri = `otpauth://totp/${encodeURIComponent(`Golden Pay:${accountLabel}`)}?secret=${secret}&issuer=${encodeURIComponent(TOTP_ISSUER)}&algorithm=SHA1&digits=6&period=30`;
  return {
    secret,
    otpauth_uri: uri,
    qr_code: await QRCode.toDataURL(uri, { width: 280, margin: 2 }),
    current_method: (config.mfa_method as string | undefined) ?? "totp",
  };
}
export async function activateTotp(userId: string, code: string, context: RequestContext, mode: "totp" | "both" = "totp") {
  const result = await transaction(async () => {
    const config = (await query("SELECT * FROM admin_security WHERE user_id=$1 FOR UPDATE", [userId]))[0];
    if (!config?.pending_secret) throw new ApiError(400, "TOTP_SETUP_REQUIRED", "ابدأ إعداد تطبيق المصادقة أولاً.");
    const secret = decryptString(String(config.pending_secret));
    const step = Math.floor(Date.now() / 30000);
    const matched = [step - 1, step, step + 1].find((candidate) => constantTimeEqual(totp(secret, candidate), code));
    if (matched === undefined) throw new ApiError(401, "INVALID_TOTP", "الرمز غير صحيح. تأكد من رمز تطبيق المصادقة وحاول مجدداً.");
    const recoveryCodes = Array.from({ length: 8 }, () => randomBytes(12).toString("hex"));
    await query(
      "UPDATE admin_security SET secret=pending_secret,pending_secret=NULL,mfa_method=$4,mfa_required=true,last_step=$2,recovery_hashes=$3::text::jsonb WHERE user_id=$1",
      [userId, matched, JSON.stringify(recoveryCodes.map(sha256Hex)), mode],
    );
    await query("DELETE FROM admin_mfa_challenges WHERE user_id=$1", [userId]);
    return { recoveryCodes };
  });
  await recordAudit({ event: "admin.mfa.enrolled", userId, success: true, context, metadata: { method: mode } });
  return { mfa_method: mode, mfa_required: true, recovery_codes: result.recoveryCodes };
}
/**
 * Switches an already-enrolled authenticator account between the plain
 * authenticator step and the chained email + authenticator flow without
 * forcing the administrator to scan a new QR code.
 */
export async function switchTotpMode(userId: string, mode: "totp" | "both", context: RequestContext) {
  const config = await security(userId);
  if (!config?.secret) throw new ApiError(400, "TOTP_SETUP_REQUIRED", "أكمل إعداد تطبيق المصادقة أولاً.");
  await transaction(async () => {
    await query("UPDATE admin_security SET mfa_method=$2,mfa_required=true WHERE user_id=$1", [userId, mode]);
    await query("DELETE FROM admin_mfa_challenges WHERE user_id=$1", [userId]);
  });
  await recordAudit({
    event: "admin.mfa.method.changed",
    userId,
    actorId: userId,
    success: true,
    context,
    metadata: { method: mode },
  });
  return { mfa_method: mode, mfa_required: true };
}
export async function disableMfa(userId: string, context: RequestContext, actorId: string) {
  await transaction(async () => {
    await query(
      "UPDATE admin_security SET mfa_required=false,secret=NULL,pending_secret=NULL,last_step=-1,recovery_hashes='[]',mfa_method='totp' WHERE user_id=$1",
      [userId],
    );
    await query("DELETE FROM admin_mfa_challenges WHERE user_id=$1", [userId]);
    await recordAudit({ event: "admin.mfa.disabled", userId, actorId, success: true, context });
  });
}
async function beginTotpChallenge(userId: string, email: string) {
  const config = await security(userId);
  const token = randomToken(32);
  const secret = config?.secret ? null : base32(randomBytes(20));
  await query("DELETE FROM admin_mfa_challenges WHERE expires_at < now() OR user_id=$1", [userId]);
  await query("INSERT INTO admin_mfa_challenges(token_hash,user_id,pending_secret,expires_at) VALUES($1,$2,$3,now()+interval '5 minutes')", [sha256Hex(token), userId, secret ? encryptString(secret) : null]);
  const uri = secret ? `otpauth://totp/${encodeURIComponent(`Golden Pay:${email}`)}?secret=${secret}&issuer=Golden%20Pay&algorithm=SHA1&digits=6&period=30` : null;
  return {
    challenge_token: token, method: "totp", enrollment_required: !!secret,
    ...(secret ? { secret, otpauth_uri: uri, qr_code: await QRCode.toDataURL(uri!, {width: 256, margin: 2}) } : {}),
  };
}
export async function beginMfa(userId: string, email: string) {
  const config = await security(userId);
  if (!config?.mfa_required) return null;
  if (config.mfa_method === "email" || config.mfa_method === "both") return beginEmailOtp(userId, email);
  return beginTotpChallenge(userId, email);
}
export async function finishMfa(token: string, code: string, context: RequestContext): Promise<
  | { userId: string; recoveryCodes: string[]; next?: never }
  | { next: Record<string, unknown>; userId?: never; recoveryCodes?: never }
> {
  const method = (await query("SELECT method FROM admin_mfa_challenges WHERE token_hash=$1", [sha256Hex(token)]))[0]?.method;
  if (method === "email") {
    const result = await finishEmailOtp(token, code, context);
    const config = await security(result.userId);
    if (config?.mfa_method === "both") {
      const account = (await query("SELECT email FROM users WHERE user_id=$1", [result.userId]))[0];
      const next = await beginTotpChallenge(result.userId, String(account?.email ?? result.userId));
      await recordAudit({ event: "auth.mfa.verified", userId: result.userId, success: true, context, metadata: { step: "email", chained: true } });
      return { next: { ...next, step: "totp" } };
    }
    return result;
  }
  // Commit failed attempts as well as successful consumption, serializing replay attempts.
  const result = await transaction(async () => {
    const challenge = (await query("SELECT * FROM admin_mfa_challenges WHERE token_hash=$1 FOR UPDATE", [sha256Hex(token)]))[0];
    if (!challenge || challenge.consumed || Number(challenge.attempts) >= 5 || new Date(String(challenge.expires_at)).getTime() <= Date.now()) return null;
    await query("UPDATE admin_mfa_challenges SET attempts=attempts+1 WHERE token_hash=$1", [sha256Hex(token)]);
    const config = (await query("SELECT * FROM admin_security WHERE user_id=$1 FOR UPDATE", [challenge.user_id]))[0];
    if (!config?.mfa_required || (config.mfa_method !== "totp" && config.mfa_method !== "both")) return null;
    const encrypted = config.secret || challenge.pending_secret;
    if (!encrypted) return null;
    const secret = decryptString(String(encrypted));
    const step = Math.floor(Date.now() / 30000);
    const matched = [step - 1, step, step + 1].find(s => s > Number(config.last_step) && constantTimeEqual(totp(secret, s), code));
    const hashes = (typeof config.recovery_hashes === "string" ? JSON.parse(config.recovery_hashes) : config.recovery_hashes) as string[];
    const recoveryIndex = config.secret && /^[a-f0-9]{24}$/.test(code) ? hashes.indexOf(sha256Hex(code)) : -1;
    if (matched === undefined && recoveryIndex < 0) return null;
    const recoveryCodes = !config.secret ? Array.from({length: 8}, () => randomBytes(12).toString("hex")) : [];
    const remaining = recoveryCodes.length ? recoveryCodes.map(sha256Hex) : hashes.filter((_, i) => i !== recoveryIndex);
    await query("UPDATE admin_security SET secret=$2,last_step=$3,recovery_hashes=$4::text::jsonb WHERE user_id=$1", [challenge.user_id, encrypted, matched ?? config.last_step, JSON.stringify(remaining)]);
    await query("UPDATE admin_mfa_challenges SET consumed=true WHERE token_hash=$1", [sha256Hex(token)]);
    return { userId: String(challenge.user_id), recoveryCodes };
  });
  if (!result) throw new ApiError(401, "INVALID_MFA", "Invalid or expired authenticator/recovery code");
  await recordAudit({ event: "auth.mfa.verified", userId: result.userId, success: true, context });
  return result;
}
export async function setPolicy(userId: string, required: boolean, context: RequestContext, actorId: string) {
  await transaction(async () => {
    await query("INSERT INTO admin_security(user_id,mfa_required) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET mfa_required=$2,secret=NULL,last_step=-1,recovery_hashes='[]'", [userId, required]);
    await query("DELETE FROM admin_mfa_challenges WHERE user_id=$1", [userId]);
    await revokeAllUserSessions(userId, "admin_security_changed");
    await recordAudit({event: "admin.mfa_policy.changed", userId, actorId, success: true, context, metadata: {mfa_required: required}});
  });
}

export async function provisionAdministrator(input: {
  email: string;
  password: string;
  fullName: string;
  mfaRequired: boolean;
  actorId: string;
  context: RequestContext;
}): Promise<{ user_id: string; email: string }> {
  const id = newId();
  const hash = await Bun.password.hash(input.password, { algorithm: "argon2id" });
  await transaction(async () => {
    await query(
      `INSERT INTO users(user_id,full_name,email,phone,national_id_encrypted,national_id_hash,national_id_last4,password_hash,account_type,status)
       VALUES($1,$2,$3,$4,'',$5,'',$6,'existing_employee','active')`,
      [id, input.fullName, input.email, `admin:${id}`, randomToken(), hash],
    );
    await query(
      "INSERT INTO user_roles(user_id,role_id,assigned_by) SELECT $1,role_id,$2 FROM roles WHERE name='admin'",
      [id, input.actorId],
    );
    await query("INSERT INTO admin_security(user_id,mfa_required) VALUES($1,$2)", [id, input.mfaRequired]);
    await recordAudit({
      event: "admin.created",
      userId: id,
      actorId: input.actorId,
      success: true,
      context: input.context,
      metadata: { email: input.email, mfa_required: input.mfaRequired },
    });
  });
  return { user_id: id, email: input.email };
}

function inviteUrl(token: string): string {
  return `${env.dashboardPublicUrl}/invite/${token}`;
}

export async function listAdministrators() {
  return query(`SELECT u.user_id,u.full_name,u.email,u.status,u.last_login_at,s.is_owner,s.mfa_required,s.mfa_method,(s.secret IS NOT NULL) AS enrolled
    FROM admin_security s JOIN users u ON u.user_id=s.user_id WHERE u.deleted_at IS NULL ORDER BY s.is_owner DESC,u.created_at`);
}

export async function listInvitations() {
  return query(`SELECT invitation_id,email,full_name,mfa_required,status,expires_at,accepted_at,last_sent_at,created_at
    FROM admin_invitations ORDER BY created_at DESC LIMIT 100`);
}

export async function createInvitation(input: {
  email: string;
  fullName: string;
  mfaRequired: boolean;
  actorId: string;
  context: RequestContext;
}): Promise<{ invitation_id: string; email: string; invite_url: string; email_sent: boolean; from: string }> {
  const existingUser = (await query("SELECT user_id FROM users WHERE lower(email)=lower($1) AND deleted_at IS NULL", [input.email]))[0];
  if (existingUser) throw new ApiError(409, "ACCOUNT_ALREADY_EXISTS", "An account with this email address already exists");
  const pending = (await query("SELECT invitation_id FROM admin_invitations WHERE lower(email)=lower($1) AND status='pending'", [input.email]))[0];
  if (pending) throw new ApiError(409, "INVITE_PENDING", "A pending invitation already exists for this email");

  const invitationId = newId();
  const token = randomToken(32);
  await query(
    `INSERT INTO admin_invitations(invitation_id,email,full_name,mfa_required,token_hash,invited_by,expires_at,last_sent_at)
     VALUES($1,$2,$3,$4,$5,$6,now()+interval '7 days',now())`,
    [invitationId, input.email, input.fullName, input.mfaRequired, sha256Hex(token), input.actorId],
  );
  const url = inviteUrl(token);
  const template = adminInviteEmail({ fullName: input.fullName, inviteUrl: url, mfaRequired: input.mfaRequired });
  const emailSent = await sendMail({ to: input.email, ...template });
  await recordAudit({
    event: "admin.invited",
    actorId: input.actorId,
    success: true,
    context: input.context,
    metadata: { email: input.email, invitation_id: invitationId, email_sent: emailSent },
  });
  return {
    invitation_id: invitationId,
    email: input.email,
    invite_url: url,
    email_sent: emailSent,
    from: env.smtpUser,
  };
}

export async function resendInvitation(invitationId: string, actorId: string, context: RequestContext) {
  const invite = (await query("SELECT * FROM admin_invitations WHERE invitation_id=$1", [invitationId]))[0];
  if (!invite || invite.status !== "pending") throw ApiError.notFound("Invitation not found");
  if (new Date(String(invite.expires_at)).getTime() <= Date.now()) {
    throw new ApiError(410, "INVITE_EXPIRED", "This invitation has expired");
  }
  const token = randomToken(32);
  await query(
    "UPDATE admin_invitations SET token_hash=$2,last_sent_at=now() WHERE invitation_id=$1",
    [invitationId, sha256Hex(token)],
  );
  const url = inviteUrl(token);
  const template = adminInviteEmail({
    fullName: String(invite.full_name ?? ""),
    inviteUrl: url,
    mfaRequired: Boolean(invite.mfa_required),
  });
  const emailSent = await sendMail({ to: String(invite.email), ...template });
  await recordAudit({
    event: "admin.invite.resent",
    actorId,
    success: true,
    context,
    metadata: { invitation_id: invitationId, email_sent: emailSent },
  });
  return { invitation_id: invitationId, invite_url: url, email_sent: emailSent, from: env.smtpUser };
}

export async function revokeInvitation(invitationId: string, actorId: string, context: RequestContext) {
  const updated = await query(
    "UPDATE admin_invitations SET status='revoked' WHERE invitation_id=$1 AND status='pending' RETURNING invitation_id",
    [invitationId],
  );
  if (!updated[0]) throw ApiError.notFound("Invitation not found");
  await recordAudit({ event: "admin.invite.revoked", actorId, success: true, context, metadata: { invitation_id: invitationId } });
  return { revoked: true };
}

export async function peekInvitation(token: string) {
  const invite = (await query("SELECT * FROM admin_invitations WHERE token_hash=$1", [sha256Hex(token)]))[0];
  if (!invite || invite.status !== "pending") throw ApiError.notFound("Invitation not found");
  if (new Date(String(invite.expires_at)).getTime() <= Date.now()) {
    throw new ApiError(410, "INVITE_EXPIRED", "This invitation has expired");
  }
  return {
    email: String(invite.email),
    full_name: invite.full_name ? String(invite.full_name) : "",
    mfa_required: Boolean(invite.mfa_required),
    expires_at: invite.expires_at,
  };
}

export async function acceptInvitation(input: {
  token: string;
  password: string;
  fullName: string;
  context: RequestContext;
}) {
  return transaction(async () => {
  const invite = (await query("SELECT * FROM admin_invitations WHERE token_hash=$1 FOR UPDATE", [sha256Hex(input.token)]))[0];
  if (!invite || invite.status !== "pending") throw ApiError.notFound("Invitation not found");
  if (new Date(String(invite.expires_at)).getTime() <= Date.now()) {
    throw new ApiError(410, "INVITE_EXPIRED", "This invitation has expired");
  }
  const email = String(invite.email);
  const fullName = input.fullName || String(invite.full_name ?? "Administrator");
  const created = await provisionAdministrator({
    email,
    password: input.password,
    fullName,
    mfaRequired: Boolean(invite.mfa_required),
    actorId: String(invite.invited_by),
    context: input.context,
  });
  await query(
    "UPDATE admin_invitations SET status='accepted',accepted_at=now(),accepted_user_id=$2 WHERE invitation_id=$1",
    [invite.invitation_id, created.user_id],
  );
  return { ...created, mfa_required: Boolean(invite.mfa_required) };
  });
}
