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

-- Every area an investigator is authorised to serve. The profile's area (chosen at signup or
-- from the app) is the primary row and is kept in sync; admins may add more. Dispatch offers
-- a case to anyone with at least one matching area, once per investigator.
CREATE TABLE IF NOT EXISTS investigator_service_areas (
  area_id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id text NOT NULL REFERENCES users(user_id),
  is_primary boolean NOT NULL DEFAULT false,
  governorate text,
  district text,
  local_unit text,
  main_village text,
  sub_village text,
  governorate_key text NOT NULL,
  district_key text,
  local_unit_key text,
  main_village_key text,
  sub_village_key text,
  active boolean NOT NULL DEFAULT true,
  added_by text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_service_area_primary ON investigator_service_areas (user_id) WHERE is_primary;
CREATE INDEX IF NOT EXISTS idx_service_areas_user ON investigator_service_areas (user_id) WHERE active;
CREATE INDEX IF NOT EXISTS idx_service_areas_keys
  ON investigator_service_areas (governorate_key, district_key, local_unit_key) WHERE active;

-- Existing work areas become primary service areas (once; later edits keep them in sync).
INSERT INTO investigator_service_areas (user_id, is_primary, governorate, district, local_unit, main_village,
  sub_village, governorate_key, district_key, local_unit_key, main_village_key, sub_village_key, created_at)
SELECT p.user_id, true, p.governorate, p.district, p.local_unit, p.main_village, p.sub_village,
  p.governorate_key, p.district_key, p.local_unit_key, p.main_village_key, p.sub_village_key,
  COALESCE(p.location_set_at, now())
FROM investigator_profiles p
WHERE p.location_set_at IS NOT NULL AND p.governorate_key IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM investigator_service_areas a WHERE a.user_id = p.user_id AND a.is_primary);
