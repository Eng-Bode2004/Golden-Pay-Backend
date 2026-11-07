import { strict as assert } from "node:assert";
import { base32, totp } from "../Services/admin-security.service.ts";
import { connectDatabase, query, database } from "../Config/db.ts";

// Supply owner credentials as JSON on stdin. Run against an isolated local API.
const credentials = JSON.parse(await Bun.stdin.text());
const base = process.env.TEST_API_URL ?? "http://127.0.0.1:4012/api/v1";
const createdIds: string[] = [];
async function call(path: string, body?: unknown, token?: string) {
  const res = await fetch(base + path, {method: body ? "POST" : "GET", headers: {"Content-Type":"application/json", ...(token ? {Authorization:`Bearer ${token}`} : {})}, body: body ? JSON.stringify(body) : undefined});
  return {status: res.status, ...(await res.json() as any)};
}
function check(name: string, value: unknown) { assert.ok(value, name); console.log("PASS", name); }
await connectDatabase();
try {
  check("RFC 6238 vector", totp(base32(Buffer.from("12345678901234567890")), 1) === "287082");
  const owner = await call("/auth/login", credentials);
  check("owner email login", owner.status === 200);
  const token = owner.data.access_token;
  check("owner status", (await call("/admin/security", undefined, token)).data.is_owner);
  const email = `mfa-test-${Date.now()}@example.com`;
  const password = `Test-${crypto.randomUUID()}9aA`;
  const created = await call("/admin/administrators", {email,password,full_name:"MFA Integration Test",mfa_required:true}, token);
  check("create required-MFA admin", created.status === 201); createdIds.push(created.data.user_id);
  const first = await call("/auth/login", {email,password});
  check("no session before enrollment", first.error?.code === "MFA_REQUIRED" && !first.data?.access_token && first.error.details.secret);
  const enrollment = first.error.details;
  check("wrong code rejected", (await call("/auth/mfa/verify", {challenge_token:enrollment.challenge_token,code:"invalid"})).status === 401);
  const verified = await call("/auth/mfa/verify", {challenge_token:enrollment.challenge_token,code:totp(enrollment.secret,Math.floor(Date.now()/30000))});
  check("enrollment verified", verified.status === 200 && verified.data.recovery_codes.length === 8);
  const adminToken = verified.data.access_token;
  check("non-owner cannot provision admins", (await call("/admin/administrators", {email:"denied@example.com",password,full_name:"Denied",mfa_required:false},adminToken)).status === 403);
  check("challenge cannot be replayed", (await call("/auth/mfa/verify", {challenge_token:enrollment.challenge_token,code:totp(enrollment.secret,Math.floor(Date.now()/30000))})).status === 401);
  const next = await call("/auth/login", {email,password});
  check("existing MFA has no secret disclosure", next.error?.code === "MFA_REQUIRED" && !next.error.details.secret);
  check("TOTP replay rejected", (await call("/auth/mfa/verify", {challenge_token:next.error.details.challenge_token,code:totp(enrollment.secret,Math.floor(Date.now()/30000))})).status === 401);
  const recovery = verified.data.recovery_codes[0];
  check("recovery login", (await call("/auth/mfa/verify", {challenge_token:next.error.details.challenge_token,code:recovery})).status === 200);
  const again = await call("/auth/login", {email,password});
  check("recovery single use", (await call("/auth/mfa/verify", {challenge_token:again.error.details.challenge_token,code:recovery})).status === 401);
  for (let i=0;i<4;i++) await call("/auth/mfa/verify", {challenge_token:again.error.details.challenge_token,code:"invalid"});
  check("challenge attempt cap", (await call("/auth/mfa/verify", {challenge_token:again.error.details.challenge_token,code:verified.data.recovery_codes[1]})).status === 401);
  check("policy requires owner password", (await call(`/admin/administrators/${created.data.user_id}/policy`, {mfa_required:false,password:"wrong"},token)).status === 403);
  check("disable MFA", (await call(`/admin/administrators/${created.data.user_id}/policy`, {mfa_required:false,password:credentials.password},token)).status === 200);
  check("policy revokes existing sessions", (await call("/users/me", undefined, adminToken)).status === 401);
  check("password-only login", (await call("/auth/login", {email,password})).status === 200);
  check("employee login also enforces MFA policy", (await call("/auth/login", {employee_number:"GP-000001",password:credentials.password})).status === 200);
} finally {
  for (const id of createdIds) {
    for (const table of ["admin_mfa_challenges","admin_security","refresh_sessions","user_roles","audit_logs","users"]) {
      await query(`DELETE FROM ${table} WHERE user_id=$1`,[id]);
    }
  }
  await database.end();
}
