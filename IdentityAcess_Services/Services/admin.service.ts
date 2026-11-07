import UserModel, { type User } from "../Models/UserSchema.ts";
import type { SqlDocument } from "../Models/SqlModel.ts";
import EmployeeRecordModel from "../Models/EmployeeRecordSchema.ts";
import RefreshSessionModel from "../Models/RefreshSessionSchema.ts";
import AuditLogModel from "../Models/AuditLogSchema.ts";
import BiometricCredentialModel from "../Models/BiometricCredentialSchema.ts";
import RoleModel from "../Models/RoleSchema.ts";
import UserRoleModel from "../Models/UserRolesSchema.ts";
import type { RequestContext } from "../Utils/http.ts";
import { ApiError } from "../Utils/http.ts";
import {
  employeeIdentifierField,
  fullNameField,
  nationalIdField,
  normalisePhone,
  optionalEmail,
  optionalString,
  requiredString,
  validatePassword,
  type JsonBody,
} from "../Utils/validation.ts";
import { hashNationalId, encryptString, newId, randomToken } from "../Utils/crypto.ts";
import { readStoredFile } from "../Utils/files.ts";
import { recordAudit } from "./audit.service.ts";
import { generateEmployeeNumber } from "./employeeNumber.service.ts";
import {
  assignRoleByName,
  getUserAccess,
  removeRoleByName,
  ROLES,
  type UserAccess,
} from "./rbac.service.ts";
import {
  revokeAllUserSessions,
  toPublicSession,
  type PublicSession,
} from "./session.service.ts";
import {
  getPublicUser,
  toPublicUser,
  type PublicUser,
} from "./user.service.ts";
import {
  listBiometricCredentials,
  type BiometricCredentialSummary,
} from "./biometric.service.ts";

export interface UserListFilters {
  status?: string;
  account_type?: string;
  search?: string;
  page: number;
  limit: number;
  skip: number;
}

export interface UserListResult {
  users: Array<PublicUser & { roles: string[] }>;
  pagination: { page: number; limit: number; total: number; pages: number };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function rolesByUserId(userIds: string[]): Promise<Map<string, string[]>> {
  const links = await UserRoleModel.find({ user_id: { $in: userIds } }).lean();
  const roleIds = [...new Set(links.map((link) => link.role_id))];
  const roles = await RoleModel.find({ role_id: { $in: roleIds } }).lean();
  const roleNames = new Map(roles.map((role) => [role.role_id, role.name]));

  const result = new Map<string, string[]>();
  for (const link of links) {
    const name = roleNames.get(link.role_id);
    if (!name) continue;
    const existing = result.get(link.user_id) ?? [];
    existing.push(name);
    result.set(link.user_id, existing);
  }
  return result;
}

export async function listUsers(filters: UserListFilters): Promise<UserListResult> {
  const query: Record<string, unknown> = { deleted_at: null };

  if (filters.status === "pending") {
    query.status = { $in: ["pending_verification", "pending_approval"] };
  } else if (filters.status) {
    query.status = filters.status;
  }
  if (filters.account_type) query.account_type = filters.account_type;

  if (filters.search) {
    const pattern = new RegExp(escapeRegex(filters.search.trim()), "i");
    query.$or = [
      { employee_number: pattern },
      { employee_id: pattern },
      { full_name: pattern },
      { phone: pattern },
    ];
  }

  const [total, users] = await Promise.all([
    UserModel.countDocuments(query),
    UserModel.find(query)
      .sort({ created_at: -1 })
      .skip(filters.skip)
      .limit(filters.limit)
      .lean(),
  ]);

  const roleMap = await rolesByUserId(users.map((user) => user.user_id));

  return {
    users: users.map((user) =>
      toPublicUser(user, roleMap.get(user.user_id) ?? []),
    ),
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total,
      pages: Math.max(1, Math.ceil(total / filters.limit)),
    },
  };
}

