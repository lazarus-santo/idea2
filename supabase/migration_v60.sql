-- migration_v60: prereads.repair_hold — flagged rows that only a person may repair
--
-- HOW TO APPLY: paste into the Supabase SQL editor as role `postgres`
-- (dashboard/project/sgkycnecmdxvujybsuev/sql/new). Safe to re-run.
--
-- MUST BE APPLIED BEFORE THE CODE THAT USES IT IS DEPLOYED: Agent 2 reads and writes
-- repair_hold on every repair and Replace, and a missing column fails those calls.
--
-- APPLY AFTER the 2026-09-19 museum re-check sweep has written its flags (it has):
-- the backfill below holds every flagged museum/fair row, which at that point is
-- exactly the sweep's flags — the code live before this deploy has no museum quality
-- check, so nothing else can have flagged a museum row.
--
-- ---------------------------------------------------------------------------
-- WHY
--
-- Agent 2 repairs a 'needs_review' show on its own: it re-checks each flagged row and
-- swaps in a replacement it finds. The one-time sweep of old museum coverage was to
-- FLAG ONLY — a person decides on each row with the Replace button. repair_hold = true
-- keeps Agent 2's automatic repair (Run Now, a re-scrape, Retrigger) off a row; Replace
-- still works on it and clears the hold when it succeeds.
-- ---------------------------------------------------------------------------

ALTER TABLE prereads ADD COLUMN IF NOT EXISTS repair_hold boolean NOT NULL DEFAULT false;

UPDATE prereads p
SET repair_hold = true
FROM exhibitions e
JOIN venues v ON v.id = e.venue_id
JOIN institutions i ON i.id = v.institution_id
WHERE p.exhibition_id = e.id
  AND i.type IN ('museum', 'fair')
  AND p.quality_flag IS NOT NULL
  AND p.repair_hold = false;

-- Check: held rows should equal the sweep's flagged count (103), all blanked.
SELECT
  count(*) FILTER (WHERE repair_hold)                               AS held,
  count(*) FILTER (WHERE repair_hold AND row_status = 'blanked')    AS held_and_blanked,
  count(*) FILTER (WHERE quality_flag IS NOT NULL AND NOT repair_hold
    AND exhibition_id IN (SELECT e.id FROM exhibitions e JOIN venues v ON v.id = e.venue_id
      JOIN institutions i ON i.id = v.institution_id WHERE i.type IN ('museum', 'fair'))) AS museum_flagged_not_held
FROM prereads;
