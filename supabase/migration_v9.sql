-- migration_v9.sql
-- Link readings_tags records to a specific exhibition when a matched artist
-- has a currently running show. Enables the River → Exhibition Page live feed:
-- when a Frieze review of an artist drops in readings, it auto-surfaces on
-- their current exhibition page without any manual action.

ALTER TABLE readings_tags
  ADD COLUMN IF NOT EXISTS exhibition_id uuid REFERENCES exhibitions(id) ON DELETE SET NULL;
