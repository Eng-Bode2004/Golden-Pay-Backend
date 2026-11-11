import type { RequestContext } from "../Utils/http.ts";
import { ApiError, getUserAgent } from "../Utils/http.ts";
import {
  assertPasswordNotBasedOn,
  confirmPasswordField,
  fullNameField,
  nationalIdField,
  normaliseFullName,
  normalisePhone,
  optionalEmail,
  passwordField,
  phoneField,
  validatePassword,
} from "../Utils/validation.ts";
import {
  constantTimeEqual,
  encryptString,
  hashNationalId,
  newId,
} from "../Utils/crypto.ts";
import {
  deleteStoredFiles,
  formToJson,
  getFormFile,
  saveNationalIdImage,
  saveProfileImage,
} from "../Utils/files.ts";
import { verifySignupToken, signSignupToken, type SignupTokenClaims } from "../Utils/jwt.ts";
import UserModel, { type User } from "../Models/UserSchema.ts";
import { DatabaseConflict } from "../Config/db.ts";
import EmployeeRecordModel from "../Models/EmployeeRecordSchema.ts";
import RefreshSessionModel from "../Models/RefreshSessionSchema.ts";
import BiometricCredentialModel from "../Models/BiometricCredentialSchema.ts";
import { env } from "../Config/env.ts";
import { logger } from "../Utils/logger.ts";
import { generateEmployeeNumber } from "./employeeNumber.service.ts";
import { recordAudit } from "./audit.service.ts";
import {
  createSession,
  claimSessionForRotation,
  findSessionByRefreshToken,
  linkRotatedSession,
  markSessionReused,
  revokeAllUserSessions,
  revokeSession,
  revokeSessionByUser,
  type TokenBundle,
  type DeviceMetadata,
} from "./session.service.ts";
import {
  toPublicUser,
  type PublicUser,
} from "./user.service.ts";
import { getUserAccess as loadAccess } from "./rbac.service.ts";
import { beginMfa } from "./admin-security.service.ts";

export interface LoginInput {
  identifier: { type: "employee_number" | "employee_id" | "email" | "phone"; value: string };
  password: string;
  deviceId?: string;
  deviceName?: string;
  platform: "ios" | "android" | "web" | "unknown";
}

export interface AuthResult extends TokenBundle {
  user: PublicUser;
}

export interface SignupStarted {
  signup_token: string;
  expires_in: number;
  employee: {
    employee_number: string;
    employee_id: string;
    full_name: string;
    phone_hint: string;
    department: string | null;
    position: string | null;
  };
  next_step: "complete_profile";
}

export interface SignupCompleted {
  user_id: string;
  employee_number: string | null;
  employee_id: string | null;
  account_type: string;
  status: string;
  next_step: "await_admin_verification" | "await_admin_approval";
  message: string;
}

/** How long a refresh token may be sent again after its reply was lost (see refreshTokens). */
const REFRESH_RETRY_GRACE_MS = 60_000;
const DUMMY_PASSWORD_HASH = await Bun.password.hash(
  "identity-service-timing-safety-dummy-password",
  { algorithm: "argon2id" },
);

async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}

function maskPhone(phone: string): string {
  if (phone.length <= 6) return "***";
  return `${phone.slice(0, 4)}${"*".repeat(Math.max(2, phone.length - 7))}${phone.slice(-3)}`;
}

function duplicateKeyError(error: unknown): ApiError | null {
  const field =
    error instanceof DatabaseConflict
      ? error.field
      : typeof error === "object" &&
          error !== null &&
          (error as { code?: number }).code === 11000
        ? (Object.keys((error as { keyPattern?: Record<string, unknown> }).keyPattern ?? {})[0] ??
          "unknown")
        : null;

  if (!field) return null;

  const friendly: Record<string, string> = {
    employee_number: "An account with this employee number already exists",
    employee_id: "An account with this employee ID already exists",
    phone: "An account with this phone number already exists",
    email: "An account with this email address already exists",
    national_id_hash: "An account with this national ID already exists",
    refresh_token_hash: "Token collision, please retry",
  };

  return new ApiError(409, "ACCOUNT_ALREADY_EXISTS", friendly[field] ?? "Account already exists", {
    details: { field },
  });
}

