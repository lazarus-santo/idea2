-- migration_v54: record every deleted preread
--
-- HOW TO APPLY: paste into the Supabase SQL editor as role `postgres`
-- (dashboard/project/sgkycnecmdxvujybsuev/sql/new). Safe to re-run.
-- Independent of the app code: nothing in the app reads or writes this table,
-- so it can be applied before or after a deploy.
--
-- ---------------------------------------------------------------------------
-- WHY
--
-- On 2026-09-18 an admin meant to Blank a wrong-artist article (Artforum's
-- "Marco Poloni" listing on Diego Marcon's page) and clicked Remove instead.
-- The row was deleted, and nothing anywhere recorded what it was or when it
-- went. This keeps a copy of every deleted preread row.
--
-- A TRIGGER, NOT A LINE IN THE REMOVE ROUTE. The admin Remove button is one of
-- several ways a preread disappears: the fair coverage regenerate route
-- deletes a show's rows before re-inserting, /api/debug-prereads does the
-- same, and deleting an exhibition cascades to its prereads. A log written by
-- one route would record one of those and stay silent about the rest — the
-- exact state this exists to end. The trigger sees them all.
--
-- WHO: the admin has no identity to record. /admin is one shared password
-- (x-admin-secret), and every server write uses the service-role key, so the
-- database cannot tell one admin from another or an admin from an agent.
-- `db_role` records the Postgres role for what it's worth (normally
-- service_role). Deleting an exhibition shows up as one row here per preread it
-- took with it, all sharing the same deleted_at.
--
-- No undo: `row_data` holds the whole row, so re-inserting by hand is possible,
-- but nothing in the app does it.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS preread_deletions (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  preread_id    uuid        NOT NULL,
  exhibition_id uuid,
  article_url   text,
  article_title text,
  publication   text,
  row_data      jsonb       NOT NULL,
  deleted_at    timestamptz NOT NULL DEFAULT now(),
  db_role       text
);

CREATE INDEX IF NOT EXISTS preread_deletions_exhibition_idx ON preread_deletions (exhibition_id);
CREATE INDEX IF NOT EXISTS preread_deletions_deleted_at_idx ON preread_deletions (deleted_at DESC);

-- Admin-only. RLS on with no policies means anon and authenticated read and
-- write nothing; the service role (admin routes, the SQL editor) bypasses RLS.
ALTER TABLE preread_deletions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON preread_deletions FROM anon, authenticated;

-- SECURITY DEFINER so the log write can't fail on a permission the deleting
-- role lacks — a delete must never be blocked by its own audit record. The
-- search_path is pinned, as a definer function requires.
CREATE OR REPLACE FUNCTION log_preread_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO preread_deletions (preread_id, exhibition_id, article_url, article_title, publication, row_data, db_role)
  -- current_user would be the definer here; the 'role' setting is the role the
  -- API request ran as (PostgREST SETs it), or 'none' in the SQL editor.
  VALUES (OLD.id, OLD.exhibition_id, OLD.article_url, OLD.article_title, OLD.publication, to_jsonb(OLD), current_setting('role', true));
  RETURN OLD;
END;
$$;

-- A trigger function can't be called over the REST API, but keep it off the
-- function list regardless (v49's lesson).
REVOKE EXECUTE ON FUNCTION log_preread_deletion() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS prereads_log_deletion ON prereads;
CREATE TRIGGER prereads_log_deletion
  AFTER DELETE ON prereads
  FOR EACH ROW EXECUTE FUNCTION log_preread_deletion();

-- Verification — read what this prints: the table exists and is empty, and the
-- trigger is attached.
SELECT
  (SELECT count(*) FROM preread_deletions) AS logged_deletions,
  (SELECT count(*) FROM pg_trigger WHERE tgname = 'prereads_log_deletion') AS trigger_attached;
