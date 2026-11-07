import { SqlModel, type SqlDocument } from "./SqlModel.ts";
export interface BiometricCredential {
  credential_id: string;
  user_id: string;
  device_id: string;
  device_name?: string | null;
  platform?: "ios" | "android" | "web" | "unknown";
  public_key: string;
  algorithm: "ed25519" | "es256" | "rs256";
  status: "active" | "revoked";
  last_used_at?: Date | null;
  revoked_at?: Date | null;
  created_at: Date;
  updated_at: Date;
}
export type BiometricCredentialDocument = SqlDocument<BiometricCredential>;
export default new SqlModel<BiometricCredential>("biometric_credentials", `credential_id user_id
  device_id device_name platform public_key algorithm status last_used_at revoked_at created_at updated_at`);