export interface AdminUserDetail {
  user: PublicUser;
  employee_record: {
    employee_id: string;
    employee_number: string;
    full_name: string;
    phone: string;
    department: string | null;
    position: string | null;
    status: string;
    registered_at: Date | null;
  } | null;
  national_id_images: { front: boolean; back: boolean };
  profile_image: boolean;
  status_reason: string | null;
  biometric_devices: BiometricCredentialSummary[];
  active_sessions: PublicSession[];
}

export async function getUserDetail(userId: string): Promise<AdminUserDetail> {
  const user = await UserModel.findOne({
    user_id: userId,
    deleted_at: null,
  }).select("+FrontID_image +BackID_image +profile_image");

  if (!user) throw ApiError.notFound("User not found");

  const [access, employeeRecord, biometricDevices, sessions] = await Promise.all([
    getUserAccess(userId),
    EmployeeRecordModel.findOne({ user_id: userId }).lean(),
    listBiometricCredentials(userId),
    RefreshSessionModel.find({
      user_id: userId,
      revoked_at: null,
      expires_at: { $gt: new Date() },
    })
      .sort({ created_at: -1 })
      .lean(),
  ]);

  return {
    user: toPublicUser(user, access.roles),
    employee_record: employeeRecord
      ? {
          employee_id: employeeRecord.employee_id,
          employee_number: employeeRecord.employee_number,
          full_name: employeeRecord.full_name,
          phone: employeeRecord.phone,
          department: employeeRecord.department ?? null,
          position: employeeRecord.position ?? null,
          status: employeeRecord.status,
          registered_at: employeeRecord.registered_at ?? null,
        }
      : null,
    national_id_images: {
      front: Boolean(user.FrontID_image),
      back: Boolean(user.BackID_image),
    },
    profile_image: Boolean(user.profile_image),
    status_reason: user.status_reason ?? null,
    biometric_devices: biometricDevices,
    active_sessions: sessions.map((session) => toPublicSession(session, "")),
  };
}

async function getTargetUser(userId: string): Promise<SqlDocument<User>> {
  const user = await UserModel.findOne({ user_id: userId, deleted_at: null });
  if (!user) throw ApiError.notFound("User not found");
  return user;
}

export async function approveUser(
  actorId: string,
  userId: string,
  context: RequestContext,
): Promise<PublicUser> {
  const user = await getTargetUser(userId);

  if (user.status === "active") {
    throw new ApiError(409, "INVALID_STATUS_TRANSITION", "User is already active");
  }
  if (user.status !== "pending_verification" && user.status !== "pending_approval") {
    throw new ApiError(
      409,
      "INVALID_STATUS_TRANSITION",
      `A user with status "${user.status}" cannot be approved`,
    );
  }

  const now = new Date();
  const previousStatus = user.status;
  user.status = "active";
  user.status_reason = undefined;
  user.approved_at = now;
  user.approved_by = actorId;
  await user.save();

  await assignRoleByName(user.user_id, "employee", actorId);

  if (user.account_type === "existing_employee" && user.employee_number) {
    await EmployeeRecordModel.updateOne(
      { employee_number: user.employee_number, status: "available" },
      {
        $set: {
          status: "registered",
          user_id: user.user_id,
          registered_at: now,
        },
      },
    );
  }

  await recordAudit({
    event: "account.approved",
    userId: user.user_id,
    employeeNumber: user.employee_number ?? null,
    actorId,
    success: true,
    context,
    metadata: { previous_status: previousStatus, account_type: user.account_type },
  });

  return getPublicUser(user);
}

