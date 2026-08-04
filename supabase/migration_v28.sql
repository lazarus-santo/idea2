-- Migration v28: drop scheduling remnants from editor_picks
--
-- Two things go, both already unreachable from the application:
--
-- 1. goes_live_at. It was written by the old 'scheduled' publish mode and read
--    by nothing — no cron, no job, no check in /api/editors-picks ever promoted
--    a pending pick when its date arrived, so scheduling silently never worked.
--    The mode was removed in the commit before this one. Four rows still carry a
--    non-null value; all four are dates in the past that never did anything.
--
-- 2. 'pending' from the status CHECK. With scheduling gone, every pick is either
--    the live one or a retired one. Nothing writes 'pending' any more, and the
--    admin no longer renders it.
--
-- Verified immediately before applying: statuses across all 8 rows are
-- live=3, past=5. No row holds 'pending', so the narrowed CHECK cannot fail.
--
-- This is destructive — DROP COLUMN discards the four goes_live_at values. They
-- are meaningless (see above), but they are not recoverable.
--
-- Run in Supabase SQL Editor.

BEGIN;

ALTER TABLE editor_picks
  DROP COLUMN IF EXISTS goes_live_at;

ALTER TABLE editor_picks
  DROP CONSTRAINT IF EXISTS editor_picks_status_check;

ALTER TABLE editor_picks
  ADD CONSTRAINT editor_picks_status_check
  CHECK (status IN ('live', 'past'));

COMMIT;

-- ─── Verify ──────────────────────────────────────────────────────────────────
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'editor_picks' ORDER BY column_name;
--     -> expect: approved_at, created_at, id, pick_type, reference_id, status
--
--   SELECT status, count(*) FROM editor_picks GROUP BY status;
--     -> expect only 'live' and 'past'
--
-- Note the partial unique index from migration_v27
-- (editor_picks_one_live_per_type ON (pick_type) WHERE status = 'live')
-- is unaffected: it references status but not goes_live_at.
