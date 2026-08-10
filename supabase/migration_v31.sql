-- Migration v31: editorial status and per-venue scraping notes
--
-- Two separate needs that were being conflated.
--
-- 1. SCRAPING HINTS. Agent 1's failures are mostly not bot-walls: four of the
--    five failed venues report zero_links_after_retry, which means the page
--    loaded and no exhibition links were found — usually the wrong page, or a
--    listing behind a tab the scraper does not click. venues.scrape_notes is
--    free text handed to the extraction prompt as context, e.g. "current shows
--    are under the On View tab" or "ignore the Programs section".
--
--    Free text rather than selectors deliberately: a stale CSS selector fails
--    silently and misdirects, whereas a stale note is weighed as context and
--    degrades into noise.
--
-- 2. WHY SOMETHING IS OUT. institutions.status records the editorial decision —
--    the gallery closed, or it is not relevant to this product — separately from
--    `active`, which stays the mechanism every existing query already filters on.
--    Setting a status also sets active=false, so no queue query has to change.
--
-- venues.scrapable is a THIRD thing, and deliberately not manual_entry_required.
-- That flag is owned by the scraper: lib/scraper.ts sets it back to false on
-- every successful scrape (lines 803, 845, 901), so a human decision stored
-- there would be silently undone the next time the venue happened to work.
-- scrapable is only ever written by a person.

ALTER TABLE venues
  ADD COLUMN IF NOT EXISTS scrape_notes text,
  ADD COLUMN IF NOT EXISTS scrapable boolean NOT NULL DEFAULT true;

ALTER TABLE institutions
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS status_note text;

ALTER TABLE institutions
  DROP CONSTRAINT IF EXISTS institutions_status_check;

ALTER TABLE institutions
  ADD CONSTRAINT institutions_status_check
  CHECK (status IN ('active', 'closed', 'not_relevant'));

COMMENT ON COLUMN venues.scrape_notes IS
  'Free-text hint passed to Agent 1''s link-extraction prompt as context, e.g. "current shows are under the On View tab".';
COMMENT ON COLUMN venues.scrapable IS
  'Human decision: do not attempt automated scraping. Distinct from manual_entry_required, which the scraper itself sets and clears.';
COMMENT ON COLUMN institutions.status IS
  'Editorial state. Setting anything other than active should also set active=false; active remains the field queries filter on.';

-- ─── Verify ──────────────────────────────────────────────────────────────────
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name IN ('venues','institutions')
--     AND column_name IN ('scrape_notes','scrapable','status','status_note');
--     -> expect four rows
--
--   UPDATE institutions SET status = 'bogus' WHERE false;  -- should be rejected
