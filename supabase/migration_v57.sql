-- migration_v57: put gallery large-group shows (6+ artists) on the show-review gate
--
-- HOW TO APPLY: paste into the Supabase SQL editor as role `postgres`
-- (dashboard/project/sgkycnecmdxvujybsuev/sql/new). Safe to re-run.
-- Needs migration_v55 (the show_review_* columns) — already applied. Independent of
-- v56 (small group, 2-5 artists); either can go first.
--
-- ---------------------------------------------------------------------------
-- WHY
--
-- Large-group shows used to run their show-review search the moment Agent 2 first
-- reached them — usually before any review could exist — with no title+artist
-- pre-filter and no record of whether the search failed or came back empty. They now
-- wait 14 days like solo and small group (lib/claude.ts, generateLargeGroupPrereads)
-- and are picked up by the same daily route (/api/cron/show-reviews). No new columns:
-- this only dates the existing large-group shows, exactly as v55/v56 did, so the cron
-- can reach them. New shows get their date from Agent 2's own run.
--
-- Note: every existing large-group show already had one ungated show-review search.
-- Those opened more than 14 days ago will get one more search on the first cron run
-- after this; a review it finds is added alongside the rows the show already has.
-- ---------------------------------------------------------------------------
UPDATE exhibitions e
SET show_review_pending_until = COALESCE(e.start_date, e.created_at::date) + 14
WHERE e.show_review_pending_until IS NULL
  AND (SELECT count(*) FROM exhibition_artists ea WHERE ea.exhibition_id = e.id) >= 6
  AND EXISTS (
    SELECT 1 FROM venues v
    LEFT JOIN institutions i ON i.id = v.institution_id
    WHERE v.id = e.venue_id
      AND COALESCE(i.type, '') NOT IN ('museum', 'fair')
  );

-- Verification — read what this prints.
SELECT
  (SELECT count(*) FROM exhibitions e WHERE show_review_pending_until IS NOT NULL
     AND (SELECT count(*) FROM exhibition_artists ea WHERE ea.exhibition_id = e.id) >= 6) AS large_group_dated,
  (SELECT count(*) FROM exhibitions e WHERE show_review_pending_until <= current_date
     AND show_review_attempted_at IS NULL AND status = 'published'
     AND (e.end_date IS NULL OR e.end_date >= current_date)
     AND (SELECT count(*) FROM exhibition_artists ea WHERE ea.exhibition_id = e.id) >= 6) AS large_group_due_now;
