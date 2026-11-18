# Fairness-aware broadcast dispatch

Design and operating notes for how Golden Pay offers investigations to investigators.
Status: implemented behind the `engine` setting of the dispatch policy (default
`fair_broadcast`; `sequential` restores the previous behaviour, `shadow` runs the old engine
and records what the new one would have done).

## 1. Architecture before this change

* `Investigations_Services/dispatch.ts` ran inside the investigations service. A 15 s ticker
  expired offers and re-offered open cases with no live offer.
* A case was offered to **one investigator at a time**, ranked by how deeply their single
  registered area (`investigator_profiles`, governorate → sub-village) matched the case
  address, then by GPS distance and by cases claimed in the last day. A refusal or timeout
  moved it to the next person. A unique index (`uq_offer_pending`, one open offer per case)
  enforced this.
* A short-lived intermediate version (commit 54b4075) broadcast to everyone at the best
  geographic level, with no workload fairness.
* Area cases (`target_mode = 'area'`) were limited to the investigators matched when the
  case was created (`investigation_recipients`); personal cases (`'person'`) went to the
  chosen investigator first (`preferred_id`, tier 6) and then fell back to the area.
* Accepting (`POST /investigations/:id/claim`) updated the offer, then the case.
* There was no assignment ledger: workload was read from `investigations.assignee_id`, so a
  reassignment or cancellation rewrote history.
* There was no manual assign/reassign endpoint, no dispatch policy, no notifications (the app
  polls every 20 s), and no record of why an investigator was or was not offered a case.

## 2. Schema and constraints (relevant parts)

| Table | Purpose | Key constraints |
|---|---|---|
| `users` | accounts; `status` active / suspended / pending… | PK `user_id` |
| `investigator_profiles` | one primary work area, availability, GPS point | PK `user_id` |
| `investigations` | the case; `status`, `assignee_id`, `dispatch_round`, `accept_minutes` | PK, unique `reference` |
| `investigation_recipients` | pool of an area case | PK (case, user) |
| `investigation_offers` | offers; `response` NULL / accepted / declined / expired / cancelled / taken | partial unique (case, user) while open |
| `investigation_events` | timeline | — |

New in this change (all idempotent `CREATE … IF NOT EXISTS`, applied at service start):

