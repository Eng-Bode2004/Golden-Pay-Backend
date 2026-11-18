import { query, transaction } from "../IdentityAcess_Services/Config/db.ts";
import { logger } from "../IdentityAcess_Services/Utils/logger.ts";
import { nameKey } from "../Shared/work-area.ts";

/**
 * Sends a case to every free investigator who covers it at once; the first to
 * accept takes it and the other offers close. An area case goes to everyone in
 * the area the admin chose. Otherwise the case goes to the closest matching
 * level of the case address — sub village, then main village, local unit,
 * district, governorate — and, when nobody there accepts within the type's
 * acceptance window, to the next level out. A personal case goes to the chosen
 * investigator first and falls back the same way.
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

/** How deep the investigator's area matches the case, 0 when the governorate differs. */
function tierOf(item: Row, investigator: Row): number {
  let tier = 0;
  for (const [index, level] of LEVELS.entries()) {
    const wanted = item[level] as string | null;
    if (!wanted) continue; // the case gives no name at this level
    if (investigator[`${level}_key`] !== nameKey(wanted)) break;
    tier = index + 1;
  }
  return tier;
}

/**
 * Candidates still waiting for a chance at this case. `busy` is true for anyone
 * working on a case: they are skipped for now and the case is retried when they
 * finish. Holding other offers does not count: offers go to everyone at once.
 */
async function rankCandidates(item: Row): Promise<{ user_id: string; tier: number; busy: boolean }[]> {
  const pool = item.target_mode === "area";
  const rows = await query(
    `SELECT p.*,
       EXISTS (SELECT 1 FROM investigations w WHERE w.assignee_id = p.user_id
         AND w.status IN ('assigned','in_progress','returned')) AS working,
       (SELECT count(*)::int FROM investigations t WHERE t.assignee_id = p.user_id
         AND t.claimed_at > now() - interval '1 day') AS today
     FROM investigator_profiles p JOIN users u ON u.user_id = p.user_id
     WHERE u.status = 'active' AND u.deleted_at IS NULL AND p.available AND p.location_set_at IS NOT NULL
       AND p.user_id NOT IN (SELECT user_id FROM investigation_offers WHERE investigation_id = $1 AND round = $2)
       AND (NOT $3::boolean OR p.user_id IN (SELECT user_id FROM investigation_recipients WHERE investigation_id = $1))`,
    [item.investigation_id, item.dispatch_round, pool],
  );
  const shape = (item.area_filter as { mode?: string } | null)?.mode;
  const origin =
    item.lat !== null
      ? [item.lat as number, item.lng as number]
      : shape === "circle"
        ? [(item.area_filter as Row).lat as number, (item.area_filter as Row).lng as number]
        : null;

  return rows
    .map((row) => {
      // The admin's chosen area already limits the pool, so everyone in it qualifies.
      const tier = Math.max(tierOf(item, row), pool ? 0.5 : 0);
      const km =
        origin && row.lat !== null ? distanceKm(origin[0]!, origin[1]!, row.lat as number, row.lng as number) : 1e6;
      return {
        user_id: row.user_id as string,
        tier,
        km,
        today: row.today as number,
        busy: Boolean(row.working),
      };
    })
    .filter((row) => row.tier > 0)
    // Closest level first; within about a kilometre, whoever has done least today.
    .sort((a, b) => b.tier - a.tier || Math.round(a.km) - Math.round(b.km) || a.today - b.today || a.km - b.km)
    .map(({ user_id, tier, busy }) => ({ user_id, tier: Math.floor(tier), busy }));
}

/** The candidates who get the next round of offers: everyone free in the pool, else the closest level. */
export function nextGroup(
  ranked: { user_id: string; tier: number; busy: boolean }[],
  pool: boolean,
): { user_id: string; tier: number }[] {
  const free = ranked.filter((candidate) => !candidate.busy);
  if (!free.length) return [];
  if (pool) return free;
  const best = free[0]!.tier;
  return free.filter((candidate) => candidate.tier === best);
}

/** Offers the case to the next group of candidates, or marks it unassigned. */
export async function offerNext(investigationId: string): Promise<void> {
  await transaction(async () => {
    const [item] = await query("SELECT * FROM investigations WHERE investigation_id = $1 FOR UPDATE", [
      investigationId,
    ]);
    if (!item || item.status !== "open") return;
    const pending = await query(
      "SELECT 1 FROM investigation_offers WHERE investigation_id = $1 AND response IS NULL",
      [investigationId],
    );
    if (pending.length) return;

    let group: { user_id: string; tier: number }[] = [];
    if (item.preferred_id) {
      const tried = await query(
        "SELECT 1 FROM investigation_offers WHERE investigation_id=$1 AND user_id=$2 AND round=$3",
        [investigationId, item.preferred_id, item.dispatch_round],
      );
      if (!tried.length) group = [{ user_id: item.preferred_id as string, tier: 6 }];
    }
    if (!group.length) {
      const ranked = await rankCandidates(item);
      group = nextGroup(ranked, item.target_mode === "area");
      if (!group.length && ranked.length) {
        // Everyone eligible is busy: wait, and retry on every dispatcher tick.
        const waiting = await query(
          "SELECT 1 FROM investigation_events WHERE investigation_id=$1 AND type='waiting' AND created_at > COALESCE((SELECT max(created_at) FROM investigation_events WHERE investigation_id=$1 AND type <> 'waiting'), 'epoch')",
          [investigationId],
        );
        if (!waiting.length) await logEvent(investigationId, "waiting", null, null, `${ranked.length}`);
        return;
      }
    }

    if (!group.length) {
      await query("UPDATE investigations SET status='unassigned', updated_at=now() WHERE investigation_id=$1", [
        investigationId,
      ]);
      await logEvent(investigationId, "unassigned");
      return;
    }
    for (const next of group) {
      await query(
        `INSERT INTO investigation_offers(investigation_id,user_id,tier,round,expires_at)
         VALUES($1,$2,$3,$4, now() + make_interval(mins => $5))`,
        [investigationId, next.user_id, next.tier, item.dispatch_round, item.accept_minutes ?? 30],
      );
      await logEvent(investigationId, "offered", next.user_id, null, TIER_LABELS[next.tier] ?? null);
    }
  });
}

/** Closes every offer whose window has passed and moves each case on. */
export async function expireOffers(): Promise<number> {
  const expired = await query(
    `UPDATE investigation_offers SET response='expired', responded_at=now()
     WHERE response IS NULL AND expires_at <= now() RETURNING investigation_id, user_id`,
  );
  for (const offer of expired) {
    await logEvent(offer.investigation_id as string, "expired", offer.user_id as string);
    await offerNext(offer.investigation_id as string);
  }
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

export function startDispatcher(intervalMs = 15_000): void {
  const tick = async () => {
    try {
      await expireOffers();
      await resumeOpenCases();
    } catch (error) {
      logger.error("dispatch.tick_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  };
  void tick();
  setInterval(() => void tick(), intervalMs);
}
