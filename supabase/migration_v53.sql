-- migration_v53: Agent 2 status, quality flags and row visibility
--
-- HOW TO APPLY: paste into the Supabase SQL editor as role `postgres`
-- (dashboard/project/sgkycnecmdxvujybsuev/sql/new). Safe to re-run.
-- MUST be applied before the code that ships with it deploys: Agent 2 writes
-- exhibitions.preread_status and reads prereads.quality_flag / row_status, and
-- every one of those writes fails without these columns.
--
-- Source: the "Revamped Agent 2 Triggers + Schema Changes" Miro board.
--
-- ---------------------------------------------------------------------------
-- 1. exhibitions.preread_status — the outcome of the last generation attempt
--
--   NULL                    never attempted
--   pending_artists         blocked: a gallery-path show with no artists
--   pending_press_release   blocked: a gallery-path show with no press release
--   empty                   ran, found nothing (only an admin Retrigger reruns it)
--   error                   ran, threw (the next Agent 1 run or admin reruns it)
--   success                 ran, every row passed
--   needs_review            ran, at least one row carries a quality_flag
--
-- Written only by lib/agent2.ts, which is also where the meaning of each value
-- is enforced. The CHECK here only keeps a typo from becoming a new state.
-- ---------------------------------------------------------------------------
ALTER TABLE exhibitions ADD COLUMN IF NOT EXISTS preread_status text;

ALTER TABLE exhibitions DROP CONSTRAINT IF EXISTS exhibitions_preread_status_check;
ALTER TABLE exhibitions ADD CONSTRAINT exhibitions_preread_status_check
  CHECK (preread_status IS NULL OR preread_status IN (
    'pending_artists', 'pending_press_release', 'empty', 'error', 'success', 'needs_review'
  ));

CREATE INDEX IF NOT EXISTS exhibitions_preread_status_idx ON exhibitions (preread_status);

-- ---------------------------------------------------------------------------
-- 2. prereads.quality_flag — why a row might be bad (NULL = passed clean)
--
--   self_sourced   from the artist's or venue's own site
--   unverified     the quality-check call itself failed. Replaces the old
--                  behaviour, where a failed check silently counted as a pass.
--   no_content     real article, but boilerplate / paywall / no usable text
--   mismatched     verification judged it not substantially about the artist/show
-- ---------------------------------------------------------------------------
ALTER TABLE prereads ADD COLUMN IF NOT EXISTS quality_flag text;

ALTER TABLE prereads DROP CONSTRAINT IF EXISTS prereads_quality_flag_check;
ALTER TABLE prereads ADD CONSTRAINT prereads_quality_flag_check
  CHECK (quality_flag IS NULL OR quality_flag IN (
    'self_sourced', 'unverified', 'no_content', 'mismatched'
  ));

-- ---------------------------------------------------------------------------
-- 3. prereads.row_status — whether the row shows on the public site
--
--   active    default, shown publicly
--   blanked   kept in the table, visible in admin only
-- ---------------------------------------------------------------------------
ALTER TABLE prereads ADD COLUMN IF NOT EXISTS row_status text NOT NULL DEFAULT 'active';

ALTER TABLE prereads DROP CONSTRAINT IF EXISTS prereads_row_status_check;
ALTER TABLE prereads ADD CONSTRAINT prereads_row_status_check
  CHECK (row_status IN ('active', 'blanked'));

-- ---------------------------------------------------------------------------
-- THE RULE: a row that gets a quality_flag is blanked.
--
-- A trigger rather than app code, because the spec says the rule applies
-- everywhere a flag is set — Agent 1 runs, Run Now, Replace — and a rule kept
-- in three code paths is a rule waiting for a fourth path that forgets it.
--
-- It fires only when the flag is SET or CHANGED to a non-NULL value. An admin
-- who later reactivates a flagged row (an UPDATE touching only row_status) is
-- a deliberate override, and the trigger leaves it alone. Clearing a flag to
-- NULL does not reactivate the row by itself: the repair code sets row_status
-- to 'active' explicitly, in the same UPDATE that swaps in the repaired article.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prereads_blank_flagged()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.quality_flag IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.quality_flag IS DISTINCT FROM NEW.quality_flag) THEN
    NEW.row_status := 'blanked';
  END IF;
  RETURN NEW;
END;
$$;

-- A trigger function returning `trigger` cannot be called directly, but keep it
-- off the REST API's function list anyway (see v49's lesson about `public`).
REVOKE EXECUTE ON FUNCTION prereads_blank_flagged() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS prereads_blank_flagged ON prereads;
CREATE TRIGGER prereads_blank_flagged
  BEFORE INSERT OR UPDATE ON prereads
  FOR EACH ROW EXECUTE FUNCTION prereads_blank_flagged();

-- ---------------------------------------------------------------------------
-- The anon read policy (v26) now also hides blanked rows. The public site
-- currently reads with the service-role key, which skips RLS, so the real gate
-- is the row_status filter in each public query — this is the backstop for
-- any future anon-key reader. quality_flag and row_status are deliberately NOT
-- added to anon's column grant: why a row was hidden is admin information.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "prereads_anon_read_published" ON prereads;
CREATE POLICY "prereads_anon_read_published" ON prereads
  FOR SELECT TO anon
  USING (
    row_status = 'active'
    AND EXISTS (
      SELECT 1 FROM exhibitions e
      WHERE e.id = prereads.exhibition_id AND e.status = 'published'
    )
  );

-- ---------------------------------------------------------------------------
-- BACKFILL. Without it every existing show reads as "never attempted" and the
-- next Agent 1 run would generate a second set on top of the one it has.
--
-- A show that already has rows was attempted and produced them: 'success'
-- (nothing before today could have flagged a row). A show with none is left
-- NULL, which reruns it on its next Agent 1 visit — exactly what the old
-- "zero rows → generate" gate did, so no show's behaviour changes by accident.
-- Only rows still NULL are touched, so re-running this is harmless.
-- ---------------------------------------------------------------------------
UPDATE exhibitions e
SET preread_status = 'success'
WHERE e.preread_status IS NULL
  AND EXISTS (SELECT 1 FROM prereads p WHERE p.exhibition_id = e.id);

-- Verification — read what this prints.
SELECT
  (SELECT count(*) FROM exhibitions WHERE preread_status = 'success') AS exhibitions_success,
  (SELECT count(*) FROM exhibitions WHERE preread_status IS NULL)     AS exhibitions_never_attempted,
  (SELECT count(*) FROM prereads WHERE row_status = 'active')         AS prereads_active,
  (SELECT count(*) FROM prereads WHERE quality_flag IS NOT NULL)      AS prereads_flagged;
