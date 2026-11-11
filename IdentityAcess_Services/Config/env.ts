import { resolve } from "node:path";

/**
 * Centralised environment configuration.
 *
 * Bun automatically loads `.env` files before the application starts, so all
 * values below can be provided through the environment or a local `.env`.
 * Development fallbacks are intentionally obvious and MUST be replaced in
 * production - `loadEnv()` refuses to start in production without real secrets.
 */

const isProduction = process.env.NODE_ENV === "production";

const DEV_JWT_SECRET = "dev-only-jwt-secret-change-me-0123456789abcdef";
const DEV_NATIONAL_ID_KEY = "Z29sZGVuLXBheS1kZXYtb25seS0zMi1ieXRlLWtleSE="; // 32 bytes
const DEV_HMAC_SECRET = "dev-only-hmac-secret-change-me-0123456789abcdef";

function readString(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

function readNumber(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`Environment variable ${name} must be a number >= ${min}`);
  }
  return parsed;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function readSecret(name: string, fallback: string, minimumLength = 32): string {
  const value = process.env[name]?.trim();
  if (value && value.length >= minimumLength) return value;
  if (value && isProduction) {
    throw new Error(`${name} must be at least ${minimumLength} characters in production`);
  }
  if (isProduction) {
    throw new Error(`${name} is required in production`);
  }
  return fallback;
}

function readEncryptionKey(name: string, fallback: string): Buffer {
  const raw = process.env[name]?.trim();

  if (!raw) {
    if (isProduction) throw new Error(`${name} is required in production`);
    return Buffer.from(fallback, "base64");
  }

  let key: Buffer;
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    key = Buffer.from(raw, "hex");
  } else {
    key = Buffer.from(raw, "base64");
  }

  if (key.length !== 32) {
    throw new Error(`${name} must decode to exactly 32 bytes (base64 or 64-char hex)`);
  }

  return key;
}

