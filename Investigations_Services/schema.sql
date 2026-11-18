-- Golden Pay - Investigations service. Idempotent; applied on service start.

CREATE TABLE IF NOT EXISTS investigations (
  investigation_id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  reference text NOT NULL UNIQUE,
  -- open -> assigned -> in_progress -> submitted -> approved, or returned back
  -- to in_progress; cancelled from any state before approval.
  status text NOT NULL,
  target_mode text NOT NULL,
  area_filter jsonb,
  assignee_id text REFERENCES users(user_id),
  subject_name text NOT NULL,
  subject_phone text,
  client_reference text,
  address text NOT NULL,
  governorate text,
  district text,
  local_unit text,
  main_village text,
  sub_village text,
  landmark text,
  lat double precision,
  lng double precision,
  admin_notes text,
  client_id text NOT NULL,
  client_name text NOT NULL,
  template_id text NOT NULL,
  form_title text NOT NULL,
  -- Frozen at creation, so later form edits never change a running case.
  form_snapshot jsonb NOT NULL,
  answers jsonb NOT NULL DEFAULT '{}',
  review_note text,
  submit_lat double precision,
  submit_lng double precision,
  pdf_status text NOT NULL DEFAULT 'none',
  pdf_path text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  started_at timestamptz,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_investigations_status ON investigations (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_investigations_assignee ON investigations (assignee_id, status);

CREATE TABLE IF NOT EXISTS investigation_recipients (
  investigation_id text NOT NULL REFERENCES investigations(investigation_id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(user_id),
  PRIMARY KEY (investigation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_investigation_recipients_user ON investigation_recipients (user_id);

CREATE TABLE IF NOT EXISTS investigation_images (
  image_id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  investigation_id text NOT NULL REFERENCES investigations(investigation_id) ON DELETE CASCADE,
  field_key text NOT NULL,
  path text NOT NULL,
  uploaded_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_investigation_images ON investigation_images (investigation_id);

-- Investigation types (service levels) and the money attached to each case.
CREATE TABLE IF NOT EXISTS service_levels (
  code text PRIMARY KEY,
  name_ar text NOT NULL,
  name_en text NOT NULL,
  delivery_label text NOT NULL,
  -- NULL for scheduled cases, whose deadline is chosen per case.
  delivery_hours integer,
  -- What the bank or company pays, and what the investigator earns.
  client_price numeric(12,2) NOT NULL DEFAULT 0,
  investigator_price numeric(12,2) NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  sort integer NOT NULL DEFAULT 0,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Prices are copied onto each case when it is sent, so later price changes never
-- alter past earnings.
ALTER TABLE investigations ADD COLUMN IF NOT EXISTS service_level text;
ALTER TABLE investigations ADD COLUMN IF NOT EXISTS service_name text;
ALTER TABLE investigations ADD COLUMN IF NOT EXISTS client_price numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE investigations ADD COLUMN IF NOT EXISTS investigator_price numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE investigations ADD COLUMN IF NOT EXISTS due_at timestamptz;
ALTER TABLE investigations ADD COLUMN IF NOT EXISTS return_count integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_investigations_reviewed ON investigations (status, reviewed_at);

-- One investigator at a time is offered a case for the type's acceptance window.
ALTER TABLE service_levels ADD COLUMN IF NOT EXISTS accept_minutes integer NOT NULL DEFAULT 30;
ALTER TABLE investigations ADD COLUMN IF NOT EXISTS preferred_id text;
ALTER TABLE investigations ADD COLUMN IF NOT EXISTS accept_minutes integer NOT NULL DEFAULT 30;
ALTER TABLE investigations ADD COLUMN IF NOT EXISTS dispatch_round integer NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS investigation_offers (
  offer_id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  investigation_id text NOT NULL REFERENCES investigations(investigation_id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(user_id),
  -- 6 chosen by the admin, 5 sub village ... 1 governorate, 0 map-drawn area.
  tier integer NOT NULL,
  round integer NOT NULL DEFAULT 1,
  offered_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  seen_at timestamptz,
  responded_at timestamptz,
  -- NULL while waiting; accepted, declined, expired, cancelled, or taken (another
  -- investigator accepted first: a case is offered to everyone who covers it at once).
  response text,
  reason text
);
CREATE INDEX IF NOT EXISTS idx_offers_case ON investigation_offers (investigation_id, round);
CREATE INDEX IF NOT EXISTS idx_offers_user ON investigation_offers (user_id, offered_at DESC);
-- One open offer per case and investigator (a case used to go to one person at a time).
DROP INDEX IF EXISTS uq_offer_pending;
CREATE UNIQUE INDEX IF NOT EXISTS uq_offer_pending_user ON investigation_offers (investigation_id, user_id) WHERE response IS NULL;

-- Every step of a case, for the admin timeline and response-time analytics.
CREATE TABLE IF NOT EXISTS investigation_events (
  event_id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  investigation_id text NOT NULL REFERENCES investigations(investigation_id) ON DELETE CASCADE,
  type text NOT NULL,
  user_id text,
  actor_id text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_case ON investigation_events (investigation_id, created_at);

-- Negative investigation: the person was not found, with the reasons why.
ALTER TABLE investigations ADD COLUMN IF NOT EXISTS outcome text NOT NULL DEFAULT 'positive';
ALTER TABLE investigations ADD COLUMN IF NOT EXISTS negative_reasons jsonb;
ALTER TABLE investigations ADD COLUMN IF NOT EXISTS negative_note text;

-- Where the investigator was while working on a case.
CREATE TABLE IF NOT EXISTS investigation_locations (
  location_id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  investigation_id text NOT NULL REFERENCES investigations(investigation_id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(user_id),
  kind text NOT NULL,
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  accuracy double precision,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_investigation_locations ON investigation_locations (investigation_id, created_at);

-- The exact template version a case was sent with. Versions never change once approved,
-- so a case always reports with the form and layout it was created with.
ALTER TABLE investigations ADD COLUMN IF NOT EXISTS template_version_id text;
ALTER TABLE investigations ADD COLUMN IF NOT EXISTS template_version_no integer;
ALTER TABLE investigations ADD COLUMN IF NOT EXISTS template_hash text;
ALTER TABLE investigations ADD COLUMN IF NOT EXISTS investigation_type text;
CREATE INDEX IF NOT EXISTS idx_investigations_template_version ON investigations (template_version_id);

-- How the last report was produced, and what was missing or left out of it.
ALTER TABLE investigations ADD COLUMN IF NOT EXISTS report_layout text;
ALTER TABLE investigations ADD COLUMN IF NOT EXISTS report_engine text;
ALTER TABLE investigations ADD COLUMN IF NOT EXISTS report_pages integer;
ALTER TABLE investigations ADD COLUMN IF NOT EXISTS report_issues jsonb;
ALTER TABLE investigations ADD COLUMN IF NOT EXISTS report_docx_path text;
ALTER TABLE investigations ADD COLUMN IF NOT EXISTS report_error text;
ALTER TABLE investigations ADD COLUMN IF NOT EXISTS report_built_at timestamptz;

-- ───────────── Fairness-aware broadcast dispatch (docs/dispatch-fairness.md) ─────────────

-- One policy row. engine: fair_broadcast (default) | sequential (the old one-at-a-time) |
-- shadow (runs sequential, records what fair_broadcast would have offered).
CREATE TABLE IF NOT EXISTS dispatch_policy (
  policy_id text PRIMARY KEY,
  engine text NOT NULL DEFAULT 'fair_broadcast',
  -- assignments: successful assignments in the window; hybrid: plus weighted active cases.
  score_mode text NOT NULL DEFAULT 'assignments',
  window_days integer NOT NULL DEFAULT 30,
  active_weight numeric(6,2) NOT NULL DEFAULT 1,
  -- NULL: each investigation type's acceptance window.
  offer_minutes integer,
  -- Investigators with this many active cases get no new offers.
  max_active integer NOT NULL DEFAULT 1,
  manual_counts boolean NOT NULL DEFAULT true,
  newcomer_boost boolean NOT NULL DEFAULT true,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO dispatch_policy (policy_id) VALUES ('default') ON CONFLICT (policy_id) DO NOTHING;

-- The assignment ledger: the source of truth for fairness. One open row per case.
CREATE TABLE IF NOT EXISTS investigation_assignments (
  assignment_id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  investigation_id text NOT NULL REFERENCES investigations(investigation_id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(user_id),
  -- accepted | preferred | manual | backfill
  source text NOT NULL,
  offer_id text,
  counts boolean NOT NULL DEFAULT true,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  assigned_by text,
  ended_at timestamptz,
  -- completed | cancelled | reassigned
  end_reason text,
  ended_by text,
  note text
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_assignment_open ON investigation_assignments (investigation_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_assignments_user ON investigation_assignments (user_id, assigned_at DESC);

-- Existing assignments enter the ledger once; nothing about the cases changes.
INSERT INTO investigation_assignments (investigation_id, user_id, source, counts, assigned_at, ended_at, end_reason)
SELECT i.investigation_id, i.assignee_id, 'backfill', true, COALESCE(i.claimed_at, i.created_at),
  CASE WHEN i.status IN ('approved','cancelled') THEN COALESCE(i.reviewed_at, i.updated_at) END,
  CASE WHEN i.status = 'approved' THEN 'completed' WHEN i.status = 'cancelled' THEN 'cancelled' END
FROM investigations i
WHERE i.assignee_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM investigation_assignments a WHERE a.investigation_id = i.investigation_id);

-- Every dispatch decision, so admins can see why someone was or was not offered a case.
CREATE TABLE IF NOT EXISTS dispatch_attempts (
  attempt_id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  investigation_id text NOT NULL REFERENCES investigations(investigation_id) ON DELETE CASCADE,
  round integer NOT NULL,
  engine text NOT NULL,
  shadow boolean NOT NULL DEFAULT false,
  tier integer,
  min_score numeric(10,2),
  pool_size integer NOT NULL DEFAULT 0,
  offered jsonb NOT NULL DEFAULT '[]',
  eligible jsonb NOT NULL DEFAULT '[]',
  excluded jsonb NOT NULL DEFAULT '[]',
  outcome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dispatch_attempts_case ON dispatch_attempts (investigation_id, created_at);

-- Notifications to deliver (the app reads them; push can deliver the same rows later).
CREATE TABLE IF NOT EXISTS dispatch_outbox (
  outbox_id bigserial PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(user_id),
  investigation_id text NOT NULL REFERENCES investigations(investigation_id) ON DELETE CASCADE,
  -- offer | offer_closed
  kind text NOT NULL,
  round integer NOT NULL DEFAULT 1,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_outbox_once ON dispatch_outbox (investigation_id, user_id, kind, round);
CREATE INDEX IF NOT EXISTS idx_outbox_user ON dispatch_outbox (user_id, outbox_id);

-- ───────────── Prices per company/bank and per area (head office) ─────────────
-- A rule sets the client price and the investigator's pay for one investigation type,
-- optionally for one client and optionally for one governorate or district. The most
-- specific matching rule wins; with none, the type's own prices apply. Prices are copied
-- onto each case when it is sent, so later changes never alter sent cases.
CREATE TABLE IF NOT EXISTS price_rules (
  rule_id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  service_level text NOT NULL REFERENCES service_levels(code),
  client_id text,
  governorate text,
  governorate_key text,
  district text,
  district_key text,
  client_price numeric(12,2) NOT NULL DEFAULT 0,
  investigator_price numeric(12,2) NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  note text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_price_rule
  ON price_rules (service_level, COALESCE(client_id, ''), COALESCE(governorate_key, ''), COALESCE(district_key, '')) WHERE active;
CREATE INDEX IF NOT EXISTS idx_price_rules_lookup ON price_rules (service_level, client_id) WHERE active;

-- Which price list a case was priced from (for the audit trail).
ALTER TABLE investigations ADD COLUMN IF NOT EXISTS price_rule_id text;
