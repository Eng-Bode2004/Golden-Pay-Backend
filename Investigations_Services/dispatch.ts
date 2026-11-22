import { query, transaction } from "../IdentityAcess_Services/Config/db.ts";
import { ApiError } from "../IdentityAcess_Services/Utils/http.ts";
import { logger } from "../IdentityAcess_Services/Utils/logger.ts";
import { WORKS_FOR_CLIENT_SQL } from "../Shared/investigator-clients.ts";
import { notify } from "../Shared/notifications.ts";
import { nameKey } from "../Shared/work-area.ts";
import {
  DEFAULT_POLICY,
  type Engine,
  type Policy,
  type PoolMember,
  type Selection,
  selectNext,
  selectSequential,
} from "./fairness.ts";
import { withoutPhone } from "./phone-visibility.ts";

/**
 * Fairness-aware broadcast dispatch (docs/dispatch-fairness.md).
 *
 * A case is offered at once to the eligible investigators with the fewest successful
 * assignments in the fairness window, at the closest geographic level that has anyone
 * eligible. The first to accept takes it (one transaction, row lock on the case); the other
 * offers close as "taken", which never counts against anyone. If nobody accepts in time the
 * next score group gets it, then the next level out, then the case is escalated to the admin.
 * Every decision is written to `dispatch_attempts`; assignments to the
 * `investigation_assignments` ledger, which is what fairness counts.
 */

const LEVELS = ["governorate", "district", "local_unit", "main_village", "sub_village"] as const;
export const TIER_LABELS: Record<number, string> = {
  6: "المستعلم المختار",
  5: "القرية التابعة",
  4: "القرية الأم",
  3: "الوحدة المحلية",
  2: "المركز / المدينة",
  1: "المحافظة",
  0: "المنطقة المحددة",
};

type Row = Record<string, unknown>;

export async function logEvent(
  investigationId: string,
  type: string,
  userId: string | null = null,
  actorId: string | null = null,
  note: string | null = null,
): Promise<void> {
  await query(
    "INSERT INTO investigation_events(investigation_id,type,user_id,actor_id,note) VALUES($1,$2,$3,$4,$5)",
    [investigationId, type, userId, actorId, note],
  );
}

const distanceKm = (lat1: number, lng1: number, lat2: number, lng2: number) => {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
};

/** How deep one service area matches the case, 0 when the governorate differs. */
export function tierOf(item: Row, area: Row): number {
  let tier = 0;
  for (const [index, level] of LEVELS.entries()) {
    const wanted = item[level] as string | null;
    if (!wanted) continue; // the case gives no name at this level
    if (area[`${level}_key`] !== nameKey(wanted)) break;
    tier = index + 1;
  }
  return tier;
}

// ───────────── policy ─────────────

export async function loadPolicy(): Promise<Policy> {
  try {
    const [row] = await query("SELECT * FROM dispatch_policy WHERE policy_id = 'default'");
    if (!row) return DEFAULT_POLICY;
    return {
      engine: (["fair_broadcast", "sequential", "shadow"].includes(row.engine as string) ? row.engine : "fair_broadcast") as Engine,
      score_mode: row.score_mode === "hybrid" ? "hybrid" : "assignments",
      window_days: Number(row.window_days) || DEFAULT_POLICY.window_days,
      active_weight: Number(row.active_weight ?? 1),
      offer_minutes: row.offer_minutes === null ? null : Number(row.offer_minutes),
      max_active: Math.max(1, Number(row.max_active) || 1),
      manual_counts: row.manual_counts !== false,
      newcomer_boost: row.newcomer_boost !== false,
    };
  } catch {
    return DEFAULT_POLICY;
  }
}

export async function updatePolicy(body: Row, actorId: string): Promise<Policy> {
  const current = await loadPolicy();
  const int = (value: unknown, field: string, min: number, max: number, fallback: number | null) => {
    if (value === undefined) return fallback;
    if (value === null || value === "") return null;
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) {
      throw ApiError.badRequest(`${field} must be a whole number from ${min} to ${max}`, { field });
    }
    return number;
  };
  const engine = body.engine ?? current.engine;
  if (!["fair_broadcast", "sequential", "shadow"].includes(engine as string)) throw ApiError.badRequest("Unknown engine");
  const scoreMode = body.score_mode ?? current.score_mode;
  if (!["assignments", "hybrid"].includes(scoreMode as string)) throw ApiError.badRequest("Unknown score mode");
  const weight = body.active_weight === undefined ? current.active_weight : Number(body.active_weight);
  if (!Number.isFinite(weight) || weight < 0 || weight > 20) throw ApiError.badRequest("active_weight must be 0 to 20");
  const windowDays = int(body.window_days, "window_days", 1, 365, current.window_days);
  const maxActive = int(body.max_active, "max_active", 1, 50, current.max_active);
  await query(
    `UPDATE dispatch_policy SET engine=$1, score_mode=$2, window_days=$3, active_weight=$4, offer_minutes=$5,
       max_active=$6, manual_counts=$7, newcomer_boost=$8, updated_by=$9, updated_at=now() WHERE policy_id='default'`,
    [
      engine,
      scoreMode,
      windowDays ?? DEFAULT_POLICY.window_days,
      weight,
      int(body.offer_minutes, "offer_minutes", 1, 1440, current.offer_minutes),
      maxActive ?? DEFAULT_POLICY.max_active,
      typeof body.manual_counts === "boolean" ? body.manual_counts : current.manual_counts,
      typeof body.newcomer_boost === "boolean" ? body.newcomer_boost : current.newcomer_boost,
      actorId,
    ],
  );
  return loadPolicy();
}

