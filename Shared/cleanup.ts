// Permanent clean-ups: deleting investigations with their stored files, deleting an
// investigator with everything that belongs to them, and clearing test data (all
// investigations, investigators' points and money). Nothing here can be undone.
import { query, transaction } from "../IdentityAcess_Services/Config/db.ts";
import { ApiError } from "../IdentityAcess_Services/Utils/http.ts";
import { deleteStoredFiles } from "../IdentityAcess_Services/Utils/files.ts";

/** Investigators: the field-staff role, never an administrator, HR or head office. */
export const INVESTIGATOR_IDS_SQL = `
  SELECT ur.user_id FROM user_roles ur JOIN roles r ON r.role_id = ur.role_id
  GROUP BY ur.user_id
  HAVING bool_or(r.name = 'employee') AND NOT bool_or(r.name IN ('admin', 'hr', 'head_office'))`;

/** Not finished yet: still with the investigator or waiting for one. */
const OPEN_STATUSES = ["open", "assigned", "in_progress", "returned"];

async function filesOf(where: string, params: unknown[]): Promise<string[]> {
  const rows = await query(
    `SELECT pdf_path AS path FROM investigations WHERE ${where} AND pdf_path IS NOT NULL
     UNION ALL SELECT report_docx_path FROM investigations WHERE ${where} AND report_docx_path IS NOT NULL
     UNION ALL SELECT path FROM investigation_images
       WHERE investigation_id IN (SELECT investigation_id FROM investigations WHERE ${where})`,
    params,
  );
  return rows.map((row) => String(row.path)).filter(Boolean);
}

/**
 * Deletes investigations (all of them when `where` is "true"). Their photos, events,
 * locations, offers and dispatch records go with them; their PDFs, Word reports and
 * photos are removed from storage. Returns how many were deleted.
 */
export async function purgeInvestigations(where: string, params: unknown[] = []): Promise<{ investigations: number; files: number }> {
  const files = await filesOf(where, params);
  const deleted = await query(`DELETE FROM investigations WHERE ${where} RETURNING investigation_id`, params);
  // Storage is cleaned after the rows are gone; a file that fails to delete is only space.
  await deleteStoredFiles(files);
  return { investigations: deleted.length, files: files.length };
}

export interface InvestigationDeletion {
  investigation_id: string;
  reference: string;
  status: string;
  files_deleted: number;
  /** Excuses made on the case; their charges were taken off the investigators' payroll. */
  excuses_cancelled: number;
  charges_removed: number;
  notifications_deleted: number;
  emails_deleted: number;
  /** Set when the case came from an email: that email case is marked as rejected. */
  mail_case_closed: boolean;
}

/** Tables another service creates; one it has not created yet holds nothing to delete. */
async function tableExists(name: string): Promise<boolean> {
  const [row] = await query("SELECT to_regclass($1) IS NOT NULL AS present", [`public.${name}`]);
  return Boolean(row?.present);
}

/**
 * Deletes one investigation and everything about it: its photos (the investigator's selfie
 * and ID too), reports, events, trail, offers, assignments and dispatch records; its excuses
 * with their payroll charges; its notifications and the report emails sent for it. Its stored
 * files are removed. An approved case's pay and price leave the month's totals with it.
 * A case that came from an email is marked rejected there, so it is not sent out again.
 */
