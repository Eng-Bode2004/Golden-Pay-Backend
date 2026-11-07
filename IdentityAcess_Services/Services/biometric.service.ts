import { constants, createPublicKey, verify as verifySignature } from "node:crypto";
import type { KeyObject } from "node:crypto";
import BiometricCredentialModel, {
  type BiometricCredential,
} from "../Models/BiometricCredentialSchema.ts";
import LoginChallengeModel from "../Models/LoginChallengeSchema.ts";
import UserModel, { type User } from "../Models/UserSchema.ts";
import { DatabaseConflict } from "../Config/db.ts";
import type { RequestContext } from "../Utils/http.ts";
import { ApiError } from "../Utils/http.ts";
import {
  constantTimeEqual,
  hmacHex,
  newId,
  randomToken,
} from "../Utils/crypto.ts";
import { env } from "../Config/env.ts";
import { recordAudit } from "./audit.service.ts";
import {
  createSession,
  type TokenBundle,
} from "./session.service.ts";
import {
  toPublicUser,
  type PublicUser,
} from "./user.service.ts";
import { getUserAccess } from "./rbac.service.ts";
import { assertAccountActive } from "./auth.service.ts";
import { security } from "./admin-security.service.ts";

export type BiometricAlgorithm = "ed25519" | "es256" | "rs256";

export interface RegisterBiometricInput {
  deviceId: string;
  deviceName?: string;
  platform: "ios" | "android" | "web" | "unknown";
  publicKey: string;
  algorithm: BiometricAlgorithm;
}

export interface BiometricRegistration {
  credential_id: string;
  device_id: string;
  device_name: string | null;
  platform: string;
  algorithm: BiometricAlgorithm;
  created_at: Date;
}

export interface BiometricChallenge {
  challenge_id: string;
  nonce: string;
  algorithm: BiometricAlgorithm;
  signing_payload: string;
  expires_at: Date;
  message: string;
}

export interface BiometricLoginResult extends TokenBundle {
  user: PublicUser;
}

export interface BiometricCredentialSummary {
  credential_id: string;
  device_id: string;
  device_name: string | null;
  platform: string;
  algorithm: string;
  status: string;
  created_at: Date;
  last_used_at: Date | null;
}

function decodeSignature(value: string): Buffer {
  const trimmed = value.trim();
  if (trimmed.length < 40 || trimmed.length > 4096) {
    throw new ApiError(400, "INVALID_SIGNATURE", "signature is invalid", {
      details: { field: "signature", message: "signature is invalid" },
    });
  }

  const bytes = Buffer.from(trimmed, "base64url");
  if (bytes.length < 32 || bytes.length > 2048) {
    throw new ApiError(400, "INVALID_SIGNATURE", "signature is invalid", {
      details: { field: "signature", message: "signature is invalid" },
    });
  }
  return bytes;
}

function normalisePublicKey(raw: string): string {
  const trimmed = raw.trim().replace(/\\n/g, "\n");

  if (trimmed.includes("PRIVATE KEY")) {
    throw new ApiError(400, "INVALID_PUBLIC_KEY", "A public key is required, not a private key", {
      details: { field: "public_key", message: "Private keys must never be sent to the server" },
    });
  }

  if (trimmed.includes("BEGIN PUBLIC KEY") || trimmed.includes("BEGIN RSA PUBLIC KEY")) {
    return trimmed;
  }

  const base64 = trimmed.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new ApiError(400, "INVALID_PUBLIC_KEY", "public_key must be a PEM or base64 DER key", {
      details: { field: "public_key", message: "Invalid public key format" },
    });
  }

  const lines = base64.match(/.{1,64}/g)?.join("\n") ?? base64;
  return `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----`;
}