// ───────────── the pool ─────────────

/**
 * Everyone who covers the case (any matching service area, or the area pool) and works for its
 * client, with their numbers.
 */
export async function loadPool(item: Row, policy: Policy): Promise<PoolMember[]> {
  const pool = item.target_mode === "area";
  const governorate = item.governorate ? nameKey(item.governorate as string) : null;
  if (!pool && !governorate) return [];
  const rows = await query(
    `SELECT u.user_id, u.status, COALESCE(p.available, false) AS available, p.lat, p.lng,
       COALESCE((SELECT min(a.created_at) FROM investigator_service_areas a WHERE a.user_id = u.user_id)
         > now() - make_interval(days => $4), false) AS newcomer,
       (SELECT count(*)::int FROM investigation_assignments g
         WHERE g.user_id = u.user_id AND g.counts AND g.assigned_at > now() - make_interval(days => $4)) AS recent,
       (SELECT count(*)::int FROM investigations w
         WHERE w.assignee_id = u.user_id AND w.status IN ('assigned','in_progress','returned')) AS active,
       EXISTS (SELECT 1 FROM investigation_offers o
         WHERE o.investigation_id = $1 AND o.round = $2 AND o.user_id = u.user_id) AS offered,
       EXISTS (SELECT 1 FROM investigation_offers o
         WHERE o.investigation_id = $1 AND o.round = $2 AND o.user_id = u.user_id AND o.response = 'declined') AS declined,
       COALESCE((SELECT json_agg(json_build_object('governorate_key', a.governorate_key, 'district_key', a.district_key,
           'local_unit_key', a.local_unit_key, 'main_village_key', a.main_village_key, 'sub_village_key', a.sub_village_key))
         FROM investigator_service_areas a WHERE a.user_id = u.user_id AND a.active), '[]'::json) AS areas
     FROM users u LEFT JOIN investigator_profiles p ON p.user_id = u.user_id
     WHERE u.deleted_at IS NULL AND u.phone NOT LIKE 'admin:%'
       -- Only investigators who work for this case's company or bank (head office decides).
       AND ${WORKS_FOR_CLIENT_SQL("u.user_id", "$6")} AND (
       ($3::boolean AND u.user_id IN (SELECT r.user_id FROM investigation_recipients r WHERE r.investigation_id = $1))
       OR (NOT $3::boolean AND EXISTS (SELECT 1 FROM investigator_service_areas a
         WHERE a.user_id = u.user_id AND a.active AND a.governorate_key = $5)))`,
    [item.investigation_id, item.dispatch_round, pool, policy.window_days, governorate, item.client_id ?? null],
  );
  const shape = (item.area_filter as { mode?: string } | null)?.mode;
  const origin =
    item.lat !== null && item.lat !== undefined
      ? [item.lat as number, item.lng as number]
      : shape === "circle"
        ? [(item.area_filter as Row).lat as number, (item.area_filter as Row).lng as number]
        : null;
  return rows.map((row) => {
    const areas = (typeof row.areas === "string" ? JSON.parse(row.areas) : row.areas) as Row[];
    const deepest = Math.max(0, ...areas.map((area) => tierOf(item, area)));
    return {
      user_id: row.user_id as string,
      // Everyone the admin's area selected qualifies; geography only orders them.
      tier: pool ? Math.max(deepest, 0.5) : deepest,
      km: origin && row.lat !== null ? distanceKm(origin[0]!, origin[1]!, row.lat as number, row.lng as number) : null,
      account_status: row.status as string,
      available: Boolean(row.available),
      recent: Number(row.recent),
      active: Number(row.active),
      newcomer: Boolean(row.newcomer),
      offered: Boolean(row.offered),
      declined: Boolean(row.declined),
    };
  });
}

async function recordAttempt(item: Row, engine: string, selection: Selection, outcome: string, shadow = false, poolSize = 0) {
  await query(
    `INSERT INTO dispatch_attempts(investigation_id, round, engine, shadow, tier, min_score, pool_size, offered, eligible, excluded, outcome)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8::text::jsonb,$9::text::jsonb,$10::text::jsonb,$11)`,
    [
      item.investigation_id,
      item.dispatch_round,
      engine,
      shadow,
      selection.tier === null ? null : Math.floor(selection.tier),
      selection.min_score,
      poolSize,
      JSON.stringify(selection.offer.map((member) => member.user_id)),
      JSON.stringify(
        selection.eligible.map(({ user_id, score, raw, active, tier, newcomer }) => ({
          user_id,
          score,
          raw,
          active,
          tier: Math.floor(tier),
          newcomer,
        })),
      ),
      JSON.stringify(selection.excluded),
      outcome,
    ],
  );
}