export async function deleteInvestigation(investigationId: string): Promise<InvestigationDeletion> {
  const [row] = await query("SELECT investigation_id, reference, status FROM investigations WHERE investigation_id = $1", [
    investigationId,
  ]);
  if (!row) throw ApiError.notFound("Investigation not found");
  const files = await filesOf("investigation_id = $1", [investigationId]);
  const [hasNotifications, hasMailSent, hasMailCases] = [
    await tableExists("notifications"),
    await tableExists("mail_sent"),
    await tableExists("mail_cases"),
  ];

  const counts = await transaction(async () => {
    const excuses = await query("DELETE FROM investigation_excuses WHERE investigation_id = $1 RETURNING adjustment_id", [
      investigationId,
    ]);
    const charges = excuses.map((excuse) => excuse.adjustment_id as string | null).filter((id): id is string => Boolean(id));
    const removed = charges.length
      ? await query("DELETE FROM payroll_adjustments WHERE adjustment_id = ANY($1::text[]) RETURNING adjustment_id", [charges])
      : [];
    const notifications = hasNotifications
      ? await query("DELETE FROM notifications WHERE investigation_id = $1 RETURNING notification_id", [investigationId])
      : [];
    const emails = hasMailSent
      ? await query("DELETE FROM mail_sent WHERE investigation_id = $1 RETURNING sent_id", [investigationId])
      : [];
    const mailCases = hasMailCases
      ? await query(
          `UPDATE mail_cases SET status = 'rejected', reason = 'حُذف الاستعلام من النظام', investigation_id = NULL, updated_at = now()
           WHERE investigation_id = $1 RETURNING case_id`,
          [investigationId],
        )
      : [];
    // Photos, events, trail, offers, assignments and dispatch records go with it (cascade).
    await query("DELETE FROM investigations WHERE investigation_id = $1", [investigationId]);
    return {
      excuses: excuses.length,
      charges: removed.length,
      notifications: notifications.length,
      emails: emails.length,
      mail: mailCases.length > 0,
    };
  });
  // Storage is cleaned after the rows are gone; a file that fails to delete is only space.
  await deleteStoredFiles(files);
  return {
    investigation_id: investigationId,
    reference: String(row.reference ?? ""),
    status: String(row.status ?? ""),
    files_deleted: files.length,
    excuses_cancelled: counts.excuses,
    charges_removed: counts.charges,
    notifications_deleted: counts.notifications,
    emails_deleted: counts.emails,
    mail_case_closed: counts.mail,
  };
}

export interface InvestigatorDeletion {
  user_id: string;
  full_name: string;
  employee_number: string | null;
  investigations_deleted: number;
  reports_kept: number;
  files_deleted: number;
}

/**
 * Deletes an investigator and everything that belongs to them: account, roles, sessions,
 * devices, work areas, attendance, points, salary and payroll, complaints, ID and personal
 * photos, HR record, and their offers and trail on cases. Cases they still hold must be
 * finished or reassigned first. Their finished reports stay for the client (without a
 * name attached) unless `deleteReports` is set, which deletes those reports too.
 */
export async function deleteInvestigator(userId: string, options: { deleteReports: boolean }): Promise<InvestigatorDeletion> {
  const [user] = await query(
    `SELECT user_id, full_name, employee_number, "FrontID_image" AS front, "BackID_image" AS back, profile_image
     FROM users WHERE user_id = $1`,
    [userId],
  );
  if (!user) throw ApiError.notFound("Investigator not found");
  const [isInvestigator] = await query(`SELECT 1 FROM (${INVESTIGATOR_IDS_SQL}) inv WHERE inv.user_id = $1`, [userId]);
  const [hasRoles] = await query("SELECT 1 FROM user_roles WHERE user_id = $1", [userId]);
  // An application never activated has no role yet: it may be deleted too. Staff may not.
  if (!isInvestigator && hasRoles) {
    throw ApiError.forbidden("Only investigators can be deleted here; administrators and head office are managed separately");
  }
  const [open] = await query(
    "SELECT count(*)::int AS n FROM investigations WHERE assignee_id = $1 AND status = ANY($2::text[])",
    [userId, OPEN_STATUSES],
  );
  if (Number(open?.n ?? 0) > 0 && !options.deleteReports) {
    throw new ApiError(
      409,
      "INVESTIGATOR_HAS_OPEN_CASES",
      `This investigator still holds ${open!.n} unfinished case(s). Reassign or cancel them first, or choose to delete their cases too.`,
    );
  }

  let investigations = 0;
  let files: string[] = [];
  let kept = 0;
  await transaction(async () => {
    if (options.deleteReports) {
      files = await filesOf("assignee_id = $1", [userId]);
      investigations = (await query("DELETE FROM investigations WHERE assignee_id = $1 RETURNING investigation_id", [userId])).length;
    } else {
      kept = (await query("UPDATE investigations SET assignee_id = NULL WHERE assignee_id = $1 RETURNING investigation_id", [userId])).length;
    }
    for (const table of [
      "investigation_recipients",
      "investigation_offers",
      "investigation_locations",
      "investigation_assignments",
      "dispatch_outbox",
      "investigator_service_areas",
      "investigator_profiles",
      "admin_mfa_challenges",
      "admin_security",
      "user_roles",
      "refresh_sessions",
      "biometric_credentials",
      "login_challenges",
      "employee_records",
    ]) {
      await query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]).catch((error: unknown) => {
        // A table a service has not created yet holds nothing to delete.
        if (!/does not exist/i.test(String((error as Error)?.message))) throw error;
      });
    }
    // Attendance, points, salary, payroll and complaints go with the account (cascade).
    await query("DELETE FROM users WHERE user_id = $1", [userId]);
  });
  const photos = [user.front, user.back, user.profile_image].map((value) => String(value ?? "")).filter(Boolean);
  await deleteStoredFiles([...files, ...photos]);
  return {
    user_id: userId,
    full_name: String(user.full_name ?? ""),
    employee_number: (user.employee_number as string | null) ?? null,
    investigations_deleted: investigations,
    reports_kept: kept,
    files_deleted: files.length + photos.length,
  };
}

