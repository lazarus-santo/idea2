-- migration_v67: crawls phase 2 — completing a crawl, and the social layer
--
-- HOW TO APPLY: paste into the Supabase SQL editor as role `postgres`
-- (dashboard/project/sgkycnecmdxvujybsuev/sql/new). There is no psql, no
-- Supabase CLI and no DATABASE_URL in this project. Safe to re-run.
--
-- REQUIRES migration_v66, and stops at the top if it is missing rather than
-- half-installing — the same guard v65 puts in front of v64.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS ADDS
--
--   1. 'completed' as a crawl status, with completed_at beside it.
--   2. Walking-or-driving per leg, saved with the stops (crawl_stops.arrive_by).
--   3. set_crawl_route() — the whole-list write, now carrying each leg's mode.
--      set_crawl_stops() stays, as a wrapper over it.
--   4. complete_crawl() — marks a crawl done and logs its shows as seen.
--   5. Completed crawls readable by whoever can_view_profile() lets through.
--   6. crawl_likes and crawl_saves.
--   7. recreate_crawl() — copy a completed route into a new draft of your own.
--
-- ---------------------------------------------------------------------------
-- ONLY A COMPLETED CRAWL IS SHAREABLE
--
-- Draft and planned crawls stay exactly as v66 left them: owner-only. A
-- completed crawl becomes readable by whoever may see the owner's profile —
-- public profile = anyone, including signed-out visitors; private profile =
-- the owner and approved followers; either side of a block = nobody. That is
-- public.can_view_profile() (v44, block-aware since v48/v49), the same gate
-- the logs, the Top Four and the events feed ask. There is no second privacy
-- model here.
--
-- The read is ADDED as new policies beside v66's owner policies rather than by
-- rewriting them, so the owner's access to their own drafts is untouched by
-- anything below. Writing stays owner-only on every verb, and on the stops it
-- stays function-only (v66).
--
-- ---------------------------------------------------------------------------
-- 'completed' IS SET BY ONE FUNCTION AND BY NOTHING ELSE
--
-- Completing a crawl has a side effect — its shows are logged as seen — so a
-- client that could write status = 'completed' straight to PostgREST would
-- complete a crawl with no logging, and a client that could write it BACK to
-- 'draft' would unfreeze a route other people may already have liked, saved or
-- copied. Both are prevented by one CHECK rather than a trigger:
--
--     (status = 'completed') = (completed_at IS NOT NULL)
--
-- completed_at has NO write grant, so a client can move neither half on its
-- own. A direct UPDATE to 'completed' fails the CHECK (no timestamp); a direct
-- UPDATE from 'completed' back to 'draft' fails it too (the timestamp stays).
-- Only complete_crawl(), which runs as the table owner, can set both at once.
--
-- CONSEQUENCE, INTENDED: there is no un-complete. A completed route is a fixed
-- record — its stops cannot change either (set_crawl_route refuses) — and the
-- log entries it created are the person's own to edit or delete like any
-- other. The owner can still RENAME it and can still DELETE it.
--
-- ---------------------------------------------------------------------------
-- THE AUTO-LOGGING RULE
--
-- For each stop whose show is still PUBLISHED:
--   no log entry           -> a new one, status 'seen', no rating/like/comment
--   'want_to_see'          -> upgraded to 'seen'
--   'seen'                 -> left completely alone: rating, like, comment,
--                             comment_visibility and updated_at untouched.
--
-- One INSERT ... ON CONFLICT DO UPDATE ... WHERE status = 'want_to_see'. The
-- WHERE is what leaves a 'seen' row alone: Postgres skips the update entirely
-- for rows it does not match, so updated_at does not move either.
--
-- It goes through exhibition_logs' existing rules rather than around them. The
-- gating CHECK (v62) accepts both writes as they stand — a want_to_see row by
-- construction carries no rating, like or comment — and the published-only
-- trigger (v62) still fires. A stop whose show has since been UNPUBLISHED is
-- skipped rather than allowed to fail the whole completion, and reported as
-- skipped.
--
-- ---------------------------------------------------------------------------
-- WHY THE LEG MODE MOVED INTO THE DATABASE
--
-- v66 saved the ORDER only; each leg's walk/drive choice lived in the /map
-- page's memory and was lost on reload. Harmless while only the owner ever saw
-- a crawl. Not harmless once somebody else opens it: every leg would be drawn
-- as walking, including the ones the owner drove. Franklin chose to save it.
--
-- arrive_by is the mode of the leg ARRIVING at a stop, so stop 1 has none. A
-- CHECK ties the two together — (position = 1) = (arrive_by IS NULL) — which
-- is only safe to state because the database generates positions itself.
--
-- It is carried by a jsonb LIST OF STOPS, each with its own mode, rather than a
-- second array beside the ids. Parallel arrays can arrive misaligned by one
-- and draw a driving leg where somebody walked, with nothing to flag it — the
-- reasoning set_top_four_content() (v64) and the route API already follow.
--
-- ---------------------------------------------------------------------------
-- LIKES AND SAVES
--
-- Two tables, the same shape, deliberately kept apart: a like is a public
-- signal (its COUNT is shown) and a save is a private bookmark ("want to do
-- this") that nobody but the saver sees. Neither copies anything.
--
-- Either may be placed only on a crawl the caller can currently SEE and that
-- is not their own — enforced in the INSERT policy, which asks the crawls
-- table under the caller's own RLS, so a crawl that is invisible to you cannot
-- be liked and the refusal is identical whether it exists or not. Liking or
-- saving your own crawl is refused: the owner sees the count, and their own
-- crawl already sits in their Crawls section.
--
-- Reads are first-person (you see your own likes and saves, full stop, like
-- public.follows). The only thing anybody learns about other people's likes is
-- a COUNT, from crawl_like_counts(), and only for crawls they may see.
--
-- If you lose sight of a crawl you saved (unfollowed from a private profile,
-- say), your save row is not deleted — it simply stops coming back, because
-- every read of the crawl behind it goes through RLS. A block goes further and
-- deletes both people's likes and saves on each other's crawls, the way v48's
-- block severs follows in both directions.
--
-- ---------------------------------------------------------------------------
-- WHAT IS NOT HERE
--
-- No notifications (still deferred project-wide). No feed event type — v47's
-- log stays deliberately empty; "completed a crawl" is now a plausible event,
-- noted and not built. Nothing in Agent 1, 2, 3 or 4 changes.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF to_regclass('public.crawl_stops') IS NULL
     OR to_regprocedure('public.set_crawl_stops(uuid, uuid[])') IS NULL THEN
    RAISE EXCEPTION 'migration_v67 needs migration_v66 applied first';
  END IF;
END;
$$;

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. 'completed', and when.
-- ---------------------------------------------------------------------------
ALTER TABLE public.crawls ADD COLUMN IF NOT EXISTS completed_at timestamptz;

ALTER TABLE public.crawls DROP CONSTRAINT IF EXISTS crawls_status_values;
ALTER TABLE public.crawls ADD CONSTRAINT crawls_status_values
  CHECK (status IN ('draft', 'planned', 'completed'));

-- See the header: this is what makes complete_crawl() the only way in, and the
-- only way there is no way back out.
ALTER TABLE public.crawls DROP CONSTRAINT IF EXISTS crawls_completed_at_consistent;
ALTER TABLE public.crawls ADD CONSTRAINT crawls_completed_at_consistent
  CHECK ((status = 'completed') = (completed_at IS NOT NULL));

COMMENT ON COLUMN public.crawls.status IS
  'draft = being put together; planned = the owner considers it finished; completed = walked, set ONLY by complete_crawl(). Draft and planned are owner-only. Completed is readable by whoever can_view_profile(user_id) allows, and its stops are frozen.';
COMMENT ON COLUMN public.crawls.completed_at IS
  'When complete_crawl() ran. NULL exactly when status is not completed (crawls_completed_at_consistent). Not writable by any client.';

-- Profiles list completed crawls newest-first.
CREATE INDEX IF NOT EXISTS crawls_user_completed_idx
  ON public.crawls (user_id, completed_at DESC)
  WHERE status = 'completed';

-- ---------------------------------------------------------------------------
-- 2. Walking or driving, per leg.
--
-- Existing stops are backfilled to 'walking' — what the map drew for them,
-- since nothing else was ever saved — before the CHECK that requires a mode
-- on every stop but the first is added.
-- ---------------------------------------------------------------------------
ALTER TABLE public.crawl_stops ADD COLUMN IF NOT EXISTS arrive_by text;

UPDATE public.crawl_stops SET arrive_by = 'walking'
 WHERE position > 1 AND arrive_by IS NULL;
UPDATE public.crawl_stops SET arrive_by = NULL
 WHERE position = 1 AND arrive_by IS NOT NULL;

ALTER TABLE public.crawl_stops DROP CONSTRAINT IF EXISTS crawl_stops_arrive_by_values;
ALTER TABLE public.crawl_stops ADD CONSTRAINT crawl_stops_arrive_by_values
  CHECK (arrive_by IS NULL OR arrive_by IN ('walking', 'driving'));

ALTER TABLE public.crawl_stops DROP CONSTRAINT IF EXISTS crawl_stops_arrive_by_first;
ALTER TABLE public.crawl_stops ADD CONSTRAINT crawl_stops_arrive_by_first
  CHECK ((position = 1) = (arrive_by IS NULL));

COMMENT ON COLUMN public.crawl_stops.arrive_by IS
  'How you get TO this stop from the one before: walking | driving. NULL on stop 1, and only there. Written by set_crawl_route() with the rest of the list.';

-- ---------------------------------------------------------------------------
-- 3. Who may read a completed crawl.
--
-- NEW policies, beside v66's owner-only ones; permissive policies are OR'd, so
-- nothing the owner could see before is affected.
--
-- anon is included: a completed crawl on a PUBLIC profile is visible to
-- signed-out visitors, as the rest of a public profile is. can_view_profile()
-- with no auth.uid() answers true only for public profiles (v47 relies on the
-- same thing), and it is already granted to anon (v52).
--
-- The stops policy spells the completed-and-visible rule out rather than
-- leaning on "whatever crawls' RLS returns", so a future policy on crawls
-- cannot widen who reads the stops by accident.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS crawls_read_completed ON public.crawls;
CREATE POLICY crawls_read_completed ON public.crawls
  FOR SELECT TO anon, authenticated
  USING (status = 'completed' AND public.can_view_profile(user_id));

DROP POLICY IF EXISTS crawl_stops_read_completed ON public.crawl_stops;
CREATE POLICY crawl_stops_read_completed ON public.crawl_stops
  FOR SELECT TO anon, authenticated
  USING (EXISTS (
    SELECT 1 FROM public.crawls c
     WHERE c.id = crawl_stops.crawl_id
       AND c.status = 'completed'
       AND public.can_view_profile(c.user_id)
  ));

GRANT SELECT (id, user_id, title, status, created_at, updated_at, completed_at)
  ON public.crawls TO anon, authenticated;
GRANT SELECT (crawl_id, exhibition_id, position, arrive_by, created_at)
  ON public.crawl_stops TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Set the whole route: stops in order, each with the mode of its leg.
--
-- p_stops is a jsonb array: [{"exhibition_id": "<uuid>", "arrive_by":
-- "walking" | "driving"}, ...]. Element 1 is stop 1 and its arrive_by is
-- ignored (there is no leg into the first stop). A missing arrive_by on any
-- later stop means walking — what the map defaults a new leg to. An arrive_by
-- that is neither word is REFUSED, never defaulted: silently drawing a walk
-- where somebody asked for something else is the error this avoids.
--
-- Everything v66's set_crawl_stops() said still holds — owner from auth.uid()
-- and never an argument, one transaction, validate before the delete, created_at
-- carried across reorders — plus one new refusal: a COMPLETED crawl's route is
-- frozen. The crawl row is locked FOR UPDATE first, so a save and a completion
-- racing each other cannot interleave.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_crawl_route(
  p_crawl_id uuid,
  p_stops    jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  me             uuid := (SELECT auth.uid());
  stops          jsonb := coalesce(p_stops, '[]'::jsonb);
  n              integer;
  current_status text;
  prior          jsonb;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'not_signed_in'
      USING HINT = 'Sign in to edit a crawl.';
  END IF;

  SELECT c.status INTO current_status
    FROM public.crawls c
   WHERE c.id = p_crawl_id AND c.user_id = me
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'crawl_not_found'
      USING HINT = 'That crawl does not exist, or is not yours.';
  END IF;

  IF current_status = 'completed' THEN
    RAISE EXCEPTION 'crawl_completed'
      USING HINT = 'A completed crawl''s route is fixed.';
  END IF;

  IF jsonb_typeof(stops) <> 'array' THEN
    RAISE EXCEPTION 'crawl_bad_input'
      USING HINT = 'The stops must be a list.';
  END IF;

  n := jsonb_array_length(stops);

  IF n > 25 THEN
    RAISE EXCEPTION 'crawl_too_many_stops'
      USING HINT = 'A crawl holds twenty-five stops at most.';
  END IF;

  -- A missing id, or an element that is not an object at all (->> on a
  -- non-object is NULL), becomes one named refusal instead of a NOT NULL
  -- violation three statements later.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(stops) AS t(e)
     WHERE jsonb_typeof(t.e) <> 'object' OR (t.e ->> 'exhibition_id') IS NULL
  ) THEN
    RAISE EXCEPTION 'crawl_bad_input'
      USING HINT = 'That list of stops has an empty slot in it.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(stops) WITH ORDINALITY AS t(e, ord)
     WHERE t.ord > 1
       AND (t.e ->> 'arrive_by') IS NOT NULL
       AND (t.e ->> 'arrive_by') NOT IN ('walking', 'driving')
  ) THEN
    RAISE EXCEPTION 'crawl_bad_input'
      USING HINT = 'A leg is walked or driven.';
  END IF;

  -- A malformed id would otherwise fail as a bare 22P02 naming a type.
  BEGIN
    PERFORM (t.e ->> 'exhibition_id')::uuid FROM jsonb_array_elements(stops) AS t(e);
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'crawl_bad_input'
      USING HINT = 'That list of stops has an id that is not an id.';
  END;

  IF n <> (SELECT count(DISTINCT (t.e ->> 'exhibition_id')::uuid)
             FROM jsonb_array_elements(stops) AS t(e)) THEN
    RAISE EXCEPTION 'crawl_duplicate_stop'
      USING HINT = 'A show cannot be two stops on the same crawl.';
  END IF;

  SELECT coalesce(jsonb_object_agg(s.exhibition_id::text, s.created_at), '{}'::jsonb)
    INTO prior
    FROM public.crawl_stops s
   WHERE s.crawl_id = p_crawl_id;

  DELETE FROM public.crawl_stops s WHERE s.crawl_id = p_crawl_id;

  INSERT INTO public.crawl_stops (crawl_id, exhibition_id, position, arrive_by, created_at)
  SELECT
    p_crawl_id,
    (t.e ->> 'exhibition_id')::uuid,
    t.ord::smallint,
    CASE WHEN t.ord = 1 THEN NULL ELSE coalesce(t.e ->> 'arrive_by', 'walking') END,
    coalesce((prior ->> ((t.e ->> 'exhibition_id')::uuid)::text)::timestamptz, now())
  FROM jsonb_array_elements(stops) WITH ORDINALITY AS t(e, ord);

  UPDATE public.crawls c SET updated_at = now() WHERE c.id = p_crawl_id;