| Table | Purpose |
|---|---|
| `dispatch_policy` | one row (`policy_id = 'default'`): engine, score mode, window, offer minutes, workload limit, manual-assignment rule, newcomer rule |
| `investigator_service_areas` | every area an investigator serves (the profile's area is kept in sync as the primary one) |
| `investigation_assignments` | **assignment ledger**, the source of truth for fairness |
| `dispatch_attempts` | every dispatch decision: who was eligible with which score, who was excluded and why, who got the offer |
| `dispatch_outbox` | notifications to deliver (new offer, offer closed), one per case/user/kind/round |

## 3. Fairness algorithm (default policy)

For each dispatch step of a case:

1. **Pool**: investigators whose service areas cover the case (§4); for an area case, the
   recipients matched at creation.
2. **Exclude**, with a recorded reason: account not active, marked unavailable, already
   offered in this round, at the workload limit (`active ≥ max_active`).
3. **Geography first**: for address cases, keep the deepest matching level that still has
   eligible investigators (sub-village before village … before governorate).
4. **Score** each eligible investigator:
   `score = successful assignments in the last window_days (default 30)`
   plus, in `hybrid` mode, `active_weight × current active cases`.
   Newcomers (first area set inside the window) start at `max(raw, pool_min − 1)`, so they
   are prioritised once without taking a whole window of cases.
5. **Broadcast** to everyone with the **minimum score**.
6. If nobody accepts before `expires_at`, the next step offers the next-lowest score group,
   then the next geographic level, without re-notifying anyone already offered this round.
7. When everyone is exhausted, the case becomes `unassigned` and is escalated to the admin
   (event `unassigned`, shown on the dispatch dashboard).

The four-investigator example: all at 0 → A, B, C, D offered; A accepts (A = 1); next case →
B, C, D (minimum 0); B accepts; next → C, D; … when all are 1 the minimum group is everyone again.

**Why a rolling window of successful assignments:** it is explainable ("you had 3 cases in
the last 30 days, the others had 2"), cannot be gamed by toggling availability or by
declining (neither changes the score), gives no lasting advantage to fast tappers (winning
raises your score, so you sit out until the others catch up), and history older than the
window stops counting, so nobody is excluded forever. A virtual-round counter would reset
too abruptly; normalised rates are harder to explain.

### Fairness accounting rules (ledger)

| Event | Ledger effect | Counts for fairness |
|---|---|---|
| Investigator accepts an offer | new row, source `accepted` | yes |
| Admin assigns manually | new row, source `manual` | per policy `manual_counts` (default yes) |
| Personal case accepted by the chosen investigator | row, source `preferred` | yes |
| Report approved | row ended `completed` | unchanged |
| Cancelled before work started (status `assigned`) | row ended `cancelled`, `counts = false` | no |
| Cancelled after work started | row ended `cancelled` | yes |
| Reassigned to someone else | old row ended `reassigned` (voided if work had not started); new row for the new person | per the two rules above |
| Declined / expired / closed because someone else won (`taken`) | no row | never |

Every change of `counts` is written with `ended_by` and `end_reason` and an event on the case,
so a fairness complaint can be traced. A partial unique index (one open ledger row per case)
makes a double assignment impossible.

Metrics exposed per investigator: assignments in window, total, active, completed,
cancelled, offers declined, expired, taken, reassigned away, availability, average response.

## 4. Geographic eligibility

* `investigator_service_areas` holds any number of areas per investigator (governorate,
  district, local unit, main village, sub-village keys, normalised with `nameKey`). The
  signup / profile area is the primary row; admins can add or remove extra areas.
* An investigator matches a case if **any** of their areas matches; the match depth is the
  deepest of their areas, so overlapping areas never produce two offers (one per
  investigator, enforced by the unique open-offer index).
* Admin-drawn areas (circle / polygon) select by the investigator's **registered** point,
  never live GPS; live GPS only orders candidates within the same level.
* **Fairness pool**: the score counts an investigator's assignments in all areas, so serving
  several areas gives no extra share and nothing is double-counted.
* Indexes: `(governorate_key, district_key, local_unit_key)` on service areas, plus
  `user_id`.

## 5. Concurrency and transactions

* **Issuing offers**: `offerNext` locks the case row (`SELECT … FOR UPDATE`) and checks for a
  live offer before creating new ones, so two dispatch workers cannot issue two groups.
  Offers are inserted under the unique (case, user) open-offer index and a unique
  (case, round, user) index.
* **Accepting** (`acceptOffer`, one transaction): lock the case → if it is already assigned to
  this investigator, return success (idempotent) → if not open, `INVESTIGATION_TAKEN` → mark
  this offer accepted only if it is open and not expired (`expires_at > now()`, enforced by
  the server) → insert the ledger row (unique open row per case) → assign the case → close
  every other open offer as `taken`. All or nothing; the loser waits on the row lock and sees
  the case taken.
* **Expiry** is a single `UPDATE … WHERE expires_at <= now() RETURNING`, so each offer
  expires once even with several workers.
* **Billing** is untouched: prices stay on the case and earnings follow the assignee at
  approval, as before.

## 6. Migration plan

All statements are additive and idempotent, applied by the service at start:

1. Create the new tables and indexes.
2. Backfill `investigator_service_areas` from `investigator_profiles` (primary area).
3. Backfill the ledger from existing assigned cases (`source = 'backfill'`, ended for
   approved/cancelled cases). Existing assignments are not changed.
4. Seed the default policy (`engine = 'fair_broadcast'`).
5. Open offers from the old engine stay valid and expire normally; the new engine takes over
   at the next step of each case.

Rollback: set `engine = 'sequential'` on the dashboard (no deploy needed). Full code rollback:
redeploy the previous commit; the new tables are ignored by old code and can stay.

## 7. Mobile app

* The offer list and the case screen show a live countdown to `expires_at`.
* Offers taken by someone else disappear at the next refresh; refresh is every 20 s, every
  10 s while an offer is on screen, and on resume.
* Accepting needs a connection: offline, the app says so instead of queueing, so a stale
  screen can never accept. The server rejects expired or taken offers anyway, and the app
  explains which one it was and removes the offer.
* Notifications are read from the outbox (`/investigations/feed`); each is shown once.
  Real push notifications need a Firebase project (not set up yet); the outbox is designed
  so FCM can deliver the same rows later.

## 8. Admin dashboard

New page **Dispatch & fairness** (التوزيع والعدالة):

* Policy: engine, score mode, window, offer minutes, workload limit, manual-assignment rule.
* Investigators: areas, availability, active cases, score, assignments in window, completed,
  cancelled, declined, expired, taken, average response, extra service areas.
* Waiting cases and open offers.
* Metrics: average time to assignment, share assigned within the offer window, acceptance
  rate, fairness imbalance (max − min and standard deviation of scores), conflicts, manual
  interventions.
* Case drawer: the dispatch decisions of the case (eligible with scores, excluded with
  reasons, offered) and manual assign / reassign with a required reason.

## 9. Performance

* A dispatch step reads the pool with one query (profiles × areas × workload counts from the
  ledger with an index on `(user_id, assigned_at)`), scores in memory, and inserts one offer
  row per recipient in the same transaction. For 300 investigators this is a few
  milliseconds; 300 offers are one multi-row insert.
* Offers are per case, so many cases dispatch independently; each locks only its own row.

## 10. Testing

* `dispatch.test.ts`: pure fairness selection (score groups, newcomers, workload exclusion,
  geography order).
* `dispatch.db.test.ts`: real PostgreSQL behaviour (set `TEST_DATABASE_URL` to an empty
  database; skipped otherwise): the 20 scenarios in the brief, including simultaneous
  acceptance with separate connections and hundreds of recipients.

## 11. Deployment and rollback

1. Deploy backend (schema migrates itself). Engine defaults to `fair_broadcast`; to evaluate
   first, set it to `shadow` on the dashboard and compare the recorded decisions.
2. Deploy dashboard; publish the app update.
3. Rollback: set the engine to `sequential`, or redeploy the previous commit.
