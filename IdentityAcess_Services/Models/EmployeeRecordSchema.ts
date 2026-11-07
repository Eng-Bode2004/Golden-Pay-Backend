import { SqlModel, type SqlDocument } from "./SqlModel.ts";
export const EMPLOYEE_RECORD_STATUSES = ["available", "registered", "inactive"] as const;
export type EmployeeRecordStatus = (typeof EMPLOYEE_RECORD_STATUSES)[number];
export interface EmployeeRecord {
  employee_id: string;
  employee_number: string;
  full_name: string;
  phone: string;
  email?: string | null;
  national_id_hash: string;
  national_id_last4: string;
  department?: string | null;
  position?: string | null;
  status: EmployeeRecordStatus;
  user_id?: string | null;
  registered_at?: Date | null;
  imported_by?: string | null;
  created_at: Date;
  updated_at: Date;
}
export type EmployeeRecordDocument = SqlDocument<EmployeeRecord>;
export default new SqlModel<EmployeeRecord>("employee_records", `employee_id employee_number
  full_name phone email national_id_hash national_id_last4 department position status user_id
  registered_at imported_by created_at updated_at`, ["national_id_hash"]);
