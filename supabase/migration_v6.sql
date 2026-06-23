-- Lazarus Idea 2 — Schema v6
-- Adds hours jsonb to venues for open/closed map pin logic.
-- Run in Supabase SQL Editor.

ALTER TABLE venues ADD COLUMN IF NOT EXISTS hours jsonb;

-- hours format: { "monday": ["HH:MM", "HH:MM"] | null, ... }
-- null value for a day means closed; absent key is treated as closed.
-- Example: { "tuesday": ["10:00", "18:00"], "wednesday": null, ... }
