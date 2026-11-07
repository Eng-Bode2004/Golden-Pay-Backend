import AuditLogModel, { type AuditEvent } from "../Models/AuditLogSchema.ts";
import type { RequestContext } from "../Utils/http.ts";
import { logger } from "../Utils/logger.ts";

export interface AuditInput {
  event: AuditEvent;
  userId?: string | null;
  employeeNumber?: string | null;
  actorId?: string | null;
  success: boolean;
  reason?: string | null;
  context?: Pick<RequestContext, "ip" | "requestId"> & { req?: Request };
  metadata?: Record<string, unknown>;
}

/**
 * Persists a security-relevant event. Auditing must never break the main
 * operation, so failures are logged and swallowed.
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    await AuditLogModel.create({
      event: input.event,
      user_id: input.userId ?? null,
      employee_number: input.employeeNumber ?? null,
      actor_id: input.actorId ?? null,
      success: input.success,
      reason: input.reason ?? null,
      ip: input.context?.ip ?? null,
      user_agent: input.context?.req?.headers.get("user-agent")?.slice(0, 512) ?? null,
      request_id: input.context?.requestId ?? null,
      metadata: input.metadata,
    });
  } catch (error) {
    logger.error("audit.write_failed", {
      event: input.event,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
