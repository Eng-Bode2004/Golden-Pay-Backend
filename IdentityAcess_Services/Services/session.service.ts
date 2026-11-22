import RefreshSessionModel, {
  type RefreshSession,
  type RefreshSessionDocument,
} from "../Models/RefreshSessionSchema.ts";
import type { User } from "../Models/UserSchema.ts";
import { env } from "../Config/env.ts";
import { hashRefreshToken, newId, randomToken } from "../Utils/crypto.ts";
import { ApiError } from "../Utils/http.ts";
import { signAccessToken } from "../Utils/jwt.ts";
import { assertInvestigatorDevice } from "./device-lock.service.ts";

/**
 * Sessions do not expire: one ends only when somebody ends it (sign-out, password change,
 * suspension, phone reset, security policy change). 100 years rather than NULL, because the
 * column is NOT NULL and installed apps add this number of seconds to today's date.
 */
export const SESSION_LIFETIME_SECONDS = 100 * 365 * 24 * 60 * 60;
const sessionEnd = (): Date => new Date(Date.now() + SESSION_LIFETIME_SECONDS * 1000);

export interface DeviceMetadata {
  deviceId?: string | null;
  deviceName?: string | null;
  platform: "ios" | "android" | "web" | "unknown";
  ip: string;
  userAgent: string;
}

export interface TokenBundle {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_expires_in: number;
  auth_method: "password" | "biometric" | "google";
  session: {
    session_id: string;
    created_at: Date;
    expires_at: Date;
  };
}

export async function createSession(
  user: Pick<User, "user_id">,
  authMethod: "password" | "biometric" | "google",
  metadata: DeviceMetadata,
): Promise<TokenBundle> {
  // Investigators sign in only from their own phone.
  await assertInvestigatorDevice(user.user_id, metadata);
  const sessionId = newId();
  const refreshToken = randomToken(48);
  const expiresAt = sessionEnd();
  const now = new Date();

  await RefreshSessionModel.create({
    session_id: sessionId,
    user_id: user.user_id,
    refresh_token_hash: hashRefreshToken(refreshToken),
    auth_method: authMethod,
    device_id: metadata.deviceId ?? null,
    device_name: metadata.deviceName ?? null,
    platform: metadata.platform,
    ip: metadata.ip,
    user_agent: metadata.userAgent,
    created_at: now,
    last_used_at: now,
    expires_at: expiresAt,
  });

  return tokenBundle(
    { session_id: sessionId, user_id: user.user_id, auth_method: authMethod, created_at: now, expires_at: expiresAt },
    refreshToken,
  );
}

function tokenBundle(
  session: Pick<RefreshSession, "session_id" | "user_id" | "auth_method" | "created_at" | "expires_at">,
  refreshToken: string,
): TokenBundle {
  return {
    access_token: signAccessToken({
      user_id: session.user_id,
      session_id: session.session_id,
      auth_method: session.auth_method,
    }),
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: env.accessTokenTtlSeconds,
    refresh_expires_in: SESSION_LIFETIME_SECONDS,
    auth_method: session.auth_method,
    session: {
      session_id: session.session_id,
      created_at: session.created_at,
      expires_at: session.expires_at,
    },
  };
}

export async function findSessionByRefreshToken(
  refreshToken: string,
): Promise<RefreshSessionDocument | null> {
  return RefreshSessionModel.findOne({ refresh_token_hash: hashRefreshToken(refreshToken) });
}

/**
 * A new access token for the same session. The refresh token is not replaced, so several tabs,
 * a lost reply or a retry can use it again. The update matches live sessions only: a sign-out
 * that happens meanwhile wins.
 */
export async function renewSession(
  session: RefreshSessionDocument,
  refreshToken: string,
  metadata: Pick<DeviceMetadata, "ip" | "userAgent">,
): Promise<TokenBundle> {
  // Investigators stay bound to their own phone.
  await assertInvestigatorDevice(session.user_id, {
    deviceId: session.device_id,
    deviceName: session.device_name,
    platform: session.platform,
  });
  const renewed = await RefreshSessionModel.findOneAndUpdate(
    { _id: session._id, revoked_at: null },
    {
      $set: {
        expires_at: sessionEnd(),
        last_used_at: new Date(),
        ip: metadata.ip,
        user_agent: metadata.userAgent,
      },
    },
    { new: true },
  );
  if (!renewed) throw ApiError.unauthorized("Session has been revoked");
  return tokenBundle(renewed, refreshToken);
}

export async function revokeSession(
  sessionId: string,
  reason: string,
): Promise<boolean> {
  const result = await RefreshSessionModel.updateOne(
    { session_id: sessionId, revoked_at: null },
    { $set: { revoked_at: new Date(), revoked_reason: reason } },
  );
  return result.modifiedCount > 0;
}

export async function revokeSessionByUser(
  sessionId: string,
  userId: string,
  reason: string,
): Promise<boolean> {
  const result = await RefreshSessionModel.updateOne(
    { session_id: sessionId, user_id: userId, revoked_at: null },
    { $set: { revoked_at: new Date(), revoked_reason: reason } },
  );
  return result.modifiedCount > 0;
}

export async function revokeAllUserSessions(
  userId: string,
  reason: string,
  exceptSessionId?: string,
  skipSessionDocumentId?: string,
): Promise<void> {
  const filter: Record<string, unknown> = {
    user_id: userId,
    revoked_at: null,
  };

  if (exceptSessionId) filter.session_id = { $ne: exceptSessionId };
  if (skipSessionDocumentId) filter._id = { $ne: skipSessionDocumentId };

  await RefreshSessionModel.updateMany(filter, {
    $set: { revoked_at: new Date(), revoked_reason: reason },
  });
}

export async function getActiveSession(
  sessionId: string,
  userId: string,
): Promise<RefreshSessionDocument> {
  const session = await RefreshSessionModel.findOne({
    session_id: sessionId,
    user_id: userId,
  });

  if (!session) throw ApiError.unauthorized("Session not found");
  if (session.revoked_at) throw ApiError.unauthorized("Session has been revoked");
  if (session.expires_at.getTime() <= Date.now()) {
    throw ApiError.unauthorized("Session has expired");
  }

  return session;
}

export interface PublicSession {
  session_id: string;
  auth_method: string;
  device_id: string | null;
  device_name: string | null;
  platform: string;
  ip: string | null;
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date;
  current: boolean;
}

export function toPublicSession(
  session: RefreshSession,
  currentSessionId: string,
): PublicSession {
  return {
    session_id: session.session_id,
    auth_method: session.auth_method,
    device_id: session.device_id ?? null,
    device_name: session.device_name ?? null,
    platform: session.platform ?? "unknown",
    ip: session.ip ?? null,
    created_at: session.created_at,
    last_used_at: session.last_used_at ?? null,
    expires_at: session.expires_at,
    current: session.session_id === currentSessionId,
  };
}
