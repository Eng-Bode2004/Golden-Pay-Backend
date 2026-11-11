import RefreshSessionModel, {
  type RefreshSession,
  type RefreshSessionDocument,
} from "../Models/RefreshSessionSchema.ts";
import type { User } from "../Models/UserSchema.ts";
import { env } from "../Config/env.ts";
import { hashRefreshToken, newId, randomToken } from "../Utils/crypto.ts";
import { ApiError } from "../Utils/http.ts";
import { signAccessToken } from "../Utils/jwt.ts";

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
  const sessionId = newId();
  const refreshToken = randomToken(48);
  const expiresAt = new Date(Date.now() + env.refreshTokenTtlSeconds * 1000);
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

  return {
    access_token: signAccessToken({
      user_id: user.user_id,
      session_id: sessionId,
      auth_method: authMethod,
    }),
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: env.accessTokenTtlSeconds,
    refresh_expires_in: env.refreshTokenTtlSeconds,
    auth_method: authMethod,
    session: {
      session_id: sessionId,
      created_at: now,
      expires_at: expiresAt,
    },
  };
}

export async function findSessionByRefreshToken(
  refreshToken: string,
): Promise<RefreshSessionDocument | null> {
  return RefreshSessionModel.findOne({ refresh_token_hash: hashRefreshToken(refreshToken) });
}

/**
 * Atomically consumes a session for rotation. Returns the previous session
 * document when this caller won the race, otherwise treats it as token reuse.
 */
export async function claimSessionForRotation(
  session: RefreshSessionDocument,
): Promise<RefreshSessionDocument> {
  const claimed = await RefreshSessionModel.findOneAndUpdate(
    { _id: session._id, revoked_at: null },
    {
      $set: {
        revoked_at: new Date(),
        revoked_reason: "rotated",
        last_used_at: new Date(),
      },
    },
    { new: true },
  );

  if (!claimed) {
    throw ApiError.unauthorized("Refresh token has already been used");
  }

  return claimed;
}

export async function linkRotatedSession(
  previousSessionId: string,
  replacementSessionId: string,
): Promise<void> {
  await RefreshSessionModel.updateOne(
    { session_id: previousSessionId },
    { $set: { replaced_by_session_id: replacementSessionId } },
  );
}

export async function markSessionReused(session: RefreshSessionDocument): Promise<void> {
  await revokeAllUserSessions(
    session.user_id,
    "refresh_token_reuse_detected",
    undefined,
    session._id.toString(),
  );
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
