import {strict as assert} from "node:assert";
import {connectDatabase, database, query} from "../Config/db.ts";
import {newId, randomToken, sha256Hex} from "../Utils/crypto.ts";
import {ApiError, type RequestContext} from "../Utils/http.ts";
import {beginEmailOtp, finishEmailOtp} from "../Services/email-otp.service.ts";
import type {OutboundMail} from "../Services/mail.service.ts";

const id = newId(), email = `otp-${id}@example.test`;
const url = new URL("http://localhost/auth/mfa/verify");
const context: RequestContext = {req: new Request(url.toString()), url, params: {}, requestId: newId(), ip: "127.0.0.1"};
let code = "";
const deliver = async (message: OutboundMail) => {
  assert.equal(message.to, email);
  code = message.text.match(/\d{6}/)![0];
  return true;
};
const rejects = async (action: () => Promise<unknown>, expected: string) => assert.rejects(action, error => error instanceof ApiError && error.code === expected);
async function reset() { await query("DELETE FROM admin_mfa_challenges WHERE user_id=$1",[id]); }
await connectDatabase();
try {
  await query("INSERT INTO users(user_id,full_name,email,phone,national_id_encrypted,national_id_hash,national_id_last4,password_hash,account_type,status) VALUES($1,'OTP Test',$2,$3,'',$4,'','not-a-real-login','existing_employee','active')", [id,email,`test:${id}`,randomToken()]);
  await query("INSERT INTO admin_security(user_id,mfa_required,mfa_method) VALUES($1,true,'email')",[id]);
  const challenge = await beginEmailOtp(id, email, deliver);
  assert.equal(challenge.method,"email");
  assert.equal(JSON.stringify(challenge).includes(code), false);
  const stored = (await query("SELECT otp_hash FROM admin_mfa_challenges WHERE user_id=$1",[id]))[0]!;
  assert.notEqual(stored.otp_hash,code);
  await rejects(() => beginEmailOtp(id,email,deliver),"TOO_MANY_REQUESTS");
  await rejects(() => finishEmailOtp(challenge.challenge_token,"wrong",context),"INVALID_EMAIL_OTP");
  assert.equal((await finishEmailOtp(challenge.challenge_token,code,context)).userId,id);
  await rejects(() => finishEmailOtp(challenge.challenge_token,code,context),"INVALID_EMAIL_OTP");
  console.log("PASS email challenge, hashed code, cooldown, invalid code, successful verification, replay rejection");
  await reset();
  const locked = await beginEmailOtp(id,email,deliver);
  for (let i=0;i<5;i++) await rejects(() => finishEmailOtp(locked.challenge_token,"invalid",context),"INVALID_EMAIL_OTP");
  await rejects(() => finishEmailOtp(locked.challenge_token,code,context),"INVALID_EMAIL_OTP");
  await reset();
  const expired = await beginEmailOtp(id,email,deliver);
  await query("UPDATE admin_mfa_challenges SET expires_at=now()-interval '1 second' WHERE token_hash=$1",[sha256Hex(expired.challenge_token)]);
  await rejects(() => finishEmailOtp(expired.challenge_token,code,context),"INVALID_EMAIL_OTP");
  console.log("PASS attempt cap and expiration");
  await reset();
  await rejects(() => beginEmailOtp(id,email,async () => false),"OTP_DELIVERY_FAILED");
  assert.equal((await query("SELECT token_hash FROM admin_mfa_challenges WHERE user_id=$1",[id])).length,0);
  const changed = await beginEmailOtp(id,email,deliver);
  await query("UPDATE users SET password_changed_at=now()+interval '1 second' WHERE user_id=$1",[id]);
  await rejects(() => finishEmailOtp(changed.challenge_token,code,context),"INVALID_EMAIL_OTP");
  console.log("PASS mail failure fails closed and password change invalidates challenge");
} finally {
  for (const table of ["admin_mfa_challenges","admin_security","audit_logs","users"]) await query(`DELETE FROM ${table} WHERE user_id=$1`,[id]);
  await database.end();
}