function parseAndValidatePublicKey(raw: string, algorithm: BiometricAlgorithm): string {
  let key: KeyObject;
  try {
    key = createPublicKey(normalisePublicKey(raw));
  } catch {
    throw new ApiError(400, "INVALID_PUBLIC_KEY", "public_key is not a valid public key", {
      details: { field: "public_key", message: "Invalid public key" },
    });
  }

  const keyType = key.asymmetricKeyType;
  const details = key.asymmetricKeyDetails as
    | { namedCurve?: string; modulusLength?: number }
    | undefined;

  if (algorithm === "ed25519" && keyType !== "ed25519") {
    throw new ApiError(400, "PUBLIC_KEY_ALGORITHM_MISMATCH", "public_key is not an Ed25519 key", {
      details: { field: "public_key" },
    });
  }

  if (algorithm === "es256") {
    const curve = details?.namedCurve;
    if (keyType !== "ec" || (curve !== "prime256v1" && curve !== "P-256")) {
      throw new ApiError(400, "PUBLIC_KEY_ALGORITHM_MISMATCH", "public_key must be a P-256 EC key", {
        details: { field: "public_key" },
      });
    }
  }

  if (algorithm === "rs256") {
    if (keyType !== "rsa" || (details?.modulusLength ?? 0) < 2048) {
      throw new ApiError(400, "PUBLIC_KEY_ALGORITHM_MISMATCH", "public_key must be an RSA key of at least 2048 bits", {
        details: { field: "public_key" },
      });
    }
  }

  return key.export({ type: "spki", format: "pem" }).toString();
}

/** Converts a raw 64-byte P-256 signature (r || s) to ASN.1 DER. */
function rawEcdsaSignatureToDer(signature: Buffer): Buffer {
  const half = signature.length / 2;
  const encodeInteger = (input: Buffer): Buffer => {
    let start = 0;
    while (start < input.length - 1 && input[start] === 0) start += 1;
    let value = input.subarray(start);
    if ((value[0] ?? 0) & 0x80) {
      value = Buffer.concat([Buffer.from([0x00]), value]);
    }
    return Buffer.concat([Buffer.from([0x02, value.length]), value]);
  };

  const r = encodeInteger(signature.subarray(0, half));
  const s = encodeInteger(signature.subarray(half));
  const body = Buffer.concat([r, s]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

function signatureIsValid(
  algorithm: string,
  publicKeyPem: string,
  payload: string,
  signature: Buffer,
): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    const data = Buffer.from(payload, "utf8");

    if (algorithm === "ed25519") {
      return verifySignature(null, data, key, signature);
    }

    if (algorithm === "es256") {
      if (verifySignature("sha256", data, { key, dsaEncoding: "der" }, signature)) {
        return true;
      }
      if (signature.length === 64) {
        return verifySignature(
          "sha256",
          data,
          { key, dsaEncoding: "der" },
          rawEcdsaSignatureToDer(signature),
        );
      }
      return false;
    }

    if (algorithm === "rs256") {
      return verifySignature(
        "sha256",
        data,
        { key, padding: constants.RSA_PKCS1_PADDING },
        signature,
      );
    }

    return false;
  } catch {
    return false;
  }
}

export async function registerBiometric(
  user: User,
  input: RegisterBiometricInput,
  context: RequestContext,
): Promise<BiometricRegistration> {
  const publicKey = parseAndValidatePublicKey(input.publicKey, input.algorithm);

  const existing = await BiometricCredentialModel.findOne({
    user_id: user.user_id,
    device_id: input.deviceId,
    status: "active",
  });

  if (existing) {
    throw new ApiError(
      409,
      "BIOMETRIC_ALREADY_REGISTERED",
      "Biometric sign-in is already enabled for this device. Revoke the existing credential first.",
      { details: { credential_id: existing.credential_id } },
    );
  }

  let credential;
  try {
    credential = await BiometricCredentialModel.create({
      credential_id: newId(),
      user_id: user.user_id,
      device_id: input.deviceId,
      device_name: input.deviceName ?? null,
      platform: input.platform,
      public_key: publicKey,
      algorithm: input.algorithm,
      status: "active",
    });
  } catch (error) {
    if (error instanceof DatabaseConflict) {
      throw new ApiError(
        409,
        "BIOMETRIC_ALREADY_REGISTERED",
        "Biometric sign-in is already enabled for this device",
      );
    }
    throw error;
  }

  await UserModel.updateOne(
    { user_id: user.user_id },
    { $set: { biometric_enabled: true } },
  );

  await recordAudit({
    event: "biometric.registered",
    userId: user.user_id,
    employeeNumber: user.employee_number ?? null,
    success: true,
    context,
    metadata: {
      credential_id: credential.credential_id,
      device_id: input.deviceId,
      algorithm: input.algorithm,
    },
  });

  return {
    credential_id: credential.credential_id,
    device_id: credential.device_id,
    device_name: credential.device_name ?? null,
    platform: credential.platform ?? "unknown",
    algorithm: credential.algorithm as BiometricAlgorithm,
    created_at: credential.created_at,
  };
}

