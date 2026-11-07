import { SqlModel, type SqlDocument } from "./SqlModel.ts";

export const ACCOUNT_TYPES = ["existing_employee", "new_investigator"] as const;
export const ACCOUNT_STATUSES = ["pending_verification", "pending_approval", "active", "rejected", "suspended"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];
export interface User {
  user_id: string;
  employee_id?: string | null;
  employee_number?: string | null;
  full_name: string;
  phone: string;
  phone_verified_at?: Date | null;
  email?: string | null;
  national_id_encrypted: string;
  national_id_hash: string;
  national_id_last4: string;
  FrontID_image: string;
  BackID_image: string;
  profile_image: string;
  password_hash: string;
  password_changed_at?: Date | null;
  account_type: AccountType;
  status: AccountStatus;
  status_reason?: string | null;
  approved_at?: Date | null;
  approved_by?: string | null;
  rejected_at?: Date | null;
  failed_login_attempts?: number;
  locked_until?: Date | null;
  last_login_at?: Date | null;
  biometric_enabled?: boolean;
  deleted_at?: Date | null;
  created_at: Date;
  updated_at: Date;
}
export type UserDocument = SqlDocument<User>;
export default new SqlModel<User>("users", `user_id employee_id employee_number full_name phone
  phone_verified_at email national_id_encrypted national_id_hash national_id_last4 FrontID_image
  BackID_image profile_image password_hash password_changed_at account_type status status_reason approved_at
  approved_by rejected_at failed_login_attempts locked_until last_login_at biometric_enabled
  deleted_at created_at updated_at`, ["password_hash", "national_id_encrypted", "national_id_hash",
    "FrontID_image", "BackID_image", "profile_image", "failed_login_attempts", "locked_until"]);
