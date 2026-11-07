import { env } from "../Config/env.ts";

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SENSITIVE_KEYS = new Set([
  "password",
  "confirmPassword",
  "confirm_password",
  "currentPassword",
  "newPassword",
  "password_hash",
  "national_id",
  "national_id_number",
  "national_ID",
  "authorization",
  "refresh_token",
  "signup_token",
  "signature",
  "public_key",
  "nonce",
]);

function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 4) return "[redacted]";
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SENSITIVE_KEYS.has(key) ? "[redacted]" : redact(entry, depth + 1);
    }
    return output;
  }
  return value;
}

function write(level: Level, message: string, meta?: Record<string, unknown>): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[env.logLevel]) return;

  const line = {
    timestamp: new Date().toISOString(),
    level,
    service: env.serviceName,
    message,
    ...(meta ? (redact(meta) as Record<string, unknown>) : {}),
  };

  const serialised = JSON.stringify(line);
  if (level === "error") {
    console.error(serialised);
  } else if (level === "warn") {
    console.warn(serialised);
  } else {
    console.log(serialised);
  }
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => write("debug", message, meta),
  info: (message: string, meta?: Record<string, unknown>) => write("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => write("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => write("error", message, meta),
};