async function resolveCredential(
  deviceId: string,
  identifier?: { type: "employee_number" | "employee_id"; value: string },
): Promise<{ credential: BiometricCredential; user: User }> {
  let userId: string | undefined;

  if (identifier) {
    const user = await UserModel.findOne(
      identifier.type === "employee_number"
        ? { employee_number: identifier.value, deleted_at: null }
        : { employee_id: identifier.value, deleted_at: null },
    );
    if (!user) {
      throw new ApiError(
        404,
        "BIOMETRIC_NOT_ENABLED",
        "Biometric sign-in is not enabled for this account on this device",
      );
    }
    userId = user.user_id;
  }

  const credentials = await BiometricCredentialModel.find({
    device_id: deviceId,
    status: "active",
    ...(userId ? { user_id: userId } : {}),
  }).limit(2);

  if (credentials.length === 0) {
    throw new ApiError(
      404,
      "BIOMETRIC_NOT_ENABLED",
      "Biometric sign-in is not enabled for this account on this device",
    );
  }

  if (credentials.length > 1) {
    throw new ApiError(
      409,
      "MULTIPLE_ACCOUNTS_ON_DEVICE",
      "Multiple accounts use biometrics on this device. Provide an employee number.",
    );
  }

  const credential = credentials[0] as BiometricCredential;
  const user = await UserModel.findOne({
    user_id: credential.user_id,
    deleted_at: null,
  });

  if (!user) {
    throw new ApiError(404, "BIOMETRIC_NOT_ENABLED", "Biometric account not found");
  }

  assertAccountActive(user);

  return { credential, user };
}

export async function createBiometricChallenge(input: {
  deviceId: string;
  identifier?: { type: "employee_number" | "employee_id"; value: string };
}): Promise<BiometricChallenge> {
  const { credential } = await resolveCredential(input.deviceId, input.identifier);
  const challengeId = newId();
  const nonce = randomToken(32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + env.biometricChallengeTtlSeconds * 1000);

  await LoginChallengeModel.create({
    challenge_id: challengeId,
    user_id: credential.user_id,
    credential_id: credential.credential_id,
    device_id: input.deviceId,
    nonce_hash: hmacHex(env.refreshTokenPepper, nonce),
    created_at: now,
    expires_at: expiresAt,
  });

  const signingPayload = `golden-pay-biometric:${challengeId}:${nonce}`;

  return {
    challenge_id: challengeId,
    nonce,
    algorithm: credential.algorithm as BiometricAlgorithm,
    signing_payload: signingPayload,
    expires_at: expiresAt,
    message:
      "Sign signing_payload with the private key protected by Face ID / fingerprint, then POST challenge_id and signature to /auth/biometric/login",
  };
}

