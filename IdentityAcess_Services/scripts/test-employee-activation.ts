// End-to-end check for the existing-employee registration and activation flow:
// employee number -> profile + personal photo + ID images -> admin review -> sign in,
// including a rejected employee applying again.
// Requires the API on http://127.0.0.1:4001; creates and deletes temporary records.
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { connectDatabase, database, query, transaction } from "../Config/db.ts";
import { env } from "../Config/env.ts";
import { seedRbac } from "../Services/rbac.service.ts";
import { hashNationalId, newId, randomToken } from "../Utils/crypto.ts";

const base = "http://127.0.0.1:4001/api/v1";
const adminId = newId();
const adminEmail = `activation-${adminId}@example.test`;
const adminPassword = `Http-${randomToken(12)}-9aA`;

const suffix = String(Date.now()).slice(-8);
const employeeNumber = `TST-${suffix}`;
const employeeId = `TID-${suffix}`;
const fullName = "موظف اختبار التفعيل";
const phone = `010${suffix}`;
const nationalId = `2990101${suffix.slice(-7)}`;
const password = `Emp-${randomToken(10)}-9aA`;

// 1x1 transparent PNG; the API validates magic bytes, not dimensions.
const png = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (char) => char.charCodeAt(0),
);

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${base}${path}`, init);
  const body = (await response.json()) as { data?: T; error?: unknown };
  if (!response.ok) throw new Error(`${path} -> ${response.status} ${JSON.stringify(body)}`);
  return body.data as T;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function signupForm(withPhoto: boolean): FormData {
  const form = new FormData();
  form.set("full_name", fullName);
  form.set("phone", phone);
  form.set("national_id_number", nationalId);
  form.set("password", password);
  form.set("confirm_password", password);
  form.set("national_id_front", new File([png], "front.png", { type: "image/png" }));
  form.set("national_id_back", new File([png], "back.png", { type: "image/png" }));
  if (withPhoto) form.set("profile_image", new File([png], "photo.png", { type: "image/png" }));
  return form;
}

await connectDatabase();
await seedRbac();
let applicantId = "";
try {
  const hash = await Bun.password.hash(adminPassword, { algorithm: "argon2id" });
  await transaction(async () => {
    await query(
      "INSERT INTO users(user_id,full_name,email,phone,national_id_encrypted,national_id_hash,national_id_last4,password_hash,account_type,status) VALUES($1,'مدير الاختبار',$2,$3,'',$4,'',$5,'existing_employee','active')",
      [adminId, adminEmail, `admin:${adminId}`, randomToken(), hash],
    );
    await query("INSERT INTO user_roles(user_id,role_id) SELECT $1,role_id FROM roles WHERE name='admin'", [adminId]);
    await query("INSERT INTO admin_security(user_id,mfa_required) VALUES($1,false)", [adminId]);
    await query(
      "INSERT INTO employee_records(employee_id,employee_number,full_name,phone,national_id_hash,national_id_last4,department,position) VALUES($1,$2,$3,$4,$5,$6,'المراجعة','محقق')",
      [employeeId, employeeNumber, fullName, phone, hashNationalId(nationalId), nationalId.slice(-4)],
    );
  });

  const session = await call<{ access_token: string }>(
    "/auth/login",
    json({ email: adminEmail, password: adminPassword, platform: "web" }),
  );
  const auth = { Authorization: `Bearer ${session.access_token}` };

  const started = await call<{ signup_token: string; employee: { full_name: string } }>(
    "/auth/signup/existing/start",
    json({ employee_number: employeeNumber }),
  );
  if (started.employee.full_name !== fullName) throw new Error("Employee summary mismatch");
  console.log("PASS employee number finds the HR record");

  const missing = await fetch(`${base}/auth/signup/existing/complete`, {
    method: "POST",
    headers: { Authorization: `Bearer ${started.signup_token}` },
    body: signupForm(false),
  });
  const missingBody = (await missing.json()) as { error?: { details?: { field?: string } } };
  if (missing.status !== 400 || missingBody.error?.details?.field !== "profile_image") {
    throw new Error(`Expected a missing-photo rejection, got ${missing.status}`);
  }
  console.log("PASS signup without a personal photo is rejected");

  const completed = await call<{ user_id: string; status: string }>("/auth/signup/existing/complete", {
    method: "POST",
    headers: { Authorization: `Bearer ${started.signup_token}` },
    body: signupForm(true),
  });
  applicantId = completed.user_id;
  if (completed.status !== "pending_verification") throw new Error("Applicant must await activation");
  console.log("PASS signup with photo waits for administrator activation");

  const blocked = await fetch(
    `${base}/auth/login`,
    json({ employee_number: employeeNumber, password, platform: "android" }),
  );
  const blockedBody = (await blocked.json()) as { error?: { code?: string } };
  if (blockedBody.error?.code !== "ACCOUNT_PENDING_VERIFICATION") throw new Error("Pending login must fail");
  console.log("PASS applicant cannot sign in before activation");

  await call(`/admin/users/${applicantId}/reject`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "صورة غير واضحة" }),
  });
  const photoFolder = join(env.uploadDir, "profile-images", applicantId);
  const firstPhoto = await readdir(photoFolder);

  const restarted = await call<{ signup_token: string }>(
    "/auth/signup/existing/start",
    json({ employee_number: employeeNumber }),
  );
  console.log("PASS rejected employee can start registration again");

  const reapplied = await call<{ user_id: string; status: string }>("/auth/signup/existing/complete", {
    method: "POST",
    headers: { Authorization: `Bearer ${restarted.signup_token}` },
    body: signupForm(true),
  });
  if (reapplied.user_id !== applicantId || reapplied.status !== "pending_verification") {
    throw new Error("Reapplying must reopen the same account for review");
  }
  const secondPhoto = await readdir(photoFolder);
  if (secondPhoto.length !== 1 || secondPhoto[0] === firstPhoto[0]) {
    throw new Error("Reapplying must replace the previous photo");
  }
  console.log("PASS reapplying reopens the account and replaces its images");

  const repeat = await fetch(
    `${base}/auth/signup/existing/start`,
    json({ employee_number: employeeNumber }),
  );
  if (repeat.status !== 409) throw new Error(`Pending account must block a new signup, got ${repeat.status}`);
  console.log("PASS employee cannot restart while the new request is pending");

  const pending = await call<{ users: { user_id: string }[] }>(
    `/admin/users?status=pending&search=${employeeNumber}`,
    { headers: auth },
  );
  if (!pending.users.some((user) => user.user_id === applicantId)) throw new Error("Request not listed");
  console.log("PASS GET /admin/users?status=pending lists the request");

  const detail = await call<{
    profile_image: boolean;
    national_id_images: { front: boolean; back: boolean };
    employee_record: { department: string | null; phone: string } | null;
  }>(`/admin/users/${applicantId}`, { headers: auth });
  if (!detail.profile_image || !detail.national_id_images.front || !detail.national_id_images.back) {
    throw new Error("Uploaded images are missing from the request");
  }
  if (detail.employee_record?.department !== "المراجعة" || detail.employee_record.phone !== phone) {
    throw new Error("HR record is missing from the request");
  }
  console.log("PASS GET /admin/users/:id returns images and the HR record");

  const photo = await fetch(`${base}/admin/users/${applicantId}/photo`, { headers: auth });
  if (photo.headers.get("content-type") !== "image/png" || (await photo.arrayBuffer()).byteLength !== png.length) {
    throw new Error("Personal photo did not round-trip");
  }
  console.log("PASS GET /admin/users/:id/photo streams the personal photo");

  const anonymous = await fetch(`${base}/admin/users/${applicantId}/photo`);
  if (anonymous.status !== 401) throw new Error(`Photo must require auth, got ${anonymous.status}`);
  console.log("PASS photo endpoint rejects anonymous requests");

  await call(`/admin/users/${applicantId}/approve`, { method: "POST", headers: auth });
  const login = await call<{ access_token: string; user: { status: string } }>(
    "/auth/login",
    json({ employee_number: employeeNumber, password, platform: "android" }),
  );
  if (!login.access_token || login.user.status !== "active") throw new Error("Activated login failed");
  console.log("PASS activated employee signs in with the employee number");
} finally {
  await transaction(async () => {
    await query("DELETE FROM employee_records WHERE employee_number=$1", [employeeNumber]);
    for (const id of [applicantId, adminId].filter(Boolean)) {
      for (const table of ["admin_mfa_challenges", "admin_security", "refresh_sessions", "user_roles", "audit_logs", "users"]) {
        await query(`DELETE FROM ${table} WHERE user_id=$1`, [id]);
      }
    }
    await query("DELETE FROM audit_logs WHERE employee_number=$1", [employeeNumber]);
  });
  if (applicantId) {
    for (const folder of ["national-ids", "profile-images"]) {
      await rm(join(env.uploadDir, folder, applicantId.replace(/[^a-zA-Z0-9_-]/g, "")), {
        recursive: true,
        force: true,
      });
    }
  }
  await database.end();
}
