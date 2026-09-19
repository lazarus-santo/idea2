-- migration_v56: put gallery small-group shows (2-5 artists) on the show-review gate
--
-- HOW TO APPLY: paste into the Supabase SQL editor as role `postgres`
-- (dashboard/project/sgkycnecmdxvujybsuev/sql/new). Safe to re-run.
-- Needs migration_v55 (the show_review_* columns) — already applied.
--
-- ---------------------------------------------------------------------------
-- WHY
--
-- v55 gave gallery solo shows a 14-day wait before their show-review search.
-- Small-group shows now wait the same way (lib/claude.ts,
-- generateSmallGroupPrereads) and are picked up by the same daily route
-- (/api/cron/show-reviews). No new columns: this only dates the existing
-- small-group shows, exactly as v55's backfill dated the solo ones, so the
-- cron can reach them. New shows get their date from Agent 2's own run.
--
-- Note: every existing small-group show already had one show-review search
-- (ungated, on the day Agent 2 first ran). Most opened more than 14 days ago,
-- so the first cron run after this searches for each of them once more; a
-- review it finds is added alongside the rows the show already has.
-- ---------------------------------------------------------------------------
UPDATE exhibitions e
SET show_review_pending_until = COALESCE(e.start_date, e.created_at::date) + 14
WHERE e.show_review_pending_until IS NULL
  AND (SELECT count(*) FROM exhibition_artists ea WHERE ea.exhibition_id = e.id) BETWEEN 2 AND 5
  AND EXISTS (
    SELECT 1 FROM venues v
    LEFT JOIN institutions i ON i.id = v.institution_id
    WHERE v.id = e.venue_id
      AND COALESCE(i.type, '') NOT IN ('museum', 'fair')
  );

-- Verification — read what this prints.
SELECT
  (SELECT count(*) FROM exhibitions e WHERE show_review_pending_until IS NOT NULL
     AND (SELECT count(*) FROM exhibition_artists ea WHERE ea.exhibition_id = e.id) BETWEEN 2 AND 5) AS small_group_dated,
  (SELECT count(*) FROM exhibitions e WHERE show_review_pending_until <= current_date
     AND show_review_attempted_at IS NULL AND status = 'published'
     AND (SELECT count(*) FROM exhibition_artists ea WHERE ea.exhibition_id = e.id) BETWEEN 2 AND 5) AS small_group_due_now;
