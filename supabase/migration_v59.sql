-- migration_v59: museum classification is now 'solo' / 'group_show'
--
-- HOW TO APPLY: paste into the Supabase SQL editor as role `postgres`
-- (dashboard/project/sgkycnecmdxvujybsuev/sql/new). Safe to re-run.
--
-- MUST BE APPLIED BEFORE THE CODE THAT USES IT IS DEPLOYED: Agent 2 now writes
-- coverage_type = 'solo' or 'group_show' for every museum show it runs, and treats a
-- refused write as a failed run. The old CHECK (migration_v24) only allows the Type
-- A/B/C-Small/C-Large/D values.
--
-- ---------------------------------------------------------------------------
-- WHY
--
-- The five old tiers are replaced by two, decided by artist count alone:
--   1 artist     → 'solo'
--   0 or 2+      → 'group_show'
-- Existing rows are re-labelled from their CURRENT artist count, not their old tier:
-- the old label often no longer matches (e.g. "Untitled" (America) at the Whitney is
-- type_a with 23 artists, because artists were added after it ran).
--
-- Only the label changes. No preread rows are touched, and no museum show is given a
-- show_review_pending_until here — existing museum shows keep the coverage they have
-- and are not searched again.

ALTER TABLE exhibitions DROP CONSTRAINT IF EXISTS chk_coverage_type;

UPDATE exhibitions e
SET coverage_type = CASE
  WHEN (SELECT count(*) FROM exhibition_artists ea WHERE ea.exhibition_id = e.id) = 1 THEN 'solo'
  ELSE 'group_show'
END
WHERE e.coverage_type IS NOT NULL
  AND e.coverage_type NOT IN ('solo', 'group_show');

ALTER TABLE exhibitions
  ADD CONSTRAINT chk_coverage_type
  CHECK (coverage_type IN ('solo', 'group_show') OR coverage_type IS NULL);

-- Check: expect only solo / group_show / NULL.
-- SELECT coverage_type, count(*) FROM exhibitions GROUP BY 1;
