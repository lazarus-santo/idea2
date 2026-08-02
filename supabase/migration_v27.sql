-- Migration v27: at most one live editor's pick per type
--
-- The application already intends this. Both write paths retire before they
-- promote — app/api/admin/editor-picks/route.ts sets every non-past row of the
-- type to 'past' before inserting, and [id]/approve/route.ts does the same
-- before flipping the target row live. Nothing enforced it, so when those
-- retire writes silently failed against the old CHECK constraint (see
-- migration_v25.sql), duplicates accumulated unnoticed: 2 live exhibition
-- picks, 2 live article picks and 3 live book picks.
--
-- The public page has no tie-breaking rule for that. /api/editors-picks does
--   picks.find(p => p.pick_type === 'exhibition')
-- against a created_at DESC ordering, so it silently showed whichever row
-- happened to sort first — a real editorial decision made by ordering.
--
-- A partial unique index turns that from a convention into a guarantee.
-- 'past' and 'pending' rows are unconstrained: history can hold as many
-- retired picks as it likes, and scheduling a replacement while one is still
-- live has to keep working.
--
-- Safe to apply as written: verified 2026-08-02 that every type is at exactly
-- one live row. If this errors with a uniqueness violation, the data drifted
-- again — find the offenders with the query at the bottom before retrying.
--
-- Run in Supabase SQL Editor.

CREATE UNIQUE INDEX IF NOT EXISTS editor_picks_one_live_per_type
  ON editor_picks (pick_type)
  WHERE status = 'live';


-- ─── If the CREATE INDEX above fails ─────────────────────────────────────────
-- Lists the types that still have more than one live pick:
--
--   SELECT pick_type, count(*), array_agg(id ORDER BY created_at DESC)
--   FROM   editor_picks
--   WHERE  status = 'live'
--   GROUP  BY pick_type
--   HAVING count(*) > 1;
--
-- Retire all but the newest of each, then re-run:
--
--   UPDATE editor_picks e SET status = 'past'
--   WHERE  e.status = 'live'
--   AND    e.id <> (
--            SELECT id FROM editor_picks x
--            WHERE  x.pick_type = e.pick_type AND x.status = 'live'
--            ORDER  BY x.approved_at DESC NULLS LAST, x.created_at DESC
--            LIMIT  1
--          );
