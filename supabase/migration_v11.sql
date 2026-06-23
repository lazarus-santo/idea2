-- Migration v11: swap institution/venue table names + rename FK column
--
-- CURRENT (wrong):
--   institutions = physical gallery locations (id, name, exhibitions_url, address,
--                  neighborhood, latitude, longitude, active, created_at, venue_id, hours)
--   venues       = gallery org brands (id, name, website, type, active, created_at)
--   exhibitions.venue_id  → institutions.id
--   institutions.venue_id → venues.id
--
-- TARGET (correct):
--   institutions = gallery org brands (id, name, website, type, active, created_at)
--   venues       = physical gallery locations (id, name, exhibitions_url, address,
--                  neighborhood, latitude, longitude, active, created_at, institution_id, hours)
--   exhibitions.venue_id      → venues.id         (auto-updated by PG rename)
--   venues.institution_id     → institutions.id
--
-- Note: readings_tags uses entity_type/entity_id — no venue_id column, no changes needed.
--
-- Run in Supabase SQL Editor.

-- ─── Step 1: swap table names ────────────────────────────────────────────────
-- PostgreSQL auto-updates FK constraints on other tables when a table is renamed.

ALTER TABLE institutions RENAME TO venues_swap;
ALTER TABLE venues RENAME TO institutions;
ALTER TABLE venues_swap RENAME TO venues;

-- After this point:
--   venues       = was institutions (physical locations) — exhibitions.venue_id → venues.id ✓
--   institutions = was venues       (org brands)

-- ─── Step 2: rename FK column on venues to match new semantics ───────────────

-- venues.venue_id was the FK pointing to old-venues/now-institutions
ALTER TABLE venues RENAME COLUMN venue_id TO institution_id;

-- ─── Step 3: rename index if one exists on the old column name ───────────────
DROP INDEX IF EXISTS idx_institutions_venue_id;
CREATE INDEX IF NOT EXISTS idx_venues_institution_id ON venues(institution_id);
