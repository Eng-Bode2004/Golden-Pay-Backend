import type { RequestContext } from "../Utils/http.ts";
import {
  ApiError,
  created,
  noContent,
  ok,
  readJson,
  readOptionalJson,
} from "../Utils/http.ts";
import type { AuthContext } from "../MIddlewares/auth.middleware.ts";
import {
  approveUser,
  assignUserRole,
  createInvestigator,
  getNationalIdImage,
  getOverviewStats,
  getProfileImage,
  getUserDetail,
  importEmployees,
  listAuditLogs,
  listEmployeeRecords,
  listUsers,
  reactivateUser,
  rejectUser,
  removeUserRole,
  suspendUser,
} from "../Services/admin.service.ts";
import { listRoles } from "../Services/rbac.service.ts";
import {
  parsePagination,
  requiredString,
  optionalString,
} from "../Utils/validation.ts";
import { ACCOUNT_STATUSES, ACCOUNT_TYPES } from "../Models/UserSchema.ts";

function optionalQuery(url: URL, key: string, max = 120): string | undefined {
  const value = url.searchParams.get(key)?.trim();
  if (!value) return undefined;
  if (value.length > max) throw ApiError.badRequest(`${key} is too long`);
  return value;
}

export async function listUsersController(context: RequestContext): Promise<Response> {
  const pagination = parsePagination(context.url);
  const status = optionalQuery(context.url, "status", 32);
  const accountType = optionalQuery(context.url, "account_type", 32);
  const search = optionalQuery(context.url, "search", 100);

  // "pending" is a filter alias covering every account waiting for an administrator.
  if (
    status &&
    status !== "pending" &&
    !ACCOUNT_STATUSES.includes(status as (typeof ACCOUNT_STATUSES)[number])
  ) {
    throw ApiError.badRequest(`status must be pending or one of: ${ACCOUNT_STATUSES.join(", ")}`);
  }
  if (
    accountType &&
    !ACCOUNT_TYPES.includes(accountType as (typeof ACCOUNT_TYPES)[number])
  ) {
    throw ApiError.badRequest(`account_type must be one of: ${ACCOUNT_TYPES.join(", ")}`);
  }

  const result = await listUsers({
    status,
    account_type: accountType,
    search,
    ...pagination,
  });

  return ok(result);
}

export async function overviewStatsController(): Promise<Response> {
  return ok(await getOverviewStats());
}

export async function createInvestigatorController(
  context: RequestContext,
  auth: AuthContext,
): Promise<Response> {
  const body = await readJson(context.req);
  const createdInvestigator = await createInvestigator(
    auth.user.user_id,
    {
      full_name: requiredString(body, "full_name", { min: 3, max: 120, label: "full_name" }),
      phone: requiredString(body, "phone", { max: 20, label: "phone" }),
      national_id_number: requiredString(body, "national_id_number", {
        max: 20,
        label: "national_id_number",
      }),
      employee_number: optionalString(body, "employee_number", { max: 32, label: "employee_number" }),
      employee_id: optionalString(body, "employee_id", { max: 32, label: "employee_id" }),
      email: optionalString(body, "email", { max: 254, label: "email" }),
      password: optionalString(body, "password", { max: 128, label: "password", trim: false }),
      department: optionalString(body, "department", { max: 120, label: "department" }),
      position: optionalString(body, "position", { max: 120, label: "position" }),
    },
    context,
  );

  return created(createdInvestigator);
}
export async function getUserDetailController(
  context: RequestContext,
): Promise<Response> {
  const userId = context.params.user_id;
  const result = await getUserDetail(userId ?? "");
  return ok(result);
}

export async function approveUserController(
  context: RequestContext,
  auth: AuthContext,
): Promise<Response> {
  const user = await approveUser(auth.user.user_id, context.params.user_id ?? "", context);
  return ok({ user });
}

export async function rejectUserController(
  context: RequestContext,
  auth: AuthContext,
): Promise<Response> {
  const body = await readOptionalJson(context.req);
  const reason = optionalString(body, "reason", { max: 500, label: "reason" });
  const user = await rejectUser(
    auth.user.user_id,
    context.params.user_id ?? "",
    reason,
    context,
  );
  return ok({ user });
}

