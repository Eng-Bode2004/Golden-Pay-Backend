import type { RequestContext } from "../Utils/http.ts";
import { ApiError } from "../Utils/http.ts";
import type { Middleware, RouteHandler } from "../Utils/router.ts";
import { extractBearerToken, verifyAccessToken } from "../Utils/jwt.ts";
import { getActiveSession } from "../Services/session.service.ts";
import { findActiveUser } from "../Services/user.service.ts";
import { assertAccountActive } from "../Services/auth.service.ts";
import { getUserAccess, hasPermission, type UserAccess } from "../Services/rbac.service.ts";
import type { User } from "../Models/UserSchema.ts";

export interface AuthContext {
  user: User;
  access: UserAccess;
  sessionId: string;
  authMethod: "password" | "biometric" | "google";
}

export async function authenticate(req: Request): Promise<AuthContext> {
  const token = extractBearerToken(req);
  if (!token) {
    throw new ApiError(401, "UNAUTHORIZED", "Authentication is required", {
      headers: { "WWW-Authenticate": "Bearer" },
    });
  }

  const claims = verifyAccessToken(token);
  const session = await getActiveSession(claims.sid, claims.sub);
  const user = await findActiveUser(claims.sub);

  if (!user) {
    throw new ApiError(401, "UNAUTHORIZED", "Session is no longer valid", {
      headers: { "WWW-Authenticate": "Bearer" },
    });
  }

  assertAccountActive(user);

  const access = await getUserAccess(user.user_id);

  return {
    user,
    access,
    sessionId: session.session_id,
    authMethod: claims.amr,
  };
}

export function withAuth(
  handler: (context: RequestContext, auth: AuthContext) => Promise<Response> | Response,
): RouteHandler {
  return async (context) => {
    const auth = await authenticate(context.req);
    return handler(context, auth);
  };
}

export function withAnyPermission(
  permissions: string[],
  handler: (context: RequestContext, auth: AuthContext) => Promise<Response> | Response,
): RouteHandler {
  return async (context) => {
    const auth = await authenticate(context.req);
    const allowed = permissions.some((permission) => hasPermission(auth.access, permission));

    if (!allowed) {
      throw ApiError.forbidden("You do not have permission to perform this action");
    }

    return handler(context, auth);
  };
}

export function withPermission(
  permission: string,
  handler: (context: RequestContext, auth: AuthContext) => Promise<Response> | Response,
): RouteHandler {
  return withAnyPermission([permission], handler);
}

export type { Middleware };
