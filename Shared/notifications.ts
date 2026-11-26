import { createSign } from "node:crypto";
import { query } from "../IdentityAcess_Services/Config/db.ts";
import { logger } from "../IdentityAcess_Services/Utils/logger.ts";

/**
 * One way to tell people things. Every event (a new offer, a report sent back, a point, a
 * reply from head office…) calls `notify()`. It is stored first (the app's notifications
 * list and bell), then pushed to the person's phones through Firebase Cloud Messaging when
 * the server has Firebase credentials (FCM_SERVICE_ACCOUNT). Without them nothing is lost:
 * the app still shows the notification, and raises a phone notification, the next time it
 * checks while it is running.
 */

export type NotificationKind =
  | "offer"
  | "offer_closed"
  | "assigned"
  | "case_edited"
  | "taken_back"
  | "excused"
  | "returned"
  | "approved"
  | "cancelled"
  | "account_approved"
  | "points"
  | "complaint_reply"
  | "payroll_paid"
  | "payroll_adjusted"
  | "announcement";

export interface NotificationInput {
  kind: NotificationKind;
  title: string;
  body: string;
  investigation_id?: string | null;
  data?: Record<string, unknown>;
}

/** Stores the notification for each person and pushes it to their phones. Never throws. */
export async function notify(userIds: string | string[], input: NotificationInput): Promise<void> {
  const ids = [...new Set((Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean))];
  if (!ids.length) return;
  try {
    const rows = await query(
      `INSERT INTO notifications (user_id, kind, title, body, investigation_id, data)
       SELECT u, $2, $3, $4, $5, $6::text::jsonb FROM unnest($1::text[]) AS u
       RETURNING notification_id, user_id`,
      [ids, input.kind, input.title.slice(0, 200), input.body.slice(0, 1000), input.investigation_id ?? null, JSON.stringify(input.data ?? {})],
    );
    void push(rows.map((row) => ({ id: Number(row.notification_id), user_id: row.user_id as string })), input);
  } catch (error) {
    // A notification must never break the action that caused it.
    logger.warn("notify.failed", { kind: input.kind, error: error instanceof Error ? error.message : String(error) });
  }
}

export async function listNotifications(userId: string, after = 0, limit = 50) {
  const [rows, [unread]] = await Promise.all([
    query(
      `SELECT notification_id::int AS notification_id, kind, title, body, investigation_id, data, created_at, read_at
       FROM notifications WHERE user_id = $1 AND ($2::bigint = 0 OR notification_id > $2)
       ORDER BY notification_id DESC LIMIT $3`,
      [userId, after, Math.min(Math.max(limit, 1), 100)],
    ),
    query("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL", [userId]),
  ]);
  return { notifications: rows, unread: Number(unread?.n ?? 0) };
}

export async function markRead(userId: string, ids: number[] | "all"): Promise<number> {
  const rows =
    ids === "all"
      ? await query("UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL RETURNING 1", [userId])
      : await query(
          "UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND notification_id = ANY($2::bigint[]) RETURNING 1",
          [userId, ids],
        );
  return rows.length;
}

export async function savePushToken(userId: string, token: string, platform: string | null, deviceId: string | null) {
  await query(
    `INSERT INTO push_tokens (token, user_id, platform, device_id) VALUES ($1,$2,$3,$4)
     ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform,
       device_id = EXCLUDED.device_id, last_seen_at = now()`,
    [token, userId, platform, deviceId],
  );
}

export async function removePushToken(userId: string, token: string | null) {
  if (token) await query("DELETE FROM push_tokens WHERE user_id = $1 AND token = $2", [userId, token]);
  else await query("DELETE FROM push_tokens WHERE user_id = $1", [userId]);
}

export async function pushStatus() {
  const [row] = await query("SELECT count(*)::int AS tokens, count(DISTINCT user_id)::int AS people FROM push_tokens");
  return { configured: Boolean(serviceAccount()), tokens: Number(row?.tokens ?? 0), people: Number(row?.people ?? 0) };
}

// ───────────── Firebase Cloud Messaging (HTTP v1) ─────────────

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

let account: ServiceAccount | null | undefined;
function serviceAccount(): ServiceAccount | null {
  if (account !== undefined) return account;
  const raw = process.env.FCM_SERVICE_ACCOUNT?.trim();
  account = null;
  if (!raw) return null;
  try {
    const json = JSON.parse(raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8")) as ServiceAccount;
    if (json.project_id && json.client_email && json.private_key) account = json;
  } catch {
    logger.warn("push.bad_service_account", {});
  }
  return account;
}

let accessToken: { value: string; expires: number } | null = null;
async function googleToken(sa: ServiceAccount): Promise<string> {
  if (accessToken && accessToken.expires > Date.now() + 60_000) return accessToken.value;
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(sa.private_key.replace(/\\n/g, "\n"), "base64url");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }),
  });
  if (!response.ok) throw new Error(`Google token request failed (${response.status})`);
  const data = (await response.json()) as { access_token: string; expires_in: number };
  accessToken = { value: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

async function push(rows: { id: number; user_id: string }[], input: NotificationInput): Promise<void> {
  if (!rows.length) return;
  const sa = serviceAccount();
  const ids = rows.map((row) => row.id);
  if (!sa) {
    await query("UPDATE notifications SET push_status = 'skipped' WHERE notification_id = ANY($1::bigint[])", [ids]).catch(() => {});
    return;
  }
  try {
    const tokens = await query("SELECT token, user_id FROM push_tokens WHERE user_id = ANY($1::text[])", [rows.map((row) => row.user_id)]);
    const bearer = await googleToken(sa);
    const sent = new Set<string>();
    for (const { token, user_id } of tokens) {
      const notification = rows.find((row) => row.user_id === user_id);
      const response = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            token,
            notification: { title: input.title, body: input.body },
            data: {
              kind: input.kind,
              notification_id: String(notification?.id ?? ""),
              investigation_id: input.investigation_id ?? "",
            },
            android: { priority: "high", notification: { channel_id: "goldenpay_alerts", sound: "default" } },
          },
        }),
      });
      if (response.ok) sent.add(user_id as string);
      else if (response.status === 404 || response.status === 400) {
        // The app was removed or the token replaced: forget it.
        await query("DELETE FROM push_tokens WHERE token = $1", [token]);
      }
    }
    await query(
      `UPDATE notifications SET push_status = CASE WHEN user_id = ANY($2::text[]) THEN 'sent' ELSE 'no_device' END
       WHERE notification_id = ANY($1::bigint[])`,
      [ids, [...sent]],
    );
  } catch (error) {
    logger.warn("push.failed", { kind: input.kind, error: error instanceof Error ? error.message : String(error) });
    await query("UPDATE notifications SET push_status = 'failed' WHERE notification_id = ANY($1::bigint[])", [ids]).catch(() => {});
  }
}