export async function suspendUserController(
  context: RequestContext,
  auth: AuthContext,
): Promise<Response> {
  const body = await readOptionalJson(context.req);
  const reason = optionalString(body, "reason", { max: 500, label: "reason" });
  const user = await suspendUser(
    auth.user.user_id,
    context.params.user_id ?? "",
    reason,
    context,
  );
  return ok({ user });
}

export async function reactivateUserController(
  context: RequestContext,
  auth: AuthContext,
): Promise<Response> {
  const user = await reactivateUser(auth.user.user_id, context.params.user_id ?? "", context);
  return ok({ user });
}

export async function importEmployeesController(
  context: RequestContext,
  auth: AuthContext,
): Promise<Response> {
  const body = await readJson(context.req);
  const employees = body.employees;

  if (!Array.isArray(employees)) {
    throw ApiError.badRequest("employees must be an array", {
      field: "employees",
      message: "employees must be an array",
    });
  }

  const result = await importEmployees(auth.user.user_id, employees, context);
  return created(result);
}

export async function listEmployeeRecordsController(
  context: RequestContext,
): Promise<Response> {
  const pagination = parsePagination(context.url);
  const status = optionalQuery(context.url, "status", 32);
  const search = optionalQuery(context.url, "search", 100);

  if (status && !["available", "registered", "inactive"].includes(status)) {
    throw ApiError.badRequest("status must be one of: available, registered, inactive");
  }

  const result = await listEmployeeRecords({ status, search, ...pagination });
  return ok(result);
}

export async function listRolesController(): Promise<Response> {
  return ok({ roles: await listRoles() });
}

export async function assignRoleController(
  context: RequestContext,
  auth: AuthContext,
): Promise<Response> {
  const body = await readJson(context.req);
  const role = requiredString(body, "role", {
    min: 2,
    max: 64,
    label: "role",
    pattern: /^[a-z][a-z0-9_-]{1,63}$/,
    patternMessage: "role has an invalid format",
  });

  const access = await assignUserRole(
    auth.user.user_id,
    context.params.user_id ?? "",
    role,
    context,
  );

  return ok({ user_id: context.params.user_id, roles: access.roles, permissions: access.permissions });
}

export async function removeRoleController(
  context: RequestContext,
  auth: AuthContext,
): Promise<Response> {
  const body = await readJson(context.req);
  const role = requiredString(body, "role", {
    min: 2,
    max: 64,
    label: "role",
    pattern: /^[a-z][a-z0-9_-]{1,63}$/,
    patternMessage: "role has an invalid format",
  });

  const access = await removeUserRole(
    auth.user.user_id,
    context.params.user_id ?? "",
    role,
    context,
  );

  return ok({ user_id: context.params.user_id, roles: access.roles, permissions: access.permissions });
}

export async function auditLogsController(context: RequestContext): Promise<Response> {
  const pagination = parsePagination(context.url);
  const event = optionalQuery(context.url, "event", 64);
  const userId = optionalQuery(context.url, "user_id", 64);
  const success = optionalQuery(context.url, "success", 8);

  if (success !== undefined && success !== "true" && success !== "false") {
    throw ApiError.badRequest("success must be true or false");
  }

  const from = optionalQuery(context.url, "from", 40);
  const to = optionalQuery(context.url, "to", 40);

  const parseDate = (value: string | undefined, field: string): Date | undefined => {
    if (!value) return undefined;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw ApiError.badRequest(`${field} must be a valid date`);
    return date;
  };

  const result = await listAuditLogs({
    event,
    user_id: userId,
    success: success === undefined ? undefined : success === "true",
    from: parseDate(from, "from"),
    to: parseDate(to, "to"),
    ...pagination,
  });

  return ok(result);
}

export async function nationalIdImageController(
  context: RequestContext,
): Promise<Response> {
  const side = context.params.side;
  if (side !== "front" && side !== "back") {
    throw ApiError.badRequest("side must be front or back");
  }

  const { bytes, contentType } = await getNationalIdImage(
    context.params.user_id ?? "",
    side,
  );

  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `inline; filename="national-id-${side}"`,
      "Cache-Control": "no-store",
    },
  });
}

export async function profileImageController(context: RequestContext): Promise<Response> {
  const { bytes, contentType } = await getProfileImage(context.params.user_id ?? "");

  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": 'inline; filename="personal-photo"',
      "Cache-Control": "no-store",
    },
  });
}
