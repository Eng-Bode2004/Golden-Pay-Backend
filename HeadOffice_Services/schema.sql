-- Head office: attendance, points, salaries, expenses and complaints.
-- Idempotent; applied every time the service starts.

CREATE TABLE IF NOT EXISTS ho_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per person per Cairo day: first and last time they were active.
CREATE TABLE IF NOT EXISTS attendance (
  user_id text NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  day date NOT NULL,
  first_seen timestamptz NOT NULL,
  last_seen timestamptz NOT NULL,
  late_minutes int NOT NULL DEFAULT 0,
  work_day boolean NOT NULL DEFAULT true,
  pings int NOT NULL DEFAULT 1,
  platform text,
  PRIMARY KEY (user_id, day)
);
CREATE INDEX IF NOT EXISTS attendance_day ON attendance(day);

-- green: on time all day · black: late, absent or a violation · blue: extra work or recognition.
CREATE TABLE IF NOT EXISTS staff_points (
  point_id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id text NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  color text NOT NULL CHECK (color IN ('green', 'black', 'blue')),
  reason text NOT NULL,
  minutes int,
  note text,
  day date NOT NULL,
  awarded_by text,
  revoked_at timestamptz,
  revoked_by text,
  revoke_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Automatic points are given once per person, day and reason.
CREATE UNIQUE INDEX IF NOT EXISTS staff_points_auto ON staff_points(user_id, day, reason) WHERE reason <> 'manual';
CREATE INDEX IF NOT EXISTS staff_points_user_day ON staff_points(user_id, day);

CREATE TABLE IF NOT EXISTS staff_salaries (
  user_id text PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  base_salary numeric(12, 2) NOT NULL DEFAULT 0,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payroll_adjustments (
  adjustment_id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id text NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  month date NOT NULL,
  amount numeric(12, 2) NOT NULL,
  note text NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payroll_adjustments_month ON payroll_adjustments(month);

-- A month marked paid keeps the amount and breakdown it was paid with.
CREATE TABLE IF NOT EXISTS payroll_payments (
  user_id text NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  month date NOT NULL,
  amount numeric(12, 2) NOT NULL,
  breakdown jsonb NOT NULL,
  paid_by text,
  paid_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, month)
);

CREATE TABLE IF NOT EXISTS business_expenses (
  expense_id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  title text NOT NULL,
  category text NOT NULL,
  amount numeric(12, 2) NOT NULL,
  month date NOT NULL,
  recurring boolean NOT NULL DEFAULT false,
  end_month date,
  note text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS business_expenses_month ON business_expenses(month);

CREATE TABLE IF NOT EXISTS complaints (
  complaint_id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  reference text NOT NULL UNIQUE,
  user_id text NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  category text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_review', 'resolved')),
  last_reply_at timestamptz,
  seen_by_user_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS complaints_user ON complaints(user_id, created_at DESC);
-- complaint: from investigators (the app) · message: from administrators (the dashboard).
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'complaint';

CREATE TABLE IF NOT EXISTS complaint_messages (
  message_id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  complaint_id text NOT NULL REFERENCES complaints(complaint_id) ON DELETE CASCADE,
  author_id text NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  from_office boolean NOT NULL DEFAULT false,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
