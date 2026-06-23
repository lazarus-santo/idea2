-- migration_v7.sql
-- Cache geocoded coordinates for exhibitions with address_override.
-- override_latitude/override_longitude are populated automatically when
-- an admin sets address_override; read by /api/map-exhibitions to place pins.

ALTER TABLE exhibitions
  ADD COLUMN IF NOT EXISTS override_latitude  numeric,
  ADD COLUMN IF NOT EXISTS override_longitude numeric;