export interface TestDataReset {
  investigations: number;
  files: number;
  points_cleared: number;
  adjustments_deleted: number;
  payments_deleted: number;
}

/**
 * Clears test data: every investigation (with its files), and every investigator's points
 * and money. Points are revoked rather than deleted, so the automatic absence check does not
 * give them back. Base salaries are settings, not earnings, and stay as they are.
 */
export async function resetTestData(actorId: string): Promise<TestDataReset> {
  const removed = await purgeInvestigations("true");
  const result = await transaction(async () => {
    const points = await query(
      `UPDATE staff_points SET revoked_at = now(), revoked_by = $1, revoke_note = 'تصفير بيانات الاختبار'
       WHERE revoked_at IS NULL AND user_id IN (${INVESTIGATOR_IDS_SQL}) RETURNING point_id`,
      [actorId],
    );
    const adjustments = await query(`DELETE FROM payroll_adjustments WHERE user_id IN (${INVESTIGATOR_IDS_SQL}) RETURNING adjustment_id`);
    const payments = await query(`DELETE FROM payroll_payments WHERE user_id IN (${INVESTIGATOR_IDS_SQL}) RETURNING user_id`);
    // Excuses made while testing go too (their charges were payroll adjustments, removed above).
    await query("DELETE FROM investigation_excuses").catch(() => {});
    return { points: points.length, adjustments: adjustments.length, payments: payments.length };
  });
  return {
    investigations: removed.investigations,
    files: removed.files,
    points_cleared: result.points,
    adjustments_deleted: result.adjustments,
    payments_deleted: result.payments,
  };
}

/** What a reset would remove, shown before it runs. */
export async function previewTestDataReset() {
  const [cases] = await query("SELECT count(*)::int AS n FROM investigations");
  const [points] = await query(`SELECT count(*)::int AS n FROM staff_points WHERE revoked_at IS NULL AND user_id IN (${INVESTIGATOR_IDS_SQL})`);
  const [adjustments] = await query(`SELECT count(*)::int AS n FROM payroll_adjustments WHERE user_id IN (${INVESTIGATOR_IDS_SQL})`);
  const [payments] = await query(`SELECT count(*)::int AS n FROM payroll_payments WHERE user_id IN (${INVESTIGATOR_IDS_SQL})`);
  const [investigators] = await query(`SELECT count(*)::int AS n FROM (${INVESTIGATOR_IDS_SQL}) inv`);
  return {
    investigations: Number(cases?.n ?? 0),
    active_points: Number(points?.n ?? 0),
    payroll_adjustments: Number(adjustments?.n ?? 0),
    payroll_payments: Number(payments?.n ?? 0),
    investigators: Number(investigators?.n ?? 0),
  };
}
