import { strict as assert } from "node:assert";
import { connectDatabase, database, query } from "../Config/db.ts";
import { acceptInvitation, peekInvitation, securitySummary } from "../Services/admin-security.service.ts";
import { newId, randomToken, sha256Hex } from "../Utils/crypto.ts";
import type { RequestContext } from "../Utils/http.ts";

const invitationId = newId();
const token = randomToken(32);
const email = `onboarding-${invitationId}@example.test`;
const url = new URL("http://localhost/api/v1/auth/admin-invite/accept");
const context: RequestContext = { req: new Request(url.toString()), url, params: {}, requestId: newId(), ip: "127.0.0.1" };
let userId: string | undefined;
await connectDatabase();
try {
  const owner = (await query("SELECT user_id FROM admin_security WHERE is_owner=true LIMIT 1"))[0];
  assert.ok(owner, "An owner is required for this integration test");
  await query("INSERT INTO admin_invitations(invitation_id,email,full_name,mfa_required,token_hash,invited_by,expires_at,last_sent_at) VALUES($1,$2,'',false,$3,$4,now()+interval '1 hour',now())", [invitationId, email, sha256Hex(token), owner.user_id]);
  assert.equal((await peekInvitation(token)).full_name, "");
  const attempts = await Promise.allSettled([0,1].map(() => acceptInvitation({ token, password: "Test-Invite-2026aA!", fullName: "New Administrator", context })));
  const successful = attempts.filter(result => result.status === "fulfilled");
  assert.equal(successful.length, 1, "An invitation can only be consumed once, including concurrent requests");
  const result = successful[0];
  assert.ok(result?.status === "fulfilled");
  userId = result.value.user_id;
  assert.equal((await securitySummary(userId))?.mfa_required, false);
  const account = (await query("SELECT full_name,password_hash FROM users WHERE user_id=$1", [userId]))[0]!;
  assert.equal(account.full_name, "New Administrator");
  assert.equal(await Bun.password.verify("Test-Invite-2026aA!", String(account.password_hash)), true);
  await assert.rejects(() => peekInvitation(token));
  console.log("PASS email-only invitation, recipient profile/password, default access and atomic single-use acceptance");
} finally {
  await query("DELETE FROM admin_invitations WHERE invitation_id=$1", [invitationId]);
  if (userId) for (const table of ["admin_mfa_challenges", "admin_security", "refresh_sessions", "user_roles", "audit_logs", "users"]) await query(`DELETE FROM ${table} WHERE user_id=$1`, [userId]);
  await database.end();
}
