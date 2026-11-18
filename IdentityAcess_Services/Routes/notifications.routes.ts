// The signed-in person's notifications (the app's bell and list) and the phones that receive
// them as push notifications.
import { listNotifications, markRead, pushStatus, removePushToken, savePushToken } from "../../Shared/notifications.ts";
import { type AuthContext, withAuth, withPermission } from "../MIddlewares/auth.middleware.ts";
import { PERMISSIONS } from "../Services/rbac.service.ts";
import { ApiError, ok, readJson, readOptionalJson, type RequestContext } from "../Utils/http.ts";
import type { Router } from "../Utils/router.ts";

const TOKEN = /^[A-Za-z0-9_:\-.]{20,4096}$/;

export function registerNotificationRoutes(router: Router): void {
  router.get(
    "/notifications",
    withAuth(async (context: RequestContext, auth: AuthContext) => {
      const after = Number(context.url.searchParams.get("after") ?? 0) || 0;
      const limit = Number(context.url.searchParams.get("limit") ?? 50) || 50;
      return ok(await listNotifications(auth.user.user_id, after, limit));
    }),
  );

  /** Marks some notifications (ids) or all of them as read. */
  router.post(
    "/notifications/read",
    withAuth(async (context: RequestContext, auth: AuthContext) => {
      const body = await readOptionalJson(context.req);
      const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isInteger).slice(0, 500) : null;
      if (body.all !== true && !ids?.length) throw ApiError.badRequest("Send ids or all: true");
      return ok({ read: await markRead(auth.user.user_id, body.all === true ? "all" : ids!) });
    }),
  );

  /** The app registers its Firebase token so notifications reach the phone when it is closed. */
  router.post(
    "/notifications/push-token",
    withAuth(async (context: RequestContext, auth: AuthContext) => {
      const body = await readJson(context.req);
      const token = typeof body.token === "string" ? body.token.trim() : "";
      if (!TOKEN.test(token)) throw ApiError.badRequest("token is invalid", { field: "token" });
      const platform = typeof body.platform === "string" ? body.platform.slice(0, 20) : null;
      const device = typeof body.device_id === "string" ? body.device_id.slice(0, 200) : null;
      await savePushToken(auth.user.user_id, token, platform, device);
      return ok({ saved: true });
    }),
  );
  router.delete(
    "/notifications/push-token",
    withAuth(async (context: RequestContext, auth: AuthContext) => {
      const body = await readOptionalJson(context.req);
      await removePushToken(auth.user.user_id, typeof body.token === "string" ? body.token : null);
      return ok({ removed: true });
    }),
  );

  /** Whether push is set up on the server, and how many phones can receive it. */
  router.get(
    "/admin/notifications/status",
    withPermission(PERMISSIONS.USERS_READ, async () => ok({ push: await pushStatus() })),
  );
}
