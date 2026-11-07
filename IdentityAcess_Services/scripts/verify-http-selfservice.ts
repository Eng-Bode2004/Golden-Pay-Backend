// End-to-end check for the dashboard self-service MFA and profile routes.
// Requires the API on http://127.0.0.1:4001; creates and deletes a temporary admin.
import { connectDatabase, database, query, transaction } from "../Config/db.ts";
import { seedRbac } from "../Services/rbac.service.ts";
import { newId, randomToken } from "../Utils/crypto.ts";
import { totp } from "../Services/admin-security.service.ts";

const base = "http://127.0.0.1:4001/api/v1";
const id = newId();
const email = `http-${id}@example.test`;
const password = `Http-${randomToken(12)}-9aA`;

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const body = (await response.json()) as { data?: T; error?: unknown };
  if (!response.ok) throw new Error(`${path} -> ${response.status} ${JSON.stringify(body)}`);
  return body.data as T;
}

await connectDatabase();
await seedRbac();
try {
  const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
  await transaction(async () => {
    await query(
      "INSERT INTO users(user_id,full_name,email,phone,national_id_encrypted,national_id_hash,national_id_last4,password_hash,account_type,status) VALUES($1,'اسم مؤقت',$2,$3,'',$4,'',$5,'existing_employee','active')",
      [id, email, `admin:${id}`, randomToken(), hash],
    );
    await query("INSERT INTO user_roles(user_id,role_id) SELECT $1,role_id FROM roles WHERE name='admin'", [id]);
    await query("INSERT INTO admin_security(user_id,mfa_required) VALUES($1,false)", [id]);
  });

  const session = await call<{ access_token: string; refresh_token: string }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password, platform: "web" }),
  });
  const auth = { Authorization: `Bearer ${session.access_token}` };

  const before = await call<{ mfa_method: string; enrolled: boolean }>("/admin/security", { headers: auth });
  console.log("PASS GET /admin/security", before);

  const setup = await call<{ secret: string; qr_code: string }>("/auth/mfa/totp/setup", {
    method: "POST",
    headers: auth,
    body: "{}",
  });
  if (!setup.qr_code.startsWith("data:image/png;base64,")) throw new Error("Missing QR code");
  console.log("PASS POST /auth/mfa/totp/setup returns a QR code");

  const code = totp(setup.secret, Math.floor(Date.now() / 30000));
  const activated = await call<{ recovery_codes: string[]; mfa_method: string }>(
    "/auth/mfa/totp/activate",
    { method: "POST", headers: auth, body: JSON.stringify({ code }) },
  );
  if (activated.mfa_method !== "totp" || activated.recovery_codes.length !== 8) throw new Error("Activation failed");
  console.log("PASS POST /auth/mfa/totp/activate enables authenticator login");

  const after = await call<{ mfa_method: string; enrolled: boolean; recovery_codes_remaining: number }>(
    "/admin/security",
    { headers: auth },
  );
  if (after.mfa_method !== "totp" || !after.enrolled || after.recovery_codes_remaining !== 8) throw new Error("Security summary mismatch");
  console.log("PASS GET /admin/security reflects the activated authenticator");

  const renamed = await call<{ user: { full_name: string } }>("/users/me", {
    method: "PATCH",
    headers: auth,
    body: JSON.stringify({ full_name: "اسم محدّث من الواجهة" }),
  });
  if (renamed.user.full_name !== "اسم محدّث من الواجهة") throw new Error("Name update failed");
  console.log("PASS PATCH /users/me updates an administrator name");
} finally {
  await transaction(async () => {
    for (const table of ["admin_mfa_challenges", "admin_security", "refresh_sessions", "user_roles", "audit_logs", "users"]) {
      await query(`DELETE FROM ${table} WHERE user_id=$1`, [id]);
    }
  });
  await database.end();
}
