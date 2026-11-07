import { Router } from "../Utils/router.ts";
import { withAuth } from "../MIddlewares/auth.middleware.ts";
import { byIp, rateLimit, RATE_LIMITS, consumeRateLimit } from "../MIddlewares/rateLimit.middleware.ts";
import { ApiError, ok, created, readJson } from "../Utils/http.ts";
import { requiredString, optionalEmail, optionalString, validatePassword } from "../Utils/validation.ts";
import UserModel from "../Models/UserSchema.ts";
import { assertAccountActive } from "../Services/auth.service.ts";
import { createSession } from "../Services/session.service.ts";
import { toPublicUser } from "../Services/user.service.ts";
import { getUserAccess } from "../Services/rbac.service.ts";
import {
  acceptInvitation,
  activateTotp,
  beginTotpEnrollment,
  createInvitation,
  disableMfa,
  finishMfa,
  listAdministrators,
  listInvitations,
  peekInvitation,
  provisionAdministrator,
  requireOwner,
  resendInvitation,
  revokeInvitation,
  security,
  securitySummary,
  setPolicy,
  switchTotpMode,
} from "../Services/admin-security.service.ts";
import { beginEmailOtp, confirmEmailOtpSwitch } from "../Services/email-otp.service.ts";

export function registerAdminSecurityRoutes(router: Router) {
  router.post("/auth/mfa/verify", rateLimit("mfa.verify", RATE_LIMITS.loginByIp, byIp)(async context => {
    const body = await readJson(context.req);
    const result = await finishMfa(requiredString(body, "challenge_token", {max: 128}), requiredString(body, "code", {max: 32}), context);
    if (result.next) return ok({ mfa_next: result.next });
    const user = await UserModel.findOne({user_id: result.userId, deleted_at: null});
    if (!user) throw new ApiError(401, "INVALID_CREDENTIALS", "Account unavailable");
    assertAccountActive(user);
    const tokens = await createSession(user, "password", {platform: "web", ip: context.ip, userAgent: context.req.headers.get("user-agent") ?? ""});
    return ok({...tokens, user: toPublicUser(user, (await getUserAccess(user.user_id)).roles), recovery_codes: result.recoveryCodes});
  }));

  router.get("/auth/admin-invite/:token", rateLimit("invite.peek", RATE_LIMITS.loginByIp, byIp)(async context => {
    return ok(await peekInvitation(context.params.token!));
  }));

  router.post("/auth/admin-invite/accept", rateLimit("invite.accept", RATE_LIMITS.signupComplete, byIp)(async context => {
    const body = await readJson(context.req);
    const token = requiredString(body, "token", { max: 128 });
    const password = validatePassword(body.password);
    const fullName = optionalString(body, "full_name", { min: 2, max: 120, label: "full_name" }) ?? "";
    return ok(await acceptInvitation({ token, password, fullName, context }));
  }));

  router.get("/admin/security", withAuth(async (_context, auth) => {
    return ok(await securitySummary(auth.user.user_id) ?? {
      is_owner: false,
      mfa_required: false,
      mfa_method: "totp",
      enrolled: false,
      pending_enrollment: false,
      recovery_codes_remaining: 0,
    });
  }));

  router.post("/auth/mfa/totp/setup", withAuth(async (_context, auth) => {
    consumeRateLimit(`mfa.setup:${auth.user.user_id}`, RATE_LIMITS.adminWrite);
    return ok(await beginTotpEnrollment(
      auth.user.user_id,
      auth.user.email ?? auth.user.employee_number ?? auth.user.full_name,
    ));
  }));

  router.post("/auth/mfa/totp/activate", withAuth(async (context, auth) => {
    consumeRateLimit(`mfa.activate:${auth.user.user_id}`, RATE_LIMITS.loginByAccount);
    const body = await readJson(context.req);
    if (body.mode !== undefined && body.mode !== "totp" && body.mode !== "both") {
      throw new ApiError(400, "VALIDATION_ERROR", "mode must be totp or both");
    }
    return ok(await activateTotp(
      auth.user.user_id,
      requiredString(body, "code", { max: 8 }),
      context,
      body.mode === "both" ? "both" : "totp",
    ));
  }));

  router.post("/auth/mfa/totp/mode", withAuth(async (context, auth) => {
    consumeRateLimit(`mfa.mode:${auth.user.user_id}`, RATE_LIMITS.loginByAccount);
    const body = await readJson(context.req);
    const password = requiredString(body, "password", { max: 256 });
    const account = await UserModel.findOne({ user_id: auth.user.user_id }).select("+password_hash");
    if (!account || !await Bun.password.verify(password, account.password_hash)) {
      throw new ApiError(403, "INVALID_CREDENTIALS", "Confirm your password to change the sign-in method");
    }
    if (body.method !== "totp" && body.method !== "both") {
      throw new ApiError(400, "VALIDATION_ERROR", "method must be totp or both");
    }
    return ok(await switchTotpMode(auth.user.user_id, body.method, context));
  }));

  router.post("/auth/mfa/totp/disable", withAuth(async (context, auth) => {
    consumeRateLimit(`mfa.disable:${auth.user.user_id}`, RATE_LIMITS.loginByAccount);
    const body = await readJson(context.req);
    const password = requiredString(body, "password", { max: 256 });
    const account = await UserModel.findOne({ user_id: auth.user.user_id }).select("+password_hash");
    if (!account || !await Bun.password.verify(password, account.password_hash)) {
      throw new ApiError(403, "INVALID_CREDENTIALS", "Confirm your password to disable two-step verification");
    }
    await disableMfa(auth.user.user_id, context, auth.user.user_id);
    return ok({ disabled: true });
  }));

  router.post("/auth/mfa/email/start", withAuth(async (context, auth) => {
    consumeRateLimit(`mfa.email.start:${auth.user.user_id}`, RATE_LIMITS.loginByAccount);
    const body = await readJson(context.req);
    const password = requiredString(body, "password", { max: 256 });
    const account = await UserModel.findOne({ user_id: auth.user.user_id }).select("+password_hash");
    if (!account || !await Bun.password.verify(password, account.password_hash)) {
      throw new ApiError(403, "INVALID_CREDENTIALS", "Confirm your password to change the sign-in method");
    }
    if (!await security(auth.user.user_id)) throw ApiError.forbidden("Administrator account required");
    if (!auth.user.email) throw new ApiError(400, "VALIDATION_ERROR", "This account has no email address for verification codes");
    return ok(await beginEmailOtp(auth.user.user_id, auth.user.email));
  }));

  router.post("/auth/mfa/email/confirm", withAuth(async (context, auth) => {
    consumeRateLimit(`mfa.email.confirm:${auth.user.user_id}`, RATE_LIMITS.loginByAccount);
    const body = await readJson(context.req);
    await confirmEmailOtpSwitch(
      auth.user.user_id,
      requiredString(body, "challenge_token", { max: 128 }),
      requiredString(body, "code", { max: 16 }),
      context,
    );
    return ok({ enabled: true, mfa_required: true, mfa_method: "email" });
  }));

  router.get("/admin/administrators", withAuth(async (_context, auth) => {
    await requireOwner(auth.user.user_id);
    return ok({administrators: await listAdministrators()});
  }));

  router.post("/admin/administrators", withAuth(async (context, auth) => {
    await requireOwner(auth.user.user_id);
    consumeRateLimit(`admin.create:${auth.user.user_id}`, RATE_LIMITS.adminWrite);
    const body = await readJson(context.req);
    const email = optionalEmail(body);
    if (!email) throw new ApiError(400, "VALIDATION_ERROR", "Email is required");
    const password = validatePassword(body.password);
    const fullName = requiredString(body, "full_name", {min: 2, max: 120});
    if (typeof body.mfa_required !== "boolean") throw new ApiError(400, "VALIDATION_ERROR", "Select an authentication policy");
    return created(await provisionAdministrator({
      email,
      password,
      fullName,
      mfaRequired: body.mfa_required,
      actorId: auth.user.user_id,
      context,
    }));
  }));

  router.get("/admin/administrators/invitations", withAuth(async (_context, auth) => {
    await requireOwner(auth.user.user_id);
    return ok({ invitations: await listInvitations(), from: "goldenpayservices@gmail.com" });
  }));

  router.post("/admin/administrators/invitations", withAuth(async (context, auth) => {
    await requireOwner(auth.user.user_id);
    consumeRateLimit(`admin.invite:${auth.user.user_id}`, RATE_LIMITS.adminWrite);
    const body = await readJson(context.req);
    const email = optionalEmail(body);
    if (!email) throw new ApiError(400, "VALIDATION_ERROR", "Email is required");
    const fullName = optionalString(body, "full_name", { min: 2, max: 120, label: "full_name" }) ?? "";
    if (body.mfa_required !== undefined && typeof body.mfa_required !== "boolean") throw new ApiError(400, "VALIDATION_ERROR", "Invalid authentication policy");
    return created(await createInvitation({
      email,
      fullName,
      mfaRequired: body.mfa_required === true,
      actorId: auth.user.user_id,
      context,
    }));
  }));

  router.post("/admin/administrators/invitations/:id/resend", withAuth(async (context, auth) => {
    await requireOwner(auth.user.user_id);
    consumeRateLimit(`admin.invite.resend:${auth.user.user_id}`, RATE_LIMITS.adminWrite);
    return ok(await resendInvitation(context.params.id!, auth.user.user_id, context));
  }));

  router.delete("/admin/administrators/invitations/:id", withAuth(async (context, auth) => {
    await requireOwner(auth.user.user_id);
    return ok(await revokeInvitation(context.params.id!, auth.user.user_id, context));
  }));

  router.post("/admin/administrators/:id/policy", withAuth(async (context, auth) => {
    await requireOwner(auth.user.user_id);
    consumeRateLimit(`admin.policy:${auth.user.user_id}`, RATE_LIMITS.loginByAccount);
    const body = await readJson(context.req);
    const id = context.params.id!;
    if (!await security(id)) throw new ApiError(404, "NOT_FOUND", "Administrator not found");
    const owner = await UserModel.findOne({user_id: auth.user.user_id}).select("+password_hash");
    if (!owner || typeof body.password !== "string" || !await Bun.password.verify(body.password, owner.password_hash)) throw new ApiError(403, "INVALID_CREDENTIALS", "Confirm your password");
    if (typeof body.mfa_required !== "boolean") throw new ApiError(400, "VALIDATION_ERROR", "Select an authentication policy");
    await setPolicy(id, body.mfa_required, context, auth.user.user_id);
    return ok({updated: true});
  }));
}
