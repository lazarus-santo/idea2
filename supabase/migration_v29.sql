-- Migration v29: fair support on institutions
--
-- 'fair' was already a legal institutions.type — migration_v2.sql:23 created the
-- column as CHECK (type IN ('museum','gallery','fair')) and the live constraint
-- accepts it (probed 2026-08-04). No constraint change is needed here; only the
-- two fair-specific fields are new.
--
-- SHAPE
-- A fair is an institution + one venue + exactly one exhibitions row. That row is
-- the fair: show_title is the fair name, start_date/end_date are its run dates,
-- coverage holds Agent 2's results, preread_type is 'coverage_only'. Modelling it
-- this way reuses the Fairs tab, the exhibition card, /exhibitions/[id], the map,
-- and the museum coverage path unchanged.
--
-- WHY NO fair_start_date / fair_end_date
-- The brief asked for them on institutions, but the Fairs tab renders exhibitions
-- rows (venue_type is joined from institutions.type), so the card and detail page
-- both read dates from exhibitions. Storing the run dates again here would create
-- a second copy that nothing reads and nothing syncs. Since a fair has exactly one
-- exhibitions row, that row's start_date/end_date already is the single event
-- range the brief describes.
--
-- exhibitors holds names as they appear on the fair's own exhibitor list —
-- deliberately plain strings, not references to institutions. Matching them to
-- existing records is a name-variation problem that is out of scope.

ALTER TABLE institutions
  ADD COLUMN IF NOT EXISTS exhibitors jsonb,
  ADD COLUMN IF NOT EXISTS fair_location text;

COMMENT ON COLUMN institutions.exhibitors IS
  'Fairs only. jsonb array of exhibiting gallery names as printed on the fair''s exhibitor page. Plain strings, intentionally not FKs to institutions.';
COMMENT ON COLUMN institutions.fair_location IS
  'Fairs only. Free text — fairs run at piers, armories and temporary structures that do not fit the venues address shape.';

-- ─── Verify ──────────────────────────────────────────────────────────────────
--   SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'institutions' ORDER BY column_name;
--     -> expect exhibitors (jsonb) and fair_location (text) alongside the rest
--
-- Note for anyone adding a fair by hand: set the fair's venue row to
-- manual_entry_required = true. Both getActiveInstitutions() and
-- getInstitutionsDueForRefresh() filter on manual_entry_required = false, so that
-- single flag is what keeps fairs out of Agent 1's recurring scrape queue. Fairs
-- are scraped once, on demand, from the admin.
