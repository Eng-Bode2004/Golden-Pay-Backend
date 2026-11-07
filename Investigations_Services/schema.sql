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
  -- NULL while waiting; accepted, declined, expired or cancelled.
  response text,
  reason text
);
CREATE INDEX IF NOT EXISTS idx_offers_case ON investigation_offers (investigation_id, round);
CREATE INDEX IF NOT EXISTS idx_offers_user ON investigation_offers (user_id, offered_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_offer_pending ON investigation_offers (investigation_id) WHERE response IS NULL;

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
