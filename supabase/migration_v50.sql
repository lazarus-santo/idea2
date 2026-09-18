-- migration_v50: hide long artist lists without losing them
--
-- HOW TO APPLY: paste into the Supabase SQL editor as role `postgres`
-- (dashboard/project/sgkycnecmdxvujybsuev/sql/new). Safe to re-run.
--
-- ---------------------------------------------------------------------------
-- WHY
--
-- Agent 1's rebuilt artist handling publishes a credited group show of six or
-- more artists with the names hidden: forty names on a card is not information,
-- it is noise. Two things follow from that, and both are the point of this
-- migration.
--
-- 1. HIDING IS A DISPLAY DECISION, NEVER A DELETION. Agent 2 classifies museum
--    coverage by artist count and searches per artist, and preread
--    cross-linking matches on artist names. Both read exhibition_artists, and
--    both must keep working on a show whose names are hidden. So the names are
--    stored exactly as before and a boolean on the exhibition says not to show
--    them. Nothing in the pipeline achieves suppression by writing fewer rows.
--
-- 2. THE FIRST ONE AT EACH VENUE IS CONFIRMED BY A PERSON. A venue that runs
--    big group shows will produce these forever, so after one confirmation the
--    venue is muted and the rest publish straight through.
--
--    The mute is keyed to (venue, warning_type) and NOT to the artist count.
--    A venue muted on a six-artist show stays muted for a forty-artist one:
--    it is the same judgement, and re-asking per count would make the mute
--    worthless. warning_type is a text column rather than an enum so a later
--    warning kind needs no migration.
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The display flag.
--
-- NOT NULL DEFAULT false: every existing row means "show the names", which is
-- the behaviour before this migration, so the backfill is the default and no
-- UPDATE is needed.
-- ---------------------------------------------------------------------------
ALTER TABLE exhibitions
  ADD COLUMN IF NOT EXISTS hide_artist_names boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN exhibitions.hide_artist_names IS
  'Do not display this show''s artist names publicly. The names are still stored in exhibition_artists and are still read by Agent 2 coverage and preread matching — this hides them on screen only. Set by Agent 1 for a credited group of 6+, and by the admin from Pending review.';

-- ---------------------------------------------------------------------------
-- 2. The per-venue mute.
--
-- One row per (venue, warning_type) means "stop asking me about this here".
-- Its presence is the mute; there is no boolean to get out of sync. Deleting
-- the row un-mutes the venue, which is what a future admin "ask me again"
-- control would do.
--
-- Venues are deactivated rather than deleted, so the cascade is only tidiness
-- against an accidental hard delete.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS venue_artist_warnings (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id      uuid        NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  warning_type  text        NOT NULL,
  -- Which show prompted it, for tracing back. No FK: the exhibition may later
  -- be deleted, and losing the mute because of that would re-ask a settled
  -- question.
  exhibition_id uuid,
  muted_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, warning_type)
);

COMMENT ON TABLE venue_artist_warnings IS
  'A venue + warning_type pair the admin has said not to prompt about again. Currently one type: non_inferred_group_6_plus — a credited group show of 6 or more artists, whose names publish with hide_artist_names set. Keyed to the venue and the type, deliberately not to the artist count.';

ALTER TABLE venue_artist_warnings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON venue_artist_warnings FROM anon, authenticated;
GRANT ALL ON venue_artist_warnings TO service_role;

COMMIT;

-- ---------------------------------------------------------------------------
-- VERIFY
--
-- 1. The column exists and defaults false:
--      SELECT column_name, data_type, is_nullable, column_default
--        FROM information_schema.columns
--       WHERE table_name = 'exhibitions' AND column_name = 'hide_artist_names';
--      -- expect (hide_artist_names, boolean, NO, false)
--
-- 2. Nothing was hidden by applying this:
--      SELECT count(*) FROM exhibitions WHERE hide_artist_names;   -- expect 0
--
-- 3. The mute table is service-role only. With the ANON key:
--      GET /rest/v1/venue_artist_warnings?select=id
--      -- expect an empty result or a permission error, never rows.
--
-- 4. The unique pair holds:
--      INSERT INTO venue_artist_warnings (venue_id, warning_type)
--      SELECT id, 'non_inferred_group_6_plus' FROM venues LIMIT 1;
--      -- running it twice must raise 23505 on the second.
--      DELETE FROM venue_artist_warnings WHERE warning_type = 'non_inferred_group_6_plus';
-- ---------------------------------------------------------------------------
