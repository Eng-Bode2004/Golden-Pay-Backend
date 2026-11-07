import { env } from "../Config/env.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly headers?: Record<string, string>;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { details?: unknown; headers?: Record<string, string>; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.headers = options.headers;
  }

  static badRequest(message: string, details?: unknown): ApiError {
    return new ApiError(400, "BAD_REQUEST", message, { details });
  }

  static unauthorized(message = "Authentication is required"): ApiError {
    return new ApiError(401, "UNAUTHORIZED", message);
  }

  static forbidden(message = "You are not allowed to perform this action"): ApiError {
    return new ApiError(403, "FORBIDDEN", message);
  }

  static notFound(message = "Resource not found"): ApiError {
    return new ApiError(404, "NOT_FOUND", message);
  }

  static conflict(message: string, details?: unknown): ApiError {
    return new ApiError(409, "CONFLICT", message, { details });
  }

  static tooManyRequests(message: string, retryAfterSeconds?: number): ApiError {
    return new ApiError(429, "TOO_MANY_REQUESTS", message, {
      headers: retryAfterSeconds
        ? { "Retry-After": String(Math.max(1, Math.ceil(retryAfterSeconds))) }
        : undefined,
    });
  }

  static payloadTooLarge(message = "Request body is too large"): ApiError {
    return new ApiError(413, "PAYLOAD_TOO_LARGE", message);
  }
}

export interface RequestContext {
  readonly req: Request;
  readonly url: URL;
  readonly params: Record<string, string>;
  readonly requestId: string;
  readonly ip: string;
}

export interface SuccessBody<T> {
  success: true;
  data: T;
  request_id?: string;
}

export interface ErrorBody {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  request_id?: string;
}

export function ok<T>(data: T, init: ResponseInit = {}): Response {
  return jsonResponse({ success: true, data }, 200, init);
}

export function created<T>(data: T): Response {
  return jsonResponse({ success: true, data }, 201);
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

export function jsonResponse(
  body: unknown,
  status = 200,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers as unknown as Record<string, string> | undefined);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { ...init, status, headers });
}

export function errorResponse(error: ApiError, requestId?: string): Response {
  const body: ErrorBody = {
    success: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    },
    ...(requestId ? { request_id: requestId } : {}),
  };

  const headers = new Headers(error.headers);
  headers.set("Cache-Control", "no-store");
  return jsonResponse(body, error.status, { headers });
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw ApiError.badRequest("Content-Type must be application/json");
  }

  const declaredLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > env.maxJsonBytes) {
    throw ApiError.payloadTooLarge();
  }

  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > env.maxJsonBytes) {
    throw ApiError.payloadTooLarge();
  }
  if (text.trim().length === 0) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw ApiError.badRequest("Request body must contain valid JSON");
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw ApiError.badRequest("Request body must be a JSON object");
  }

  return parsed as Record<string, unknown>;
}

/** Accepts a missing body (e.g. logout without a refresh token). */
export async function readOptionalJson(req: Request): Promise<Record<string, unknown>> {
  const contentType = req.headers.get("content-type") ?? "";
  const declaredLength = Number(req.headers.get("content-length") ?? "0");

  if (!contentType.toLowerCase().includes("application/json")) return {};
  if (Number.isFinite(declaredLength) && declaredLength === 0) return {};

  return readJson(req);
}

export async function readFormData(req: Request): Promise<FormData> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    throw ApiError.badRequest("Content-Type must be multipart/form-data");
  }

  const declaredLength = Number(req.headers.get("content-length") ?? "0");
  // Two ID images plus form fields; allow the transport overhead on top of the configured cap.
  const maxBody = env.maxUploadBytes * 2 + env.maxJsonBytes;
  if (Number.isFinite(declaredLength) && declaredLength > maxBody) {
    throw ApiError.payloadTooLarge("Uploaded files are too large");
  }

  try {
    // Bun returns its own FormData at runtime; the DOM lib types differ slightly.
    return (await req.formData()) as unknown as FormData;
  } catch {
    throw ApiError.badRequest("Malformed multipart/form-data body");
  }
}

export function getClientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  return "unknown";
}

export function getUserAgent(req: Request): string {
  return (req.headers.get("user-agent") ?? "unknown").slice(0, 512);
}
