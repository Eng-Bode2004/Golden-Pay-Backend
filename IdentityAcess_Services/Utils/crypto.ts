import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { env } from "../Config/env.ts";

const ENCRYPTION_VERSION = "v1";
const IV_LENGTH = 12;

/** Cryptographically secure, URL-safe token. */
export function randomToken(bytes = 48): string {
  return randomBytes(bytes).toString("base64url");
}

export function newId(): string {
  return randomUUID();
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hmacHex(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value, "utf8").digest("hex");
}

export function hashRefreshToken(token: string): string {
  return hmacHex(env.refreshTokenPepper, token);
}

export function hashNationalId(normalisedNationalId: string): string {
  return hmacHex(env.nationalIdHmacSecret, normalisedNationalId);
}

/** Constant-time comparison for secrets of any length. */
export function constantTimeEqual(left: string, right: string): boolean {
  const leftHash = createHmac("sha256", "constant-time").update(left).digest();
  const rightHash = createHmac("sha256", "constant-time").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

/**
 * AES-256-GCM encryption for national ID numbers.
 * Format: v1.<iv>.<authTag>.<ciphertext> (all base64url).
 */
export function encryptString(plaintext: string, key = env.nationalIdEncryptionKey): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    ENCRYPTION_VERSION,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptString(payload: string, key = env.nationalIdEncryptionKey): string {
  const [version, ivPart, tagPart, cipherPart] = payload.split(".");
  if (
    version !== ENCRYPTION_VERSION ||
    !ivPart ||
    !tagPart ||
    cipherPart === undefined
  ) {
    throw new Error("Unsupported encrypted payload");
  }

  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(cipherPart, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
