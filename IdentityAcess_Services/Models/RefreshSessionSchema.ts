import { SqlModel, type SqlDocument } from "./SqlModel.ts";
export interface RefreshSession {
  session_id: string;
  user_id: string;
  refresh_token_hash: string;
  auth_method: "password" | "biometric" | "google";
  device_id?: string | null;
  device_name?: string | null;
  platform?: "ios" | "android" | "web" | "unknown";
  ip?: string | null;
  user_agent?: string | null;
  created_at: Date;
  last_used_at?: Date | null;
  expires_at: Date;
  revoked_at?: Date | null;
  revoked_reason?: string | null;
  replaced_by_session_id?: string | null;
}
export type RefreshSessionDocument = SqlDocument<RefreshSession>;
export default new SqlModel<RefreshSession>("refresh_sessions", `session_id user_id refresh_token_hash
  auth_method device_id device_name platform ip user_agent created_at last_used_at expires_at
  revoked_at revoked_reason replaced_by_session_id`);
