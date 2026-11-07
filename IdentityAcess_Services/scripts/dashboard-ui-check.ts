// Temporary local UI verification account. Never changes the owner's MFA or credentials.
import {connectDatabase, database, query, transaction} from "../Config/db.ts";
import {seedRbac} from "../Services/rbac.service.ts";
import {newId, randomToken} from "../Utils/crypto.ts";
const email = "dashboard-ui-check@example.test";
await connectDatabase();
try {
  if (process.argv.includes("--cleanup")) {
    const rows = await query("SELECT user_id FROM users WHERE email=$1", [email]);
    for (const row of rows) await transaction(async () => {
      for (const table of ["admin_mfa_challenges", "admin_security", "refresh_sessions", "user_roles", "audit_logs", "users"]) {
        await query(`DELETE FROM ${table} WHERE user_id=$1`, [row.user_id]);
      }
    });
    console.log("Temporary dashboard verification account removed");
  } else {
    await seedRbac();
    if ((await query("SELECT user_id FROM users WHERE email=$1", [email])).length) throw new Error("Verification account already exists; clean up before creating another");
    const id = newId(), password = `UiCheck-${randomToken(16)}-9aA`;
    const hash = await Bun.password.hash(password, {algorithm:"argon2id"});
    await transaction(async () => {
      await query("INSERT INTO users(user_id,full_name,email,phone,national_id_encrypted,national_id_hash,national_id_last4,password_hash,account_type,status) VALUES($1,$2,$3,$4,'',$5,'',$6,'existing_employee','active')", [id,"حساب اختبار الواجهة",email,`admin:${id}`,randomToken(),hash]);
      await query("INSERT INTO user_roles(user_id,role_id) SELECT $1,role_id FROM roles WHERE name='admin'",[id]);
      await query("INSERT INTO admin_security(user_id,mfa_required) VALUES($1,false)",[id]);
    });
    console.log(JSON.stringify({email,password}));
  }
} finally {await database.end();}