// ───────────── issuing offers ─────────────

async function issueOffers(item: Row, userIds: string[], tier: number, minutes: number): Promise<void> {
  if (!userIds.length) return;
  const created = await query(
    `INSERT INTO investigation_offers(investigation_id, user_id, tier, round, expires_at)
     SELECT $1, u, $3, $4, now() + make_interval(mins => $5) FROM unnest($2::text[]) AS u
     ON CONFLICT (investigation_id, user_id) WHERE response IS NULL DO NOTHING
     RETURNING user_id, expires_at`,
    [item.investigation_id, userIds, tier, item.dispatch_round, minutes],
  );
  const offered = created.map((row) => row.user_id as string);
  if (!offered.length) return;
  await query(
    `INSERT INTO investigation_events(investigation_id, type, user_id, note)
     SELECT $1, 'offered', u, $3 FROM unnest($2::text[]) AS u`,
    [item.investigation_id, offered, TIER_LABELS[tier] ?? null],
  );
  // Delivered once per case, investigator and round (the app reads these; push can later).
  await query(
    `INSERT INTO dispatch_outbox(user_id, investigation_id, kind, round, payload)
     SELECT u, $2, 'offer', $3, $4::text::jsonb FROM unnest($1::text[]) AS u
     ON CONFLICT DO NOTHING`,
    [
      offered,
      item.investigation_id,
      item.dispatch_round,
      JSON.stringify({ reference: item.reference, expires_at: created[0]?.expires_at, service: item.service_name }),
    ],
  );
  await notify(offered, {
    kind: "offer",
    title: "استعلام جديد متاح لك",
    body: `${item.reference} · ${[item.district, item.governorate].filter(Boolean).join(" - ") || withoutPhone(item).address}. أول من يقبل يأخذه.`,
    investigation_id: item.investigation_id as string,
  });
}

/** Offers the case to the next group of candidates, or escalates it. Safe to call any time. */
export async function offerNext(investigationId: string): Promise<void> {
  await transaction(async () => {
    // The row lock makes concurrent workers take turns, so only one issues each group.
    const [item] = await query("SELECT * FROM investigations WHERE investigation_id = $1 FOR UPDATE", [investigationId]);
    if (!item || item.status !== "open") return;
    const pending = await query(
      "SELECT 1 FROM investigation_offers WHERE investigation_id = $1 AND response IS NULL LIMIT 1",
      [investigationId],
    );
    if (pending.length) return;
    const policy = await loadPolicy();
    const minutes = policy.offer_minutes ?? Number(item.accept_minutes ?? 30);

    // A personal case goes to the chosen investigator first.
    if (item.preferred_id) {
      const tried = await query(
        "SELECT 1 FROM investigation_offers WHERE investigation_id=$1 AND user_id=$2 AND round=$3",
        [investigationId, item.preferred_id, item.dispatch_round],
      );
      if (!tried.length) {
        const [person] = await query("SELECT status FROM users WHERE user_id=$1 AND deleted_at IS NULL", [item.preferred_id]);
        if (person?.status === "active") {
          const chosen = { user_id: item.preferred_id as string, tier: 6, score: 0, raw: 0, active: 0, newcomer: false, km: null };
          await recordAttempt(
            item,
            "preferred",
            { offer: [chosen], eligible: [chosen], excluded: [], tier: 6, min_score: null, exhausted: false, waiting: false },
            "offered",
            false,
            1,
          );
          await issueOffers(item, [item.preferred_id as string], 6, minutes);
          return;
        }
      }
    }

    const pool = await loadPool(item, policy);
    const engine = policy.engine;
    const selection = engine === "fair_broadcast" ? selectNext(pool, policy) : selectSequential(pool, policy);
    if (engine === "shadow") {
      // What fair broadcasting would have done, for comparison before switching it on.
      await recordAttempt(item, "fair_broadcast", selectNext(pool, policy), "shadow", true, pool.length);
    }
    const engineName = engine === "shadow" ? "sequential" : engine;

    if (selection.offer.length) {
      await recordAttempt(item, engineName, selection, "offered", false, pool.length);
      await issueOffers(
        item,
        selection.offer.map((member) => member.user_id),
        Math.floor(selection.offer[0]!.tier),
        minutes,
      );
      return;
    }
    if (selection.waiting) {
      // Everyone who covers the case is busy or off for now: retried on every tick, recorded once.
      const [last] = await query(
        "SELECT outcome FROM dispatch_attempts WHERE investigation_id=$1 AND round=$2 AND NOT shadow ORDER BY created_at DESC LIMIT 1",
        [investigationId, item.dispatch_round],
      );
      if (last?.outcome !== "waiting") {
        await recordAttempt(item, engineName, selection, "waiting", false, pool.length);
        await logEvent(investigationId, "waiting", null, null, `${selection.excluded.length}`);
      }
      return;
    }
    // Nobody left to ask: the admin decides (the dispatch page lists it as needing attention).
    await recordAttempt(item, engineName, selection, "exhausted", false, pool.length);
    await query("UPDATE investigations SET status='unassigned', updated_at=now() WHERE investigation_id=$1", [investigationId]);
    await logEvent(investigationId, "unassigned");
  });
}

