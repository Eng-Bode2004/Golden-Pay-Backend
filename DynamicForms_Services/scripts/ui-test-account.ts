// Creates (or removes) a local Head Office test account for trying the template screens.
//   bun --env-file=../IdentityAcess_Services/.env scripts/ui-test-account.ts create
//   bun --env-file=../IdentityAcess_Services/.env scripts/ui-test-account.ts remove
// The generated sign-in details are written to scripts/.ui-test-account.local (never commit it).
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connectDatabase, database, query, transaction } from "../../IdentityAcess_Services/Config/db.ts";
import { newId, randomToken } from "../../IdentityAcess_Services/Utils/crypto.ts";

const file = join(import.meta.dir, ".ui-test-account.local");
await connectDatabase();
try {
  if (process.argv[2] === "remove") {
    if (!existsSync(file)) throw new Error("No test account recorded");
    const { user_id } = JSON.parse(readFileSync(file, "utf8")) as { user_id: string };
    await transaction(async () => {
      await query("DELETE FROM template_events WHERE actor_id=$1", [user_id]);
      await query("DELETE FROM audit_logs WHERE user_id=$1 OR actor_id=$1", [user_id]);
      for (const table of ["admin_mfa_challenges", "admin_security", "refresh_sessions", "user_roles", "users"]) {
        await query(`DELETE FROM ${table} WHERE user_id=$1`, [user_id]);
      }
    });
    rmSync(file);
    console.log("Removed the test account.");
  } else {
    const id = newId();
    const email = `ui-office-${id.slice(0, 6)}@example.test`;
    const password = `Ui-${randomToken(12)}-7aA`;
    const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
    await transaction(async () => {
      await query(
        `INSERT INTO users(user_id,full_name,email,phone,national_id_encrypted,national_id_hash,national_id_last4,password_hash,account_type,status)
         VALUES($1,$2,$3,$4,'',$5,'',$6,'existing_employee','active')`,
        [id, "حساب تجربة القوالب", email, `ui:${id}`, randomToken(), hash],
      );
      await query("INSERT INTO user_roles(user_id,role_id) SELECT $1,role_id FROM roles WHERE name='head_office'", [id]);
      await query("INSERT INTO admin_security(user_id,mfa_required) VALUES($1,false)", [id]);
    });
    writeFileSync(file, JSON.stringify({ user_id: id, email, password }, null, 2));
    console.log(`Created a Head Office test account. Sign-in details: ${file}`);
  }
} finally {
  await database.end();
}
