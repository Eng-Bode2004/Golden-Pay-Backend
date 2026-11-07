#!/usr/bin/env bun
/**
 * Promotes an existing account to a privileged role (bootstrap the first admin).
 *
 * There is deliberately no public API that can create the first administrator, so
 * this script is the supported way to grant `admin` or `hr` access.
 *
 * Usage:
 *   bun run scripts/promote-admin.ts --employee-number GP-000001
 *   bun run scripts/promote-admin.ts --employee-id EMP-001 --role hr
 *   bun run scripts/promote-admin.ts --phone 08012345678
 *   bun run scripts/promote-admin.ts --employee-number GP-000001 --remove
 *   bun run scripts/promote-admin.ts --email owner@company.com --role head_office
 */

import { connectDatabase, disconnectDatabase } from "../Config/db.ts";
import UserModel from "../Models/UserSchema.ts";
import {
  assignRoleByName,
  getUserAccess,
  removeRoleByName,
  ROLES,
  seedRbac,
} from "../Services/rbac.service.ts";
import { normalisePhone } from "../Utils/validation.ts";

const VALID_ROLES = new Set<string>(Object.values(ROLES));

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
      "Usage: bun run scripts/promote-admin.ts <selector> [options]",
      "",
      "Selector (one required):",
      "  --employee-number GP-000001",
      "  --employee-id EMP-001",
      "  --phone 08012345678",
      "  --user-id <user_id>",
      "  --email owner@company.com",
      "",
      "Options:",
      "  --role admin|hr|employee|head_office   Role to grant (default: admin)",
      "  --remove                   Remove the role instead of granting it",
      "",
      "The target account is also activated if it is still pending or suspended.",
    ].join("\n"),
  );
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const employeeNumber = readArgument("employee-number");
  const employeeId = readArgument("employee-id");
  const phone = readArgument("phone");
  const userId = readArgument("user-id");
  const email = readArgument("email");

  if (!employeeNumber && !employeeId && !phone && !userId && !email) {
    usage("A target account selector is required.");
    return;
  }

  const role = (readArgument("role") ?? ROLES.ADMIN).toLowerCase();
  if (!VALID_ROLES.has(role)) {
    usage(`Unknown role "${role}".`);
    return;
  }

  const remove = process.argv.includes("--remove");

  await connectDatabase();

  try {
    await seedRbac();

    const selector = employeeNumber
      ? { employee_number: employeeNumber.toUpperCase() }
      : employeeId
        ? { employee_id: employeeId.toUpperCase() }
        : phone
          ? { phone: normalisePhone(phone) }
          : email
            ? { email: email.toLowerCase() }
            : { user_id: userId as string };

    const user = await UserModel.findOne({ ...selector, deleted_at: null });
    if (!user) {
      console.error("No matching account was found.");
      process.exitCode = 1;
      return;
    }

    if (remove) {
      await removeRoleByName(user.user_id, role);
      console.log(`Removed role "${role}" from ${user.employee_number ?? user.user_id}.`);
    } else {
      if (user.status !== "active") {
        user.status = "active";
        user.status_reason = null;
        user.approved_at = user.approved_at ?? new Date();
        await user.save();
        console.log(`Activated account ${user.employee_number ?? user.user_id}.`);
      }

      await assignRoleByName(user.user_id, role, "bootstrap-script");
      console.log(`Granted role "${role}" to ${user.employee_number ?? user.user_id}.`);
    }

    const access = await getUserAccess(user.user_id);
    console.log(
      `Current roles: ${access.roles.length > 0 ? access.roles.join(", ") : "(none)"}`,
    );
    console.log(
      `Current permissions: ${
        access.permissions.length > 0 ? access.permissions.join(", ") : "(none)"
      }`,
    );
  } finally {
    await disconnectDatabase();
  }
}

await main();