// ───────────── accepting, declining, expiring ─────────────

export interface AcceptResult {
  investigation_id: string;
  status: string;
  /** True when this investigator already had the case (a repeated request). */
  repeated: boolean;
  closed: number;
}

/**
 * Accepts an offer in one transaction. Exactly one investigator can win a case: the case row
 * is locked, the offer must be open and unexpired, the ledger allows one open assignment per
 * case, and every other open offer closes as "taken". Repeating the request is harmless.
 */
export async function acceptOffer(investigationId: string, userId: string): Promise<AcceptResult> {
  const result = await transaction(async () => {
    const [item] = await query(
      "SELECT investigation_id, status, assignee_id FROM investigations WHERE investigation_id=$1 FOR UPDATE",
      [investigationId],
    );
    if (!item) throw ApiError.notFound("Investigation not found");
    if (item.assignee_id === userId && ["assigned", "in_progress", "returned"].includes(item.status as string)) {
      return { investigation_id: investigationId, status: item.status as string, repeated: true, closed: 0 };
    }
    if (item.status !== "open") {
      throw new ApiError(409, "INVESTIGATION_TAKEN", "Another investigator accepted this investigation first");
    }
    const [offer] = await query(
      "SELECT offer_id, tier, expires_at <= now() AS expired FROM investigation_offers WHERE investigation_id=$1 AND user_id=$2 AND response IS NULL",
      [investigationId, userId],
    );
    if (!offer) throw new ApiError(409, "OFFER_CLOSED", "This offer is no longer open");
    if (offer.expired) throw new ApiError(409, "OFFER_EXPIRED", "This offer has expired");
    if (offer.tier !== 6) {
      const policy = await loadPolicy();
      const [busy] = await query(
        "SELECT count(*)::int AS active FROM investigations WHERE assignee_id=$1 AND status IN ('assigned','in_progress','returned')",
        [userId],
      );
      if (Number(busy?.active ?? 0) >= policy.max_active) {
        throw new ApiError(409, "INVESTIGATOR_BUSY", "Finish your current investigation before accepting another");
      }
    }
    await query(
      "UPDATE investigation_offers SET response='accepted', responded_at=now(), seen_at=COALESCE(seen_at, now()) WHERE offer_id=$1",
      [offer.offer_id],
    );
    await query(
      `INSERT INTO investigation_assignments(investigation_id, user_id, source, offer_id, counts)
       VALUES($1, $2, $3, $4, true)`,
      [investigationId, userId, offer.tier === 6 ? "preferred" : "accepted", offer.offer_id],
    );
    await query(
      "UPDATE investigations SET status='assigned', assignee_id=$2, claimed_at=now(), updated_at=now() WHERE investigation_id=$1",
      [investigationId, userId],
    );
    const others = await query(
      `UPDATE investigation_offers SET response='taken', responded_at=now()
       WHERE investigation_id=$1 AND user_id<>$2 AND response IS NULL RETURNING user_id, round`,
      [investigationId, userId],
    );
    if (others.length) {
      await query(
        `INSERT INTO dispatch_outbox(user_id, investigation_id, kind, round)
         SELECT u, $2, 'offer_closed', $3 FROM unnest($1::text[]) AS u ON CONFLICT DO NOTHING`,
        [others.map((row) => row.user_id), investigationId, others[0]!.round],
      );
    }
    await logEvent(investigationId, "accepted", userId, null, others.length ? `${others.length}` : null);
    return { investigation_id: investigationId, status: "assigned", repeated: false, closed: others.length };
  });
  if (!result.repeated) await releaseIfFull(userId, investigationId);
  return result;
}

/** At the workload limit, the investigator's other open offers go to someone free. */
async function releaseIfFull(userId: string, keep: string): Promise<void> {
  const policy = await loadPolicy();
  const [busy] = await query(
    "SELECT count(*)::int AS active FROM investigations WHERE assignee_id=$1 AND status IN ('assigned','in_progress','returned')",
    [userId],
  );
  if (Number(busy?.active ?? 0) < policy.max_active) return;
  const released = await query(
    `UPDATE investigation_offers SET response='cancelled', responded_at=now(), reason='workload_limit'
     WHERE user_id=$1 AND response IS NULL AND tier <> 6 AND investigation_id <> $2 RETURNING investigation_id`,
    [userId, keep],
  );
  for (const offer of released) await offerNext(offer.investigation_id as string);
}

