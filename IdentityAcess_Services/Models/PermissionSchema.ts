import { SqlModel, type SqlDocument } from "./SqlModel.ts";
export interface Permission {
  permission_id: string;
  code: string;
  description?: string | null;
  created_at: Date;
  updated_at: Date;
}
export type PermissionDocument = SqlDocument<Permission>;
export default new SqlModel<Permission>("permissions", "permission_id code description created_at updated_at");
