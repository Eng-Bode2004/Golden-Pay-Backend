import { randomInt } from "node:crypto";
import { query, transaction } from "../Config/db.ts";
import { env } from "../Config/env.ts";
import { constantTimeEqual, hmacHex, randomToken, sha256Hex } from "../Utils/crypto.ts";
import { ApiError, type RequestContext } from "../Utils/http.ts";
import { sendMail, type OutboundMail } from "./mail.service.ts";
import { recordAudit } from "./audit.service.ts";

type Delivery = (message: OutboundMail) => Promise<boolean>;
const lifetimeMs = 5 * 60 * 1000;
function codeHash(tokenHash: string, code: string) {
  return hmacHex(env.refreshTokenPepper, `email-otp:${tokenHash}:${code}`);
}
function maskEmail(email: string) {
  const [name, domain] = email.split("@");
  return `${name!.slice(0, 2)}***@${domain}`;
}
function template(code: string): Omit<OutboundMail, "to"> {
  return {
    subject: "Golden Pay - Your sign-in code",
    text: `رمز تسجيل الدخول إلى جولدن باي: ${code}\nينتهي خلال 5 دقائق. لا تشارك هذا الرمز مع أي شخص.\nإذا لم تطلب الدخول، تجاهل الرسالة.`,
    html: `<!doctype html><html lang="ar" dir="rtl"><body style="background:#171b20;color:#f6f4ef;font-family:Tahoma,Arial,sans-serif;padding:32px"><div style="max-width:480px;margin:auto;padding:30px;border:1px solid #555;border-radius:20px"><p style="color:#a9caff">GOLDEN PAY SERVICES</p><h1 style="font-size:24px">رمز تسجيل الدخول</h1><p>أدخل الرمز التالي لإكمال تسجيل الدخول إلى لوحة الإدارة:</p><p dir="ltr" style="font-size:36px;letter-spacing:10px;text-align:center;font-weight:bold">${code}</p><p>ينتهي خلال 5 دقائق، ويُستخدم مرة واحدة فقط.</p><p>لا تشارك الرمز مع أي شخص. إذا لم تطلب تسجيل الدخول، تجاهل هذه الرسالة.</p></div></body></html>`,
  };
}

// A transport parameter permits isolated tests without exposing a development OTP bypass.
export async function beginEmailOtp(userId: string, email: string, deliver: Delivery = sendMail) {
  const last = (await query("SELECT sent_at FROM admin_mfa_challenges WHERE user_id=$1 AND method='email' ORDER BY sent_at DESC NULLS LAST LIMIT 1", [userId]))[0];
  if (last?.sent_at && Date.now() - new Date(String(last.sent_at)).getTime() < 60_000) {
    throw ApiError.tooManyRequests("يرجى الانتظار دقيقة قبل طلب رمز جديد.", 60);
  }
  const token = randomToken(32), tokenHash = sha256Hex(token);
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await transaction(async () => {
    // Serialize issuance for an account so concurrent requests cannot bypass the cooldown.
    await query("SELECT user_id FROM admin_security WHERE user_id=$1 FOR UPDATE", [userId]);
    const recent = await query("SELECT token_hash FROM admin_mfa_challenges WHERE user_id=$1 AND method='email' AND sent_at > now()-interval '1 minute'", [userId]);
    if (recent.length) throw ApiError.tooManyRequests("يرجى الانتظار دقيقة قبل طلب رمز جديد.", 60);
    await query("DELETE FROM admin_mfa_challenges WHERE user_id=$1 OR expires_at < now()", [userId]);
    await query("INSERT INTO admin_mfa_challenges(token_hash,user_id,method,otp_hash,email,expires_at,sent_at) VALUES($1,$2,'email',$3,$4,$5,now())", [tokenHash, userId, codeHash(tokenHash, code), email, new Date(Date.now() + lifetimeMs)]);
  });
  let sent = false;
  try { sent = await deliver({to: email, ...template(code)}); } catch { /* Fail closed if transport fails. */ }
  if (!sent) {
    await query("DELETE FROM admin_mfa_challenges WHERE token_hash=$1", [tokenHash]);
    throw new ApiError(503, "OTP_DELIVERY_FAILED", "تعذّر إرسال رمز التحقق. يجب إعداد Gmail App Password في SMTP_PASS على الخادم.");
  }
  return { challenge_token: token, method: "email", email_hint: maskEmail(email), expires_in: 300, resend_after: 60 };
}

