-- Golden Pay - Dynamic Forms service. Idempotent; applied on service start.

CREATE TABLE IF NOT EXISTS form_clients (
  client_id text PRIMARY KEY,
  name text NOT NULL,
  client_type text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS form_templates (
  template_id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  code text NOT NULL UNIQUE,
  client_id text NOT NULL REFERENCES form_clients(client_id),
  title text NOT NULL,
  category text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  sections jsonb NOT NULL,
  source_file text,
  active boolean NOT NULL DEFAULT true,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_form_templates_client ON form_templates (client_id, active);

-- ───────────── Client report templates (Head Office) ─────────────

-- What identifies each client inside a document: names, spellings and logo pictures.
ALTER TABLE form_clients ADD COLUMN IF NOT EXISTS name_en text;
ALTER TABLE form_clients ADD COLUMN IF NOT EXISTS aliases jsonb NOT NULL DEFAULT '[]';
ALTER TABLE form_clients ADD COLUMN IF NOT EXISTS logo_hashes jsonb NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS investigation_types (
  code text PRIMARY KEY,
  name text NOT NULL,
  sort integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true
);

-- A template family is one client's form for one investigation type. Its content lives
-- in versions; the family points at the version new cases use.
ALTER TABLE form_templates ADD COLUMN IF NOT EXISTS investigation_type text;
ALTER TABLE form_templates ADD COLUMN IF NOT EXISTS active_version_id text;
CREATE INDEX IF NOT EXISTS idx_form_templates_type ON form_templates (client_id, investigation_type, active);

-- Uploaded originals, stored once by content hash and never changed.
CREATE TABLE IF NOT EXISTS template_files (
  file_id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  sha256 text NOT NULL UNIQUE,
  file_name text NOT NULL,
  format text NOT NULL,
  size integer NOT NULL,
  path text NOT NULL,
  -- The .docx used for scanning when the upload was .doc or .pdf.
  docx_path text,
  source_path text,
  inventory jsonb,
  uploaded_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS template_versions (
  version_id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  template_id text NOT NULL REFERENCES form_templates(template_id),
  version_no integer NOT NULL,
  -- draft → in_review → approved → active → retired; in_review can return to draft.
  status text NOT NULL CHECK (status IN ('draft', 'in_review', 'approved', 'active', 'retired')),
  -- 'docx' fills the client's own Word layout; 'standard' prints the Golden Pay layout.
  layout_mode text NOT NULL CHECK (layout_mode IN ('docx', 'standard')),
  definition jsonb NOT NULL,
  bindings jsonb NOT NULL DEFAULT '[]',
  slots jsonb NOT NULL DEFAULT '[]',
  source_file_id text REFERENCES template_files(file_id),
  layout_path text,
  layout_sha256 text,
  -- SHA-256 of definition + bindings + layout: what the reviewer approved.
  content_hash text,
  warnings jsonb NOT NULL DEFAULT '[]',
  acknowledged jsonb NOT NULL DEFAULT '[]',
  change_note text,
  based_on_version_id text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  submitted_by text,
  submitted_at timestamptz,
  reviewed_by text,
  reviewed_at timestamptz,
  review_note text,
  activated_by text,
  activated_at timestamptz,
  retired_at timestamptz,
  UNIQUE (template_id, version_no)
);
CREATE INDEX IF NOT EXISTS idx_template_versions_status ON template_versions (status, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_template_active_version ON template_versions (template_id) WHERE status = 'active';
-- Earlier states of a draft's page (newest first), so Head Office can undo edits.
ALTER TABLE template_versions ADD COLUMN IF NOT EXISTS layout_history jsonb NOT NULL DEFAULT '[]';

-- A version that left draft can never change: only its status may move forward.
CREATE OR REPLACE FUNCTION gp_template_version_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'TEMPLATE_VERSION_IMMUTABLE: version % is %', OLD.version_no, OLD.status;
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' AND (
       NEW.definition IS DISTINCT FROM OLD.definition OR
       NEW.bindings IS DISTINCT FROM OLD.bindings OR
       NEW.slots IS DISTINCT FROM OLD.slots OR
       NEW.layout_mode IS DISTINCT FROM OLD.layout_mode OR
       NEW.layout_path IS DISTINCT FROM OLD.layout_path OR
       NEW.layout_sha256 IS DISTINCT FROM OLD.layout_sha256 OR
       NEW.content_hash IS DISTINCT FROM OLD.content_hash OR
       NEW.template_id IS DISTINCT FROM OLD.template_id OR
       NEW.version_no IS DISTINCT FROM OLD.version_no OR
       NEW.source_file_id IS DISTINCT FROM OLD.source_file_id) THEN
    RAISE EXCEPTION 'TEMPLATE_VERSION_IMMUTABLE: version % is %', OLD.version_no, OLD.status;
  END IF;
  IF OLD.status IN ('active', 'retired', 'approved') AND NEW.status = 'draft' THEN
    RAISE EXCEPTION 'TEMPLATE_VERSION_IMMUTABLE: an approved version cannot become a draft';
  END IF;
  IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN
    RAISE EXCEPTION 'TEMPLATE_VERSION_IMMUTABLE: a retired version stays retired';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_template_version_guard ON template_versions;
CREATE TRIGGER trg_template_version_guard BEFORE UPDATE OR DELETE ON template_versions
  FOR EACH ROW EXECUTE FUNCTION gp_template_version_guard();

-- Every change to templates, for the Head Office audit trail.
CREATE TABLE IF NOT EXISTS template_events (
  event_id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  template_id text,
  version_id text,
  file_id text,
  type text NOT NULL,
  actor_id text,
  note text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_template_events ON template_events (template_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_template_events_time ON template_events (created_at DESC);

-- Rendered previews, cached by content so the same preview is never built twice.
CREATE TABLE IF NOT EXISTS template_previews (
  cache_key text PRIMARY KEY,
  version_id text NOT NULL,
  path text NOT NULL,
  pages integer,
  engine text,
  created_at timestamptz NOT NULL DEFAULT now()
);