export function assertAccountActive(user: User): void {
  switch (user.status) {
    case "pending_verification":
      throw new ApiError(
        403,
        "ACCOUNT_PENDING_VERIFICATION",
        "Your account is awaiting admin verification",
        { details: { status: user.status } },
      );
    case "pending_approval":
      throw new ApiError(
        403,
        "ACCOUNT_PENDING_APPROVAL",
        "Your account is awaiting admin approval",
        { details: { status: user.status } },
      );
    case "rejected":
      throw new ApiError(403, "ACCOUNT_REJECTED", "Your registration was rejected", {
        details: { status: user.status, reason: user.status_reason ?? null },
      });
    case "suspended":
      throw new ApiError(403, "ACCOUNT_SUSPENDED", "Your account is suspended", {
        details: { status: user.status, reason: user.status_reason ?? null },
      });
    case "active":
      return;
    default:
      throw new ApiError(403, "ACCOUNT_NOT_ACTIVE", "Your account is not active", {
        details: { status: user.status },
      });
  }
}

export function deviceMetadata(input: {
  deviceId?: string;
  deviceName?: string;
  platform: "ios" | "android" | "web" | "unknown";
  context: RequestContext;
}): DeviceMetadata {
  return {
    deviceId: input.deviceId ?? null,
    deviceName: input.deviceName ?? null,
    platform: input.platform,
    ip: input.context.ip,
    userAgent: getUserAgent(input.context.req),
  };
}

export async function login(input: LoginInput, context: RequestContext): Promise<AuthResult> {
  const password = input.password;
  if (typeof password !== "string" || password.length === 0 || password.length > 128) {
    throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid employee credentials");
  }

  const query =
    input.identifier.type === "employee_number"
      ? { employee_number: input.identifier.value }
      : input.identifier.type === "employee_id"
        ? { employee_id: input.identifier.value }
        : input.identifier.type === "phone"
          ? { phone: input.identifier.value }
          : { email: input.identifier.value };

  const user = await UserModel.findOne({ ...query, deleted_at: null }).select(
    "+password_hash +failed_login_attempts +locked_until",
  );

  // Always perform one password verification to reduce timing differences.
  const passwordHash = user?.password_hash ?? DUMMY_PASSWORD_HASH;
  const passwordMatches = await verifyPassword(password, passwordHash);

  if (!user) {
    await recordAudit({
      event: "auth.login.failed",
      employeeNumber: input.identifier.type === "employee_number" ? input.identifier.value : null,
      success: false,
      reason: "unknown_identifier",
      context,
    });
    throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid employee credentials");
  }

  const now = new Date();

  if (user.locked_until && user.locked_until.getTime() > now.getTime()) {
    await recordAudit({
      event: "auth.login.failed",
      userId: user.user_id,
      employeeNumber: user.employee_number ?? null,
      success: false,
      reason: "account_locked",
      context,
    });
    const retryAfter = Math.ceil((user.locked_until.getTime() - now.getTime()) / 1000);
    throw ApiError.tooManyRequests(
      "Too many failed attempts. Your account is temporarily locked.",
      retryAfter,
    );
  }

  if (!passwordMatches) {
    const attempts = (user.failed_login_attempts ?? 0) + 1;
    const shouldLock = attempts >= env.loginMaxAttempts;
    const lockedUntil = shouldLock
      ? new Date(now.getTime() + env.loginLockMinutes * 60 * 1000)
      : null;

    await UserModel.updateOne(
      { user_id: user.user_id },
      {
        $set: {
          failed_login_attempts: attempts,
          ...(lockedUntil ? { locked_until: lockedUntil } : {}),
        },
      },
    );

    await recordAudit({
      event: "auth.login.failed",
      userId: user.user_id,
      employeeNumber: user.employee_number ?? null,
      success: false,
      reason: "invalid_password",
      context,
      metadata: { attempts },
    });

    if (shouldLock) {
      throw ApiError.tooManyRequests(
        "Too many failed attempts. Your account is temporarily locked.",
        env.loginLockMinutes * 60,
      );
    }

    throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid employee credentials");
  }

  await UserModel.updateOne(
    { user_id: user.user_id },
    {
      $set: {
        failed_login_attempts: 0,
        locked_until: null,
        last_login_at: now,
      },
    },
  );

  if (user.status !== "active") {
    await recordAudit({
      event: "auth.login.failed",
      userId: user.user_id,
      employeeNumber: user.employee_number ?? null,
      success: false,
      reason: `status_${user.status}`,
      context,
    });
    assertAccountActive(user);
  }

  if (user.deleted_at) {
    throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid employee credentials");
  }

  const mfa = await beginMfa(user.user_id, user.email ?? user.employee_number ?? user.user_id);
  if (mfa) throw new ApiError(403, "MFA_REQUIRED", "Authenticator verification required", { details: mfa });

  const tokens = await createSession(
    user,
    "password",
    deviceMetadata({ ...input, context }),
  );

  const access = await loadAccess(user.user_id);

  await recordAudit({
    event: "auth.login.password",
    userId: user.user_id,
    employeeNumber: user.employee_number ?? null,
    success: true,
    context,
    metadata: {
      auth_method: "password",
      identifier_type: input.identifier.type,
      session_id: tokens.session.session_id,
    },
  });

  return {
    ...tokens,
    user: toPublicUser(user, access.roles),
  };
}

