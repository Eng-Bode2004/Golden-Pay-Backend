#!/usr/bin/env bun
/**
 * Creates the first administrator (or any additional one) directly in PostgreSQL.
 *
 * There is no public API that can create the first administrator, so this script
 * is the supported bootstrap path. It creates:
 *   - an active `existing_employee` account with the given employee number,
 *   - a matching HR employee record (so the number cannot be reused),
 *   - the `admin` role assignment.
 *
 * The national-ID images are optional; the dashboard can display them once the
 * administrator uploads them through the regular signup flow.
 *
 * Usage:
 *   bun run create-admin --employee-number GP-000001 --full-name "اسم المدير" \
 *     --phone 01012345678 --national-id 29901011234567 --password 'Str0ngPass!'
 *
 *   bun run create-admin --full-name "اسم المدير" --phone 01012345678 \
 *     --national-id 29901011234567
 *     (an employee number and a random password are generated and printed)
 */

import { connectDatabase, disconnectDatabase } from "../Config/db.ts";
import UserModel from "../Models/UserSchema.ts";
import EmployeeRecordModel from "../Models/EmployeeRecordSchema.ts";
import { generateEmployeeNumber } from "../Services/employeeNumber.service.ts";
import { assignRoleByName, getUserAccess, ROLES, seedRbac } from "../Services/rbac.service.ts";
import {
  fullNameField,
  normalisePhone,
  nationalIdField,
  validatePassword,
} from "../Utils/validation.ts";
import {
  encryptString,
  hashNationalId,
  newId,
  randomToken,
} from "../Utils/crypto.ts";
import { ApiError } from "../Utils/http.ts";

function readArgument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function usage(message?: string): void {
  if (message) console.error(`${message}\n`);
  console.error(
    [
      "Usage: bun run create-admin [options]",
      "",
      "Required:",
      "  --full-name \"Full Name\"",
      "  --phone 01012345678",
      "  --national-id 29901011234567      Egyptian national ID, 14 digits",
      "",
      "Optional:",
      "  --employee-number GP-000001       Generated when omitted",
      "  --employee-id EMP-001             HR employee ID",
      "  --email admin@goldenpay.example",
      "  --password 'Str0ngPass!'          Random password printed when omitted",
      "  --department \"Administration\"",
      "  --position \"System Administrator\"",
    ].join("\n"),
  );
  process.exitCode = 1;
}

/** Password that always satisfies the shared password policy. */
function generatePassword(): string {
  return `Gp-${randomToken(12)}9aA`;
}

async function main(): Promise<void> {
  const rawFullName = readArgument("full-name");
  const rawPhone = readArgument("phone");
  const rawNationalId = readArgument("national-id");

  if (!rawFullName || !rawPhone || !rawNationalId) {
    usage("full-name, phone and national-id are required.");
    return;
  }

  // Reuse the API validators so the script cannot create records the service
  // itself would reject.
  const body = {
    full_name: rawFullName,
    phone: rawPhone,
    national_id_number: rawNationalId,
  };

  const fullName = fullNameField(body);
  const phone = normalisePhone(rawPhone);
  const nationalId = nationalIdField(body);
  const nationalIdHash = hashNationalId(nationalId);
  const email = readArgument("email")?.trim() || null;
  const employeeId = readArgument("employee-id")?.trim().toUpperCase() || null;
  const department = readArgument("department")?.trim() || null;
  const position = readArgument("position")?.trim() || null;

  const suppliedPassword = readArgument("password");
  const password = suppliedPassword ? validatePassword(suppliedPassword) : generatePassword();

  await connectDatabase();

  try {
    await seedRbac();

    const [phoneConflict, nationalIdConflict] = await Promise.all([
      UserModel.exists({ phone, deleted_at: null }),
      UserModel.exists({ national_id_hash: nationalIdHash }),
    ]);

    if (phoneConflict) throw new ApiError(409, "ACCOUNT_ALREADY_EXISTS", "Phone number is already registered");
    if (nationalIdConflict) {
      throw new ApiError(409, "ACCOUNT_ALREADY_EXISTS", "National ID is already registered");
    }

    let employeeNumber = readArgument("employee-number")?.trim().toUpperCase();
    if (employeeNumber) {
      const [userNumberConflict, recordNumberConflict] = await Promise.all([
        UserModel.exists({ employee_number: employeeNumber }),
        EmployeeRecordModel.exists({ employee_number: employeeNumber }),
      ]);
      if (userNumberConflict || recordNumberConflict) {
        throw new ApiError(409, "ACCOUNT_ALREADY_EXISTS", `Employee number ${employeeNumber} is already in use`);
      }
    } else {
      employeeNumber = await generateEmployeeNumber();
    }

    const userId = newId();
    const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id" });
    const now = new Date();

    await UserModel.create({
      user_id: userId,
      employee_id: employeeId,
      employee_number: employeeNumber,
      full_name: fullName,
      phone,
      phone_verified_at: now,
      email,
      national_id_encrypted: encryptString(nationalId),
      national_id_hash: nationalIdHash,
      national_id_last4: nationalId.slice(-4),
      FrontID_image: "",
      BackID_image: "",
      password_hash: passwordHash,
      password_changed_at: now,
      account_type: "existing_employee",
      status: "active",
      status_reason: null,
      approved_at: now,
      approved_by: "create-admin-script",
      biometric_enabled: false,
    });

    await EmployeeRecordModel.create({
      employee_id: employeeId ?? `ADM-${employeeNumber}`,
      employee_number: employeeNumber,
      full_name: fullName,
      phone,
      email,
      national_id_hash: nationalIdHash,
      national_id_last4: nationalId.slice(-4),
      department,
      position,
      status: "registered",
      user_id: userId,
      registered_at: now,
      imported_by: "create-admin-script",
    });

    await assignRoleByName(userId, ROLES.ADMIN, "create-admin-script");
    const access = await getUserAccess(userId);

    console.log("");
    console.log("Administrator created.");
    console.log(`  Employee number: ${employeeNumber}`);
    console.log(`  Full name:       ${fullName}`);
    console.log(`  Phone:           ${phone}`);
    console.log(`  User ID:         ${userId}`);
    console.log(`  Roles:           ${access.roles.join(", ")}`);
    console.log(`  Permissions:     ${access.permissions.join(", ")}`);
    if (!suppliedPassword) {
      console.log("");
      console.log(`  Temporary password: ${password}`);
      console.log("  Change it after the first sign-in.");
    }
    console.log("");
  } finally {
    await disconnectDatabase();
  }
}

await main().catch((error: unknown) => {
  if (error instanceof ApiError) {
    console.error(`Failed: ${error.message}`);
    const details = (error as { details?: unknown }).details;
    if (details) console.error(details);
  } else {
    console.error("Failed:", error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