END;
$$;

COMMENT ON FUNCTION public.set_crawl_route(uuid, jsonb) IS
  'Replace a crawl''s route: [{exhibition_id, arrive_by}] in order, element 1 = stop 1. arrive_by (walking | driving) is the leg INTO that stop; ignored on stop 1, walking when omitted, refused when anything else. Always a crawl the CALLER owns (auth.uid(), no user_id argument). Refused on a completed crawl. Positions are generated 1..n.';

REVOKE ALL ON FUNCTION public.set_crawl_route(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_crawl_route(uuid, jsonb) TO authenticated;

-- set_crawl_stops() keeps its signature and becomes a WRAPPER, the way v65's
-- per-item Top Four functions wrap the whole-list ones: one write path, one set
-- of rules. It exists so a browser still running the pre-v67 bundle keeps
-- saving during the deploy window; every leg it writes is walking, which is
-- exactly what that bundle's saves meant before this migration.
CREATE OR REPLACE FUNCTION public.set_crawl_stops(
  p_crawl_id        uuid,
  p_exhibition_ids  uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.set_crawl_route(
    p_crawl_id,
    (SELECT coalesce(
              jsonb_agg(jsonb_build_object('exhibition_id', x.id) ORDER BY x.ord),
              '[]'::jsonb)
       FROM unnest(coalesce(p_exhibition_ids, ARRAY[]::uuid[])) WITH ORDINALITY AS x(id, ord))
  );
END;
$$;

COMMENT ON FUNCTION public.set_crawl_stops(uuid, uuid[]) IS
  'Since v67 a wrapper over set_crawl_route() with every leg walking. Kept for compatibility; new code calls set_crawl_route().';

-- ---------------------------------------------------------------------------
-- 5. Complete a crawl.
--
-- Owner only, from auth.uid(). Returns what it did, so the page can say "3
-- shows marked as seen" rather than guess:
--   {logged, upgraded, unchanged, skipped, already_completed}
--     logged     new 'seen' entries created
--     upgraded   'want_to_see' entries moved to 'seen'
--     unchanged  already 'seen' — not touched
--     skipped    stops whose show is no longer published
--
-- Completing an already-completed crawl is a silent no-op that says so, so a
-- double click cannot log anything twice or restamp completed_at. An empty
-- crawl is refused: there is nothing to have walked.
--
-- `xmax = 0` in RETURNING is true for a row this statement INSERTED and false
-- for one it UPDATED — a long-standing Postgres idiom for telling the two
-- branches of an upsert apart. Rows the DO UPDATE's WHERE skipped (already
-- seen) are not returned at all.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.complete_crawl(p_crawl_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  me             uuid := (SELECT auth.uid());
  current_status text;
  stop_total     integer;
  eligible       integer;
  logged_n       integer := 0;
  upgraded_n     integer := 0;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'not_signed_in'
      USING HINT = 'Sign in to complete a crawl.';
  END IF;

  SELECT c.status INTO current_status
    FROM public.crawls c
   WHERE c.id = p_crawl_id AND c.user_id = me
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'crawl_not_found'
      USING HINT = 'That crawl does not exist, or is not yours.';
  END IF;

  IF current_status = 'completed' THEN
    RETURN jsonb_build_object(
      'already_completed', true,
      'logged', 0, 'upgraded', 0, 'unchanged', 0, 'skipped', 0
    );
  END IF;

  SELECT count(*) INTO stop_total
    FROM public.crawl_stops s
   WHERE s.crawl_id = p_crawl_id;

  IF stop_total = 0 THEN
    RAISE EXCEPTION 'crawl_empty'
      USING HINT = 'A crawl needs at least one stop to be completed.';
  END IF;

  SELECT count(*) INTO eligible
    FROM public.crawl_stops s
    JOIN public.exhibitions e ON e.id = s.exhibition_id AND e.status = 'published'
   WHERE s.crawl_id = p_crawl_id;

  WITH written AS (
    INSERT INTO public.exhibition_logs AS l (user_id, exhibition_id, status)
    SELECT me, s.exhibition_id, 'seen'
      FROM public.crawl_stops s
      JOIN public.exhibitions e ON e.id = s.exhibition_id AND e.status = 'published'
     WHERE s.crawl_id = p_crawl_id
    ON CONFLICT (user_id, exhibition_id) DO UPDATE
       SET status = 'seen'
     WHERE l.status = 'want_to_see'
    RETURNING (l.xmax = 0) AS inserted
  )
  SELECT count(*) FILTER (WHERE inserted), count(*) FILTER (WHERE NOT inserted)
    INTO logged_n, upgraded_n
    FROM written;

  UPDATE public.crawls c
     SET status = 'completed', completed_at = now()
   WHERE c.id = p_crawl_id;

  RETURN jsonb_build_object(
    'already_completed', false,
    'logged',    logged_n,
    'upgraded',  upgraded_n,
    'unchanged', eligible - logged_n - upgraded_n,
    'skipped',   stop_total - eligible
  );
END;
$$;

COMMENT ON FUNCTION public.complete_crawl(uuid) IS
  'Mark the caller''s crawl completed (status + completed_at) and log each published stop: none -> seen, want_to_see -> seen, seen -> untouched. Returns {logged, upgraded, unchanged, skipped, already_completed}. Idempotent. Refuses an empty crawl. The only way a crawl becomes completed.';

REVOKE ALL ON FUNCTION public.complete_crawl(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_crawl(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. Likes and saves.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.crawl_likes (
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  crawl_id   uuid NOT NULL REFERENCES public.crawls(id)   ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, crawl_id)
);

CREATE TABLE IF NOT EXISTS public.crawl_saves (
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  crawl_id   uuid NOT NULL REFERENCES public.crawls(id)   ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, crawl_id)
);

-- The PK serves "my likes/saves"; counting a crawl's likes reads the other way.
CREATE INDEX IF NOT EXISTS crawl_likes_crawl_idx ON public.crawl_likes (crawl_id);
CREATE INDEX IF NOT EXISTS crawl_saves_crawl_idx ON public.crawl_saves (crawl_id);

COMMENT ON TABLE public.crawl_likes IS
  'One like per person per completed crawl. Readable by the liker only; everyone else sees a count via crawl_like_counts(). Insertable only on a crawl the caller can see and does not own.';
COMMENT ON TABLE public.crawl_saves IS
  'The "want to do this" bookmark. Not a copy of the route (that is recreate_crawl()). Private to the saver. Insertable only on a crawl the caller can see and does not own.';

ALTER TABLE public.crawl_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crawl_saves ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crawl_likes_read_own   ON public.crawl_likes;
DROP POLICY IF EXISTS crawl_likes_insert_own ON public.crawl_likes;
DROP POLICY IF EXISTS crawl_likes_delete_own ON public.crawl_likes;
DROP POLICY IF EXISTS crawl_saves_read_own   ON public.crawl_saves;
DROP POLICY IF EXISTS crawl_saves_insert_own ON public.crawl_saves;
DROP POLICY IF EXISTS crawl_saves_delete_own ON public.crawl_saves;

CREATE POLICY crawl_likes_read_own ON public.crawl_likes
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- The subquery on crawls runs under the CALLER's RLS, so a crawl they cannot
-- see returns nothing and the insert is refused — identically for "no such
-- crawl", "not completed" and "not allowed", which is the point.
CREATE POLICY crawl_likes_insert_own ON public.crawl_likes
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.crawls c
       WHERE c.id = crawl_likes.crawl_id
         AND c.status = 'completed'
         AND c.user_id <> (SELECT auth.uid())
         AND public.can_view_profile(c.user_id)
    )
  );

