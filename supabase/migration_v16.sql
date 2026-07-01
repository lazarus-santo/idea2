-- Migration v16: manual_entry_required + scrape_failure_reason on venues
-- Run in Supabase SQL Editor.

ALTER TABLE venues
  ADD COLUMN IF NOT EXISTS manual_entry_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS scrape_failure_reason  text;

CREATE INDEX IF NOT EXISTS idx_venues_manual_entry ON venues(manual_entry_required)
  WHERE manual_entry_required = true;
