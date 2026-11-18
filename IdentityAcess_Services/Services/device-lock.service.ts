import { query } from "../Config/db.ts";
import { ApiError } from "../Utils/http.ts";
import { revokeAllUserSessions } from "./session.service.ts";

/**
 * Each investigator works from one phone. The app sends the phone's Android device ID (the
 * real MAC address is hidden from apps since Android 6); the first one seen, at signup, is
 * kept. Administrators, HR and head office are never bound. An admin resets the binding when
 * the investigator changes or loses their phone; their next sign-in binds the new one.
 */

const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;

export const cleanDeviceId = (value: unknown): string | null =>
  typeof value === "string" && DEVICE_ID.test(value.trim()) ? value.trim() : null;

const cleanName = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : null;

async function isInvestigator(userId: string): Promise<boolean> {
  const [row] = await query(
    `SELECT u.phone, COALESCE(bool_or(r.name IN ('admin','hr','head_office')), false) AS staff
     FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.user_id LEFT JOIN roles r ON r.role_id = ur.role_id
     WHERE u.user_id = $1 GROUP BY u.phone`,
    [userId],
  );
  if (!row) return false;
  return !row.staff && !String(row.phone ?? "").startsWith("admin:");
}

/** Keeps the phone used at signup (no-op without a device ID, e.g. an old app). */
export async function bindSignupDevice(userId: string, deviceId: unknown, deviceName: unknown, platform: string | null) {
  const id = cleanDeviceId(deviceId);
  if (!id) return;
  await query(
    `INSERT INTO investigator_devices (user_id, device_id, device_name, platform) VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, id, cleanName(deviceName), platform],
  );
}

/** Refuses a sign-in (or token refresh) from any phone but the investigator's own. */
export async function assertInvestigatorDevice(
  userId: string,
  device: { deviceId?: string | null; deviceName?: string | null; platform?: string | null },
): Promise<void> {
  if (!(await isInvestigator(userId))) return;
  const id = cleanDeviceId(device.deviceId);
  if (!id) {
    throw new ApiError(
      403,
      "DEVICE_REQUIRED",
      "Update the Golden Pay app to the latest version to sign in",
    );
  }
  const [bound] = await query("SELECT device_id FROM investigator_devices WHERE user_id = $1", [userId]);
  if (!bound) {
    await query(
      `INSERT INTO investigator_devices (user_id, device_id, device_name, platform, last_seen_at)
       VALUES ($1,$2,$3,$4, now()) ON CONFLICT (user_id) DO NOTHING`,
      [userId, id, cleanName(device.deviceName), device.platform ?? null],
    );
    const [now] = await query("SELECT device_id FROM investigator_devices WHERE user_id = $1", [userId]);
    if (now?.device_id === id) return;
    throw deviceRefused();
  }
  if (bound.device_id !== id) throw deviceRefused();
  await query("UPDATE investigator_devices SET last_seen_at = now() WHERE user_id = $1", [userId]);
}

const deviceRefused = () =>
  new ApiError(
    403,
    "DEVICE_NOT_ALLOWED",
    "This account works on another phone. If you changed or lost your phone, ask the administrator to reset it",
  );

export async function deviceOf(userId: string) {
  const [row] = await query(
    "SELECT device_name, platform, bound_at, last_seen_at FROM investigator_devices WHERE user_id = $1",
    [userId],
  );
  return row ?? null;
}

/** The investigator's phone is forgotten and every session ends; the next sign-in binds anew. */
export async function resetDevice(userId: string): Promise<boolean> {
  const removed = await query("DELETE FROM investigator_devices WHERE user_id = $1 RETURNING user_id", [userId]);
  await revokeAllUserSessions(userId, "device_reset");
  return removed.length > 0;
}
