-- Migration v10: rename gallery_id → venue_id
-- Reflects the broader institutions/venues rename:
--   institutions = physical gallery locations (was: venues)
--   venues       = gallery organizations/brands  (was: galleries)
-- Run in Supabase SQL Editor.

-- ─── readings_tags: rename gallery_id → venue_id ─────────────────────────────

ALTER TABLE readings_tags RENAME COLUMN gallery_id TO venue_id;

-- Recreate check constraint (Postgres does not auto-rename column refs in constraints)
ALTER TABLE readings_tags DROP CONSTRAINT IF EXISTS readings_tags_must_have_one;
ALTER TABLE readings_tags ADD CONSTRAINT readings_tags_must_have_one CHECK (
  (venue_id IS NOT NULL)::int + (artist_id IS NOT NULL)::int = 1
);

-- Recreate index
DROP INDEX IF EXISTS idx_readings_tags_gallery_id;
CREATE INDEX idx_readings_tags_venue_id ON readings_tags(venue_id);

-- ─── institutions: rename gallery_id → venue_id ──────────────────────────────
-- institutions.gallery_id was a FK to the galleries/venues organization table.
-- After the table rename (galleries → venues), the column is now named venue_id.

ALTER TABLE institutions RENAME COLUMN gallery_id TO venue_id;