export async function startExistingEmployeeSignup(
  employeeNumber: string,
  context: RequestContext,
): Promise<SignupStarted> {
  const record = await EmployeeRecordModel.findOne({ employee_number: employeeNumber });

  if (!record) {
    throw ApiError.notFound("No employee record was found for this employee number");
  }
  if (record.status === "inactive") {
    throw new ApiError(403, "EMPLOYEE_INACTIVE", "This employee record is inactive");
  }
  const existingUser = await UserModel.findOne({
    employee_number: record.employee_number,
    deleted_at: null,
  });
  // A rejected employee may apply again; their account is reopened on completion.
  if (
    existingUser?.status !== "rejected" &&
    (existingUser || record.status === "registered" || record.user_id)
  ) {
    throw new ApiError(
      409,
      "EMPLOYEE_ALREADY_REGISTERED",
      "This employee number is already registered. Please sign in or use account recovery.",
    );
  }

  const signupToken = signSignupToken({
    employee_record_id: record._id.toString(),
    employee_number: record.employee_number,
  });

  await recordAudit({
    event: "signup.existing.started",
    employeeNumber: record.employee_number,
    success: true,
    context,
  });

  return {
    signup_token: signupToken,
    expires_in: env.signupTokenTtlSeconds,
    employee: {
      employee_number: record.employee_number,
      employee_id: record.employee_id,
      full_name: record.full_name,
      phone_hint: maskPhone(record.phone),
      department: record.department ?? null,
      position: record.position ?? null,
    },
    next_step: "complete_profile",
  };
}

