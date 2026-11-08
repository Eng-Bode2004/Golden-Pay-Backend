import { SqlModel, type SqlDocument } from "./SqlModel.ts";
const AUDIT_EVENTS = [
  "auth.login.password", "auth.login.biometric", "auth.login.failed", "auth.refresh",
  "auth.refresh.reuse_detected", "auth.refresh.retry", "auth.logout", "auth.password.changed", "profile.updated",
  "signup.existing.started", "signup.existing.completed", "signup.new.completed", "account.approved",
  "account.rejected", "account.suspended", "account.reactivated", "biometric.registered",
  "biometric.revoked", "employee.imported", "role.assigned", "user.created_by_admin",
  "admin.created", "auth.mfa.verified", "auth.email_otp.verified", "admin.mfa.enrolled", "admin.mfa.disabled", "admin.mfa.method.email", "admin.mfa.method.changed", "admin.mfa_policy.changed",
  "admin.invited", "admin.invite.resent", "admin.invite.revoked",
  "headoffice.settings.updated", "headoffice.points.given", "headoffice.points.revoked", "headoffice.salary.updated",
  "headoffice.payroll.adjusted", "headoffice.payroll.adjustment_removed", "headoffice.payroll.paid",
  "headoffice.payroll.payment_undone", "headoffice.expense.created", "headoffice.expense.removed", "headoffice.complaint.status",
  "investigation.created", "investigation.claimed", "investigation.submitted", "investigation.approved",
  "investigation.returned", "investigation.cancelled", "pricing.updated", "form.updated",
  "template.file_uploaded", "template.version_drafted", "template.updated", "template.returned",
  "template.approved", "template.activated",
] as const;
export type AuditEvent = (typeof AUDIT_EVENTS)[number];
export interface AuditLog {
  event: AuditEvent;
  user_id?: string | null;
  employee_number?: string | null;
  actor_id?: string | null;
  success: boolean;
  reason?: string | null;
  ip?: string | null;
  user_agent?: string | null;
  request_id?: string | null;
  metadata?: unknown;
  created_at: Date;
}
export type AuditLogDocument = SqlDocument<AuditLog>;
export default new SqlModel<AuditLog>("audit_logs", `event user_id employee_number actor_id success
  reason ip user_agent request_id metadata created_at`);
