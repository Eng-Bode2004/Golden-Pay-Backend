import { query } from "../Config/db.ts";
import { env } from "../Config/env.ts";
import UserModel, { type User } from "../Models/UserSchema.ts";
import { ApiError, type RequestContext } from "../Utils/http.ts";
import { logger } from "../Utils/logger.ts";
import { beginMfa } from "./admin-security.service.ts";
import { recordAudit } from "./audit.service.ts";
import { assertAccountActive, type AuthResult } from "./auth.service.ts";
import { getUserAccess } from "./rbac.service.ts";
import { createSession, type DeviceMetadata } from "./session.service.ts";
import { toPublicUser } from "./user.service.ts";

/**
 * Sign in with Google. The app signs in with Google and sends the ID token; we ask Google
 * whether the token is genuine and was issued to one of our client IDs, then match it to an
 * account by the Google ID linked earlier, or by the same verified email address.
 */

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string | null;
  picture: string | null;
}

export function googleConfigured(): boolean {
  return env.googleClientIds.length > 0;
}

export async function verifyGoogleToken(idToken: unknown): Promise<GoogleIdentity> {
  if (!googleConfigured()) {
    throw new ApiError(503, "GOOGLE_NOT_CONFIGURED", "Google sign-in is not set up on this server");
  }
  if (typeof idToken !== "string" || idToken.length < 100 || idToken.length > 4096) {
    throw ApiError.badRequest("A Google ID token is required", { field: "id_token" });
  }
  let claims: Record<string, string>;
  try {
    const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new ApiError(401, "GOOGLE_TOKEN_INVALID", "Google did not accept this sign-in");
    claims = (await response.json()) as Record<string, string>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.warn("google.verify_unreachable", { error: error instanceof Error ? error.message : String(error) });
    throw new ApiError(503, "GOOGLE_UNREACHABLE", "Could not reach Google to verify the sign-in");
  }
  const issuerOk = claims.iss === "accounts.google.com" || claims.iss === "https://accounts.google.com";
  const audienceOk = env.googleClientIds.includes(claims.aud ?? "");
  const fresh = Number(claims.exp ?? 0) * 1000 > Date.now();
  if (!issuerOk || !audienceOk || !fresh || !claims.sub) {
    throw new ApiError(401, "GOOGLE_TOKEN_INVALID", "Google did not accept this sign-in");
  }
  if (claims.email_verified !== "true" || !claims.email) {
    throw new ApiError(401, "GOOGLE_EMAIL_UNVERIFIED", "This Google account's email address is not verified");
  }
  return { sub: claims.sub, email: claims.email.toLowerCase(), name: claims.name ?? null, picture: claims.picture ?? null };
}

async function accountFor(identity: GoogleIdentity): Promise<User | null> {
  const [linked] = await query("SELECT user_id FROM users WHERE google_sub = $1 AND deleted_at IS NULL", [identity.sub]);
  if (linked) return UserModel.findOne({ user_id: linked.user_id as string, deleted_at: null });
  const byEmail = await UserModel.findOne({ email: identity.email, deleted_at: null });
  return byEmail ?? null;
}

/** Links a Google account to a user; refuses if it already belongs to someone else. */
export async function linkGoogle(userId: string, identity: GoogleIdentity): Promise<void> {
  const [owner] = await query("SELECT user_id FROM users WHERE google_sub = $1", [identity.sub]);
  if (owner && owner.user_id !== userId) {
    throw new ApiError(409, "GOOGLE_ALREADY_LINKED", "This Google account is already linked to another account");
  }
  await query("UPDATE users SET google_sub = $1, updated_at = now() WHERE user_id = $2", [identity.sub, userId]);
}

/** Before a sign-up: the Google account must not already belong to an account. */
export async function assertGoogleUnused(identity: GoogleIdentity): Promise<void> {
  if (await accountFor(identity)) {
    throw new ApiError(409, "ACCOUNT_ALREADY_EXISTS", "An account already uses this Google account. Sign in instead.", {
      details: { field: "email" },
    });
  }
}

export async function loginWithGoogle(
  idToken: unknown,
  device: DeviceMetadata,
  context: RequestContext,
): Promise<AuthResult> {
  const identity = await verifyGoogleToken(idToken);
  const user = await accountFor(identity);
  if (!user) {
    // No account yet: the app opens sign-up with the name and email already filled in.
    throw new ApiError(404, "GOOGLE_ACCOUNT_NOT_FOUND", "No Golden Pay account uses this Google account yet", {
      details: { email: identity.email, full_name: identity.name ?? "" },
    });
  }
  assertAccountActive(user);
  if (user.deleted_at) throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid employee credentials");

  // First Google sign-in by email: remember the Google ID so a later email change still works.
  await linkGoogle(user.user_id, identity);

  const mfa = await beginMfa(user.user_id, user.email ?? user.employee_number ?? user.user_id);
  if (mfa) throw new ApiError(403, "MFA_REQUIRED", "Authenticator verification required", { details: mfa });

  await UserModel.updateOne({ user_id: user.user_id }, { $set: { last_login_at: new Date(), failed_login_attempts: 0, locked_until: null } });
  const tokens = await createSession(user, "google", device);
  const access = await getUserAccess(user.user_id);
  await recordAudit({
    event: "auth.login.google",
    userId: user.user_id,
    employeeNumber: user.employee_number ?? null,
    success: true,
    context,
    metadata: { auth_method: "google", session_id: tokens.session.session_id },
  });
  return { ...tokens, user: toPublicUser(user, access.roles) };
}
