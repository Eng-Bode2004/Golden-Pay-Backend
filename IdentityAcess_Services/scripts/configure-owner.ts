import { connectDatabase, database, query, transaction } from "../Config/db.ts";
import { seedRbac } from "../Services/rbac.service.ts";
import { optionalEmail, validatePassword } from "../Utils/validation.ts";
import { newId, randomToken } from "../Utils/crypto.ts";

// Credentials are supplied through stdin, never embedded in source.
const input = JSON.parse(await Bun.stdin.text());
const email = optionalEmail(input);
if (!email) throw new Error("Email required");
const password = validatePassword(input.password);
if (input.mfa_method !== undefined && !["email", "totp", "both"].includes(input.mfa_method)) throw new Error("mfa_method must be email, totp or both");
const fullName =
  typeof input.full_name === "string" && input.full_name.trim().length >= 2
    ? input.full_name.trim()
    : "Golden Pay Services";

await connectDatabase();
await seedRbac();
try {
  await transaction(async () => {
    let user =
      (await query("SELECT u.user_id FROM users u JOIN admin_security s USING(user_id) WHERE s.is_owner=true AND u.deleted_at IS NULL"))[0] ??
      (await query("SELECT user_id FROM users WHERE lower(email)=lower($1) AND deleted_at IS NULL", [email]))[0] ??
      (await query("SELECT user_id FROM users WHERE employee_number=$1 AND deleted_at IS NULL", [
        input.employee_number ?? "GP-000001",
      ]))[0];

    const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
    if (!user) {
      const id = newId();
      await query(
        `INSERT INTO users(user_id,full_name,email,phone,national_id_encrypted,national_id_hash,national_id_last4,password_hash,account_type,status)
         VALUES($1,$2,$3,$4,'',$5,'',$6,'existing_employee','active')`,
        [id, fullName, email, `admin:${id}`, randomToken(), hash],
      );
      user = { user_id: id };
    } else {
      await query(
        "UPDATE users SET email=$2,full_name=COALESCE($3,full_name),password_hash=$4,status='active',failed_login_attempts=0,locked_until=NULL,password_changed_at=now(),updated_at=now() WHERE user_id=$1",
        [user.user_id, email, input.full_name ? fullName : null, hash],
      );
    }

    await query(
      "INSERT INTO user_roles(user_id,role_id) SELECT $1,role_id FROM roles WHERE name='admin' ON CONFLICT (user_id, role_id) DO NOTHING",
      [user.user_id],
    );
    await query(
      "INSERT INTO admin_security(user_id,is_owner) VALUES($1,true) ON CONFLICT(user_id) DO UPDATE SET is_owner=true",
      [user.user_id],
    );
    if (input.mfa_method) {
      await query("UPDATE admin_security SET mfa_method=$2,mfa_required=true,secret=NULL,last_step=-1,recovery_hashes='[]' WHERE user_id=$1", [user.user_id,input.mfa_method]);
    }
    await query("DELETE FROM admin_mfa_challenges WHERE user_id=$1", [user.user_id]);
    await query(
      "UPDATE refresh_sessions SET revoked_at=now(),revoked_reason='owner_credentials_updated' WHERE user_id=$1 AND revoked_at IS NULL",
      [user.user_id],
    );
    console.log("Primary administrator configured:", email);
  });
} finally {
  await database.end();
}
