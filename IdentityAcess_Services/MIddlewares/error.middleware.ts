import { DatabaseConflict, isConnectionError } from "../Config/db.ts";
import { ApiError } from "../Utils/http.ts";
import { env } from "../Config/env.ts";
import { logger } from "../Utils/logger.ts";

const DUPLICATE_MESSAGES: Record<string, string> = {
  employee_number: "An account with this employee number already exists",
  employee_id: "An account with this employee ID already exists",
  phone: "An account with this phone number already exists",
  email: "An account with this email address already exists",
  national_id_hash: "An account with this national ID already exists",
  session_id: "Session already exists",
  refresh_token_hash: "Token collision, please retry",
  challenge_id: "Challenge already exists",
  credential_id: "Credential already exists",
};

export function toApiError(error: unknown, requestId: string): ApiError {
  if (error instanceof ApiError) return error;

  if (error instanceof DatabaseConflict) {
    return new ApiError(
      409,
      "ACCOUNT_ALREADY_EXISTS",
      DUPLICATE_MESSAGES[error.field] ?? "A record with these details already exists",
      { details: { field: error.field } },
    );
  }

  if (error instanceof SyntaxError) {
    return new ApiError(400, "BAD_REQUEST", "Request body must contain valid JSON");
  }

  if (isConnectionError(error)) {
    logger.error("postgresql.unreachable", {
      request_id: requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    return new ApiError(
      503,
      "DATABASE_UNAVAILABLE",
      "تعذّر الاتصال بقاعدة البيانات الآن، ولم يُحفظ شيء. حاول مرة أخرى بعد قليل.",
    );
  }

  logger.error("request.unhandled", {
    request_id: requestId,
    error: error instanceof Error ? error.message : String(error),
    ...(env.isProduction
      ? {}
      : { stack: error instanceof Error ? error.stack?.split("\n").slice(0, 8) : undefined }),
  });

  return new ApiError(500, "INTERNAL_ERROR", "An unexpected error occurred");
}
