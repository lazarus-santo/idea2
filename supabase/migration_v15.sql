-- Migration v15: venue-level check_back_date, scrape_failed flag, date_notes on exhibitions
-- Run in Supabase SQL Editor.

-- ─── venues: add check_back_date and scrape_failed ───────────────────────────

ALTER TABLE venues
  ADD COLUMN IF NOT EXISTS check_back_date date,
  ADD COLUMN IF NOT EXISTS scrape_failed   boolean NOT NULL DEFAULT false;

-- Backfill check_back_date from earliest exhibition check_back_date per venue
UPDATE venues v
SET    check_back_date = sub.min_cbd
FROM (
  SELECT venue_id, MIN(check_back_date) AS min_cbd
  FROM   exhibitions
  WHERE  check_back_date IS NOT NULL
  GROUP  BY venue_id
) sub
WHERE v.id = sub.venue_id;

CREATE INDEX IF NOT EXISTS idx_venues_check_back_date ON venues(check_back_date);
CREATE INDEX IF NOT EXISTS idx_venues_scrape_failed   ON venues(scrape_failed) WHERE scrape_failed = true;

-- ─── exhibitions: add date_notes column ──────────────────────────────────────

ALTER TABLE exhibitions
  ADD COLUMN IF NOT EXISTS date_notes text;