/** A refusal: the others keep their offers; when nobody is left waiting, the next group gets it. */
export async function declineOffer(investigationId: string, userId: string, reason: string | null): Promise<void> {
  const rows = await query(
    `UPDATE investigation_offers SET response='declined', responded_at=now(), reason=$3, seen_at=COALESCE(seen_at, now())
     WHERE investigation_id=$1 AND user_id=$2 AND response IS NULL RETURNING offer_id`,
    [investigationId, userId, reason],
  );
  if (!rows.length) throw new ApiError(409, "OFFER_CLOSED", "This offer is no longer open");
  await logEvent(investigationId, "declined", userId, null, reason);
  await offerNext(investigationId);
}

/** Closes every offer whose window has passed and moves each case on. Each offer expires once. */
export async function expireOffers(): Promise<number> {
  const expired = await query(
    `UPDATE investigation_offers SET response='expired', responded_at=now()
     WHERE response IS NULL AND expires_at <= now() RETURNING investigation_id, user_id`,
  );
  const cases = new Set<string>();
  for (const offer of expired) {
    await logEvent(offer.investigation_id as string, "expired", offer.user_id as string);
    cases.add(offer.investigation_id as string);
  }
  for (const id of cases) await offerNext(id);
  return expired.length;
}

/** Starts dispatch for open cases that have no live offer, e.g. after a restart. */
export async function resumeOpenCases(): Promise<void> {
  const waiting = await query(
    `SELECT investigation_id FROM investigations i WHERE status = 'open'
     AND NOT EXISTS (SELECT 1 FROM investigation_offers o WHERE o.investigation_id = i.investigation_id AND o.response IS NULL)
     ORDER BY due_at NULLS LAST, created_at`,
  );
  for (const row of waiting) await offerNext(row.investigation_id as string);
}

// ───────────── accepted but not done in time ─────────────

export interface WorkRules {
  /** Minutes from accepting (or the appointment) to sending the report; null = no limit. */
  work_minutes: number | null;
  /** What an investigator is charged for excusing themselves from an accepted case. */
  excuse_penalty: number;
}

/** Head office's rules for accepted cases. */
export async function loadWorkRules(): Promise<WorkRules> {
  try {
    const [row] = await query("SELECT work_minutes, excuse_penalty FROM dispatch_policy WHERE policy_id = 'default'");
    return {
      work_minutes: row?.work_minutes === null || row?.work_minutes === undefined ? null : Number(row.work_minutes),
      excuse_penalty: Number(row?.excuse_penalty ?? 0) || 0,
    };
  } catch {
    return { work_minutes: null, excuse_penalty: 0 };
  }
}

export async function loadWorkMinutes(): Promise<number | null> {
  return (await loadWorkRules()).work_minutes;
}

export async function setWorkRules(body: Record<string, unknown>, actorId: string): Promise<WorkRules> {
  const current = await loadWorkRules();
  let minutes = current.work_minutes;
  if (body.work_minutes !== undefined) {
    minutes = null;
    if (body.work_minutes !== null && body.work_minutes !== "") {
      minutes = Number(body.work_minutes);
      if (!Number.isInteger(minutes) || minutes < 15 || minutes > 60 * 24 * 14) {
        throw ApiError.badRequest("The time must be from 15 minutes to 14 days", { field: "work_minutes" });
      }
    }
  }
  let penalty = current.excuse_penalty;
  if (body.excuse_penalty !== undefined) {
    penalty = Number(body.excuse_penalty ?? 0);
    if (!Number.isFinite(penalty) || penalty < 0 || penalty > 100_000) {
      throw ApiError.badRequest("The amount must be from 0 to 100000", { field: "excuse_penalty" });
    }
    penalty = Math.round(penalty * 100) / 100;
  }
  await query(
    "UPDATE dispatch_policy SET work_minutes=$1, excuse_penalty=$2, updated_by=$3, updated_at=now() WHERE policy_id='default'",
    [minutes, penalty, actorId],
  );
  return loadWorkRules();
}

/**
 * Takes an accepted case back from its investigator (the case row is locked by the caller)
 * and reopens it for everyone else in the area: the assignment ends, the round moves on,
 * the investigator counts as already asked, and they are told.
 */
