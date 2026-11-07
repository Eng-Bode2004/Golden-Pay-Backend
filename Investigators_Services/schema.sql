-- Golden Pay - Investigators service. Idempotent; applied on service start.

-- Egypt's location tree. Levels: 1 governorate, 2 district, 3 local unit,
-- 4 main village, 5 sub village. Names typed by investigators are added here so
-- the next person can pick them from the list.
CREATE TABLE IF NOT EXISTS geo_locations (
  location_id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  parent_id text REFERENCES geo_locations(location_id),
  level integer NOT NULL,
  name text NOT NULL,
  name_en text,
  name_key text NOT NULL,
  source text NOT NULL DEFAULT 'seed',
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_geo_location
  ON geo_locations (COALESCE(parent_id, ''), name_key);
CREATE INDEX IF NOT EXISTS idx_geo_parent ON geo_locations (parent_id, level);

CREATE TABLE IF NOT EXISTS investigator_profiles (
  user_id text PRIMARY KEY REFERENCES users(user_id),
  governorate text,
  district text,
  local_unit text,
  main_village text,
  sub_village text,
  street text,
  governorate_key text,
  district_key text,
  local_unit_key text,
  main_village_key text,
  sub_village_key text,
  lat double precision,
  lng double precision,
  available boolean NOT NULL DEFAULT true,
  location_set_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_investigator_area
  ON investigator_profiles (governorate_key, district_key, local_unit_key);
