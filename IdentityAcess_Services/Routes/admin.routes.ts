import { Router } from "../Utils/router.ts";
import { withPermission } from "../MIddlewares/auth.middleware.ts";
import { byIp, rateLimit, RATE_LIMITS } from "../MIddlewares/rateLimit.middleware.ts";
import { PERMISSIONS } from "../Services/rbac.service.ts";
import {
  approveUserController,
  assignRoleController,
  auditLogsController,
  createInvestigatorController,
  getUserDetailController,
  importEmployeesController,
  listEmployeeRecordsController,
  listRolesController,
  listUsersController,
  nationalIdImageController,
  overviewStatsController,
  profileImageController,
  reactivateUserController,
  rejectUserController,
  removeRoleController,
  suspendUserController,
} from "../Controllers/admin.controller.ts";

export function registerAdminRoutes(router: Router): void {
  router.get("/admin/users", withPermission(PERMISSIONS.USERS_READ, listUsersController));
  router.get(
    "/admin/stats",
    withPermission(PERMISSIONS.USERS_READ, overviewStatsController),
  );
  router.get(
    "/admin/users/:user_id",
    withPermission(PERMISSIONS.USERS_READ, getUserDetailController),
  );
  router.get(
    "/admin/users/:user_id/national-id/:side",
    withPermission(PERMISSIONS.USERS_READ, nationalIdImageController),
  );
  router.get(
    "/admin/users/:user_id/photo",
    withPermission(PERMISSIONS.USERS_READ, profileImageController),
  );

  const adminWriteLimit = rateLimit("admin.write", RATE_LIMITS.adminWrite, byIp);

  router.post(
    "/admin/investigators",
    adminWriteLimit(withPermission(PERMISSIONS.USERS_MANAGE, createInvestigatorController)),
  );
  router.post(
    "/admin/users/:user_id/approve",
    adminWriteLimit(withPermission(PERMISSIONS.USERS_APPROVE, approveUserController)),
  );
  router.post(
    "/admin/users/:user_id/reject",
    adminWriteLimit(withPermission(PERMISSIONS.USERS_APPROVE, rejectUserController)),
  );
  router.post(
    "/admin/users/:user_id/suspend",
    adminWriteLimit(withPermission(PERMISSIONS.USERS_MANAGE, suspendUserController)),
  );
  router.post(
    "/admin/users/:user_id/reactivate",
    adminWriteLimit(withPermission(PERMISSIONS.USERS_MANAGE, reactivateUserController)),
  );

  router.post(
    "/admin/users/:user_id/roles",
    adminWriteLimit(withPermission(PERMISSIONS.ROLES_MANAGE, assignRoleController)),
  );
  router.delete(
    "/admin/users/:user_id/roles",
    adminWriteLimit(withPermission(PERMISSIONS.ROLES_MANAGE, removeRoleController)),
  );

  router.get(
    "/admin/roles",
    withPermission(PERMISSIONS.USERS_READ, listRolesController),
  );
  router.get(
    "/admin/employees",
    withPermission(PERMISSIONS.EMPLOYEES_IMPORT, listEmployeeRecordsController),
  );
  router.post(
    "/admin/employees/import",
    adminWriteLimit(
      withPermission(PERMISSIONS.EMPLOYEES_IMPORT, importEmployeesController),
    ),
  );

  router.get(
    "/admin/audit-logs",
    withPermission(PERMISSIONS.AUDIT_READ, auditLogsController),
  );
}