export async function completeExistingEmployeeSignup(
  signupToken: string,
  form: FormData,
  context: RequestContext,
): Promise<SignupCompleted> {
  const claims: SignupTokenClaims = verifySignupToken(signupToken);
  const record = await EmployeeRecordModel.findOne({
    _id: claims.employee_record_id,
  }).select("+national_id_hash");

  if (!record || record.employee_number !== claims.employee_number) {
    throw new ApiError(401, "INVALID_SIGNUP_SESSION", "Signup session is invalid, please restart");
  }

  const rejected = await UserModel.findOne({
    employee_number: record.employee_number,
    status: "rejected",
    deleted_at: null,
  }).select("+FrontID_image +BackID_image +profile_image");

  if (!rejected && (record.status !== "available" || record.user_id)) {
    throw new ApiError(
      409,
      "EMPLOYEE_ALREADY_REGISTERED",
      "This employee number is already registered",
    );
  }

  const body = formToJson(form);
  const fullName = fullNameField(body);
  const phone = phoneField(body);
  const email = optionalEmail(body);
  const password = passwordField(body);
  confirmPasswordField(body, password);
  const nationalId = nationalIdField(body);
  const nationalIdHash = hashNationalId(nationalId);

  assertPasswordNotBasedOn(password, [nationalId, record.employee_number]);

  const identityIssues: Array<{ field: string; message: string }> = [];

  if (!constantTimeEqual(record.national_id_hash, nationalIdHash)) {
    identityIssues.push({
      field: "national_id_number",
      message: "National ID does not match employee records",
    });
  }

  if (env.strictEmployeeVerification) {
    if (normalisePhone(record.phone) !== phone) {
      identityIssues.push({ field: "phone", message: "Phone does not match employee records" });
    }
    if (normaliseFullName(record.full_name) !== normaliseFullName(fullName)) {
      identityIssues.push({
        field: "full_name",
        message: "Full name does not match employee records",
      });
    }
  }

  if (identityIssues.length > 0) {
    throw new ApiError(
      400,
      "IDENTITY_VERIFICATION_FAILED",
      "Your details do not match the employee record",
      { details: identityIssues },
    );
  }

  const otherAccounts = rejected ? { user_id: { $ne: rejected.user_id } } : {};
  const [phoneConflict, employeeIdConflict, nationalIdConflict] = await Promise.all([
    UserModel.exists({ phone, deleted_at: null, ...otherAccounts }),
    UserModel.exists({ employee_id: record.employee_id, deleted_at: null, ...otherAccounts }),
    UserModel.exists({ national_id_hash: nationalIdHash, ...otherAccounts }),
  ]);

  if (phoneConflict) {
    throw new ApiError(409, "ACCOUNT_ALREADY_EXISTS", "An account with this phone number already exists", {
      details: { field: "phone" },
    });
  }
  if (employeeIdConflict) {
    throw new ApiError(409, "ACCOUNT_ALREADY_EXISTS", "An account with this employee ID already exists", {
      details: { field: "employee_id" },
    });
  }
  if (nationalIdConflict) {
    throw new ApiError(409, "ACCOUNT_ALREADY_EXISTS", "An account with this national ID already exists", {
      details: { field: "national_id_number" },
    });
  }

  const userId = rejected?.user_id ?? newId();
  const frontFile = getFormFile(
    form,
    ["national_id_front", "front_id_image", "FrontID_image"],
    "national_id_front",
  );
  const backFile = getFormFile(
    form,
    ["national_id_back", "back_id_image", "BackID_image"],
    "national_id_back",
  );
  const profileFile = getFormFile(form, ["profile_image"], "profile_image");

  const savedFiles: string[] = [];

  try {
    const frontPath = await saveNationalIdImage(frontFile, userId, "front");
    savedFiles.push(frontPath);
    const backPath = await saveNationalIdImage(backFile, userId, "back");
    savedFiles.push(backPath);
    const profilePath = await saveProfileImage(profileFile, userId);
    savedFiles.push(profilePath);

    const passwordHash = await hashPassword(password);

    if (rejected) {
      const reopened = await UserModel.findOneAndUpdate(
        { user_id: userId, status: "rejected" },
        {
          $set: {
            full_name: fullName,
            phone,
            email: email ?? record.email ?? null,
            national_id_encrypted: encryptString(nationalId),
            national_id_hash: nationalIdHash,
            national_id_last4: nationalId.slice(-4),
            FrontID_image: frontPath,
            BackID_image: backPath,
            profile_image: profilePath,
            password_hash: passwordHash,
            status: "pending_verification",
            status_reason: null,
            rejected_at: null,
            failed_login_attempts: 0,
            locked_until: null,
          },
        },
        { new: true },
      );
      if (!reopened) {
        throw new ApiError(
          409,
          "EMPLOYEE_ALREADY_REGISTERED",
          "This employee number is already registered",
        );
      }

      await deleteStoredFiles([
        rejected.FrontID_image,
        rejected.BackID_image,
        rejected.profile_image,
      ]);
      await recordAudit({
        event: "signup.existing.completed",
        userId,
        employeeNumber: record.employee_number,
        success: true,
        context,
        metadata: { account_type: "existing_employee", reapplied: true },
      });

      return {
        user_id: userId,
        employee_number: record.employee_number,
        employee_id: record.employee_id,
        account_type: "existing_employee",
        status: "pending_verification",
        next_step: "await_admin_verification",
        message:
          "Your profile was submitted successfully. An administrator will verify your account before you can sign in.",
      };
    }

    const claimedRecord = await EmployeeRecordModel.findOneAndUpdate(
      { _id: record._id, status: "available", user_id: null },
      {
        $set: {
          status: "registered",
          user_id: userId,
          registered_at: new Date(),
        },
      },
      { new: true },
    );

    if (!claimedRecord) {
      throw new ApiError(
        409,
        "EMPLOYEE_ALREADY_REGISTERED",
        "This employee number is already registered",
      );
    }

    try {
      await UserModel.create({
        user_id: userId,
        employee_id: record.employee_id,
        employee_number: record.employee_number,
        full_name: fullName,
        phone,
        phone_verified_at: null,
        email: email ?? record.email,
        national_id_encrypted: encryptString(nationalId),
        national_id_hash: nationalIdHash,
        national_id_last4: nationalId.slice(-4),
        FrontID_image: frontPath,
        BackID_image: backPath,
        profile_image: profilePath,
        password_hash: passwordHash,
        account_type: "existing_employee",
        status: "pending_verification",
      });
    } catch (error) {
      await EmployeeRecordModel.updateOne(
        { _id: record._id, user_id: userId },
        {
          $set: { status: "available", user_id: null, registered_at: null },
        },
      );
      throw error;
    }

    await recordAudit({
      event: "signup.existing.completed",
      userId,
      employeeNumber: record.employee_number,
      success: true,
      context,
      metadata: { account_type: "existing_employee" },
    });

    return {
      user_id: userId,
      employee_number: record.employee_number,
      employee_id: record.employee_id,
      account_type: "existing_employee",
      status: "pending_verification",
      next_step: "await_admin_verification",
      message:
        "Your profile was submitted successfully. An administrator will verify your account before you can sign in.",
    };
  } catch (error) {
    await deleteStoredFiles(savedFiles);
    const duplicate = duplicateKeyError(error);
    if (duplicate) throw duplicate;
    throw error;
  }
}

