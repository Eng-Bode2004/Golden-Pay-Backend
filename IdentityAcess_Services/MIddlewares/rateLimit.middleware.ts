import { ApiError, type RequestContext } from "../Utils/http.ts";
import type { Middleware, RouteHandler } from "../Utils/router.ts";

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  message?: string;
}

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 50_000;

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 5 * 60 * 1000);
(cleanupTimer as unknown as { unref?: () => void }).unref?.();

/**
 * Fixed-window counter. Suitable for a single instance; use Redis for a
 * horizontally scaled deployment.
 */
export function consumeRateLimit(
  key: string,
  options: RateLimitOptions,
): { remaining: number; resetAt: number } {
  const now = Date.now();
  let bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + options.windowMs };
    if (buckets.size >= MAX_BUCKETS) buckets.clear();
    buckets.set(key, bucket);
  }

  bucket.count += 1;
  const remaining = Math.max(0, options.max - bucket.count);

  if (bucket.count > options.max) {
    const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
    throw ApiError.tooManyRequests(
      options.message ?? "Too many requests, please try again later",
      retryAfter,
    );
  }

  return { remaining, resetAt: bucket.resetAt };
}

export function rateLimit(
  name: string,
  options: RateLimitOptions,
  key: (context: RequestContext) => string,
): Middleware {
  return (handler: RouteHandler): RouteHandler =>
    async (context) => {
      const state = consumeRateLimit(`${name}:${key(context)}`, options);
      const response = await handler(context);

      try {
        response.headers.set("X-RateLimit-Limit", String(options.max));
        response.headers.set("X-RateLimit-Remaining", String(state.remaining));
        response.headers.set("X-RateLimit-Reset", String(Math.ceil(state.resetAt / 1000)));
      } catch {
        // Some response types expose immutable headers; rate limit headers are optional.
      }

      return response;
    };
}

export function byIp(context: RequestContext): string {
  return context.ip;
}

export const RATE_LIMITS = {
  loginByIp: { windowMs: 15 * 60 * 1000, max: 30, message: "Too many login attempts, try again later" },
  loginByAccount: {
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: "Too many login attempts for this account, try again later",
  },
  signupStart: {
    windowMs: 60 * 60 * 1000,
    max: 20,
    message: "Too many signup attempts, try again later",
  },
  signupComplete: {
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: "Too many signup attempts, try again later",
  },
  refresh: { windowMs: 15 * 60 * 1000, max: 120, message: "Too many refresh requests" },
  biometric: {
    windowMs: 15 * 60 * 1000,
    max: 30,
    message: "Too many biometric attempts, try again later",
  },
  adminWrite: {
    windowMs: 60 * 60 * 1000,
    max: 60,
    message: "Too many administrative requests",
  },
} as const;
