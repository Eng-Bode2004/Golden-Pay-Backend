import { strict as assert } from "node:assert";
import { connectDatabase, database, query } from "../Config/db.ts";
import { newId, randomToken } from "../Utils/crypto.ts";
import { ApiError, type RequestContext } from "../Utils/http.ts";
import {
  activateTotp,
  beginMfa,
  beginTotpEnrollment,
  disableMfa,
  finishMfa,
  securitySummary,
  switchTotpMode,
  totp,
} from "../Services/admin-security.service.ts";
import { updateProfile } from "../Services/user.service.ts";

const id = newId();
const email = `self-${id}@example.test`;
const url = new URL("http://localhost/api/v1/auth/mfa/totp/activate");
const context: RequestContext = {
  req: new Request(url.toString()),
  url,
  params: {},
  requestId: newId(),
  ip: "127.0.0.1",
};

await connectDatabase();
try {
  await query(
    "INSERT INTO users(user_id,full_name,email,phone,national_id_encrypted,national_id_hash,national_id_last4,password_hash,account_type,status) VALUES($1,'اسم قديم',$2,$3,'',$4,'','not-a-real-login','existing_employee','active')",
    [id, email, `test:${id}`, randomToken()],
  );
  await query(
    "INSERT INTO admin_security(user_id,mfa_required,mfa_method) VALUES($1,true,'email')",
    [id],
  );

  const setup = await beginTotpEnrollment(id, email);
  assert.match(setup.secret, /^[A-Z2-7]{32}$/);
  assert.match(setup.qr_code, /^data:image\/png;base64,/);
  assert.match(setup.otpauth_uri, /^otpauth:\/\/totp\//);
  assert.equal((await securitySummary(id))?.pending_enrollment, true);

  const step = Math.floor(Date.now() / 30000);
  const wrong = String((Number(totp(setup.secret, step)) + 1) % 1_000_000).padStart(6, "0");
  await assert.rejects(
    () => activateTotp(id, wrong, context),
    (error: unknown) => error instanceof ApiError && error.code === "INVALID_TOTP",
  );
  console.log("PASS authenticator setup issues QR/secret and rejects a wrong code");

  const activation = await activateTotp(id, totp(setup.secret, step), context);
  assert.equal(activation.mfa_method, "totp");
  assert.equal(activation.recovery_codes.length, 8);
  const summary = await securitySummary(id);
  assert.equal(summary?.mfa_method, "totp");
  assert.equal(summary?.enrolled, true);
  assert.equal(summary?.recovery_codes_remaining, 8);
  console.log("PASS authenticator activation stores the secret and issues recovery codes");

  const challenge = await beginMfa(id, email);
  assert.equal(challenge?.method, "totp");
  assert.equal((challenge as { enrollment_required?: boolean } | null)?.enrollment_required, false);
  const verified = await finishMfa(
    challenge!.challenge_token,
    totp(setup.secret, step + 1),
    context,
  );
  assert.equal(verified.userId, id);
  console.log("PASS subsequent logins require the authenticator code");

  await switchTotpMode(id, "both", context);
  const chained = await securitySummary(id);
  assert.equal(chained?.mfa_method, "both");
  assert.equal(chained?.enrolled, true);
  assert.equal(chained?.recovery_codes_remaining, 8);
  await switchTotpMode(id, "totp", context);
  assert.equal((await securitySummary(id))?.mfa_method, "totp");
  console.log("PASS the email step can be added or removed without re-enrolling");

  const recovered = await beginMfa(id, email);
  const recovery = await finishMfa(recovered!.challenge_token, activation.recovery_codes[0]!, context);
  assert.equal(recovery.userId, id);
  await assert.rejects(
    async () => {
      const replay = await beginMfa(id, email);
      return finishMfa(replay!.challenge_token, activation.recovery_codes[0]!, context);
    },
    (error: unknown) => error instanceof ApiError && error.code === "INVALID_MFA",
  );
  console.log("PASS recovery codes are single-use");

  const renamed = await updateProfile({
    userId: id,
    body: { full_name: "اسم المدير الجديد" },
    context,
  });
  assert.equal(renamed.full_name, "اسم المدير الجديد");
  console.log("PASS administrators can change their display name");

  await disableMfa(id, context, id);
  const disabled = await securitySummary(id);
  assert.equal(disabled?.mfa_required, false);
  assert.equal(disabled?.enrolled, false);
  assert.equal(await beginMfa(id, email), null);
  console.log("PASS two-step verification can be disabled");
} finally {
  for (const table of ["admin_mfa_challenges", "admin_security", "audit_logs", "users"]) {
    await query(`DELETE FROM ${table} WHERE user_id=$1`, [id]);
  }
  await database.end();
}
