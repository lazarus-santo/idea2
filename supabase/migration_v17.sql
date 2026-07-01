-- Migration v17: add 'upcoming' to the exhibitions status check constraint
-- Previously only ('pending', 'published') were allowed; scraper sets 'upcoming'
-- for shows whose start_date is in the future, which violated the constraint.

ALTER TABLE exhibitions
  DROP CONSTRAINT IF EXISTS exhibitions_status_check;

ALTER TABLE exhibitions
  ADD CONSTRAINT exhibitions_status_check
    CHECK (status IN ('pending', 'published', 'upcoming'));
