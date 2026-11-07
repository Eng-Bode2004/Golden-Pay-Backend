import type { RequestContext } from "../Utils/http.ts";
import { noContent, ok, readJson } from "../Utils/http.ts";
import type { AuthContext } from "../MIddlewares/auth.middleware.ts";
import {
  listUserSessions,
  revokeUserSession,
  toPublicUser,
  updateProfile,
} from "../Services/user.service.ts";

export async function meController(
  _context: RequestContext,
  auth: AuthContext,
): Promise<Response> {
  return ok({ user: toPublicUser(auth.user, auth.access.roles), permissions: auth.access.permissions });
}

export async function updateProfileController(
  context: RequestContext,
  auth: AuthContext,
): Promise<Response> {
  const body = await readJson(context.req);
  const user = await updateProfile({
    userId: auth.user.user_id,
    body,
    context,
  });
  return ok({ user });
}

export async function listSessionsController(
  _context: RequestContext,
  auth: AuthContext,
): Promise<Response> {
  const sessions = await listUserSessions(auth.user.user_id, auth.sessionId);
  return ok({ sessions });
}

export async function revokeSessionController(
  context: RequestContext,
  auth: AuthContext,
): Promise<Response> {
  const sessionId = context.params.session_id;
  await revokeUserSession(
    auth.user.user_id,
    sessionId ?? "",
    auth.sessionId,
    context,
  );
  return noContent();
}
