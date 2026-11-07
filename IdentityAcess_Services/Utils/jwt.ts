import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../Config/env.ts";
import { ApiError } from "./http.ts";
import { newId } from "./crypto.ts";

export interface JwtClaims {
  iss: string;
  aud: string;
  sub: string;
  typ: "access" | "signup";
  jti: string;
  iat: number;
  exp: number;
}

export interface AccessTokenClaims extends JwtClaims {
  typ: "access";
  sid: string;
  amr: "password" | "biometric";
}

export interface SignupTokenClaims extends JwtClaims {
  typ: "signup";
  purpose: "existing_employee_signup";
  account_type: "existing_employee";
  employee_number: string;
  employee_record_id: string;
}

interface StoredClaims {
  iss: string;
  aud: string;
  sub: string;
  typ: string;
  jti: string;
  iat: number;
  exp: number;
  [key: string]: unknown;
}

function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signInput(input: string): string {
  return createHmac("sha256", env.jwtSecret).update(input, "utf8").digest("base64url");
}

function issueJwt(
  claims: Record<string, unknown> & { sub: string; typ: string },
  ttlSeconds: number,
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload: StoredClaims = {
    ...claims,
    iss: env.jwtIssuer,
    aud: env.jwtAudience,
    jti: newId(),
    iat: now,
    exp: now + ttlSeconds,
  };

  const encodedHeader = encodeSegment(header);
  const encodedPayload = encodeSegment(payload);
  const input = `${encodedHeader}.${encodedPayload}`;
  return `${input}.${signInput(input)}`;
}

function decodeJwt(token: string): StoredClaims {
  if (typeof token !== "string" || token.length < 32 || token.length > 4096) {
    throw ApiError.unauthorized("Invalid or expired token");
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    throw ApiError.unauthorized("Invalid or expired token");
  }

  const [encodedHeader, encodedPayload, signature] = parts as [string, string, string];

  let header: { alg?: unknown; typ?: unknown };
  try {
    header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
  } catch {
    throw ApiError.unauthorized("Invalid or expired token");
  }

  if (header.alg !== "HS256" || header.typ !== "JWT") {
    throw ApiError.unauthorized("Invalid or expired token");
  }

  const expected = Buffer.from(signInput(`${encodedHeader}.${encodedPayload}`), "utf8");
  const provided = Buffer.from(signature, "utf8");
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    throw ApiError.unauthorized("Invalid or expired token");
  }

  let payload: StoredClaims;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    throw ApiError.unauthorized("Invalid or expired token");
  }

  if (
    payload.iss !== env.jwtIssuer ||
    payload.aud !== env.jwtAudience ||
    typeof payload.exp !== "number" ||
    typeof payload.iat !== "number" ||
    typeof payload.sub !== "string" ||
    typeof payload.typ !== "string"
  ) {
    throw ApiError.unauthorized("Invalid or expired token");
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now || payload.iat > now + 60) {
    throw ApiError.unauthorized("Invalid or expired token");
  }

  return payload;
}

export function signAccessToken(input: {
  user_id: string;
  session_id: string;
  auth_method: "password" | "biometric";
}): string {
  return issueJwt(
    {
      sub: input.user_id,
      typ: "access",
      sid: input.session_id,
      amr: input.auth_method,
    },
    env.accessTokenTtlSeconds,
  );
}

export function signSignupToken(input: {
  employee_record_id: string;
  employee_number: string;
}): string {
  return issueJwt(
    {
      sub: input.employee_record_id,
      typ: "signup",
      purpose: "existing_employee_signup",
      account_type: "existing_employee",
      employee_number: input.employee_number,
      employee_record_id: input.employee_record_id,
    },
    env.signupTokenTtlSeconds,
  );
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  const payload = decodeJwt(token);
  if (
    payload.typ !== "access" ||
    typeof payload.sid !== "string" ||
    !["password", "biometric"].includes(String(payload.amr))
  ) {
    throw ApiError.unauthorized("Invalid or expired token");
  }
  return payload as unknown as AccessTokenClaims;
}

export function verifySignupToken(token: string): SignupTokenClaims {
  const payload = decodeJwt(token);
  if (
    payload.typ !== "signup" ||
    payload.purpose !== "existing_employee_signup" ||
    payload.account_type !== "existing_employee" ||
    typeof payload.employee_number !== "string" ||
    typeof payload.employee_record_id !== "string"
  ) {
    throw ApiError.unauthorized("Invalid or expired signup token");
  }
  return payload as unknown as SignupTokenClaims;
}

export function extractBearerToken(req: Request): string {
  const header = req.headers.get("authorization");
  if (!header) return "";
  const [scheme, token] = header.split(" ");
  if (!scheme || !token || scheme.toLowerCase() !== "bearer") return "";
  return token.trim();
}