export async function signupNewInvestigator(
  form: FormData,
  context: RequestContext,
): Promise<SignupCompleted> {
  const body = formToJson(form);
  const fullName = fullNameField(body);
  const phone = phoneField(body);
  const email = optionalEmail(body);
  const password = passwordField(body);
  confirmPasswordField(body, password);
  const nationalId = nationalIdField(body);
  const nationalIdHash = hashNationalId(nationalId);

  assertPasswordNotBasedOn(password, [nationalId]);

  const [phoneConflict, nationalIdConflict, employeeRecordConflict] = await Promise.all([
    UserModel.exists({ phone, deleted_at: null }),
    UserModel.exists({ national_id_hash: nationalIdHash }),
    EmployeeRecordModel.exists({ national_id_hash: nationalIdHash }),
  ]);

  if (phoneConflict) {
    throw new ApiError(409, "ACCOUNT_ALREADY_EXISTS", "An account with this phone number already exists", {
      details: { field: "phone" },
    });
  }
  if (nationalIdConflict) {
    throw new ApiError(409, "ACCOUNT_ALREADY_EXISTS", "An account with this national ID already exists", {
      details: { field: "national_id_number" },
    });
  }
  if (employeeRecordConflict) {
    throw new ApiError(
      409,
      "EXISTING_EMPLOYEE_DETECTED",
      "An employee record already exists for this national ID. Please use the existing employee signup flow.",
    );
  }

  if (email) {
    const emailConflict = await UserModel.exists({ email, deleted_at: null });
    if (emailConflict) {
      throw new ApiError(409, "ACCOUNT_ALREADY_EXISTS", "An account with this email address already exists", {
        details: { field: "email" },
      });
    }
  }

  const userId = newId();
  const employeeNumber = await generateEmployeeNumber();
  const frontFile = getFormFile(
    form,
    ["national_id_front", "front_id_image", "FrontID_image"],
    "national_id_front",
  );
  const backFile = getFormFile(
    form,
    ["national_id_back", "back_id_image", "BackID_image"],
    "national_id_back",
  );
  const profileFile = getFormFile(form, ["profile_image"], "profile_image");

  const savedFiles: string[] = [];

  try {
    const frontPath = await saveNationalIdImage(frontFile, userId, "front");
    savedFiles.push(frontPath);
    const backPath = await saveNationalIdImage(backFile, userId, "back");
    savedFiles.push(backPath);
    const profilePath = await saveProfileImage(profileFile, userId);
    savedFiles.push(profilePath);

    const passwordHash = await hashPassword(password);

    await UserModel.create({
      user_id: userId,
      employee_number: employeeNumber,
      full_name: fullName,
      phone,
      phone_verified_at: null,
      email,
      national_id_encrypted: encryptString(nationalId),
      national_id_hash: nationalIdHash,
      national_id_last4: nationalId.slice(-4),
      FrontID_image: frontPath,
      BackID_image: backPath,
      profile_image: profilePath,
      password_hash: passwordHash,
      account_type: "new_investigator",
      status: "pending_approval",
    });

    await recordAudit({
      event: "signup.new.completed",
      userId,
      employeeNumber,
      success: true,
      context,
      metadata: { account_type: "new_investigator" },
    });

    return {
      user_id: userId,
      employee_number: employeeNumber,
      employee_id: null,
      account_type: "new_investigator",
      status: "pending_approval",
      next_step: "await_admin_approval",
      message:
        "Your profile was submitted successfully. Save your employee number: it is required to sign in. An administrator will review your application.",
    };
  } catch (error) {
    await deleteStoredFiles(savedFiles);
    const duplicate = duplicateKeyError(error);
    if (duplicate) throw duplicate;
    throw error;
  }
}

