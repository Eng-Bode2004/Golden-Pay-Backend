import { ApiError } from "./http.ts";

export type JsonBody = Record<string, unknown>;

export interface StringRules {
  min?: number;
  max?: number;
  label?: string;
  pattern?: RegExp;
  patternMessage?: string;
  trim?: boolean;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M}'\- ]{1,118}[\p{L}\p{M}]$/u;
const EMPLOYEE_IDENTIFIER_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;

const COMMON_PASSWORDS = new Set([
  "password",
  "password1",
  "password123",
  "12345678",
  "123456789",
  "qwerty123",
  "letmein123",
  "welcome123",
  "admin123",
  "changeme",
]);

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;

function invalid(field: string, message: string): never {
  throw new ApiError(400, "VALIDATION_ERROR", message, {
    details: { field, message },
  });
}

/** Reads the first present key, allowing snake_case and camelCase clients. */
export function pick(
  body: JsonBody,
  ...keys: string[]
): { key: string; value: unknown } | undefined {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      return { key, value: body[key] };
    }
  }
  return undefined;
}

export function requiredString(
  body: JsonBody,
  keys: string | string[],
  rules: StringRules = {},
): string {
  const keyList = Array.isArray(keys) ? keys : [keys];
  const found = pick(body, ...keyList);
  const label = rules.label ?? keyList[0] ?? "value";
  if (!found || found.value === undefined || found.value === null) {
    invalid(label, `${label} is required`);
  }
  return validateString(found.value, label, rules);
}

export function optionalString(
  body: JsonBody,
  keys: string | string[],
  rules: StringRules = {},
): string | undefined {
  const keyList = Array.isArray(keys) ? keys : [keys];
  const found = pick(body, ...keyList);
  const label = rules.label ?? keyList[0] ?? "value";
  if (!found || found.value === undefined || found.value === null || found.value === "") {
    return undefined;
  }
  return validateString(found.value, label, rules);
}

export function validateString(value: unknown, label: string, rules: StringRules = {}): string {
  if (typeof value !== "string") {
    invalid(label, `${label} must be a string`);
  }

  const trimmed = rules.trim === false ? value : value.trim();
  const min = rules.min ?? 1;
  const max = rules.max ?? 255;

  if (trimmed.length < min) invalid(label, `${label} must be at least ${min} characters`);
  if (trimmed.length > max) invalid(label, `${label} must be at most ${max} characters`);
  if (rules.pattern && !rules.pattern.test(trimmed)) {
    invalid(label, rules.patternMessage ?? `${label} has an invalid format`);
  }

  return trimmed;
}

export function requiredBoolean(body: JsonBody, keys: string | string[], label?: string): boolean {
  const keyList = Array.isArray(keys) ? keys : [keys];
  const found = pick(body, ...keyList);
  const fieldLabel = label ?? keyList[0] ?? "value";
  if (!found || typeof found.value !== "boolean") {
    invalid(fieldLabel, `${fieldLabel} must be a boolean`);
  }
  return found.value;
}

export function optionalBoolean(
  body: JsonBody,
  keys: string | string[],
  label?: string,
): boolean | undefined {
  const keyList = Array.isArray(keys) ? keys : [keys];
  const found = pick(body, ...keyList);
  const fieldLabel = label ?? keyList[0] ?? "value";
  if (!found || found.value === undefined || found.value === null) return undefined;
  if (typeof found.value !== "boolean") {
    invalid(fieldLabel, `${fieldLabel} must be a boolean`);
  }
  return found.value;
}

export function requiredEnum<T extends string>(
  body: JsonBody,
  keys: string | string[],
  allowed: readonly T[],
  label?: string,
): T {
  const keyList = Array.isArray(keys) ? keys : [keys];
  const value = requiredString(body, keyList, { label: label ?? keyList[0] });
  if (!allowed.includes(value as T)) {
    invalid(
      label ?? keyList[0] ?? "value",
      `${label ?? keyList[0]} must be one of: ${allowed.join(", ")}`,
    );
  }
  return value as T;
}

export function normaliseEmployeeIdentifier(value: string, label = "employee number"): string {
  const normalised = value.trim().toUpperCase();
  if (!EMPLOYEE_IDENTIFIER_PATTERN.test(normalised)) {
    invalid(
      label,
      `${label} must be 3-32 characters using letters, numbers, dash or underscore`,
    );
  }
  return normalised;
}

export function employeeIdentifierField(
  body: JsonBody,
  keys: string | string[],
  label = "employee number",
): string {
  return normaliseEmployeeIdentifier(requiredString(body, keys, { label }), label);
}