export async function rejectUser(
  actorId: string,
  userId: string,
  reason: string | undefined,
  context: RequestContext,
): Promise<PublicUser> {
  const user = await getTargetUser(userId);

  if (user.status !== "pending_verification" && user.status !== "pending_approval") {
    throw new ApiError(
      409,
      "INVALID_STATUS_TRANSITION",
      `A user with status "${user.status}" cannot be rejected`,
    );
  }

  user.status = "rejected";
  user.status_reason = reason;
  user.rejected_at = new Date();
  await user.save();

  await revokeAllUserSessions(user.user_id, "account_rejected");

  await recordAudit({
    event: "account.rejected",
    userId: user.user_id,
    employeeNumber: user.employee_number ?? null,
    actorId,
    success: true,
    reason,
    context,
  });

  return getPublicUser(user);
}

export async function suspendUser(
  actorId: string,
  userId: string,
  reason: string | undefined,
  context: RequestContext,
): Promise<PublicUser> {
  const user = await getTargetUser(userId);

  if (user.status !== "active") {
    throw new ApiError(409, "INVALID_STATUS_TRANSITION", "Only active users can be suspended");
  }

  user.status = "suspended";
  user.status_reason = reason;
  await user.save();

  await revokeAllUserSessions(user.user_id, "account_suspended");

  await recordAudit({
    event: "account.suspended",
    userId: user.user_id,
    employeeNumber: user.employee_number ?? null,
    actorId,
    success: true,
    reason,
    context,
  });

  return getPublicUser(user);
}

export async function reactivateUser(
  actorId: string,
  userId: string,
  context: RequestContext,
): Promise<PublicUser> {
  const user = await getTargetUser(userId);

  if (user.status !== "suspended") {
    throw new ApiError(409, "INVALID_STATUS_TRANSITION", "Only suspended users can be reactivated");
  }

  user.status = "active";
  user.status_reason = undefined;
  await user.save();

  await recordAudit({
    event: "account.reactivated",
    userId: user.user_id,
    employeeNumber: user.employee_number ?? null,
    actorId,
    success: true,
    context,
  });

  return getPublicUser(user);
}

export interface ImportResult {
  received: number;
  imported: number;
  updated: number;
  skipped: number;
  errors: Array<{ index: number; employee_number: string | null; message: string }>;
}

