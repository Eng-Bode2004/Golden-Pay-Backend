import UserModel, { type User } from "../Models/UserSchema.ts";
import RefreshSessionModel from "../Models/RefreshSessionSchema.ts";
import { query } from "../Config/db.ts";
import { getUserAccess, type UserAccess } from "./rbac.service.ts";
import { ApiError, type RequestContext } from "../Utils/http.ts";
import {
  normaliseFullName,
  normalisePhone,
  optionalEmail,
  optionalString,
} from "../Utils/validation.ts";
import { toPublicSession, type PublicSession } from "./session.service.ts";
import { recordAudit } from "./audit.service.ts";

export interface PublicUser {
  user_id: string;
  employee_id: string | null;
  employee_number: string | null;
  full_name: string;
  phone: string;
  phone_verified_at: Date | null;
  email: string | null;
  national_id_last4: string;
  account_type: string;
  status: string;
  biometric_enabled: boolean;
  last_login_at: Date | null;
  created_at: Date;
  roles: string[];
}

export function toPublicUser(user: User, roles: string[] = []): PublicUser {
  return {
    user_id: user.user_id,
    employee_id: user.employee_id ?? null,
    employee_number: user.employee_number ?? null,
    full_name: user.full_name,
    phone: user.phone,
    phone_verified_at: user.phone_verified_at ?? null,
    email: user.email ?? null,
    national_id_last4: user.national_id_last4,
    account_type: user.account_type,
    status: user.status,
    biometric_enabled: user.biometric_enabled ?? false,
    last_login_at: user.last_login_at ?? null,
    created_at: user.created_at,
    roles,
  };
}

export async function getPublicUser(user: User): Promise<PublicUser> {
  const access = await getUserAccess(user.user_id);
  return toPublicUser(user, access.roles);
}

export interface AuthenticatedUser {
  user: User;
  access: UserAccess;
  sessionId: string;
  authMethod: "password" | "biometric";
}

export async function findActiveUser(userId: string): Promise<User | null> {
  return UserModel.findOne({
    user_id: userId,
    deleted_at: null,
  });
}

export function displayEmployee(user: User): {
  user_id: string;
  employee_number: string | null;
  employee_id: string | null;
  full_name: string;
  account_type: string;
  status: string;
} {
  return {
    user_id: user.user_id,
    employee_number: user.employee_number ?? null,
    employee_id: user.employee_id ?? null,
    full_name: user.full_name,
    account_type: user.account_type,
    status: user.status,
  };
}

export async function updateProfile(input: {
  userId: string;
  body: Record<string, unknown>;
  context: RequestContext;
}): Promise<PublicUser> {
  const user = await UserModel.findOne({ user_id: input.userId, deleted_at: null });
  if (!user) throw ApiError.notFound("User not found");

  const requestedName = optionalString(input.body, "full_name", {
    min: 3,
    max: 120,
    label: "full_name",
  });

  if (
    requestedName &&
    normaliseFullName(requestedName) !== normaliseFullName(user.full_name)
  ) {
    const administrator = (await query(
      "SELECT 1 FROM admin_security WHERE user_id=$1",
      [user.user_id],
    ))[0];
    if (!administrator) {
      throw new ApiError(
        400,
        "FULL_NAME_IMMUTABLE",
        "full_name cannot be changed after registration. Contact an administrator.",
        { details: { field: "full_name" } },
      );
    }
    user.full_name = requestedName.trim();
  }

  const rawPhone = optionalString(input.body, "phone", { max: 32, label: "phone" });
  if (rawPhone !== undefined) {
    const phone = normalisePhone(rawPhone);
    if (phone !== user.phone) {
      const conflict = await UserModel.exists({
        phone,
        user_id: { $ne: user.user_id },
        deleted_at: null,
      });
      if (conflict) {
        throw new ApiError(409, "ACCOUNT_ALREADY_EXISTS", "An account with this phone number already exists", {
          details: { field: "phone" },
        });
      }
      user.phone = phone;
      user.phone_verified_at = null;
    }
  }

  const hasEmailKey =
    Object.prototype.hasOwnProperty.call(input.body, "email") ||
    Object.prototype.hasOwnProperty.call(input.body, "email_address");

  const rawEmail =
    input.body.email ?? input.body.email_address ?? undefined;

  if (hasEmailKey) {
    if (rawEmail === null || rawEmail === "") {
      user.email = null;
    } else {
      const email = optionalEmail({ email: rawEmail }, "email");
      if (!email) {
        throw new ApiError(400, "VALIDATION_ERROR", "email is invalid", {
          details: { field: "email" },
        });
      }
      if (email !== user.email) {
        const conflict = await UserModel.exists({
          email,
          user_id: { $ne: user.user_id },
          deleted_at: null,
        });
        if (conflict) {
          throw new ApiError(409, "ACCOUNT_ALREADY_EXISTS", "An account with this email address already exists", {
            details: { field: "email" },
          });
        }
        user.email = email;
      }
    }
  }

  await user.save();

  await recordAudit({
    event: "profile.updated",
    userId: user.user_id,
    success: true,
    context: input.context,
  });

  return getPublicUser(user);
}

export async function listUserSessions(
  userId: string,
  currentSessionId: string,
): Promise<PublicSession[]> {
  const sessions = await RefreshSessionModel.find({
    user_id: userId,
    revoked_at: null,
    expires_at: { $gt: new Date() },
  })
    .sort({ created_at: -1 })
    .lean();

  return sessions.map((session) => toPublicSession(session, currentSessionId));
}

export async function revokeUserSession(
  userId: string,
  sessionId: string,
  currentSessionId: string,
  context: RequestContext,
): Promise<void> {
  if (sessionId === currentSessionId) {
    throw new ApiError(
      400,
      "CANNOT_REVOKE_CURRENT_SESSION",
      "Use the logout endpoint to end the current session",
    );
  }

  const result = await RefreshSessionModel.updateOne(
    { session_id: sessionId, user_id: userId, revoked_at: null },
    { $set: { revoked_at: new Date(), revoked_reason: "revoked_by_user" } },
  );

  if (result.modifiedCount === 0) {
    throw ApiError.notFound("Session not found");
  }

  await recordAudit({
    event: "auth.logout",
    userId,
    success: true,
    context,
    metadata: { revoked_session_id: sessionId },
  });
}