export async function refreshTokens(
  refreshToken: string,
  context: RequestContext,
): Promise<AuthResult> {
  if (typeof refreshToken !== "string" || refreshToken.length < 20 || refreshToken.length > 512) {
    throw ApiError.unauthorized("Invalid refresh token");
  }

  let session = await findSessionByRefreshToken(refreshToken);
  if (!session) {
    throw ApiError.unauthorized("Invalid refresh token");
  }

  // The reply to a refresh can be lost (the connection dropped or the server restarted after
  // rotating). The browser then sends the same token again moments later. Within a short
  // window, and only while the session that replaced it is still unused, rotate that
  // replacement instead of treating the retry as a stolen token.
  if (
    session.revoked_at &&
    session.revoked_reason === "rotated" &&
    session.replaced_by_session_id &&
    Date.now() - session.revoked_at.getTime() < REFRESH_RETRY_GRACE_MS
  ) {
    const replacement = await RefreshSessionModel.findOne({ session_id: session.replaced_by_session_id });
    if (replacement && !replacement.revoked_at && replacement.user_id === session.user_id) {
      await recordAudit({
        event: "auth.refresh.retry",
        userId: session.user_id,
        success: true,
        reason: "lost_refresh_reply",
        context,
        metadata: { session_id: session.session_id, replacement_session_id: replacement.session_id },
      });
      session = replacement;
    }
  }

  if (session.revoked_at) {
    await markSessionReused(session);
    await recordAudit({
      event: "auth.refresh.reuse_detected",
      userId: session.user_id,
      success: false,
      reason: "refresh_token_reuse",
      context,
      metadata: { session_id: session.session_id },
    });
    throw ApiError.unauthorized("Refresh token has already been used");
  }

  if (session.expires_at.getTime() <= Date.now()) {
    await revokeSession(session.session_id, "expired");
    throw ApiError.unauthorized("Refresh token has expired");
  }

  const user = await UserModel.findOne({ user_id: session.user_id, deleted_at: null });
  if (!user) {
    await revokeSession(session.session_id, "user_not_found");
    throw ApiError.unauthorized("Invalid refresh token");
  }
  if (user.status !== "active") {
    await revokeSession(session.session_id, "account_not_active");
    assertAccountActive(user);
  }

  let claimed;
  try {
    claimed = await claimSessionForRotation(session);
  } catch (error) {
    await markSessionReused(session);
    await recordAudit({
      event: "auth.refresh.reuse_detected",
      userId: session.user_id,
      success: false,
      reason: "refresh_token_race_or_reuse",
      context,
      metadata: { session_id: session.session_id },
    });
    throw error;
  }

  const tokens = await createSession(user, session.auth_method, {
    deviceId: claimed.device_id ?? null,
    deviceName: claimed.device_name ?? null,
    platform: (claimed.platform ?? "unknown") as DeviceMetadata["platform"],
    ip: context.ip,
    userAgent: getUserAgent(context.req),
  });

  await linkRotatedSession(session.session_id, tokens.session.session_id);

  const access = await loadAccess(user.user_id);

  await recordAudit({
    event: "auth.refresh",
    userId: user.user_id,
    employeeNumber: user.employee_number ?? null,
    success: true,
    context,
    metadata: {
      previous_session_id: session.session_id,
      session_id: tokens.session.session_id,
    },
  });

  return {
    ...tokens,
    user: toPublicUser(user, access.roles),
  };
}

