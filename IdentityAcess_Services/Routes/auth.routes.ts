import { Router } from "../Utils/router.ts";
import { byIp, rateLimit, RATE_LIMITS } from "../MIddlewares/rateLimit.middleware.ts";
import { withAuth } from "../MIddlewares/auth.middleware.ts";
import {
  changePasswordController,
  loginController,
  logoutAllController,
  logoutController,
  refreshController,
  signupExistingCompleteController,
  signupExistingStartController,
  signupNewController,
} from "../Controllers/auth.controller.ts";
import {
  biometricChallengeController,
  biometricLoginController,
  listBiometricDevicesController,
  registerBiometricController,
  revokeBiometricDeviceController,
} from "../Controllers/biometric.controller.ts";

export function registerAuthRoutes(router: Router): void {
  router.post(
    "/auth/login",
    rateLimit("auth.login.ip", RATE_LIMITS.loginByIp, byIp)(loginController),
  );

  router.post(
    "/auth/signup/existing/start",
    rateLimit("auth.signup.start", RATE_LIMITS.signupStart, byIp)(
      signupExistingStartController,
    ),
  );
  router.post(
    "/auth/signup/existing/complete",
    rateLimit("auth.signup.complete", RATE_LIMITS.signupComplete, byIp)(
      signupExistingCompleteController,
    ),
  );
  router.post(
    "/auth/signup/new",
    rateLimit("auth.signup.new", RATE_LIMITS.signupComplete, byIp)(signupNewController),
  );

  router.post(
    "/auth/refresh",
    rateLimit("auth.refresh", RATE_LIMITS.refresh, byIp)(refreshController),
  );

  router.post("/auth/logout", withAuth(logoutController));
  router.post("/auth/logout-all", withAuth(logoutAllController));
  router.post("/auth/password/change", withAuth(changePasswordController));

  router.post("/auth/biometric/register", withAuth(registerBiometricController));
  router.post(
    "/auth/biometric/challenge",
    rateLimit("auth.biometric.challenge", RATE_LIMITS.biometric, byIp)(
      biometricChallengeController,
    ),
  );
  router.post(
    "/auth/biometric/login",
    rateLimit("auth.biometric.login", RATE_LIMITS.biometric, byIp)(
      biometricLoginController,
    ),
  );
  router.get("/auth/biometric/devices", withAuth(listBiometricDevicesController));
  router.delete(
    "/auth/biometric/devices/:credential_id",
    withAuth(revokeBiometricDeviceController),
  );
}
