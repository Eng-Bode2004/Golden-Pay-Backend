import type { RequestContext } from "../Utils/http.ts";
import {
  ApiError,
  created,
  ok,
  readFormData,
  readJson,
  readOptionalJson,
} from "../Utils/http.ts";
import {
  devicePlatform,
  employeeIdentifierField,
  loginIdentifierField,
  optionalDeviceId,
  optionalDeviceName,
  requiredString,
} from "../Utils/validation.ts";
import {
  changePassword,
  completeExistingEmployeeSignup,
  login,
  logout,
  logoutAll,
  refreshTokens,
  signupNewInvestigator,
  startExistingEmployeeSignup,
} from "../Services/auth.service.ts";
import { extractBearerToken } from "../Utils/jwt.ts";
import { consumeRateLimit, RATE_LIMITS } from "../MIddlewares/rateLimit.middleware.ts";
import type { AuthContext } from "../MIddlewares/auth.middleware.ts";

export async function loginController(context: RequestContext): Promise<Response> {
  const body = await readJson(context.req);
  const identifier = loginIdentifierField(body);
  const password = requiredString(body, "password", {
    min: 1,
    max: 128,
    label: "password",
    trim: false,
  });

  const key = `${identifier.type}:${identifier.value}`;
  consumeRateLimit(`auth.login.account:${key}`, RATE_LIMITS.loginByAccount);

  const result = await login(
    {
      identifier,
      password,
      deviceId: optionalDeviceId(body),
      deviceName: optionalDeviceName(body),
      platform: devicePlatform(body),
    },
    context,
  );

  return ok(result);
}

export async function signupExistingStartController(
  context: RequestContext,
): Promise<Response> {
  const body = await readJson(context.req);
  const employeeNumber = employeeIdentifierField(body, "employee_number", "employee_number");
  const result = await startExistingEmployeeSignup(employeeNumber, context);
  return ok(result);
}

export async function signupExistingCompleteController(
  context: RequestContext,
): Promise<Response> {
  const signupToken = extractBearerToken(context.req);
  if (!signupToken) {
    throw new ApiError(
      401,
      "SIGNUP_TOKEN_REQUIRED",
      "The signup token returned by /auth/signup/existing/start is required",
      { headers: { "WWW-Authenticate": "Bearer" } },
    );
  }

  const form = await readFormData(context.req);
  const result = await completeExistingEmployeeSignup(signupToken, form, context);
  return created(result);
}

export async function signupNewController(context: RequestContext): Promise<Response> {
  const form = await readFormData(context.req);
  const result = await signupNewInvestigator(form, context);
  return created(result);
}

export async function refreshController(context: RequestContext): Promise<Response> {
  const body = await readJson(context.req);
  const refreshToken = requiredString(body, "refresh_token", {
    min: 20,
    max: 512,
    label: "refresh_token",
    trim: false,
  });

  const result = await refreshTokens(refreshToken, context);
  return ok(result);
}

export async function logoutController(
  context: RequestContext,
  auth: AuthContext,
): Promise<Response> {
  const body = await readOptionalJson(context.req);
  const refreshToken =
    typeof body.refresh_token === "string" && body.refresh_token.length > 0
      ? body.refresh_token
      : undefined;

  await logout(auth.user.user_id, auth.sessionId, refreshToken, context);
  return ok({ message: "Signed out successfully" });
}

export async function logoutAllController(
  context: RequestContext,
  auth: AuthContext,
): Promise<Response> {
  await logoutAll(auth.user.user_id, auth.sessionId, context);
  return ok({ message: "Signed out from all devices" });
}

export async function changePasswordController(
  context: RequestContext,
  auth: AuthContext,
): Promise<Response> {
  const body = await readJson(context.req);
  const currentPassword = requiredString(body, "current_password", {
    min: 1,
    max: 128,
    label: "current_password",
    trim: false,
  });
  const newPassword = requiredString(body, "new_password", {
    min: 1,
    max: 128,
    label: "new_password",
    trim: false,
  });
  const confirmPassword = requiredString(
    body,
    ["confirm_password", "confirmPassword"],
    {
      min: 1,
      max: 128,
      label: "confirm_password",
      trim: false,
    },
  );

  await changePassword({
    userId: auth.user.user_id,
    currentPassword,
    newPassword,
    confirmPassword,
    currentSessionId: auth.sessionId,
    context,
  });

  return ok({
    message:
      "Password changed successfully. Other sessions and biometric sign-in have been revoked.",
  });
}