export async function logout(
  userId: string,
  currentSessionId: string,
  refreshToken: string | undefined,
  context: RequestContext,
): Promise<void> {
  if (refreshToken) {
    const session = await findSessionByRefreshToken(refreshToken);
    if (session && session.user_id === userId) {
      await revokeSessionByUser(session.session_id, userId, "logout");
    }
  }

  await revokeSessionByUser(currentSessionId, userId, "logout");

  await recordAudit({
    event: "auth.logout",
    userId,
    success: true,
    context,
    metadata: { session_id: currentSessionId },
  });
}

export async function logoutAll(
  userId: string,
  currentSessionId: string,
  context: RequestContext,
): Promise<void> {
  await revokeAllUserSessions(userId, "logout_all", currentSessionId);
  await revokeSessionByUser(currentSessionId, userId, "logout_all");

  await recordAudit({
    event: "auth.logout",
    userId,
    success: true,
    context,
    metadata: { all_sessions: true },
  });
}

export async function changePassword(input: {
  userId: string;
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
  currentSessionId: string;
  context: RequestContext;
}): Promise<void> {
  const user = await UserModel.findOne({
    user_id: input.userId,
    deleted_at: null,
  }).select("+password_hash");

  if (!user?.password_hash) {
    throw ApiError.unauthorized();
  }

  const currentMatches = await verifyPassword(input.currentPassword, user.password_hash);
  if (!currentMatches) {
    throw new ApiError(400, "INVALID_CURRENT_PASSWORD", "Current password is incorrect");
  }

  const newPassword = validatePassword(input.newPassword, "new_password");
  if (input.confirmPassword !== newPassword) {
    throw new ApiError(400, "VALIDATION_ERROR", "confirm_password does not match new_password", {
      details: { field: "confirm_password", message: "Passwords do not match" },
    });
  }
  if (newPassword === input.currentPassword) {
    throw new ApiError(400, "PASSWORD_REUSE", "New password must be different from the current password");
  }

  assertPasswordNotBasedOn(newPassword, [user.employee_number ?? undefined, user.phone]);

  const passwordHash = await hashPassword(newPassword);
  const now = new Date();

  await UserModel.updateOne(
    { user_id: input.userId },
    {
      $set: {
        password_hash: passwordHash,
        password_changed_at: now,
        failed_login_attempts: 0,
        locked_until: null,
      },
    },
  );

  // Changing the password invalidates other sessions and all biometric keys.
  await revokeAllUserSessions(
    input.userId,
    "password_changed",
    input.currentSessionId,
  );
  await BiometricCredentialModel.updateMany(
    { user_id: input.userId, status: "active" },
    { $set: { status: "revoked", revoked_at: now } },
  );
  await UserModel.updateOne(
    { user_id: input.userId },
    { $set: { biometric_enabled: false } },
  );

  await recordAudit({
    event: "auth.password.changed",
    userId: input.userId,
    success: true,
    context: input.context,
  });

  logger.info("auth.password.changed", { user_id: input.userId });
}