-- Removing your own like needs no visibility check: somebody who has lost
-- sight of a crawl may still take their like back.
CREATE POLICY crawl_likes_delete_own ON public.crawl_likes
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY crawl_saves_read_own ON public.crawl_saves
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY crawl_saves_insert_own ON public.crawl_saves
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.crawls c
       WHERE c.id = crawl_saves.crawl_id
         AND c.status = 'completed'
         AND c.user_id <> (SELECT auth.uid())
         AND public.can_view_profile(c.user_id)
    )
  );

CREATE POLICY crawl_saves_delete_own ON public.crawl_saves
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- No UPDATE on either: a like or a save is there or it is not.
GRANT SELECT (user_id, crawl_id, created_at) ON public.crawl_likes TO authenticated;
GRANT INSERT (user_id, crawl_id)             ON public.crawl_likes TO authenticated;
GRANT DELETE                                 ON public.crawl_likes TO authenticated;
GRANT SELECT (user_id, crawl_id, created_at) ON public.crawl_saves TO authenticated;
GRANT INSERT (user_id, crawl_id)             ON public.crawl_saves TO authenticated;
GRANT DELETE                                 ON public.crawl_saves TO authenticated;
GRANT ALL ON public.crawl_likes TO service_role;
GRANT ALL ON public.crawl_saves TO service_role;

