-- Migration v23: classify exhibitions vs. installations
-- Installations (site-specific, long-term, or permanent works) commonly have no
-- end_date — that's their normal state, not missing data. Adds show_type so the
-- scraper (lib/scraper.ts) can let installations auto-publish on start_date alone,
-- marking them is_ongoing instead of requiring an end_date like a normal exhibition.
--
-- Run in Supabase SQL Editor.

ALTER TABLE exhibitions
  ADD COLUMN IF NOT EXISTS show_type text NOT NULL DEFAULT 'exhibition';

ALTER TABLE exhibitions
  ADD CONSTRAINT exhibitions_show_type_check CHECK (show_type IN ('exhibition', 'installation'));
