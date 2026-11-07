import RoleModel from "../Models/RoleSchema.ts";
import PermissionModel from "../Models/PermissionSchema.ts";
import RolePermissionModel from "../Models/RolePermissionSchema.ts";
import UserRoleModel from "../Models/UserRolesSchema.ts";
import { newId } from "../Utils/crypto.ts";
import { ApiError } from "../Utils/http.ts";
import { logger } from "../Utils/logger.ts";

export const PERMISSIONS = {
  USERS_READ: "users:read",
  USERS_APPROVE: "users:approve",
  USERS_MANAGE: "users:manage",
  EMPLOYEES_IMPORT: "employees:import",
  ROLES_MANAGE: "roles:manage",
  AUDIT_READ: "audit:read",
  FORMS_MANAGE: "forms:manage",
  INVESTIGATIONS_MANAGE: "investigations:manage",
  FINANCE_MANAGE: "finance:manage",
  HEADOFFICE_MANAGE: "headoffice:manage",
  TEMPLATES_MANAGE: "templates:manage",
  TEMPLATES_APPROVE: "templates:approve",
} as const;

/** Head office permissions: administrators never hold them through the admin role. */
const HEAD_OFFICE_ONLY: string[] = ["headoffice:manage", "templates:manage", "templates:approve"];

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ROLES = {
  ADMIN: "admin",
  HR: "hr",
  EMPLOYEE: "employee",
  HEAD_OFFICE: "head_office",
} as const;

export type RoleName = (typeof ROLES)[keyof typeof ROLES];

const PERMISSION_DEFINITIONS: Array<{ code: PermissionCode; description: string }> = [
  { code: PERMISSIONS.USERS_READ, description: "View employee accounts" },
  { code: PERMISSIONS.USERS_APPROVE, description: "Approve, reject, suspend and reactivate accounts" },
  { code: PERMISSIONS.USERS_MANAGE, description: "Manage employee accounts and roles" },
  { code: PERMISSIONS.EMPLOYEES_IMPORT, description: "Import existing employees from HR data" },
  { code: PERMISSIONS.ROLES_MANAGE, description: "Assign roles to users" },
  { code: PERMISSIONS.AUDIT_READ, description: "Read authentication audit logs" },
  { code: PERMISSIONS.FORMS_MANAGE, description: "Edit investigation form templates" },
  { code: PERMISSIONS.INVESTIGATIONS_MANAGE, description: "Send, review and export investigations" },
  { code: PERMISSIONS.FINANCE_MANAGE, description: "Set prices and view earnings" },
  { code: PERMISSIONS.HEADOFFICE_MANAGE, description: "Head office: attendance, points, salaries, expenses and complaints" },
  { code: PERMISSIONS.TEMPLATES_MANAGE, description: "Upload, map and version client report templates" },
  { code: PERMISSIONS.TEMPLATES_APPROVE, description: "Review, approve and activate client report templates" },
];

const ROLE_DEFINITIONS: Array<{ name: RoleName; description: string; permissions: PermissionCode[] }> = [
  {
    name: ROLES.ADMIN,
    description: "Full administrative access",
    // Head office oversees administrators, so its permission is never part of admin.
    permissions: Object.values(PERMISSIONS).filter((code) => !HEAD_OFFICE_ONLY.includes(code)),
  },
  {
    name: ROLES.HEAD_OFFICE,
    description: "Head office: salaries, attendance, points and business results",
    permissions: [PERMISSIONS.HEADOFFICE_MANAGE, PERMISSIONS.TEMPLATES_MANAGE, PERMISSIONS.TEMPLATES_APPROVE],
  },
  {
    name: ROLES.HR,
    description: "Human resources reviewer",
    permissions: [
      PERMISSIONS.USERS_READ,
      PERMISSIONS.USERS_APPROVE,
      PERMISSIONS.EMPLOYEES_IMPORT,
      PERMISSIONS.AUDIT_READ,
      PERMISSIONS.INVESTIGATIONS_MANAGE,
    ],
  },
  {
    name: ROLES.EMPLOYEE,
    description: "Regular employee / investigator",
    permissions: [],
  },
];

export interface UserAccess {
  roles: string[];
  permissions: string[];
}

