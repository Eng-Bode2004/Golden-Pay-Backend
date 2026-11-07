import { SqlModel, type SqlDocument } from "./SqlModel.ts";
export interface RolePermission {
  role_id: string;
  permission_id: string;
  created_at: Date;
  updated_at: Date;
}
export type RolePermissionDocument = SqlDocument<RolePermission>;
export default new SqlModel<RolePermission>("role_permissions", "role_id permission_id created_at updated_at");
