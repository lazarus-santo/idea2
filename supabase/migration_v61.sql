-- migration_v61 — a preread row a person has logged is never overwritten
--
-- Run this in the Supabase SQL editor. Safe to re-run.
--
-- ---------------------------------------------------------------------------
-- WHY
--
-- Repair and the admin Replace button both write the new article onto the
-- existing row: same id, different article. That is fine while nothing points
-- at a preread, and wrong the moment the planned logging feature does. A
-- person's rating and review would stay attached to the id while the article
-- underneath it silently became a different piece — nothing would look broken,
-- which is exactly the failure Agent 1's delete-and-recreate bug would have
-- caused, in slower motion.
--
-- From v61 a logged row is frozen instead: the fresh article goes into a NEW
-- row, and the logged row is blanked (hidden from the public page) with its
-- content untouched, so the log still resolves to what the person actually
-- read.
--
-- superseded_by points the frozen row at the row that took over. It is what
-- makes a frozen row distinguishable from a row an admin blanked by hand,
-- which matters in three places (see lib/agent2.ts):
--   1. automatic repair skips superseded rows — without this, the frozen row
--      keeps its quality_flag, stays in the repair pool, and every later run
--      freezes it again, one new row per run, for ever.
--   2. recomputePrereadStatus ignores them — a frozen row's old flag would
--      otherwise pin the show at 'needs_review' with nothing an admin could do
--      about it.
--   3. the group-show artist slot count ignores them — a frozen row and its
--      replacement are one article's worth of coverage, not two.
--
-- ON DELETE SET NULL, not CASCADE: deleting the replacement must never delete
-- the logged row. It just stops pointing anywhere.
-- ---------------------------------------------------------------------------

ALTER TABLE prereads ADD COLUMN IF NOT EXISTS superseded_by uuid
  REFERENCES prereads(id) ON DELETE SET NULL;

COMMENT ON COLUMN prereads.superseded_by IS
  'Set when this row was frozen because someone had logged it: points at the row that replaced it. Frozen rows are blanked, never repaired again, and excluded from the exhibition''s status.';

-- The reads that matter are "is this row frozen" (superseded_by IS NOT NULL)
-- over one show's rows, so a partial index on the set that is normally empty.
CREATE INDEX IF NOT EXISTS prereads_superseded_by_idx
  ON prereads (superseded_by) WHERE superseded_by IS NOT NULL;

-- A frozen row is hidden, so it must not also be readable as live coverage.
-- The public site reads with the service-role key (which skips RLS) and filters
-- row_status itself; this is the backstop for any future anon-key reader, and
-- matches how v53 handled blanked rows.
--
-- Verification — read what this prints: the column exists, and no row is
-- frozen yet.
SELECT
  (SELECT count(*) FROM information_schema.columns
     WHERE table_name = 'prereads' AND column_name = 'superseded_by') AS column_added,
  (SELECT count(*) FROM prereads WHERE superseded_by IS NOT NULL)     AS frozen_rows;