/** Idempotently creates the system roles/permissions and their links. */
export async function seedRbac(): Promise<void> {
  const permissionIds = new Map<string, string>();

  for (const definition of PERMISSION_DEFINITIONS) {
    const permission = await PermissionModel.findOneAndUpdate(
      { code: definition.code },
      {
        $set: { description: definition.description },
        $setOnInsert: { permission_id: newId(), code: definition.code },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    permissionIds.set(definition.code, permission.permission_id);
  }

  const roleIds = new Map<string, string>();

  for (const definition of ROLE_DEFINITIONS) {
    const role = await RoleModel.findOneAndUpdate(
      { name: definition.name },
      {
        $set: { description: definition.description, is_system: true },
        $setOnInsert: { role_id: newId(), name: definition.name },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    roleIds.set(definition.name, role.role_id);
  }

  for (const definition of ROLE_DEFINITIONS) {
    const roleId = roleIds.get(definition.name);
    if (!roleId) continue;

    for (const code of definition.permissions) {
      const permissionId = permissionIds.get(code);
      if (!permissionId) continue;

      await RolePermissionModel.updateOne(
        { role_id: roleId, permission_id: permissionId },
        { $setOnInsert: { role_id: roleId, permission_id: permissionId } },
        { upsert: true },
      );
    }
  }

  logger.info("rbac.seeded", {
    roles: ROLE_DEFINITIONS.length,
    permissions: PERMISSION_DEFINITIONS.length,
  });
}

export async function getUserAccess(userId: string): Promise<UserAccess> {
  const userRoles = await UserRoleModel.find({ user_id: userId }).lean();
  const roleIds = userRoles.map((userRole) => userRole.role_id);
  if (roleIds.length === 0) return { roles: [], permissions: [] };

  const roles = await RoleModel.find({ role_id: { $in: roleIds } }).lean();
  const roleNames = roles.map((role) => role.name);

  if (roleNames.includes(ROLES.ADMIN)) {
    // Admins hold everything except head office, which oversees them.
    return {
      roles: roleNames,
      permissions: Object.values(PERMISSIONS).filter(
        (code) => !HEAD_OFFICE_ONLY.includes(code) || roleNames.includes(ROLES.HEAD_OFFICE),
      ),
    };
  }

  const links = await RolePermissionModel.find({
    role_id: { $in: roles.map((role) => role.role_id) },
  }).lean();
  const permissionIds = [...new Set(links.map((link) => link.permission_id))];

  const permissions =
    permissionIds.length === 0
      ? []
      : (await PermissionModel.find({ permission_id: { $in: permissionIds } }).lean()).map(
          (permission) => permission.code,
        );

  return { roles: roleNames, permissions };
}

export function hasPermission(access: UserAccess, permission: string): boolean {
  if (access.roles.includes(ROLES.ADMIN) && !HEAD_OFFICE_ONLY.includes(permission)) return true;
  return access.permissions.includes(permission);
}

export async function assignRoleByName(
  userId: string,
  roleName: string,
  assignedBy: string | null = null,
): Promise<void> {
  const role = await RoleModel.findOne({ name: roleName.toLowerCase() }).lean();
  if (!role) {
    throw ApiError.badRequest(`Unknown role: ${roleName}`, {
      field: "role",
      message: `Unknown role: ${roleName}`,
    });
  }

  await UserRoleModel.updateOne(
    { user_id: userId, role_id: role.role_id },
    {
      $setOnInsert: {
        user_id: userId,
        role_id: role.role_id,
        assigned_by: assignedBy,
      },
    },
    { upsert: true },
  );
}

export async function removeRoleByName(userId: string, roleName: string): Promise<void> {
  const role = await RoleModel.findOne({ name: roleName.toLowerCase() }).lean();
  if (!role) throw ApiError.notFound(`Unknown role: ${roleName}`);
  await UserRoleModel.deleteOne({ user_id: userId, role_id: role.role_id });
}

export async function listRoles(): Promise<Array<{ name: string; description: string | null }>> {
  const roles = await RoleModel.find({}).sort({ name: 1 }).lean();
  return roles.map((role) => ({ name: role.name, description: role.description ?? null }));
}