-- ---------------------------------------------------------------------------
-- 7. Like counts.
--
-- SECURITY DEFINER because the table's own reads are first-person. Returns a
-- row only for a crawl the caller may see — completed and can_view_profile() —
-- so a guessed id answers with nothing rather than with a zero that would
-- confirm the crawl exists. Capped at 200 ids a call; a profile never lists
-- more than that on one page.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crawl_like_counts(p_crawl_ids uuid[])
RETURNS TABLE (crawl_id uuid, like_count integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.id,
         (SELECT count(*)::int FROM public.crawl_likes l WHERE l.crawl_id = c.id)
    FROM public.crawls c
   WHERE c.id = ANY ((coalesce(p_crawl_ids, ARRAY[]::uuid[]))[1:200])
     AND c.status = 'completed'
     AND public.can_view_profile(c.user_id);
$$;

COMMENT ON FUNCTION public.crawl_like_counts(uuid[]) IS
  'Like counts for completed crawls the caller may see; other ids are silently absent. MUST be called with the visitor''s session: it reads auth.uid() through can_view_profile().';

REVOKE ALL ON FUNCTION public.crawl_like_counts(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.crawl_like_counts(uuid[]) TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. A block takes likes and saves with it, both directions.
--
-- The same move v48 makes for follows: blocking somebody should not leave
-- their like counted on your crawl, or your bookmark pointing at theirs. A
-- separate trigger rather than an edit to v48's, so neither migration has to
-- know the other's body.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.blocks_sever_crawl_interest()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM public.crawl_likes l
   USING public.crawls c
   WHERE c.id = l.crawl_id
     AND ((l.user_id = NEW.blocker_id AND c.user_id = NEW.blocked_id)
       OR (l.user_id = NEW.blocked_id AND c.user_id = NEW.blocker_id));

  DELETE FROM public.crawl_saves s
   USING public.crawls c
   WHERE c.id = s.crawl_id
     AND ((s.user_id = NEW.blocker_id AND c.user_id = NEW.blocked_id)
       OR (s.user_id = NEW.blocked_id AND c.user_id = NEW.blocker_id));

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.blocks_sever_crawl_interest() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS blocks_sever_crawl_interest ON public.blocks;
CREATE TRIGGER blocks_sever_crawl_interest
  AFTER INSERT ON public.blocks
  FOR EACH ROW EXECUTE FUNCTION public.blocks_sever_crawl_interest();

-- ---------------------------------------------------------------------------
-- 9. Recreate a completed crawl as your own draft.
--
-- Copies the ORDERED STOPS and each leg's mode — nothing else. Not the
-- original owner's logs, likes, saves, dates or anything personal; the new
-- crawl is an ordinary draft owned by the caller, editable through
-- set_crawl_route() like any other, with no link back to the original.
--
-- The title is carried over so the copy is recognisable; its new owner can
-- rename it. Stops whose show has since been unpublished are left out (the
-- published-only trigger would refuse them anyway) and the rest renumbered
-- 1..n; the first surviving stop loses its arrive_by, since nothing leads
-- into it any more.
--
-- The source must be completed and visible to the caller, or the answer is
-- crawl_not_found — the same answer for a crawl that does not exist, is a
-- draft, or belongs to a profile you cannot see.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recreate_crawl(p_crawl_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  me        uuid := (SELECT auth.uid());
  src_title text;
  new_id    uuid;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'not_signed_in'
      USING HINT = 'Sign in to recreate a crawl.';
  END IF;

  SELECT c.title INTO src_title
    FROM public.crawls c
   WHERE c.id = p_crawl_id
     AND c.status = 'completed'
     AND public.can_view_profile(c.user_id);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'crawl_not_found'
      USING HINT = 'That crawl does not exist, or you cannot see it.';
  END IF;

  INSERT INTO public.crawls (user_id, title, status)
  VALUES (me, src_title, 'draft')
  RETURNING id INTO new_id;

  INSERT INTO public.crawl_stops (crawl_id, exhibition_id, position, arrive_by)
  SELECT new_id,
         k.exhibition_id,
         k.rn,
         CASE WHEN k.rn = 1 THEN NULL ELSE coalesce(k.arrive_by, 'walking') END
    FROM (
      SELECT s.exhibition_id,
             s.arrive_by,
             (row_number() OVER (ORDER BY s.position))::smallint AS rn
        FROM public.crawl_stops s
        JOIN public.exhibitions e ON e.id = s.exhibition_id AND e.status = 'published'
       WHERE s.crawl_id = p_crawl_id
    ) k;

  RETURN new_id;
END;
$$;

COMMENT ON FUNCTION public.recreate_crawl(uuid) IS
  'Copy a completed crawl the caller can see into a NEW draft owned by the caller: ordered stops and leg modes only, published shows only, renumbered 1..n. Returns the new crawl''s id. crawl_not_found for anything the caller may not copy.';

REVOKE ALL ON FUNCTION public.recreate_crawl(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recreate_crawl(uuid) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