async function takeBack(
  item: Row,
  reason: "timed_out" | "excused",
  note: string,
  eventNote: string | null,
): Promise<string> {
  const id = item.investigation_id as string;
  const person = item.assignee_id as string;
  await endAssignment(id, reason, null, note);
  const [next] = await query(
    `UPDATE investigations SET status='open', assignee_id=NULL, claimed_at=NULL, started_at=NULL,
       dispatch_round = dispatch_round + 1, updated_at=now()
     WHERE investigation_id=$1 RETURNING dispatch_round`,
    [id],
  );
  await query(
    `INSERT INTO investigation_offers(investigation_id, user_id, tier, round, expires_at, response, responded_at, reason)
     VALUES($1,$2,0,$3,now(),$4,now(),$5)`,
    [id, person, next?.dispatch_round, reason === "excused" ? "declined" : "expired", reason === "excused" ? "excused" : "work_timeout"],
  );
  await query(
    `INSERT INTO dispatch_outbox(user_id, investigation_id, kind, round) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [person, id, reason === "excused" ? "excused" : "taken_back", next?.dispatch_round],
  );
  await logEvent(id, reason, person, null, eventNote);
  await notify(person, {
    kind: reason === "excused" ? "excused" : "taken_back",
    title: reason === "excused" ? "تم تسجيل اعتذارك" : "سُحب منك الاستعلام",
    body:
      reason === "excused"
        ? `أُرسل الاستعلام ${item.reference} لمستعلم آخر.`
        : `انتهت مهلة إنجاز الاستعلام ${item.reference}، فأُرسل لمستعلم آخر.`,
    investigation_id: id,
  });
  return person;
}

/**
 * The investigator excuses themselves from a case they accepted: head office is told (the
 * excuses list), the case goes to the next investigator in the area, and head office's charge
 * for excusing is taken from this month's pay.
 */
export async function excuseCase(investigationId: string, userId: string, reason: string) {
  const rules = await loadWorkRules();
  const result = await transaction(async () => {
    const [item] = await query("SELECT * FROM investigations WHERE investigation_id = $1 FOR UPDATE", [investigationId]);
    if (!item) throw ApiError.notFound("Investigation not found");
    if (item.assignee_id !== userId || !["assigned", "in_progress", "returned"].includes(item.status as string)) {
      throw new ApiError(409, "INVALID_STATUS_TRANSITION", "This investigation is not with you any more");
    }
    await takeBack(item, "excused", `اعتذار: ${reason}`, reason);
    let adjustment: string | null = null;
    if (rules.excuse_penalty > 0) {
      const [row] = await query(
        `INSERT INTO payroll_adjustments (user_id, month, amount, note)
         VALUES ($1, date_trunc('month', now() AT TIME ZONE 'Africa/Cairo')::date, $2, $3) RETURNING adjustment_id`,
        [userId, -rules.excuse_penalty, `خصم اعتذار عن الاستعلام ${item.reference}: ${reason}`.slice(0, 500)],
      );
      adjustment = (row?.adjustment_id as string) ?? null;
    }
    await query(
      `INSERT INTO investigation_excuses (investigation_id, user_id, reference, reason, penalty, adjustment_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [investigationId, userId, item.reference, reason, rules.excuse_penalty, adjustment],
    );
    return { reference: item.reference as string, penalty: rules.excuse_penalty };
  });
  await offerNext(investigationId);
  return result;
}

/** Recent excuses for head office, newest first. */
export async function listExcuses(limit = 100) {
  return query(
    `SELECT e.excuse_id, e.investigation_id, e.reference, e.reason, e.penalty::float8 AS penalty, e.created_at,
       u.user_id, u.full_name, u.employee_number, i.status, i.subject_name,
       (SELECT n.full_name FROM users n WHERE n.user_id = i.assignee_id) AS now_with
     FROM investigation_excuses e JOIN users u ON u.user_id = e.user_id
     LEFT JOIN investigations i ON i.investigation_id = e.investigation_id
     ORDER BY e.created_at DESC LIMIT $1`,
    [limit],
  );
}

/** When the investigator must have sent the report: from accepting, or from the appointment. */
const DEADLINE_SQL = (minutes: string) =>
  `(GREATEST(i.claimed_at, CASE WHEN l.delivery_hours IS NULL THEN i.due_at ELSE i.claimed_at END)
     + make_interval(mins => ${minutes}))`;

/**
 * Cases accepted but not sent within head office's time go back to dispatch, for everyone
 * except the investigator who held them. Returned reports (being corrected) are left alone.
 */
export async function reclaimOverdue(): Promise<number> {
  const minutes = await loadWorkMinutes();
  if (!minutes) return 0;
  const overdue = await query(
    `SELECT i.investigation_id FROM investigations i LEFT JOIN service_levels l ON l.code = i.service_level
     WHERE i.status IN ('assigned','in_progress') AND i.assignee_id IS NOT NULL AND i.claimed_at IS NOT NULL
       AND ${DEADLINE_SQL("$1")} <= now()
     ORDER BY i.claimed_at LIMIT 50`,
    [minutes],
  );
  let moved = 0;
  for (const row of overdue) {
    const id = row.investigation_id as string;
    const taken = await transaction(async () => {
      const [item] = await query(
        `SELECT i.*, ${DEADLINE_SQL("$2")} <= now() AS late FROM investigations i
         LEFT JOIN service_levels l ON l.code = i.service_level WHERE i.investigation_id = $1 FOR UPDATE OF i`,
        [id, minutes],
      );
      if (!item || !item.late || !["assigned", "in_progress"].includes(item.status as string) || !item.assignee_id) return null;
      return takeBack(item, "timed_out", "لم يُنجز في الوقت المحدد", `${minutes}`);
    });
    if (taken) {
      moved += 1;
      logger.info("dispatch.reclaimed", { investigation_id: id, user_id: taken });
      await offerNext(id);
    }
  }
  return moved;
}

