-- migration_v38: weekly-distributed Agent 1 scheduling
--
-- Four changes, all for the 15-minute Agent 1 queue in app/api/cron/scrape:
--
-- 1. venues.scrape_day_of_week — a permanent weekly slot per venue
--    (0 = Sunday ... 6 = Saturday, New York time). Added with no default so
--    existing rows stay NULL for scripts/backfill-scrape-day-of-week.mjs to
--    fill evenly; the default is set afterwards so every future insert gets a
--    random day. The default lives here rather than in application code because
--    venues are also inserted by hand in the SQL editor, and a NULL slot means
--    the venue is never scraped.
--
-- 2. venues scrape state — the per-venue, per-day status the queue reads.
--      not_started / completed  "completed" only blocks the rest of the New York
--                               day it was set on (derived from
--                               scrape_status_changed_at); an older one reads as
--                               not_started, so there is no nightly reset job.
--      in_progress              set when a venue is claimed, before any work.
--      error1 / error2          retried after a cooldown, on any day.
--      error3                   no further automatic retries; also sets
--                               manual_entry_required, which is what the Scrape
--                               Issues tab and every queue query already key on.
--    scrape_failures carries the error count through in_progress (a status of
--    in_progress alone would lose it). scrape_status_version is the
--    compare-and-swap token: every state write is conditional on the version
--    it read, so two claimers can never both win the same venue.
--
--    Existing manual_entry_required venues land on not_started and stay
--    excluded by that flag exactly as today — no automatic retry spend on them
--    until someone clears the issue or scrapes them from the admin.
--
-- 3. venue_scrape_attempts — one row per scrape attempt, inserted when the
--    venue is claimed and completed at the end with duration_ms, whatever the
--    outcome. An attempt killed by the platform never completes; the next
--    queue run marks it timed_out. Average completed duration drives the
--    queue's time-left check.
--
-- 4. agent_runs.status gains 'timed_out', for runs the platform killed before
--    they could record completion (scripts/cleanup-stale-agent-runs.mjs).
--
-- None of the new columns are granted to anon: migration_v26 grants anon a
-- fixed column list on venues, and revoked default privileges on new tables.

BEGIN;

-- ─── 1. Weekly slot ──────────────────────────────────────────────────────────
ALTER TABLE venues
  ADD COLUMN IF NOT EXISTS scrape_day_of_week smallint
    CHECK (scrape_day_of_week BETWEEN 0 AND 6);

-- After the ADD, so existing rows are left NULL for the even backfill.
ALTER TABLE venues
  ALTER COLUMN scrape_day_of_week SET DEFAULT floor(random() * 7)::smallint;

-- ─── 2. Scrape state ─────────────────────────────────────────────────────────
ALTER TABLE venues
  ADD COLUMN IF NOT EXISTS scrape_status text NOT NULL DEFAULT 'not_started'
    CHECK (scrape_status IN ('not_started', 'in_progress', 'completed', 'error1', 'error2', 'error3')),
  ADD COLUMN IF NOT EXISTS scrape_status_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS scrape_failures smallint NOT NULL DEFAULT 0
    CHECK (scrape_failures BETWEEN 0 AND 3),
  ADD COLUMN IF NOT EXISTS scrape_status_version integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN venues.scrape_day_of_week IS
  'Permanent weekly scrape slot, 0=Sunday..6=Saturday in America/New_York. Never re-randomized.';
COMMENT ON COLUMN venues.scrape_status IS
  'Agent 1 queue state. completed blocks only the NY day of scrape_status_changed_at.';
COMMENT ON COLUMN venues.scrape_status_version IS
  'Compare-and-swap token; every scrape state write is conditional on it.';

-- ─── 3. Per-attempt timing ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS venue_scrape_attempts (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Venues are deactivated, never deleted; cascade just keeps an accidental
  -- delete from being blocked by its own history.
  venue_id              uuid        NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  agent_run_id          uuid        REFERENCES agent_runs(id) ON DELETE SET NULL,
  trigger               text        NOT NULL CHECK (trigger IN ('cron', 'manual')),
  started_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  duration_ms           integer,
  outcome               text        NOT NULL DEFAULT 'running'
    CHECK (outcome IN ('running', 'completed', 'failed', 'timed_out')),
  failure_reason        text,
  exhibitions_upserted  integer
);

CREATE INDEX IF NOT EXISTS idx_venue_scrape_attempts_venue_started
  ON venue_scrape_attempts(venue_id, started_at DESC);

ALTER TABLE venue_scrape_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON venue_scrape_attempts FROM anon, authenticated;
GRANT ALL ON venue_scrape_attempts TO service_role;

-- ─── 4. agent_runs.status: add 'timed_out' ───────────────────────────────────
-- Dropped by lookup rather than by name: the constraint was declared inline in
-- migration_v18, and this schema has a history of out-of-band changes.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.agent_runs'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE public.agent_runs DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_status_check
  CHECK (status IN ('running', 'success', 'partial', 'failed', 'timed_out'));

COMMIT;

-- ─── Verify ──────────────────────────────────────────────────────────────────
--   SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'venues' AND column_name LIKE 'scrape_%' ORDER BY column_name;
--     -> scrape_day_of_week (smallint, YES, floor((random() * 7)...)),
--        scrape_failures (smallint, NO, 0), scrape_status (text, NO, 'not_started'),
--        scrape_status_changed_at (timestamptz, YES), scrape_status_version (integer, NO, 0)
--        (plus the pre-existing scrape_failed / scrape_failure_reason / scrape_notes)
--
--   SELECT count(*) FROM venues WHERE scrape_day_of_week IS NULL;
--     -> every existing venue, until the backfill runs
--
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'public.agent_runs'::regclass AND contype = 'c';
--     -> includes CHECK (status = ANY (ARRAY[... 'timed_out'::text]))