export async function importEmployees(
  actorId: string,
  records: unknown[],
  context: RequestContext,
): Promise<ImportResult> {
  if (records.length === 0) {
    throw ApiError.badRequest("employees array must not be empty");
  }
  if (records.length > 500) {
    throw ApiError.badRequest("A maximum of 500 employees can be imported per request");
  }

  const result: ImportResult = {
    received: records.length,
    imported: 0,
    updated: 0,
    skipped: 0,
    errors: [],
  };

  for (let index = 0; index < records.length; index += 1) {
    const raw = records[index];
    let employeeNumber: string | null = null;

    try {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw ApiError.badRequest(`employees[${index}] must be an object`);
      }
      const body = raw as JsonBody;

      const employeeId = employeeIdentifierField(body, "employee_id", "employee_id");
      employeeNumber = employeeIdentifierField(body, "employee_number", "employee_number");
      const fullName = fullNameField(body);
      const phone = normalisePhone(requiredString(body, "phone", { label: "phone" }));
      const email = optionalEmail(body);
      const nationalId = nationalIdField(body);
      const nationalIdHash = hashNationalId(nationalId);
      const department = optionalString(body, "department", { max: 120, label: "department" });
      const position = optionalString(body, "position", { max: 120, label: "position" });

      const conflictingUser = await UserModel.exists({
        deleted_at: null,
        $or: [
          { employee_number: employeeNumber },
          { employee_id: employeeId },
          { phone },
          { national_id_hash: nationalIdHash },
        ],
      });

      if (conflictingUser) {
        throw new ApiError(
          409,
          "EMPLOYEE_ALREADY_REGISTERED",
          "A user account already exists for this employee",
        );
      }

      const existingByNumber = await EmployeeRecordModel.findOne({
        employee_number: employeeNumber,
      });

      if (existingByNumber) {
        if (existingByNumber.status === "registered" || existingByNumber.user_id) {
          throw new ApiError(
            409,
            "EMPLOYEE_ALREADY_REGISTERED",
            "This employee record is already registered",
          );
        }

        const [otherId, otherNationalId] = await Promise.all([
          EmployeeRecordModel.findOne({
            employee_id: employeeId,
            employee_number: { $ne: employeeNumber },
          }),
          EmployeeRecordModel.findOne({
            national_id_hash: nationalIdHash,
            employee_number: { $ne: employeeNumber },
          }),
        ]);

        if (otherId) {
          throw new ApiError(409, "EMPLOYEE_ID_CONFLICT", "employee_id belongs to another record");
        }
        if (otherNationalId) {
          throw new ApiError(
            409,
            "NATIONAL_ID_CONFLICT",
            "National ID belongs to another employee record",
          );
        }

        existingByNumber.employee_id = employeeId;
        existingByNumber.full_name = fullName;
        existingByNumber.phone = phone;
        existingByNumber.email = email;
        existingByNumber.national_id_hash = nationalIdHash;
        existingByNumber.national_id_last4 = nationalId.slice(-4);
        existingByNumber.department = department;
        existingByNumber.position = position;
        existingByNumber.imported_by = actorId;
        await existingByNumber.save();
        result.updated += 1;
        continue;
      }

      const [idConflict, nationalIdConflict] = await Promise.all([
        EmployeeRecordModel.exists({ employee_id: employeeId }),
        EmployeeRecordModel.exists({ national_id_hash: nationalIdHash }),
      ]);

      if (idConflict) {
        throw new ApiError(409, "EMPLOYEE_ID_CONFLICT", "employee_id belongs to another record");
      }
      if (nationalIdConflict) {
        throw new ApiError(
          409,
          "NATIONAL_ID_CONFLICT",
          "National ID belongs to another employee record",
        );
      }

      await EmployeeRecordModel.create({
        employee_id: employeeId,
        employee_number: employeeNumber,
        full_name: fullName,
        phone,
        email,
        national_id_hash: nationalIdHash,
        national_id_last4: nationalId.slice(-4),
        department,
        position,
        status: "available",
        imported_by: actorId,
      });

      result.imported += 1;
    } catch (error) {
      result.skipped += 1;
      result.errors.push({
        index,
        employee_number: employeeNumber,
        message: error instanceof ApiError ? error.message : "Failed to import employee",
      });
    }
  }

  await recordAudit({
    event: "employee.imported",
    actorId,
    success: result.errors.length === 0,
    context,
    metadata: {
      received: result.received,
      imported: result.imported,
      updated: result.updated,
      skipped: result.skipped,
    },
  });

  return result;
}

export async function listEmployeeRecords(input: {
  status?: string;
  search?: string;
  page: number;
  limit: number;
  skip: number;
}): Promise<{
  employees: Array<{
    employee_id: string;
    employee_number: string;
    full_name: string;
    phone: string;
    email: string | null;
    department: string | null;
    position: string | null;
    status: string;
    user_id: string | null;
    registered_at: Date | null;
  }>;
  pagination: { page: number; limit: number; total: number; pages: number };
}> {
  const query: Record<string, unknown> = {};
  if (input.status) query.status = input.status;
  if (input.search) {
    const pattern = new RegExp(escapeRegex(input.search.trim()), "i");
    query.$or = [
      { employee_number: pattern },
      { employee_id: pattern },
      { full_name: pattern },
      { phone: pattern },
    ];
  }

  const [total, employees] = await Promise.all([
    EmployeeRecordModel.countDocuments(query),
    EmployeeRecordModel.find(query)
      .sort({ created_at: -1 })
      .skip(input.skip)
      .limit(input.limit)
      .lean(),
  ]);

  return {
    employees: employees.map((employee) => ({
      employee_id: employee.employee_id,
      employee_number: employee.employee_number,
      full_name: employee.full_name,
      phone: employee.phone,
      email: employee.email ?? null,
      department: employee.department ?? null,
      position: employee.position ?? null,
      status: employee.status,
      user_id: employee.user_id ?? null,
      registered_at: employee.registered_at ?? null,
    })),
    pagination: {
      page: input.page,
      limit: input.limit,
      total,
      pages: Math.max(1, Math.ceil(total / input.limit)),
    },
  };
}