export function validateEmail(value: unknown): string {
  const email = validateString(value, "email", {
    min: 5,
    max: 254,
    pattern: EMAIL_PATTERN,
    patternMessage: "email must be a valid email address",
  }).toLowerCase();

  return email;
}

export function optionalEmail(body: JsonBody, keys: string | string[] = "email"): string | undefined {
  const found = pick(body, ...(Array.isArray(keys) ? keys : [keys]));
  if (!found || found.value === undefined || found.value === null || found.value === "") {
    return undefined;
  }
  return validateEmail(found.value);
}

/**
 * Normalises Egyptian local mobile numbers (01xxxxxxxxx) to E.164 (+20...)
 * and keeps other international numbers in +digits form.
 */
export function normalisePhone(value: string): string {
  const stripped = value.replace(/[\s()-]/g, "");

  if (/^01\d{9}$/.test(stripped)) {
    return `+20${stripped.slice(1)}`;
  }
  if (/^\+201\d{9}$/.test(stripped)) {
    return stripped;
  }
  if (/^\+[1-9]\d{7,14}$/.test(stripped)) {
    return stripped;
  }
  if (/^[1-9]\d{7,14}$/.test(stripped)) {
    return `+${stripped}`;
  }

  invalid("phone", "phone must be a valid mobile number");
}

export function phoneField(body: JsonBody, keys: string | string[] = "phone"): string {
  const label = Array.isArray(keys) ? keys[0] : keys;
  return normalisePhone(requiredString(body, keys, { label: label ?? "phone" }));
}

const NATIONAL_ID_PATTERN = /^\d{14}$/;

/** Egyptian national ID: 14 digits. Stored normalised (digits only). */
export function normaliseNationalId(value: string): string {
  const digits = value.replace(/[\s-]/g, "");
  if (!NATIONAL_ID_PATTERN.test(digits)) {
    invalid("national_id_number", "national_id_number must be exactly 14 digits");
  }
  return digits;
}

export function nationalIdField(body: JsonBody, keys: string | string[] = "national_id_number"): string {
  const label = Array.isArray(keys) ? keys[0] : keys;
  return normaliseNationalId(requiredString(body, keys, { label: label ?? "national_id_number" }));
}

