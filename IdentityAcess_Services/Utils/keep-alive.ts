import { logger } from "./logger.ts";

/**
 * Bun stops the whole process on an error nobody caught (a rejected promise with no handler,
 * an exception thrown from a timer). One such slip in a request would take the service down
 * and sign every user out, so it is logged with its details and the service keeps running.
 */
export function keepServiceAlive(service: string): void {
  const describe = (value: unknown) =>
    value instanceof Error ? { error: value.message, stack: value.stack?.split("\n").slice(0, 8).join("\n") } : { error: String(value) };
  process.on("unhandledRejection", (reason) => logger.error("process.unhandled_rejection", { service, ...describe(reason) }));
  process.on("uncaughtException", (error) => logger.error("process.uncaught_exception", { service, ...describe(error) }));
}
