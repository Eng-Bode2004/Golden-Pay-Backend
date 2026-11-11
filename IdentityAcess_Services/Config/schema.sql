-- ---------------------------------------------------------------------------
-- Golden Pay - Identity & Access service
-- PostgreSQL schema (idempotent). Applied automatically on service start by
-- Config/db.ts#applySchema, or manually with: bun run db:init
--
-- All tables use a generated text primary key named `_id`; the business keys
-- (user_id, session_id, ...) are separate UNIQUE columns so the API contract
-- stays identical to the mobile application.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  "_id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id text NOT NULL UNIQUE,
  employee_id text UNIQUE,
  employee_number text UNIQUE,
  full_name text NOT NULL,
  phone text NOT NULL UNIQUE,
  phone_verified_at timestamptz,
  email text UNIQUE,
  national_id_encrypted text NOT NULL,
  national_id_hash text NOT NULL UNIQUE,
  national_id_last4 text NOT NULL,
  "FrontID_image" text NOT NULL DEFAULT '',
  "BackID_image" text NOT NULL DEFAULT '',
  password_hash text NOT NULL,
  password_changed_at timestamptz,
  account_type text NOT NULL,
  status text NOT NULL,
  status_reason text,
  approved_at timestamptz,
  approved_by text,
  rejected_at timestamptz,
  failed_login_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  biometric_enabled boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_image text NOT NULL DEFAULT '';
-- The Google account linked by "Sign in with Google" (its stable subject ID).
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub text;
CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_unique ON users(google_sub) WHERE google_sub IS NOT NULL;

CREATE TABLE IF NOT EXISTS employee_records (
  "_id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  employee_id text NOT NULL UNIQUE,
  employee_number text NOT NULL UNIQUE,
  full_name text NOT NULL,
  phone text NOT NULL,
  email text,
  national_id_hash text NOT NULL UNIQUE,
  national_id_last4 text NOT NULL,
  department text,
  position text,
  status text NOT NULL DEFAULT 'available',
  user_id text,
  registered_at timestamptz,
  imported_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refresh_sessions (
  "_id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  session_id text NOT NULL UNIQUE,
  user_id text NOT NULL,
  refresh_token_hash text NOT NULL UNIQUE,
  auth_method text NOT NULL,
  device_id text,
  device_name text,
  platform text,
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text,
  replaced_by_session_id text
);

CREATE TABLE IF NOT EXISTS biometric_credentials (
  "_id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  credential_id text NOT NULL UNIQUE,
  user_id text NOT NULL,
  device_id text NOT NULL,
  device_name text,
  platform text,
  public_key text NOT NULL,
  algorithm text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS login_challenges (
  "_id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  challenge_id text NOT NULL UNIQUE,
  user_id text NOT NULL,
  credential_id text NOT NULL,
  device_id text NOT NULL,
  nonce_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE TABLE IF NOT EXISTS roles (
  "_id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  role_id text NOT NULL UNIQUE,
  name text NOT NULL UNIQUE,
  description text,
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS permissions (
  "_id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  permission_id text NOT NULL UNIQUE,
  code text NOT NULL UNIQUE,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS role_permissions (
  "_id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  role_id text NOT NULL,
  permission_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT role_permissions_role_permission_unique UNIQUE (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS user_roles (
  "_id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id text NOT NULL,
  role_id text NOT NULL,
  assigned_by text,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_roles_user_role_unique UNIQUE (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS counters (
  "_id" text PRIMARY KEY,
  value integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit_logs (
  "_id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  event text NOT NULL,
  user_id text,
  employee_number text,
  actor_id text,
  success boolean NOT NULL,
  reason text,
  ip text,
  user_agent text,
  request_id text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Indexes for the queries used by the API / dashboard
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_users_status ON users (status);
CREATE INDEX IF NOT EXISTS idx_users_account_type ON users (account_type);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_employee_number ON users (employee_number);

CREATE INDEX IF NOT EXISTS idx_employee_records_status ON employee_records (status);
CREATE INDEX IF NOT EXISTS idx_employee_records_created_at ON employee_records (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_employee_records_user ON employee_records (user_id);

CREATE INDEX IF NOT EXISTS idx_refresh_sessions_user ON refresh_sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_refresh_sessions_expires ON refresh_sessions (expires_at);

CREATE INDEX IF NOT EXISTS idx_biometric_user ON biometric_credentials (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_biometric_active_device
  ON biometric_credentials (user_id, device_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_login_challenges_lookup
  ON login_challenges (challenge_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_event ON audit_logs (event);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs (user_id);

CREATE TABLE IF NOT EXISTS admin_security (
  user_id text PRIMARY KEY REFERENCES users(user_id),
  is_owner boolean NOT NULL DEFAULT false,
  mfa_required boolean NOT NULL DEFAULT false,
  secret text,
  last_step bigint NOT NULL DEFAULT -1,
  recovery_hashes jsonb NOT NULL DEFAULT '[]'
);
CREATE UNIQUE INDEX IF NOT EXISTS one_primary_admin ON admin_security (is_owner) WHERE is_owner;
ALTER TABLE admin_security ADD COLUMN IF NOT EXISTS mfa_method text NOT NULL DEFAULT 'totp';
ALTER TABLE admin_security ADD COLUMN IF NOT EXISTS pending_secret text;
CREATE TABLE IF NOT EXISTS admin_mfa_challenges (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(user_id),
  pending_secret text,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  consumed boolean NOT NULL DEFAULT false
);
ALTER TABLE admin_mfa_challenges ADD COLUMN IF NOT EXISTS method text NOT NULL DEFAULT 'totp';
ALTER TABLE admin_mfa_challenges ADD COLUMN IF NOT EXISTS otp_hash text;
ALTER TABLE admin_mfa_challenges ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE admin_mfa_challenges ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE admin_mfa_challenges ADD COLUMN IF NOT EXISTS sent_at timestamptz;

CREATE TABLE IF NOT EXISTS admin_invitations (
  invitation_id text PRIMARY KEY,
  email text NOT NULL,
  full_name text,
  mfa_required boolean NOT NULL DEFAULT false,
  token_hash text NOT NULL UNIQUE,
  invited_by text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_user_id text,
  last_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_invite_pending_email
  ON admin_invitations (lower(email))
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_admin_invitations_status ON admin_invitations (status, created_at DESC);
