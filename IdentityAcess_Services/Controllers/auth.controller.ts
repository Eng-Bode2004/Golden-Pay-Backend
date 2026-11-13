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
import { deviceMetadata } from "../Services/auth.service.ts";
import {
  assertGoogleUnused,
  googleConfigured,
  type GoogleIdentity,
  linkGoogle,
  loginWithGoogle,
  verifyGoogleToken,
} from "../Services/google.service.ts";
import { clearRateLimit, consumeRateLimit, RATE_LIMITS } from "../MIddlewares/rateLimit.middleware.ts";
import type { AuthContext } from "../MIddlewares/auth.middleware.ts";
import { AREA_LEVELS, hasWorkArea, parseWorkArea, saveWorkArea, type WorkArea } from "../../Shared/work-area.ts";

/**
 * The work area an investigator picked while signing up (checked before the account is made,
 * so a bad area never leaves a half-made account). Older app versions send none: null.
 */
function signupWorkArea(form: FormData): WorkArea | null {
  const body: Record<string, unknown> = {};
  for (const key of [...AREA_LEVELS, "street", "lat", "lng"]) {
    const value = form.get(key);
    if (typeof value !== "string" || value.trim() === "") continue;
    body[key] = key === "lat" || key === "lng" ? Number(value) : value;
  }
  return hasWorkArea(body) ? parseWorkArea(body) : null;
}

/** The account already exists: a failed save is logged, and the app asks again after login. */
async function keepWorkArea(area: WorkArea, userId: string): Promise<void> {
  try {
    await saveWorkArea(area, userId);
  } catch (error) {
    console.error("[signup] work area not saved", { userId, error: error instanceof Error ? error.message : String(error) });
  }
}

export async function loginController(context: RequestContext): Promise<Response> {
  const body = await readJson(context.req);
  const identifier = loginIdentifierField(body);
  const password = requiredString(body, "password", {
    min: 1,
    max: 128,
    label: "password",
    trim: false,
  });

  const key = `auth.login.account:${identifier.type}:${identifier.value}`;
  consumeRateLimit(key, RATE_LIMITS.loginByAccount);

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
  // The password was right: earlier tries no longer count, so signing in often (several
  // devices, a new tab, an expired session) never locks the account. Wrong passwords
  // still add up and lock after ten.
  clearRateLimit(key);

  return ok(result);
}

/** Sign in with Google; 404 GOOGLE_ACCOUNT_NOT_FOUND carries the name and email for sign-up. */
export async function googleLoginController(context: RequestContext): Promise<Response> {
  const body = await readJson(context.req);
  const result = await loginWithGoogle(
    body.id_token,
    deviceMetadata({
      deviceId: optionalDeviceId(body),
      deviceName: optionalDeviceName(body),
      platform: devicePlatform(body),
      context,
    }),
    context,
  );
  return ok(result);
}

/** Whether the app should show "Sign in with Google". */
export function googleStatusController(): Response {
  return ok({ enabled: googleConfigured() });
}

/** A sign-up may carry a Google ID token: its verified email is used and the account is linked. */
async function googleForSignup(form: FormData): Promise<GoogleIdentity | null> {
  const token = form.get("google_id_token");
  if (typeof token !== "string" || !token) return null;
  const identity = await verifyGoogleToken(token);
  await assertGoogleUnused(identity);
  form.set("email", identity.email);
  return identity;
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
  const area = signupWorkArea(form);
  const google = await googleForSignup(form);
  const result = await completeExistingEmployeeSignup(signupToken, form, context);
  if (google) await linkGoogle(result.user_id, google);
  if (area) await keepWorkArea(area, result.user_id);
  return created(result);
}

export async function signupNewController(context: RequestContext): Promise<Response> {
  const form = await readFormData(context.req);
  const area = signupWorkArea(form);
  const google = await googleForSignup(form);
  const result = await signupNewInvestigator(form, context);
  if (google) await linkGoogle(result.user_id, google);
  if (area) await keepWorkArea(area, result.user_id);
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
