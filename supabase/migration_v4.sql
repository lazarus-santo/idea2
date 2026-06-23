-- Lazarus Idea 2 — Schema v4
-- Adds thumbnail_url to the readings table.
-- Run in Supabase SQL Editor.

ALTER TABLE readings ADD COLUMN IF NOT EXISTS thumbnail_url text;
