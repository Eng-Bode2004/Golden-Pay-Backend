import type { RequestContext } from "../Utils/http.ts";
import { ApiError, created, noContent, ok, readJson } from "../Utils/http.ts";
import {
  deviceIdField,
  devicePlatform,
  optionalDeviceName,
  optionalLoginIdentifier,
  requiredEnum,
  requiredString,
} from "../Utils/validation.ts";
import {
  createBiometricChallenge,
  listBiometricCredentials,
  loginWithBiometric,
  registerBiometric,
  revokeBiometricCredential,
} from "../Services/biometric.service.ts";
import type { AuthContext } from "../MIddlewares/auth.middleware.ts";

const ALGORITHMS = ["ed25519", "es256", "rs256"] as const;

export async function registerBiometricController(
  context: RequestContext,
  auth: AuthContext,
): Promise<Response> {
  const body = await readJson(context.req);

  const result = await registerBiometric(
    auth.user,
    {
      deviceId: deviceIdField(body),
      deviceName: optionalDeviceName(body),
      platform: devicePlatform(body),
      publicKey: requiredString(body, ["public_key", "publicKey"], {
        min: 40,
        max: 8192,
        label: "public_key",
      }),
      algorithm: requiredEnum(body, "algorithm", ALGORITHMS),
    },
    context,
  );

  return created(result);
}

export async function biometricChallengeController(
  context: RequestContext,
): Promise<Response> {
  const body = await readJson(context.req);

  const challenge = await createBiometricChallenge({
    deviceId: deviceIdField(body),
    identifier: optionalLoginIdentifier(body),
  });

  return ok(challenge);
}

export async function biometricLoginController(
  context: RequestContext,
): Promise<Response> {
  const body = await readJson(context.req);

  const result = await loginWithBiometric(
    {
      challengeId: requiredString(body, "challenge_id", {
        min: 10,
        max: 100,
        label: "challenge_id",
      }),
      nonce: requiredString(body, "nonce", {
        min: 16,
        max: 200,
        label: "nonce",
        trim: false,
      }),
      signature: requiredString(body, "signature", {
        min: 40,
        max: 4096,
        label: "signature",
        trim: false,
      }),
    },
    context,
  );

  return ok(result);
}

export async function listBiometricDevicesController(
  _context: RequestContext,
  auth: AuthContext,
): Promise<Response> {
  const credentials = await listBiometricCredentials(auth.user.user_id);
  return ok({ devices: credentials });
}

export async function revokeBiometricDeviceController(
  context: RequestContext,
  auth: AuthContext,
): Promise<Response> {
  const credentialId = context.params.credential_id;
  if (!credentialId) {
    throw ApiError.badRequest("credential_id is required");
  }

  await revokeBiometricCredential(auth.user.user_id, credentialId, context);
  return noContent();
}
