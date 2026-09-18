-- migration_v55: gallery solo show-review (S4) gate
--
-- HOW TO APPLY: paste into the Supabase SQL editor as role `postgres`
-- (dashboard/project/sgkycnecmdxvujybsuev/sql/new). Safe to re-run.
-- MUST be applied before the code that ships with it deploys: Agent 2 reads
-- and writes these columns for every gallery show, and its load query fails
-- without them.
--
-- ---------------------------------------------------------------------------
-- WHY
--
-- A show review can't exist on the day a show opens. The rebuilt gallery solo
-- ladder (lib/claude.ts, generateSoloPrereads) waits 14 days before searching
-- for one (stage S4), and a daily cron (/api/cron/show-reviews) picks shows up
-- once their wait is over.
--
--   show_review_pending_until  opening date + 14 days (the day S4 may first run)
--   show_review_attempted_at   when S4 last ran; NULL = never
--   show_review_status         what the last run found:
--                                found   stored at least one review — final
--                                empty   the search answered, nothing passed —
--                                        final, never retried
--                                error1  a search call never answered (Exa down,
--                                error2  network, API error). Same ladder as a
--                                        venue's scrape_status: error1 and
--                                        error2 are retried on the next daily run
--                                error3  third failure — the hard wall, no more
--                                        automatic retries
--
-- Only gallery-path solo shows use these today. The group tiers still run their
-- show review immediately, and leave all three NULL.
-- ---------------------------------------------------------------------------
ALTER TABLE exhibitions ADD COLUMN IF NOT EXISTS show_review_pending_until date;
ALTER TABLE exhibitions ADD COLUMN IF NOT EXISTS show_review_attempted_at timestamptz;
ALTER TABLE exhibitions ADD COLUMN IF NOT EXISTS show_review_status text;

ALTER TABLE exhibitions DROP CONSTRAINT IF EXISTS exhibitions_show_review_status_check;
ALTER TABLE exhibitions ADD CONSTRAINT exhibitions_show_review_status_check
  CHECK (show_review_status IS NULL OR show_review_status IN ('found', 'empty', 'error1', 'error2', 'error3'));

CREATE INDEX IF NOT EXISTS exhibitions_show_review_pending_idx
  ON exhibitions (show_review_pending_until)
  WHERE show_review_attempted_at IS NULL OR show_review_status IN ('error1', 'error2');

-- ---------------------------------------------------------------------------
-- BACKFILL. Existing gallery-path solo shows get their date, so the cron can
-- reach them. A show with no start_date counts from when it was added.
-- Only rows still NULL are touched, so re-running this is harmless.
--
-- Note: most existing solo shows opened more than 14 days ago, so the first
-- cron run after this will search for all of them at once.
-- ---------------------------------------------------------------------------
UPDATE exhibitions e
SET show_review_pending_until = COALESCE(e.start_date, e.created_at::date) + 14
WHERE e.show_review_pending_until IS NULL
  AND (SELECT count(*) FROM exhibition_artists ea WHERE ea.exhibition_id = e.id) = 1
  AND EXISTS (
    SELECT 1 FROM venues v
    LEFT JOIN institutions i ON i.id = v.institution_id
    WHERE v.id = e.venue_id
      AND COALESCE(i.type, '') NOT IN ('museum', 'fair')
  );

-- Verification — read what this prints.
SELECT
  (SELECT count(*) FROM exhibitions WHERE show_review_pending_until IS NOT NULL)          AS solo_shows_dated,
  (SELECT count(*) FROM exhibitions WHERE show_review_pending_until <= current_date
     AND show_review_attempted_at IS NULL AND status = 'published')                        AS due_now;