/**
 * Confirms an emailed code for an administrator switching their sign-in method
 * to email OTP. Unlike finishEmailOtp this runs before the method is active:
 * the method only becomes active after the delivered code is proven to work,
 * so a broken mail transport can never lock an administrator out.
 */
export async function confirmEmailOtpSwitch(userId: string, token: string, code: string, context: RequestContext) {
  const ok = await transaction(async () => {
    const tokenHash = sha256Hex(token);
    const challenge = (await query("SELECT * FROM admin_mfa_challenges WHERE token_hash=$1 FOR UPDATE", [tokenHash]))[0];
    if (!challenge || challenge.method !== "email" || String(challenge.user_id) !== userId || challenge.consumed || Number(challenge.attempts) >= 5 || new Date(String(challenge.expires_at)).getTime() <= Date.now()) return false;
    await query("UPDATE admin_mfa_challenges SET attempts=attempts+1 WHERE token_hash=$1", [tokenHash]);
    const account = (await query("SELECT email FROM users WHERE user_id=$1 AND deleted_at IS NULL AND status='active'", [userId]))[0];
    if (!account || account.email !== challenge.email) return false;
    if (!/^\d{6}$/.test(code) || !constantTimeEqual(String(challenge.otp_hash), codeHash(tokenHash, code))) return false;
    await query("UPDATE admin_security SET mfa_required=true,mfa_method='email',secret=NULL,pending_secret=NULL,last_step=-1,recovery_hashes='[]' WHERE user_id=$1", [userId]);
    await query("UPDATE admin_mfa_challenges SET consumed=true,otp_hash=NULL WHERE token_hash=$1", [tokenHash]);
    await query("DELETE FROM admin_mfa_challenges WHERE user_id=$1 AND token_hash<>$2", [userId, tokenHash]);
    return true;
  });
  await recordAudit({ event: "admin.mfa.method.email", userId, actorId: userId, success: ok, context });
  if (!ok) throw new ApiError(401, "INVALID_EMAIL_OTP", "رمز التحقق غير صحيح أو انتهت صلاحيته. اطلب رمزاً جديداً.");
}

export async function finishEmailOtp(token: string, code: string, context: RequestContext) {  const userId = await transaction(async () => {
    const challenge = (await query("SELECT * FROM admin_mfa_challenges WHERE token_hash=$1 FOR UPDATE", [sha256Hex(token)]))[0];
    if (!challenge || challenge.method !== "email" || challenge.consumed || Number(challenge.attempts) >= 5 || new Date(String(challenge.expires_at)).getTime() <= Date.now()) return null;
    await query("UPDATE admin_mfa_challenges SET attempts=attempts+1 WHERE token_hash=$1", [sha256Hex(token)]);
    const config = (await query("SELECT s.mfa_required,s.mfa_method,u.email,u.status,u.deleted_at,u.password_changed_at FROM admin_security s JOIN users u USING(user_id) WHERE s.user_id=$1 FOR UPDATE", [challenge.user_id]))[0];
    if (!config?.mfa_required || (config.mfa_method !== "email" && config.mfa_method !== "both") || config.email !== challenge.email || config.status !== "active" || config.deleted_at || (config.password_changed_at && new Date(String(config.password_changed_at)) > new Date(String(challenge.created_at)))) return null;
    if (!/^\d{6}$/.test(code) || !constantTimeEqual(String(challenge.otp_hash), codeHash(sha256Hex(token), code))) return null;
    await query("UPDATE admin_mfa_challenges SET consumed=true,otp_hash=NULL WHERE token_hash=$1", [sha256Hex(token)]);
    return String(challenge.user_id);
  });
  await recordAudit({event: "auth.email_otp.verified", userId, success: !!userId, context});
  if (!userId) throw new ApiError(401, "INVALID_EMAIL_OTP", "رمز التحقق غير صحيح أو انتهت صلاحيته. أعد تسجيل الدخول لطلب رمز جديد.");
  return {userId, recoveryCodes: [] as string[]};
}
