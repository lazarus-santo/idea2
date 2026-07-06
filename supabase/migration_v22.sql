-- Migration v22: fix duplicate exhibitions
-- Root cause: exhibitions were matched for upsert purposes by (venue_id, show_title)
-- via a case-insensitive ILIKE comparison, with no stored detail-page URL and no
-- DB-level uniqueness constraint. Since show_title comes from a fresh Claude
-- extraction on every scrape, any drift in the extracted title text (subtitle,
-- punctuation, whitespace) between two scrapes of the same real-world show
-- caused a second row to be inserted instead of updating the existing one.
--
-- Fix: store the detail-page URL scraped for each exhibition and match/constrain
-- on (venue_id, detail_url) instead, which is stable across scrapes.
--
-- Existing rows get detail_url = NULL (Postgres treats NULLs as distinct for
-- UNIQUE purposes, so this constraint applies cleanly regardless of any
-- duplicate rows already sitting in the table from before this fix — those are
-- a data cleanup task, not a migration-blocking one). Every future write from
-- the scraper populates detail_url, so the constraint takes effect immediately
-- for all new/updated rows going forward.
--
-- Run in Supabase SQL Editor.

ALTER TABLE exhibitions
  ADD COLUMN IF NOT EXISTS detail_url text;

ALTER TABLE exhibitions
  ADD CONSTRAINT exhibitions_venue_detail_url_key UNIQUE (venue_id, detail_url);
