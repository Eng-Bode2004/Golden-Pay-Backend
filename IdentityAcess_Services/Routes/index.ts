import { Router } from "../Utils/router.ts";
import { registerAuthRoutes } from "./auth.routes.ts";
import { registerUserRoutes } from "./user.routes.ts";
import { registerAdminRoutes } from "./admin.routes.ts";
import { registerAdminSecurityRoutes } from "./admin-security.routes.ts";

export function createRouter(): Router {
  const router = new Router();
  registerAuthRoutes(router);
  registerUserRoutes(router);
  registerAdminRoutes(router);
  registerAdminSecurityRoutes(router);
  return router;
}
