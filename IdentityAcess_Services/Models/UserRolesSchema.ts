import { SqlModel, type SqlDocument } from "./SqlModel.ts";
export interface UserRole {
  user_id: string;
  role_id: string;
  assigned_by?: string | null;
  assigned_at: Date;
}
export type UserRoleDocument = SqlDocument<UserRole>;
export default new SqlModel<UserRole>("user_roles", "user_id role_id assigned_by assigned_at");