export function startDispatcher(intervalMs = 15_000): void {
  const tick = async () => {
    try {
      await reclaimOverdue();
      await expireOffers();
      await resumeOpenCases();
    } catch (error) {
      logger.error("dispatch.tick_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  };
  void tick();
  setInterval(() => void tick(), intervalMs);
}

// ───────────── the ledger: completion, cancellation, manual assignment ─────────────

/**
 * Ends the case's open assignment. Cancelled or reassigned before the investigator started
 * work: it stops counting for fairness (no work was done). Otherwise it keeps counting.
 */
export async function endAssignment(
  investigationId: string,
  reason: "completed" | "cancelled" | "reassigned" | "timed_out" | "excused",
  actorId: string | null,
  note: string | null = null,
): Promise<void> {
  const ended = await query(
    `UPDATE investigation_assignments a SET ended_at=now(), end_reason=$2, ended_by=$3, note=COALESCE($4, a.note),
       counts = a.counts AND NOT ($2 IN ('cancelled','reassigned') AND i.started_at IS NULL)
     FROM investigations i
     WHERE a.investigation_id=$1 AND a.ended_at IS NULL AND i.investigation_id = a.investigation_id
     RETURNING a.user_id, a.counts`,
    [investigationId, reason, actorId, note],
  );
  const row = ended[0];
  if (row && reason !== "completed") {
    await logEvent(
      investigationId,
      "fairness",
      row.user_id as string,
      actorId,
      row.counts ? "يبقى محتسبًا في عدالة التوزيع" : "لا يُحتسب في عدالة التوزيع (لم يبدأ العمل)",
    );
  }
}

/**
 * An admin gives the case to an investigator (first assignment or reassignment). Open offers
 * close, the previous assignment ends as "reassigned", and the new one enters the ledger;
 * whether it counts for fairness follows the policy (`manual_counts`).
 */
export async function assignManually(
  investigationId: string,
  userId: string,
  actorId: string,
  reason: string,
): Promise<{ status: string; previous: string | null }> {
  const policy = await loadPolicy();
  return transaction(async () => {
    const [item] = await query("SELECT * FROM investigations WHERE investigation_id=$1 FOR UPDATE", [investigationId]);
    if (!item) throw ApiError.notFound("Investigation not found");
    if (!["open", "unassigned", "assigned", "in_progress", "returned"].includes(item.status as string)) {
      throw new ApiError(409, "INVALID_STATUS_TRANSITION", "This investigation can no longer be assigned");
    }
    if (item.assignee_id === userId) throw ApiError.badRequest("This investigator already has the case");
    const [person] = await query("SELECT status FROM users WHERE user_id=$1 AND deleted_at IS NULL", [userId]);
    if (person?.status !== "active") throw ApiError.badRequest("Choose an active investigator");

    const previous = (item.assignee_id as string | null) ?? null;
    if (previous) await endAssignment(investigationId, "reassigned", actorId, reason);
    const closed = await query(
      `UPDATE investigation_offers SET response='cancelled', responded_at=now(), reason='manual_assignment'
       WHERE investigation_id=$1 AND response IS NULL RETURNING user_id`,
      [investigationId],
    );
    if (closed.length) {
      await query(
        `INSERT INTO dispatch_outbox(user_id, investigation_id, kind, round)
         SELECT u, $2, 'offer_closed', $3 FROM unnest($1::text[]) AS u ON CONFLICT DO NOTHING`,
        [closed.map((row) => row.user_id), investigationId, item.dispatch_round],
      );
    }
    await query(
      `INSERT INTO investigation_assignments(investigation_id, user_id, source, counts, assigned_by, note)
       VALUES($1,$2,'manual',$3,$4,$5)`,
      [investigationId, userId, policy.manual_counts, actorId, reason],
    );
    const status = ["in_progress", "returned"].includes(item.status as string) ? (item.status as string) : "assigned";
    await query(
      "UPDATE investigations SET assignee_id=$2, status=$3, claimed_at=now(), updated_at=now() WHERE investigation_id=$1",
      [investigationId, userId, status],
    );
    await logEvent(investigationId, previous ? "reassigned" : "manually_assigned", userId, actorId, reason);
    await notify(userId, {
      kind: "assigned",
      title: "أُسند إليك استعلام",
      body: `${item.reference} · ${withoutPhone(item).subject_name}`,
      investigation_id: investigationId,
    });
    if (previous) {
      await notify(previous, {
        kind: "taken_back",
        title: "نُقل الاستعلام لمستعلم آخر",
        body: `نقلت الإدارة الاستعلام ${item.reference}.`,
        investigation_id: investigationId,
      });
    }
    return { status, previous };
  });
}

// ───────────── what the dashboard shows ─────────────

/** Per investigator: the numbers fairness uses and the history behind them. */
export async function fairnessBoard(policy: Policy) {
  const rows = await query(
    `SELECT u.user_id, u.full_name, u.employee_number, u.status, COALESCE(p.available, false) AS available,
       p.governorate, p.district,
       (SELECT count(*)::int FROM investigator_service_areas a WHERE a.user_id = u.user_id AND a.active) AS areas,
       COALESCE((SELECT min(a.created_at) FROM investigator_service_areas a WHERE a.user_id = u.user_id)
         > now() - make_interval(days => $1), false) AS newcomer,
       (SELECT count(*)::int FROM investigation_assignments g WHERE g.user_id = u.user_id AND g.counts
         AND g.assigned_at > now() - make_interval(days => $1)) AS recent,
       (SELECT count(*)::int FROM investigation_assignments g WHERE g.user_id = u.user_id AND g.counts) AS total,
       (SELECT count(*)::int FROM investigation_assignments g WHERE g.user_id = u.user_id AND g.end_reason = 'completed') AS completed,
       (SELECT count(*)::int FROM investigation_assignments g WHERE g.user_id = u.user_id AND g.end_reason = 'cancelled') AS cancelled,
       (SELECT count(*)::int FROM investigation_assignments g WHERE g.user_id = u.user_id AND g.end_reason = 'reassigned') AS reassigned_away,
       (SELECT count(*)::int FROM investigation_assignments g WHERE g.user_id = u.user_id AND g.source = 'manual') AS manual,
       (SELECT count(*)::int FROM investigations w WHERE w.assignee_id = u.user_id
         AND w.status IN ('assigned','in_progress','returned')) AS active,
       (SELECT count(*)::int FROM investigation_offers o WHERE o.user_id = u.user_id AND o.response IS NULL) AS open_offers,
       (SELECT count(*)::int FROM investigation_offers o WHERE o.user_id = u.user_id AND o.response = 'declined') AS declined,
       (SELECT count(*)::int FROM investigation_offers o WHERE o.user_id = u.user_id AND o.response = 'expired') AS expired,
       (SELECT count(*)::int FROM investigation_offers o WHERE o.user_id = u.user_id AND o.response = 'taken') AS taken,
       (SELECT (avg(extract(epoch FROM o.responded_at - o.offered_at)) / 60)::float8 FROM investigation_offers o
         WHERE o.user_id = u.user_id AND o.response IN ('accepted','declined')) AS avg_response_minutes
     FROM users u JOIN investigator_profiles p ON p.user_id = u.user_id
     WHERE u.deleted_at IS NULL AND u.phone NOT LIKE 'admin:%'
     ORDER BY u.full_name`,
    [policy.window_days],
  );
  return rows.map(
    (row): Row & { score: number } => ({
      ...row,
      score: Number(row.recent) + (policy.score_mode === "hybrid" ? policy.active_weight * Number(row.active) : 0),
    }),
  );
}

export async function dispatchMetrics(days = 30) {
  const [assign] = await query(
    `SELECT (avg(extract(epoch FROM claimed_at - created_at)) / 60)::float8 AS avg_minutes_to_assignment,
       (100.0 * count(*) FILTER (WHERE claimed_at - created_at <= make_interval(mins => accept_minutes))
         / NULLIF(count(*), 0))::float8 AS pct_within_window,
       count(*)::int AS assigned
     FROM investigations WHERE claimed_at > now() - make_interval(days => $1)`,
    [days],
  );
  const [offers] = await query(
    `SELECT count(*) FILTER (WHERE response = 'accepted')::int AS accepted,
       count(*) FILTER (WHERE response = 'declined')::int AS declined,
       count(*) FILTER (WHERE response = 'expired')::int AS expired,
       count(*) FILTER (WHERE response = 'taken')::int AS taken,
       count(*) FILTER (WHERE response IS NULL)::int AS open
     FROM investigation_offers WHERE offered_at > now() - make_interval(days => $1)`,
    [days],
  );
  const [events] = await query(
    `SELECT count(*) FILTER (WHERE type = 'accept_conflict')::int AS conflicts,
       count(*) FILTER (WHERE type IN ('manually_assigned','reassigned','redispatched'))::int AS manual_interventions,
       count(*) FILTER (WHERE type = 'unassigned')::int AS escalations
     FROM investigation_events WHERE created_at > now() - make_interval(days => $1)`,
    [days],
  );
  const [excluded] = await query(
    `SELECT count(*)::int AS by_workload FROM dispatch_attempts d, jsonb_array_elements(d.excluded) e
     WHERE d.created_at > now() - make_interval(days => $1) AND NOT d.shadow AND e->>'reason' = 'workload_limit'`,
    [days],
  );
  const [waiting] = await query(
    `SELECT count(*) FILTER (WHERE status = 'unassigned')::int AS unassigned,
       count(*) FILTER (WHERE status = 'open' AND NOT EXISTS (SELECT 1 FROM investigation_offers o
         WHERE o.investigation_id = i.investigation_id AND o.response IS NULL))::int AS waiting
     FROM investigations i`,
  );
  const answered = Number(offers?.accepted ?? 0) + Number(offers?.declined ?? 0) + Number(offers?.expired ?? 0);
  return {
    ...assign,
    offers: {
      ...offers,
      acceptance_rate: answered ? Math.round((1000 * Number(offers?.accepted ?? 0)) / answered) / 10 : null,
    },
    ...events,
    excluded_by_workload: Number(excluded?.by_workload ?? 0),
    ...waiting,
  };
}