export async function loginWithBiometric(
  input: {
    challengeId: string;
    nonce: string;
    signature: string;
  },
  context: RequestContext,
): Promise<BiometricLoginResult> {
  const signature = decodeSignature(input.signature);
  const challenge = await LoginChallengeModel.findOneAndUpdate(
    {
      challenge_id: input.challengeId,
      consumed_at: null,
      expires_at: { $gt: new Date() },
    },
    { $set: { consumed_at: new Date() } },
    { new: true },
  );

  if (!challenge) {
    throw new ApiError(
      401,
      "INVALID_CHALLENGE",
      "Biometric challenge is invalid or has expired. Request a new challenge.",
    );
  }

  if (!constantTimeEqual(challenge.nonce_hash, hmacHex(env.refreshTokenPepper, input.nonce))) {
    await recordAudit({
      event: "auth.login.failed",
      userId: challenge.user_id,
      success: false,
      reason: "biometric_nonce_mismatch",
      context,
    });
    throw new ApiError(401, "BIOMETRIC_VERIFICATION_FAILED", "Biometric verification failed");
  }

  const credential = await BiometricCredentialModel.findOne({
    credential_id: challenge.credential_id,
    user_id: challenge.user_id,
    device_id: challenge.device_id,
    status: "active",
  });

  if (!credential) {
    throw new ApiError(401, "BIOMETRIC_VERIFICATION_FAILED", "Biometric verification failed");
  }

  const user = await UserModel.findOne({
    user_id: challenge.user_id,
    deleted_at: null,
  });

  if (!user) {
    throw new ApiError(401, "BIOMETRIC_VERIFICATION_FAILED", "Biometric verification failed");
  }

  assertAccountActive(user);

  const signingPayload = `golden-pay-biometric:${challenge.challenge_id}:${input.nonce}`;
  if (!signatureIsValid(credential.algorithm, credential.public_key, signingPayload, signature)) {
    await recordAudit({
      event: "auth.login.failed",
      userId: user.user_id,
      employeeNumber: user.employee_number ?? null,
      success: false,
      reason: "biometric_signature_invalid",
      context,
    });
    throw new ApiError(401, "BIOMETRIC_VERIFICATION_FAILED", "Biometric verification failed");
  }

  if ((await security(user.user_id))?.mfa_required) throw new ApiError(403, "MFA_REQUIRED", "Use password and authenticator login");
  const tokens = await createSession(user, "biometric", {
    deviceId: credential.device_id,
    deviceName: credential.device_name ?? null,
    platform: (credential.platform ?? "unknown") as "ios" | "android" | "web" | "unknown",
    ip: context.ip,
    userAgent: context.req.headers.get("user-agent")?.slice(0, 512) ?? "unknown",
  });

  await BiometricCredentialModel.updateOne(
    { credential_id: credential.credential_id },
    { $set: { last_used_at: new Date() } },
  );

  const access = await getUserAccess(user.user_id);

  await recordAudit({
    event: "auth.login.biometric",
    userId: user.user_id,
    employeeNumber: user.employee_number ?? null,
    success: true,
    context,
    metadata: {
      credential_id: credential.credential_id,
      device_id: credential.device_id,
      session_id: tokens.session.session_id,
    },
  });

  return {
    ...tokens,
    user: toPublicUser(user, access.roles),
  };
}

export async function listBiometricCredentials(
  userId: string,
): Promise<BiometricCredentialSummary[]> {
  const credentials = await BiometricCredentialModel.find({ user_id: userId })
    .sort({ created_at: -1 })
    .lean();

  return credentials.map((credential) => ({
    credential_id: credential.credential_id,
    device_id: credential.device_id,
    device_name: credential.device_name ?? null,
    platform: credential.platform ?? "unknown",
    algorithm: credential.algorithm,
    status: credential.status,
    created_at: credential.created_at,
    last_used_at: credential.last_used_at ?? null,
  }));
}

export async function revokeBiometricCredential(
  userId: string,
  credentialId: string,
  context: RequestContext,
): Promise<void> {
  const credential = await BiometricCredentialModel.findOne({
    credential_id: credentialId,
    user_id: userId,
  });

  if (!credential) {
    throw ApiError.notFound("Biometric credential not found");
  }

  if (credential.status === "active") {
    credential.status = "revoked";
    credential.revoked_at = new Date();
    await credential.save();
  }

  const remaining = await BiometricCredentialModel.countDocuments({
    user_id: userId,
    status: "active",
  });

  await UserModel.updateOne(
    { user_id: userId },
    { $set: { biometric_enabled: remaining > 0 } },
  );

  await recordAudit({
    event: "biometric.revoked",
    userId,
    success: true,
    context,
    metadata: { credential_id: credentialId },
  });
}
