import { Router } from "../Utils/router.ts";
import { withAuth } from "../MIddlewares/auth.middleware.ts";
import {
  listSessionsController,
  meController,
  revokeSessionController,
  updateProfileController,
} from "../Controllers/user.controller.ts";

export function registerUserRoutes(router: Router): void {
  router.get("/users/me", withAuth(meController));
  router.patch("/users/me", withAuth(updateProfileController));
  router.get("/users/me/sessions", withAuth(listSessionsController));
  router.delete("/users/me/sessions/:session_id", withAuth(revokeSessionController));
}
