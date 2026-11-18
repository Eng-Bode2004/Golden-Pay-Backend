// Admin clean-ups that cannot be undone: deleting an investigator with all their data, and
// clearing test data (every investigation, investigators' points and money). Each asks for
// the administrator's password again; the full reset is for the primary administrator only.
import { deleteInvestigator, previewTestDataReset, resetTestData } from "../../Shared/cleanup.ts";
import { type AuthContext, withPermission } from "../MIddlewares/auth.middleware.ts";
import { byIp, rateLimit, RATE_LIMITS } from "../MIddlewares/rateLimit.middleware.ts";
import { query } from "../Config/db.ts";
import UserModel from "../Models/UserSchema.ts";
import { deviceOf, resetDevice } from "../Services/device-lock.service.ts";
import { requireOwner } from "../Services/admin-security.service.ts";
import { recordAudit } from "../Services/audit.service.ts";
import { PERMISSIONS } from "../Services/rbac.service.ts";
import { ApiError, ok, readJson, type RequestContext } from "../Utils/http.ts";
import type { Router } from "../Utils/router.ts";

/** The administrator types their password again before anything is deleted. */
async function confirmPassword(auth: AuthContext, body: Record<string, unknown>): Promise<void> {
  const password = typeof body.password === "string" ? body.password : "";
  const account = await UserModel.findOne({ user_id: auth.user.user_id }).select("+password_hash");
  if (!password || !account || !(await Bun.password.verify(password, account.password_hash))) {
    throw new ApiError(403, "INVALID_CREDENTIALS", "Confirm your password to continue");
  }
}

/** The word the administrator types to confirm the full reset. */
export const RESET_CONFIRMATION = "حذف بيانات الاختبار";

export function registerCleanupRoutes(router: Router): void {
  const limit = rateLimit("admin.cleanup", RATE_LIMITS.adminWrite, byIp);

  router.delete(
    "/admin/users/:user_id",
    limit(
      withPermission(PERMISSIONS.USERS_MANAGE, async (context: RequestContext, auth: AuthContext) => {
        const userId = context.params.user_id ?? "";
        if (userId === auth.user.user_id) throw ApiError.badRequest("You cannot delete your own account");
        const body = await readJson(context.req);
        await confirmPassword(auth, body);
        const result = await deleteInvestigator(userId, { deleteReports: body.delete_reports === true });
        await recordAudit({
          event: "admin.investigator.deleted",
          userId: auth.user.user_id,
          employeeNumber: auth.user.employee_number ?? null,
          success: true,
          context,
          metadata: result as unknown as Record<string, unknown>,
        });
        return ok({ deleted: result });
      }),
    ),
  );

  router.get(
    "/admin/maintenance/test-data",
    withPermission(PERMISSIONS.USERS_MANAGE, async () => ok({ will_remove: await previewTestDataReset(), confirm_with: RESET_CONFIRMATION })),
  );

  router.post(
    "/admin/maintenance/test-data/reset",
    limit(
      withPermission(PERMISSIONS.USERS_MANAGE, async (context: RequestContext, auth: AuthContext) => {
        await requireOwner(auth.user.user_id);
        const body = await readJson(context.req);
        if (String(body.confirm ?? "").trim() !== RESET_CONFIRMATION) {
          throw ApiError.badRequest(`Type «${RESET_CONFIRMATION}» to confirm`);
        }
        await confirmPassword(auth, body);
        const result = await resetTestData(auth.user.user_id);
        await recordAudit({
          event: "admin.test_data.reset",
          userId: auth.user.user_id,
          employeeNumber: auth.user.employee_number ?? null,
          success: true,
          context,
          metadata: result as unknown as Record<string, unknown>,
        });
        return ok({ removed: result });
      }),
    ),
  );

  /** The investigator's registered phone (or null), for the admin's investigator page. */
  router.get(
    "/admin/users/:user_id/device",
    withPermission(PERMISSIONS.USERS_READ, async (context: RequestContext) =>
      ok({ device: await deviceOf(context.params.user_id ?? "") }),
    ),
  );

  /** A new or repaired phone: forget the old one; the next sign-in registers the new phone. */
  router.post(
    "/admin/users/:user_id/device/reset",
    limit(
      withPermission(PERMISSIONS.USERS_MANAGE, async (context: RequestContext, auth: AuthContext) => {
        const userId = context.params.user_id ?? "";
        const [user] = await query("SELECT 1 FROM users WHERE user_id = $1 AND deleted_at IS NULL", [userId]);
        if (!user) throw ApiError.notFound("Investigator not found");
        const previous = await deviceOf(userId);
        const reset = await resetDevice(userId);
        await recordAudit({
          event: "admin.investigator.device_reset",
          userId: auth.user.user_id,
          employeeNumber: auth.user.employee_number ?? null,
          success: true,
          context,
          metadata: { investigator_id: userId, previous_device: previous?.device_name ?? null },
        });
        return ok({ reset });
      }),
    ),
  );
}
