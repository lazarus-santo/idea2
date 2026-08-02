-- Migration v25: allow 'past' in the editor_picks.status CHECK constraint
--
-- migration_v2.sql created the column as:
--   status text DEFAULT 'pending' CHECK (status IN ('pending', 'live'))
-- and no later migration touched it. But three code paths write 'past' when
-- retiring a superseded pick:
--   app/api/admin/editor-picks/route.ts:177
--   app/api/admin/editor-picks/[id]/approve/route.ts:42
--   app/api/admin/editor-picks/[id]/unpublish/route.ts:13
--
-- Every one of those writes has been rejected by the constraint and the error
-- was never surfaced, so old picks were never retired. Confirmed against the
-- live database on 2026-07-29: zero rows with status='past' exist, and instead
-- there are multiple simultaneously-'live' picks per type (2 exhibition,
-- 2 article, 3 book), which is exactly the accumulation this would produce.
-- The public Editor's Picks page is therefore choosing arbitrarily among
-- several live rows per type.
--
-- Adding 'past' is purely widening — no existing row can violate the new
-- constraint, since no row currently holds a value outside ('pending','live').
--
-- Run in Supabase SQL Editor.
--
-- NOTE: applying this makes the retire-on-approve writes start succeeding.
-- Existing duplicate 'live' rows are NOT cleaned up here — that is a data
-- decision (which of the current duplicates should stay live?), deliberately
-- left out of this migration. See the companion query at the bottom.

ALTER TABLE editor_picks
  DROP CONSTRAINT IF EXISTS editor_picks_status_check;

ALTER TABLE editor_picks
  ADD CONSTRAINT editor_picks_status_check
  CHECK (status IN ('pending', 'live', 'past'));


-- ─── Optional follow-up, NOT run by this migration ───────────────────────────
-- Inspect the current duplicates before deciding how to collapse them:
--
--   SELECT pick_type, status, count(*), array_agg(id)
--   FROM   editor_picks
--   GROUP  BY pick_type, status
--   HAVING count(*) > 1 AND status = 'live';
--
-- To retire all but the most recently approved pick per type once you have
-- reviewed the above (keeps NULL approved_at last):
--
--   UPDATE editor_picks e SET status = 'past'
--   WHERE  e.status = 'live'
--   AND    e.id <> (
--            SELECT id FROM editor_picks x
--            WHERE  x.pick_type = e.pick_type AND x.status = 'live'
--            ORDER  BY x.approved_at DESC NULLS LAST, x.created_at DESC
--            LIMIT  1
--          );