function readCorsOrigins(): string[] {
  const raw = process.env.CORS_ORIGINS?.trim();
  if (!raw) return ["*"];
  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export interface AppEnv {
  readonly nodeEnv: "development" | "test" | "production";
  readonly isProduction: boolean;
  readonly serviceName: string;
  readonly port: number;
  readonly databaseUrl: string;
  readonly jwtSecret: string;
  readonly jwtIssuer: string;
  readonly jwtAudience: string;
  readonly accessTokenTtlSeconds: number;
  readonly refreshTokenTtlSeconds: number;
  readonly signupTokenTtlSeconds: number;
  readonly nationalIdEncryptionKey: Buffer;
  readonly nationalIdHmacSecret: string;
  readonly refreshTokenPepper: string;
  readonly employeeNumberPrefix: string;
  readonly employeeNumberPad: number;
  readonly uploadDir: string;
  /** Cloud object storage for uploaded and generated files; null keeps files in uploadDir. */
  readonly storage: {
    readonly bucket: string;
    readonly region: string;
    readonly endpoint?: string;
    readonly folder: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
  } | null;
  readonly maxUploadBytes: number;
  readonly maxJsonBytes: number;
  readonly loginMaxAttempts: number;
  readonly loginLockMinutes: number;
  readonly biometricChallengeTtlSeconds: number;
  readonly strictEmployeeVerification: boolean;
  readonly corsOrigins: string[];
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly dashboardPublicUrl: string;
  readonly smtpHost: string;
  readonly smtpPort: number;
  readonly smtpUser: string;
  readonly smtpPass: string;
  readonly mailFrom: string;
  /** OAuth client IDs whose Google ID tokens are accepted (the web client ID used by the app). */
  readonly googleClientIds: string[];
}

export function loadEnv(): AppEnv {
  const nodeEnv = (process.env.NODE_ENV ?? "development") as AppEnv["nodeEnv"];

  return {
    nodeEnv,
    isProduction,
    serviceName: "golden-pay-identity-access",
    port: readNumber("PORT", 4001, 1),
    databaseUrl: readString(
      "DATABASE_URL",
      "postgresql://postgres:postgres@127.0.0.1:5432/golden_pay_identity",
    ),
    jwtSecret: readSecret("JWT_SECRET", DEV_JWT_SECRET),
    jwtIssuer: readString("JWT_ISSUER", "golden-pay-identity"),
    jwtAudience: readString("JWT_AUDIENCE", "golden-pay-clients"),
    accessTokenTtlSeconds: readNumber("ACCESS_TOKEN_TTL_SECONDS", 15 * 60, 60),
    refreshTokenTtlSeconds: readNumber("REFRESH_TOKEN_TTL_SECONDS", 30 * 24 * 60 * 60, 300),
    signupTokenTtlSeconds: readNumber("SIGNUP_TOKEN_TTL_SECONDS", 20 * 60, 60),
    nationalIdEncryptionKey: readEncryptionKey(
      "NATIONAL_ID_ENCRYPTION_KEY",
      DEV_NATIONAL_ID_KEY,
    ),
    nationalIdHmacSecret: readSecret("NATIONAL_ID_HMAC_SECRET", DEV_HMAC_SECRET),
    refreshTokenPepper: readSecret("REFRESH_TOKEN_PEPPER", DEV_HMAC_SECRET),
    employeeNumberPrefix: readString("EMPLOYEE_NUMBER_PREFIX", "GP").toUpperCase(),
    employeeNumberPad: readNumber("EMPLOYEE_NUMBER_PAD", 6, 1),
    uploadDir: resolve(readString("UPLOAD_DIR", resolve(import.meta.dir, "../../../Storage/identity-access"))),
    storage: readStorage(),
    maxUploadBytes: readNumber("MAX_UPLOAD_BYTES", 8 * 1024 * 1024, 1024),
    maxJsonBytes: readNumber("MAX_JSON_BYTES", 1024 * 1024, 1024),
    loginMaxAttempts: readNumber("LOGIN_MAX_ATTEMPTS", 5, 1),
    loginLockMinutes: readNumber("LOGIN_LOCK_MINUTES", 15, 1),
    biometricChallengeTtlSeconds: readNumber("BIOMETRIC_CHALLENGE_TTL_SECONDS", 90, 30),
    strictEmployeeVerification: readBoolean("STRICT_EMPLOYEE_VERIFICATION", true),
    corsOrigins: readCorsOrigins(),
    logLevel: (process.env.LOG_LEVEL ?? (isProduction ? "info" : "debug")) as AppEnv["logLevel"],
    dashboardPublicUrl: readString("DASHBOARD_PUBLIC_URL", "http://127.0.0.1:4100").replace(/\/+$/, ""),
    smtpHost: readString("SMTP_HOST", "smtp.gmail.com"),
    smtpPort: readNumber("SMTP_PORT", 465, 1),
    smtpUser: readString("SMTP_USER", "goldenpayservices@gmail.com"),
    smtpPass: process.env.SMTP_PASS?.trim() ?? "",
    mailFrom: readString("MAIL_FROM", "Golden Pay Services <goldenpayservices@gmail.com>"),
    // GOOGLE_CLIENT_IDS (comma separated), or the same name the app build uses.
    googleClientIds: [process.env.GOOGLE_CLIENT_IDS, process.env.GOOGLE_SERVER_CLIENT_ID].join(",").split(",").map((id) => id.trim()).filter((id, index, all) => id && all.indexOf(id) === index),
  };
}

/** STORAGE_* names, or the S3_* names a host such as Thalmet Cloud provides. */
function storageSetting(name: string): string | undefined {
  for (const key of [`STORAGE_${name}`, `S3_${name}`]) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function readStorage(): AppEnv["storage"] {
  const bucket = storageSetting("BUCKET");
  if (!bucket) return null;
  const accessKeyId = storageSetting("ACCESS_KEY_ID") ?? "";
  const secretAccessKey = storageSetting("SECRET_ACCESS_KEY") ?? "";
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("A storage bucket is set but its access key id or secret access key is missing (STORAGE_* or S3_*)");
  }
  return {
    bucket,
    region: storageSetting("REGION") || "us-east-1",
    endpoint: storageSetting("ENDPOINT") || undefined,
    folder: (storageSetting("FOLDER") ?? "").replace(/^\/+|\/+$/g, ""),
    accessKeyId,
    secretAccessKey,
  };
}

export const env = loadEnv();