export function validatePassword(value: unknown, label = "password"): string {
  if (typeof value !== "string") invalid(label, `${label} must be a string`);
  if (value.length < PASSWORD_MIN_LENGTH) {
    invalid(label, `${label} must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }
  if (value.length > PASSWORD_MAX_LENGTH) {
    invalid(label, `${label} must be at most ${PASSWORD_MAX_LENGTH} characters`);
  }
  if (value !== value.trim()) {
    invalid(label, `${label} must not start or end with whitespace`);
  }
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/\d/.test(value)) {
    invalid(label, `${label} must contain a lowercase letter, an uppercase letter and a number`);
  }
  if (COMMON_PASSWORDS.has(value.toLowerCase())) {
    invalid(label, `${label} is too common, choose a stronger password`);
  }
  return value;
}

export function passwordField(body: JsonBody, keys: string | string[] = "password"): string {
  const found = pick(body, ...(Array.isArray(keys) ? keys : [keys]));
  if (!found) invalid("password", "password is required");
  return validatePassword(found.value);
}

export function confirmPasswordField(
  body: JsonBody,
  password: string,
  keys: string | string[] = ["confirm_password", "confirmPassword"],
): void {
  const found = pick(body, ...(Array.isArray(keys) ? keys : [keys]));
  if (!found) invalid("confirm_password", "confirm_password is required");
  const confirmation = validateString(found.value, "confirm_password", { max: 128, trim: false });
  if (confirmation !== password) {
    invalid("confirm_password", "confirm_password does not match password");
  }
}

export function assertPasswordNotBasedOn(
  password: string,
  personalValues: Array<string | undefined>,
): void {
  const lowerPassword = password.toLowerCase();
  for (const value of personalValues) {
    if (!value) continue;
    const normalised = value.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normalised.length >= 4 && lowerPassword.includes(normalised)) {
      invalid("password", "password must not contain your employee number or national ID");
    }
  }
}

export function fullNameField(body: JsonBody, keys: string | string[] = "full_name"): string {
  const name = requiredString(body, keys, { min: 3, max: 120, label: "full_name" }).replace(
    /\s+/g,
    " ",
  );
  if (!NAME_PATTERN.test(name)) {
    invalid("full_name", "full_name must contain only letters, spaces, apostrophes or hyphens");
  }
  return name;
}

export function normaliseFullName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export function deviceIdField(body: JsonBody, keys: string | string[] = "device_id"): string {
  return requiredString(body, keys, {
    min: 8,
    max: 200,
    label: "device_id",
    pattern: DEVICE_ID_PATTERN,
    patternMessage: "device_id has an invalid format",
  });
}

export function optionalDeviceId(
  body: JsonBody,
  keys: string[] = ["device_id", "deviceId"],
): string | undefined {
  return optionalString(body, keys, {
    min: 8,
    max: 200,
    label: "device_id",
    pattern: DEVICE_ID_PATTERN,
    patternMessage: "device_id has an invalid format",
  });
}

export function devicePlatform(body: JsonBody): "ios" | "android" | "web" | "unknown" {
  const value = optionalString(body, ["platform", "device_platform"], {
    min: 1,
    max: 20,
    label: "platform",
  });
  return normaliseDevicePlatform(value);
}

/**
 * Login accepts either `employee_number` or `employee_id` (never both), or a
 * generic `identifier` with an optional `identifier_type`.
 */
export function loginIdentifierField(body: JsonBody): {
  type: "employee_number" | "employee_id" | "email" | "phone";
  value: string;
} {
  if (Object.prototype.hasOwnProperty.call(body, "phone")) {
    return { type: "phone", value: phoneField(body) };
  }
  const hasEmployeeNumber = Object.prototype.hasOwnProperty.call(body, "employee_number");
  const hasEmployeeId = Object.prototype.hasOwnProperty.call(body, "employee_id");
  const hasEmail = Object.prototype.hasOwnProperty.call(body, "email");

  if ([hasEmployeeNumber, hasEmployeeId, hasEmail].filter(Boolean).length > 1) {
    invalid("identifier", "Provide only one login identifier");
  }

  if (hasEmployeeNumber || hasEmployeeId || hasEmail) {
    const key = hasEmployeeNumber ? "employee_number" : hasEmployeeId ? "employee_id" : "email";
    const type = key;
    if (type === "email") {
      return { type, value: optionalEmail({ email: requiredString(body, "email", { label: "email" }) })! };
    }
    return {
      type,
      value: normaliseEmployeeIdentifier(requiredString(body, key, { label: key }), key),
    };
  }

  const rawIdentifier = requiredString(body, "identifier", { label: "identifier" });
  const rawType = optionalString(body, "identifier_type", { max: 32, label: "identifier_type" });
  const type =
    rawType === undefined || rawType === "employee_number" ? "employee_number" : rawType;

  if (type !== "employee_number" && type !== "employee_id" && type !== "email") {
    invalid("identifier_type", "identifier_type must be employee_number, employee_id or email");
  }

  return {
    type,
    value: type === "email" ? optionalEmail({ email: rawIdentifier })! : normaliseEmployeeIdentifier(rawIdentifier, type),
  };
}

export function optionalLoginIdentifier(body: JsonBody): {
  type: "employee_number" | "employee_id";
  value: string;
} | undefined {
  const hasAny =
    Object.prototype.hasOwnProperty.call(body, "employee_number") ||
    Object.prototype.hasOwnProperty.call(body, "employee_id") ||
    Object.prototype.hasOwnProperty.call(body, "email") ||
    Object.prototype.hasOwnProperty.call(body, "identifier");
  if (!hasAny) return undefined;
  const identifier = loginIdentifierField(body);
  if (identifier.type === "email") invalid("email", "Use password login for email accounts");
  return identifier as {type: "employee_number" | "employee_id"; value: string};
}

export function optionalDeviceName(body: JsonBody): string | undefined {
  return optionalString(body, ["device_name", "deviceName"], {
    min: 1,
    max: 120,
    label: "device_name",
  });
}

export function normaliseDevicePlatform(value: string | undefined): "ios" | "android" | "web" | "unknown" {
  if (!value) return "unknown";
  const normalised = value.toLowerCase();
  if (normalised === "ios" || normalised === "iphone" || normalised === "ipad") return "ios";
  if (normalised === "android") return "android";
  if (normalised === "web" || normalised === "browser") return "web";
  return "unknown";
}

export function parsePagination(url: URL): { page: number; limit: number; skip: number } {
  const rawPage = Number(url.searchParams.get("page") ?? "1");
  const rawLimit = Number(url.searchParams.get("limit") ?? "20");
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
  return { page, limit, skip: (page - 1) * limit };
}

export { COMMON_PASSWORDS, NAME_PATTERN, EMPLOYEE_IDENTIFIER_PATTERN };
