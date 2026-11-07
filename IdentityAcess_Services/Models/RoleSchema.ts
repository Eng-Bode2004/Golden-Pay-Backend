import { SqlModel, type SqlDocument } from "./SqlModel.ts";
export interface Role {
  role_id: string;
  name: string;
  description?: string | null;
  is_system?: boolean;
  created_at: Date;
  updated_at: Date;
}
export type RoleDocument = SqlDocument<Role>;
export default new SqlModel<Role>("roles", "role_id name description is_system created_at updated_at");