/** Head office sits above administrators, so only the setup script can grant or remove it. */
function assertNotHeadOffice(roleName: string): void {
  if (roleName === ROLES.HEAD_OFFICE) {
    throw ApiError.forbidden("Head office access is granted only by the system owner's setup script");
  }
}

export async function assignUserRole(
  actorId: string,
  userId: string,
  roleName: string,
  context: RequestContext,
): Promise<UserAccess> {
  assertNotHeadOffice(roleName);
  await getTargetUser(userId);
  await assignRoleByName(userId, roleName, actorId);

  await recordAudit({
    event: "role.assigned",
    userId,
    actorId,
    success: true,
    context,
    metadata: { role: roleName, action: "assign" },
  });

  return getUserAccess(userId);
}

export async function removeUserRole(
  actorId: string,
  userId: string,
  roleName: string,
  context: RequestContext,
): Promise<UserAccess> {
  if (userId === actorId && roleName.toLowerCase() === "admin") {
    throw new ApiError(400, "CANNOT_REMOVE_OWN_ADMIN", "You cannot remove your own admin role");
  }

  await getTargetUser(userId);
  assertNotHeadOffice(roleName);
  await removeRoleByName(userId, roleName);

  await recordAudit({
    event: "role.assigned",
    userId,
    actorId,
    success: true,
    context,
    metadata: { role: roleName, action: "remove" },
  });

  return getUserAccess(userId);
}

export interface AuditListFilters {
  event?: string;
  user_id?: string;
  success?: boolean;
  from?: Date;
  to?: Date;
  page: number;
  limit: number;
  skip: number;
}

export async function listAuditLogs(filters: AuditListFilters): Promise<{
  logs: Array<{
    event: string;
    user_id: string | null;
    employee_number: string | null;
    actor_id: string | null;
    success: boolean;
    reason: string | null;
    ip: string | null;
    request_id: string | null;
    metadata: unknown;
    created_at: Date;
  }>;
  pagination: { page: number; limit: number; total: number; pages: number };
}> {
  const query: Record<string, unknown> = {};
  if (filters.event) query.event = filters.event;
  if (filters.user_id) query.user_id = filters.user_id;
  if (filters.success !== undefined) query.success = filters.success;

  if (filters.from || filters.to) {
    query.created_at = {
      ...(filters.from ? { $gte: filters.from } : {}),
      ...(filters.to ? { $lte: filters.to } : {}),
    };
  }

  const [total, logs] = await Promise.all([
    AuditLogModel.countDocuments(query),
    AuditLogModel.find(query)
      .sort({ created_at: -1 })
      .skip(filters.skip)
      .limit(filters.limit)
      .lean(),
  ]);

  return {
    logs: logs.map((log) => ({
      event: log.event,
      user_id: log.user_id ?? null,
      employee_number: log.employee_number ?? null,
      actor_id: log.actor_id ?? null,
      success: log.success,
      reason: log.reason ?? null,
      ip: log.ip ?? null,
      request_id: log.request_id ?? null,
      metadata: log.metadata,
      created_at: log.created_at,
    })),
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total,
      pages: Math.max(1, Math.ceil(total / filters.limit)),
    },
  };
}

export async function getNationalIdImage(
  userId: string,
  side: "front" | "back",
): Promise<{ bytes: Buffer; contentType: string }> {
  const user = await UserModel.findOne({
    user_id: userId,
    deleted_at: null,
  }).select("+FrontID_image +BackID_image");

  if (!user) throw ApiError.notFound("User not found");

  const path = side === "front" ? user.FrontID_image : user.BackID_image;
  if (!path) throw ApiError.notFound("National ID image not found");

  return readStoredFile(path);
}

