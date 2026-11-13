// Sign-in protection: wrong passwords add up and lock the account for a while; a correct
// password clears the count, so signing in often never locks anyone out.
import { expect, test } from "bun:test";
import { clearRateLimit, consumeRateLimit } from "./rateLimit.middleware.ts";

const limit = { windowMs: 60_000, max: 3, message: "Too many login attempts for this account, try again later" };

test("attempts past the limit are refused", () => {
  const key = `test.lock:${crypto.randomUUID()}`;
  for (let i = 0; i < 3; i++) consumeRateLimit(key, limit);
  expect(() => consumeRateLimit(key, limit)).toThrow("Too many login attempts");
});

test("a correct password clears the count", () => {
  const key = `test.clear:${crypto.randomUUID()}`;
  // Many successful sign-ins in a row: each clears the count after it.
  for (let i = 0; i < 10; i++) {
    consumeRateLimit(key, limit);
    clearRateLimit(key);
  }
  expect(() => consumeRateLimit(key, limit)).not.toThrow();
});
