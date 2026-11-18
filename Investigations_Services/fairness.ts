/**
 * Least-assigned-first selection for broadcast dispatch (docs/dispatch-fairness.md §3).
 * Pure: takes the pool with its numbers, returns who gets the next offers and why the rest
 * did not. The database side (dispatch.ts) loads the pool and writes the offers.
 */

export type Engine = "fair_broadcast" | "sequential" | "shadow";

export interface Policy {
  engine: Engine;
  score_mode: "assignments" | "hybrid";
  window_days: number;
  active_weight: number;
  offer_minutes: number | null;
  max_active: number;
  manual_counts: boolean;
  newcomer_boost: boolean;
}

export const DEFAULT_POLICY: Policy = {
  engine: "fair_broadcast",
  score_mode: "assignments",
  window_days: 30,
  active_weight: 1,
  offer_minutes: null,
  max_active: 1,
  manual_counts: true,
  newcomer_boost: true,
};

export type ExclusionReason =
  | "account_suspended"
  | "account_inactive"
  | "unavailable"
  | "workload_limit"
  | "already_offered"
  | "declined";

export const EXCLUSION_LABELS: Record<ExclusionReason, string> = {
  account_suspended: "الحساب موقوف",
  account_inactive: "الحساب غير مفعّل",
  unavailable: "غير متاح (أوقف استقبال الاستعلامات)",
  workload_limit: "وصل للحد الأقصى من الاستعلامات النشطة",
  already_offered: "عُرض عليه في هذه الجولة",
  declined: "رفضه في هذه الجولة",
};

/** One investigator in the case's pool, with what the database knows about them. */
export interface PoolMember {
  user_id: string;
  /** How deeply their service areas match the case: 5 sub-village … 1 governorate; 0.5 any member of an area pool. */
  tier: number;
  /** Distance from the case to their registered point, when both are known. */
  km: number | null;
  account_status: string;
  available: boolean;
  /** Successful (counting) assignments inside the fairness window. */
  recent: number;
  active: number;
  /** First service area set inside the fairness window. */
  newcomer: boolean;
  /** Offered in this round already (and how they answered, if they did). */
  offered: boolean;
  declined: boolean;
}

export interface ScoredMember {
  user_id: string;
  tier: number;
  score: number;
  raw: number;
  active: number;
  newcomer: boolean;
  km: number | null;
}

export interface Selection {
  offer: ScoredMember[];
  eligible: ScoredMember[];
  excluded: { user_id: string; reason: ExclusionReason }[];
  tier: number | null;
  min_score: number | null;
  /** True when nobody is left to offer in this round (escalate). */
  exhausted: boolean;
  /** True when people match but every one of them is busy or unavailable for now (wait). */
  waiting: boolean;
}

function exclusionOf(member: PoolMember, policy: Policy): ExclusionReason | null {
  if (member.account_status === "suspended") return "account_suspended";
  if (member.account_status !== "active") return "account_inactive";
  if (member.declined) return "declined";
  if (member.offered) return "already_offered";
  if (!member.available) return "unavailable";
  if (member.active >= policy.max_active) return "workload_limit";
  return null;
}

/** The fairness score of everyone eligible, newcomers lifted to just under the established minimum. */
export function scoreMembers(eligible: PoolMember[], policy: Policy): ScoredMember[] {
  const base = (member: PoolMember) =>
    member.recent + (policy.score_mode === "hybrid" ? policy.active_weight * member.active : 0);
  const established = eligible.filter((member) => !member.newcomer).map(base);
  const floor = established.length ? Math.min(...established) - 1 : null;
  return eligible.map((member) => {
    const raw = base(member);
    const score = policy.newcomer_boost && member.newcomer && floor !== null ? Math.max(raw, floor) : raw;
    return { user_id: member.user_id, tier: member.tier, score, raw, active: member.active, newcomer: member.newcomer, km: member.km };
  });
}

/**
 * Who gets the next broadcast of a case:
 * 1. drop anyone excluded (with the reason recorded),
 * 2. keep the deepest geographic level that still has someone eligible (area pools are one level),
 * 3. offer everyone with the lowest fairness score at that level.
 * Calling it again after a timeout (the offered ones are now `offered`) yields the next score
 * group, then the next level out.
 */
export function selectNext(pool: PoolMember[], policy: Policy): Selection {
  const excluded: Selection["excluded"] = [];
  const eligibleMembers: PoolMember[] = [];
  for (const member of pool) {
    if (member.tier <= 0) continue;
    const reason = exclusionOf(member, policy);
    if (reason) excluded.push({ user_id: member.user_id, reason });
    else eligibleMembers.push(member);
  }
  const eligible = scoreMembers(eligibleMembers, policy);
  if (!eligible.length) {
    // Someone may become free (finish a case, switch availability back on): wait for them.
    const recoverable = excluded.some((item) => item.reason === "workload_limit" || item.reason === "unavailable");
    return { offer: [], eligible, excluded, tier: null, min_score: null, exhausted: !recoverable, waiting: recoverable };
  }
  const tier = Math.max(...eligible.map((member) => Math.floor(member.tier)));
  const atTier = eligible.filter((member) => Math.floor(member.tier) === tier);
  const min = Math.min(...atTier.map((member) => member.score));
  const offer = atTier
    .filter((member) => member.score === min)
    .sort((a, b) => (a.km ?? 1e9) - (b.km ?? 1e9) || a.user_id.localeCompare(b.user_id));
  return { offer, eligible, excluded, tier, min_score: min, exhausted: false, waiting: false };
}

/** The previous engine (rollback): one investigator at a time, closest level, then nearest. */
export function selectSequential(pool: PoolMember[], policy: Policy): Selection {
  const fair = selectNext(pool, policy);
  if (!fair.eligible.length) return fair;
  const first = [...fair.eligible].sort(
    (a, b) => Math.floor(b.tier) - Math.floor(a.tier) || (a.km ?? 1e9) - (b.km ?? 1e9) || a.score - b.score,
  )[0]!;
  return { ...fair, offer: [first], tier: Math.floor(first.tier), min_score: first.score };
}

/** Max − min and standard deviation of scores: how uneven the work is (0 = perfectly even). */
export function imbalance(scores: number[]): { spread: number; stddev: number } {
  if (!scores.length) return { spread: 0, stddev: 0 };
  const mean = scores.reduce((sum, value) => sum + value, 0) / scores.length;
  const variance = scores.reduce((sum, value) => sum + (value - mean) ** 2, 0) / scores.length;
  return { spread: Math.max(...scores) - Math.min(...scores), stddev: Math.round(Math.sqrt(variance) * 100) / 100 };
}