export async function getProfileImage(
  userId: string,
): Promise<{ bytes: Buffer; contentType: string }> {
  const user = await UserModel.findOne({
    user_id: userId,
    deleted_at: null,
  }).select("+profile_image");

  if (!user) throw ApiError.notFound("User not found");
  if (!user.profile_image) throw ApiError.notFound("Personal photo not found");

  return readStoredFile(user.profile_image);
}

export interface CreateInvestigatorInput {
  full_name: string;
  phone: string;
  national_id_number: string;
  employee_number?: string;
  employee_id?: string;
  email?: string | null;
  password?: string;
  department?: string | null;
  position?: string | null;
}

export interface CreatedInvestigator {
  user: PublicUser;
  employee_record: {
    employee_id: string;
    employee_number: string;
    department: string | null;
    position: string | null;
  };
  temporary_password: string | null;
}

/** Password that always satisfies the shared policy. */
function generateTemporaryPassword(): string {
  return `Gp-${randomToken(12)}9aA`;
}

/**
 * Creates an investigator account directly from the dashboard.
 *
 * The account is immediately active and can sign in with the returned employee
 * number, which is what makes the employee number "recognised" by the mobile
 * app. A matching HR employee record is created in the same step so the number
 * cannot be reused by another registration.
 */
export async function createInvestigator(
  actorId: string,
  input: CreateInvestigatorInput,
  context: RequestContext,
): Promise<CreatedInvestigator> {
  const body = input as unknown as JsonBody;
  const fullName = fullNameField(body);
  const phone = normalisePhone(requiredString(body, "phone", { label: "phone" }));
  const email = optionalEmail(body);
  const nationalId = nationalIdField(body);
  const nationalIdHash = hashNationalId(nationalId);
  const department = optionalString(body, "department", { max: 120, label: "department" });
  const position = optionalString(body, "position", { max: 120, label: "position" });

  const requestedNumber = optionalString(body, "employee_number", {
    min: 3,
    max: 32,
    label: "employee_number",
    pattern: /^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/,
    patternMessage: "employee_number has an invalid format",
  })?.toUpperCase();

  const requestedId = optionalString(body, "employee_id", {
    min: 3,
    max: 32,
    label: "employee_id",
    pattern: /^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/,
    patternMessage: "employee_id has an invalid format",
  })?.toUpperCase();

  const suppliedPassword = optionalString(body, "password", {
    max: 128,
    trim: false,
    label: "password",
  });
  const password = suppliedPassword ? validatePassword(suppliedPassword) : generateTemporaryPassword();

  const [phoneConflict, nationalIdConflict] = await Promise.all([
    UserModel.exists({ phone, deleted_at: null }),
    UserModel.exists({ national_id_hash: nationalIdHash }),
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

  let employeeNumber = requestedNumber;
  if (employeeNumber) {
    const [numberTaken, recordTaken] = await Promise.all([
      UserModel.exists({ employee_number: employeeNumber }),
      EmployeeRecordModel.exists({ employee_number: employeeNumber }),
    ]);
    if (numberTaken || recordTaken) {
      throw new ApiError(409, "EMPLOYEE_NUMBER_TAKEN", "This employee number is already in use", {
        details: { field: "employee_number" },
      });
    }
  } else {
    employeeNumber = await generateEmployeeNumber();
  }

  let employeeId = requestedId;
  if (employeeId) {
    const idTaken = await EmployeeRecordModel.exists({ employee_id: employeeId });
    if (idTaken) {
      throw new ApiError(409, "EMPLOYEE_ID_CONFLICT", "employee_id belongs to another record", {
        details: { field: "employee_id" },
      });
    }
  } else {
    employeeId = `INV-${employeeNumber}`;
    let suffix = 1;
    while (await EmployeeRecordModel.exists({ employee_id: employeeId })) {
      suffix += 1;
      employeeId = `INV-${employeeNumber}-${suffix}`;
    }
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
    phone_verified_at: null,
    email,
    national_id_encrypted: encryptString(nationalId),
    national_id_hash: nationalIdHash,
    national_id_last4: nationalId.slice(-4),
    FrontID_image: "",
    BackID_image: "",
    password_hash: passwordHash,
    password_changed_at: null,
    account_type: "new_investigator",
    status: "active",
    status_reason: null,
    approved_at: now,
    approved_by: actorId,
    biometric_enabled: false,
  });

  await EmployeeRecordModel.create({
    employee_id: employeeId,
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
    imported_by: actorId,
  });

  await assignRoleByName(userId, ROLES.EMPLOYEE, actorId);

  await recordAudit({
    event: "user.created_by_admin",
    userId,
    employeeNumber,
    actorId,
    success: true,
    context,
    metadata: { account_type: "new_investigator", employee_id: employeeId },
  });

  const created = await UserModel.findOne({ user_id: userId }).lean();
  if (!created) throw ApiError.notFound("User not found after creation");

  return {
    user: toPublicUser(created, [ROLES.EMPLOYEE]),
    employee_record: {
      employee_id: employeeId,
      employee_number: employeeNumber,
      department: department ?? null,
      position: position ?? null,
    },
    temporary_password: suppliedPassword ? null : password,
  };
}

export interface OverviewStats {
  users: {
    total: number;
    pending_verification: number;
    pending_approval: number;
    active: number;
    rejected: number;
    suspended: number;
    existing_employee: number;
    new_investigator: number;
  };
  employees: { total: number; available: number; registered: number; inactive: number };
  audit: { total: number; failures: number; today: number };
}

/** Aggregated counters for the dashboard landing page. */
export async function getOverviewStats(): Promise<OverviewStats> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [
    total,
    pendingVerification,
    pendingApproval,
    active,
    rejected,
    suspended,
    existingEmployee,
    newInvestigator,
    employeesTotal,
    employeesAvailable,
    employeesRegistered,
    employeesInactive,
    auditTotal,
    auditFailures,
    auditToday,
  ] = await Promise.all([
    UserModel.countDocuments({ deleted_at: null }),
    UserModel.countDocuments({ status: "pending_verification", deleted_at: null }),
    UserModel.countDocuments({ status: "pending_approval", deleted_at: null }),
    UserModel.countDocuments({ status: "active", deleted_at: null }),
    UserModel.countDocuments({ status: "rejected", deleted_at: null }),
    UserModel.countDocuments({ status: "suspended", deleted_at: null }),
    UserModel.countDocuments({ account_type: "existing_employee", deleted_at: null }),
    UserModel.countDocuments({ account_type: "new_investigator", deleted_at: null }),
    EmployeeRecordModel.countDocuments({}),
    EmployeeRecordModel.countDocuments({ status: "available" }),
    EmployeeRecordModel.countDocuments({ status: "registered" }),
    EmployeeRecordModel.countDocuments({ status: "inactive" }),
    AuditLogModel.countDocuments({}),
    AuditLogModel.countDocuments({ success: false }),
    AuditLogModel.countDocuments({ created_at: { $gte: startOfDay } }),
  ]);

  return {
    users: {
      total,
      pending_verification: pendingVerification,
      pending_approval: pendingApproval,
      active,
      rejected,
      suspended,
      existing_employee: existingEmployee,
      new_investigator: newInvestigator,
    },
    employees: {
      total: employeesTotal,
      available: employeesAvailable,
      registered: employeesRegistered,
      inactive: employeesInactive,
    },
    audit: { total: auditTotal, failures: auditFailures, today: auditToday },
  };
}
