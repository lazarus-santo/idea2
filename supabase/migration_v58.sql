-- migration_v58: remember which group-show artists' searches failed, so the retry
-- searches only them
--
-- HOW TO APPLY: paste into the Supabase SQL editor as role `postgres`
-- (dashboard/project/sgkycnecmdxvujybsuev/sql/new). Safe to re-run.
--
-- MUST BE APPLIED BEFORE THE CODE THAT USES IT IS DEPLOYED: Agent 2 reads this column
-- for every show it loads (lib/agent2.ts EXHIBITION_SELECT). Without it, every Agent 2
-- run fails.
--
-- ---------------------------------------------------------------------------
-- WHY
--
-- A small- or large-group show searches each artist separately. When one of those
-- searches never gets an answer (an Exa outage — not the same as finding nothing),
-- Agent 2 now stores everything else it found, writes the failed artists' names
-- here, and marks the show preread_status = 'error'. Its next run searches only these
-- artists — for large group, only for the artist slots still open, so a show still
-- can't pass 1 show review + 5 artist pieces. NULL = nothing pending; the column is
-- cleared when a retry leaves no failures.
-- ---------------------------------------------------------------------------
ALTER TABLE exhibitions ADD COLUMN IF NOT EXISTS preread_retry_artists text[];

-- Verification — should print one row: preread_retry_artists | ARRAY
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'exhibitions' AND column_name = 'preread_retry_artists';
