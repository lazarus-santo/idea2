-- migration_v66: crawls — a saved, ordered gallery-hopping route
--
-- HOW TO APPLY: paste into the Supabase SQL editor as role `postgres`
-- (dashboard/project/sgkycnecmdxvujybsuev/sql/new). There is no psql, no
-- Supabase CLI and no DATABASE_URL in this project. Safe to re-run.
--
-- PHASE 1 OF 2. This file builds a crawl: the route and its labelled stops.
-- Completing a crawl, the connection to exhibition_logs, and the social layer
-- (like, save-to-try, recreate) are Phase 2 and are deliberately absent. The
-- shapes below are chosen so Phase 2 can be added without rewriting them, and
-- the places it will touch are named at the end.
--
-- ---------------------------------------------------------------------------
-- A CRAWL IS A PLAN, SO IT DOES NOT ASK WHETHER YOU HAVE LOGGED ANYTHING
--
-- The obvious-looking move, given v62 and v64, would be a foreign key into
-- exhibition_logs: the Top Four does exactly that, and it is what makes
-- eligibility unfakeable there. It would be wrong here, and the difference is
-- worth stating because the two tables otherwise look alike.
--
-- A Top Four entry is a CLAIM ABOUT THE PAST — "this was one of the four best
-- shows I saw" — so it is only meaningful if the show is already logged as
-- seen, and the foreign key says so. A crawl stop is a STATEMENT OF INTENT
-- about a show you have very likely never seen and may not even have marked
-- as want_to_see yet. Requiring a log row would mean making somebody log a
-- show in order to plan a walk past it, which inverts the order people
-- actually do things in.
--
-- So the only requirement on a stop is that the exhibition is PUBLISHED, which
-- is section 4's trigger and is the same rule v62 applies for the same
-- disclosure reason. Phase 2's "completing a crawl marks its stops as seen"
-- will WRITE exhibition_logs rows; it still does not need to read one here.
--
-- ---------------------------------------------------------------------------
-- ORDERING: THE SAME PROBLEM AS THE TOP FOUR, AND THE SAME ANSWER
--
-- The brief asks for two constraints — no duplicate stop in a crawl, no two
-- stops in the same slot — and for positions that stay gap-free through a
-- reorder. Those are the v64 constraints under different names, and they fail
-- in the same way for the same reason: moving stop 3 to slot 1 as a series of
-- row updates puts two rows in one slot partway through, and the unique
-- constraint refuses it, correctly, halfway done.
--
-- So crawl_stops is written the way top_four_exhibitions is. There are NO
-- INSERT, UPDATE or DELETE grants on it for anybody but service_role, and the
-- only way in is set_crawl_stops() in section 6, which takes the WHOLE list
-- of stops in order, empties the crawl and lays the new order down inside one
-- transaction. Add, remove, reorder and clear are all that one call with a
-- different array. A reorder that half-happens is not merely discouraged here,
-- it is not expressible.
--
-- The alternatives — a DEFERRABLE unique constraint, or shuffling through
-- negative positions — were argued out at length in migration_v64 and rejected
-- for reasons that apply unchanged. That reasoning is not repeated here.
--
-- GAP-FREE IS A PROPERTY OF THE WRITE PATH, NOT OF A CONSTRAINT, and this is
-- the one honest caveat in the design. "Positions run 1..n with no holes" is a
-- statement about a SET of rows; a CHECK sees one row and a UNIQUE sees one
-- pair, so neither can say it. What makes it true is that section 6 generates
-- the positions itself with WITH ORDINALITY starting at 1 — no caller ever
-- supplies a position, and no caller can, because there is no write grant.
-- Section 10 proves it from the outside instead, which is where a property of
-- a write path has to be proved.
--
-- ---------------------------------------------------------------------------
-- PRIVACY IN PHASE 1: THE OWNER, AND NOBODY ELSE
--
-- A crawl is visible and editable by the account that made it, full stop.
-- There is no can_view_profile() call in this file and that is deliberate —
-- not an oversight and not a shortcut. Sharing is Phase 2, and the moment a
-- crawl becomes shareable the question "who may see this" gets a real answer
-- that has to be designed. Answering it now, with a visibility column nothing
-- reads and a policy nothing exercises, would mean shipping an untested
-- privacy rule and then trusting it later.
--
-- The policies below are therefore strictly first-person on every verb, like
-- exhibition_logs and public.follows. Phase 2 adds the wider read; it does not
-- have to undo anything here.
--
-- ---------------------------------------------------------------------------
-- WHY THERE IS NO 'completed' STATUS
--
-- status is CHECKed to ('draft', 'planned') and Phase 2 will widen it. It is
-- left out rather than accepted-and-ignored on purpose: a status the database
-- accepts but nothing in the product can set or act on is a value that will
-- eventually arrive from somewhere and mean nothing. Widening a CHECK is a
-- one-line migration when the behaviour behind it exists.
--
-- ---------------------------------------------------------------------------
-- WHAT IS NOT HERE
--
-- No completion, no exhibition_logs writes, no sharing, no like, no
-- save-to-try, no recreate — all Phase 2. No feed event type: v47's log is
-- still deliberately empty and "planned a crawl" is now a PLAUSIBLE event,
-- which is noted and not built. Nothing in Agent 1, 2, 3 or 4 changes; this
-- file reads exhibition ids and writes no exhibition, preread or reading data.
-- The existing /map itinerary tool is untouched and shares no table with this.
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The crawl itself.
--
-- user_id points at profiles rather than auth.users, as every table since v62
-- does: a crawl belongs to the profile that will eventually show it, profiles
-- already cascades from auth.users, and deleting an account removes its crawls
-- in one step.
--
-- A SURROGATE id RATHER THAN (user_id, title). A person may well have two
-- crawls called "Chelsea Saturday" and renaming one must not be able to
-- collide with the other or move its stops. The id is also what Phase 2's
-- share link will be built from, so it wants to be stable and opaque from the
-- start.
--
-- TITLE IS REQUIRED AND MUST NOT BE BLANK. A row whose title is '' or '   '
-- forces every surface that lists crawls to invent a placeholder, and two
-- surfaces will eventually invent different ones. The client sends "Untitled
-- crawl" instead, which is a real title somebody can edit.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.crawls (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title      text NOT NULL,
  status     text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- 'completed' is NOT here. See the header.
  CONSTRAINT crawls_status_values CHECK (status IN ('draft', 'planned')),
  CONSTRAINT crawls_title_not_blank CHECK (length(btrim(title)) > 0),
  CONSTRAINT crawls_title_length    CHECK (length(title) <= 120)
);

CREATE INDEX IF NOT EXISTS crawls_user_updated_idx
  ON public.crawls (user_id, updated_at DESC);

COMMENT ON TABLE public.crawls IS
  'One gallery-hopping route somebody has planned. Phase 1: owner-only, draft or planned. The stops live in crawl_stops and are written ONLY through set_crawl_stops(). Sharing, completion and the link to exhibition_logs are Phase 2 and are deliberately absent.';
COMMENT ON COLUMN public.crawls.status IS
  'draft = still being put together; planned = the owner considers it finished. Phase 2 adds ''completed''. Nothing about visibility depends on this in Phase 1 — both states are owner-only.';

-- ---------------------------------------------------------------------------
-- 2. The stops.
--
-- PRIMARY KEY (crawl_id, exhibition_id) IS the "no duplicate stop" rule, and
-- UNIQUE (crawl_id, position) is the "no two stops in one slot" rule. Between
-- them they are what makes a reorder need section 6 rather than two casual
-- updates — see the header.
--
-- exhibition_id CASCADEs. A published exhibition is not deleted today (that is
-- what migration_v62 and the id-stability work rest on), but if one ever were,
-- a stop pointing at nothing would leave a hole in the middle of a route that
-- no reorder could close.
--
-- position is a smallint starting at 1, never 0: these are the numbers drawn
-- on the map and spoken out loud ("first stop"), so the stored value and the
-- displayed one are the same number.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.crawl_stops (
  crawl_id      uuid NOT NULL REFERENCES public.crawls(id)      ON DELETE CASCADE,
  exhibition_id uuid NOT NULL REFERENCES public.exhibitions(id) ON DELETE CASCADE,
  position      smallint NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (crawl_id, exhibition_id),

  CONSTRAINT crawl_stops_one_per_slot UNIQUE (crawl_id, position),
  CONSTRAINT crawl_stops_position_positive CHECK (position >= 1),
  CONSTRAINT crawl_stops_position_ceiling  CHECK (position <= 25)
);

-- The PK already indexes (crawl_id, exhibition_id) and the unique constraint
-- indexes (crawl_id, position), which together serve every read this phase
-- makes: "the stops of this crawl, in order". Nothing reads the other
-- direction — "which crawls include this show" is a Phase 2 question — so no
-- index on exhibition_id is created here. Add one with the feature that needs it.

COMMENT ON TABLE public.crawl_stops IS
  'The ordered stops of one crawl. position runs 1..n with no gaps, which is true because set_crawl_stops() generates it and there is no other way in — there are no row-level write grants. A show appears at most once per crawl (primary key) and a slot holds at most one show (crawl_stops_one_per_slot).';
COMMENT ON COLUMN public.crawl_stops.position IS
  '1-based and gap-free. Never supplied by a caller: set_crawl_stops() derives it from the order of the array it is given, which is why reordering is sending the same ids differently arranged.';
COMMENT ON COLUMN public.crawl_stops.created_at IS
  'When this stop was ADDED to the crawl — carried across reorders by set_crawl_stops(), not restamped. A reorder rewrites every row, so without that snapshot this column would silently become "when the list was last touched".';

-- ---------------------------------------------------------------------------
-- 3. updated_at on the crawl, and only from the database.
--
-- public.set_updated_at() is migration_v40's, already used by profiles and the
-- log tables. The column is withheld from the write grants in section 5 for
-- the usual reason: a client-supplied timestamp can be backdated, and crawls
-- are listed most-recently-touched first.
--
-- Changing the STOPS also touches the crawl — section 6 does it explicitly —
-- so "last edited" means what somebody would expect rather than "last renamed".
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS crawls_updated_at ON public.crawls;
CREATE TRIGGER crawls_updated_at
  BEFORE UPDATE ON public.crawls
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. A stop must be a PUBLISHED exhibition.
--
-- Identical in shape and reasoning to migration_v62 section 3, and worth
-- repeating rather than sharing because the two tables may diverge: the
-- foreign key proves the id exists and says nothing about whether the row is
-- one the public was ever shown. Pending rows are unreviewed scraper output
-- (v26), and a signed-in caller can name any uuid it likes — so without this,
-- guessing a pending id and putting it in a crawl would confirm both that the
-- id is real and that the show exists, ahead of any editorial decision.
--
-- SECURITY DEFINER because `authenticated` has NO read policy on exhibitions
-- at all: v26 granted published rows to `anon` only. Without the elevation
-- this trigger would find no row for anybody and refuse every legitimate stop.
--
-- This fires inside set_crawl_stops() even though that function is itself
-- SECURITY DEFINER — elevation raises the privilege, not the rules.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crawl_stops_require_published()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  show_status text;
BEGIN
  SELECT status INTO show_status
    FROM public.exhibitions
   WHERE id = NEW.exhibition_id;

  -- Both cases answer identically on purpose: "no such show" and "not
  -- published yet" are different facts, and telling them apart is the
  -- disclosure this trigger exists to prevent.
  IF show_status IS DISTINCT FROM 'published' THEN
    RAISE EXCEPTION 'no_such_exhibition'
      USING HINT = 'That exhibition cannot be added to a crawl.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS crawl_stops_published_only ON public.crawl_stops;
CREATE TRIGGER crawl_stops_published_only
  BEFORE INSERT OR UPDATE OF exhibition_id ON public.crawl_stops
  FOR EACH ROW EXECUTE FUNCTION public.crawl_stops_require_published();

-- ---------------------------------------------------------------------------
-- 5. RLS and grants.
--
-- v26 left this database deny-by-default, so a new table arrives with no
-- privileges and has to be handed back explicitly even where a policy already
-- does the filtering.
--
-- CRAWLS take ordinary per-row write grants, the way exhibition_logs does. A
-- crawl row is a complete statement on its own — its CHECKs only ever look at
-- that one row — so a row is the honest unit of write, and creating, renaming
-- and deleting go straight to PostgREST under RLS.
--
-- CRAWL_STOPS take SELECT ONLY, the way top_four_exhibitions does, because
-- their invariants are about the LIST. See the header. This asymmetry inside
-- one migration is the point: the grant follows the invariant.
--
-- No anon policy on either table: a signed-out visitor has no crawls and, in
-- this phase, may not see anybody else's.
-- ---------------------------------------------------------------------------
ALTER TABLE public.crawls      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crawl_stops ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crawls_read_own   ON public.crawls;
DROP POLICY IF EXISTS crawls_insert_own ON public.crawls;
DROP POLICY IF EXISTS crawls_update_own ON public.crawls;
DROP POLICY IF EXISTS crawls_delete_own ON public.crawls;

CREATE POLICY crawls_read_own ON public.crawls
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY crawls_insert_own ON public.crawls
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

-- USING and WITH CHECK both, and they answer different questions: USING picks
-- which rows may be updated, WITH CHECK decides what they may become. Without
-- the second, somebody could rename their own crawl and hand it to another
-- account in the same statement by rewriting user_id.
CREATE POLICY crawls_update_own ON public.crawls
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY crawls_delete_own ON public.crawls
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- The stops of a crawl are readable by whoever may read the crawl. Expressed
-- as a lookup rather than a duplicated user_id column: a denormalised owner on
-- crawl_stops would be a second copy of the answer, and the two copies would
-- eventually disagree after some future transfer or merge.
DROP POLICY IF EXISTS crawl_stops_read_own ON public.crawl_stops;

CREATE POLICY crawl_stops_read_own ON public.crawl_stops
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.crawls c
     WHERE c.id = crawl_stops.crawl_id
       AND c.user_id = (SELECT auth.uid())
  ));

-- THERE ARE NO WRITE POLICIES ON crawl_stops AND NO WRITE GRANTS BELOW. That
-- is the design, not an omission — section 6 is the only way in.

GRANT SELECT (id, user_id, title, status, created_at, updated_at)
  ON public.crawls TO authenticated;

-- created_at and updated_at are readable but NOT writable: both are the
-- database's account of when something happened, and a caller that can set
-- them can lie about it.
GRANT INSERT (user_id, title, status) ON public.crawls TO authenticated;

-- user_id is NOT in the UPDATE list. Unlike exhibition_logs there is no upsert
-- here — a crawl is created once and edited by id — so the key column can be
-- withheld outright rather than defended by the policy alone. Two locks.
GRANT UPDATE (title, status) ON public.crawls TO authenticated;

GRANT DELETE ON public.crawls TO authenticated;

GRANT SELECT (crawl_id, exhibition_id, position, created_at)
  ON public.crawl_stops TO authenticated;

GRANT ALL ON public.crawls      TO service_role;
GRANT ALL ON public.crawl_stops TO service_role;

-- ---------------------------------------------------------------------------
-- 6. Set the whole list of stops.
--
-- Takes the stops IN ORDER: the first id is stop 1, the second stop 2, and so
-- on. An empty array empties the crawl. There is no add(), no remove() and no
-- move() — each of those is this function called with a different list, which
-- is why a reorder cannot half-happen and why positions cannot develop a gap.
--
-- SECURITY DEFINER, and it takes a crawl id because a person has many crawls —
-- but it NEVER takes a user_id. Ownership is read from auth.uid() and checked
-- against the crawl before anything is written, so there is no argument
-- anybody could point at somebody else's route. That is the whole of the
-- authorisation story, and it is what makes the elevation safe: this function
-- can write these tables, and only ever into a crawl the caller owns.
--
-- THE MISSING CRAWL AND THE SOMEBODY-ELSE'S CRAWL GET THE SAME ANSWER, for the
-- reason section 4 gives: distinguishing them would confirm that a given id
-- names a real crawl belonging to someone.
--
-- ORDER OF OPERATIONS, each step there for a reason:
--   1. validate   length, nulls and duplicates. Before anything is written, so
--                 a bad list changes nothing.
--   2. snapshot   the created_at of stops already in the crawl, keyed by
--                 exhibition, so a reorder does not restamp them.
--   3. delete     every stop at once. This is what makes the constraints
--                 unfightable: no slot is occupied when the new order is laid
--                 down, so a swap, a rotation and a replacement are all the
--                 same operation.
--   4. insert     the new order, carrying the old dates where a stop stayed.
--   5. touch      the crawl, so "last edited" counts stop changes.
--
-- It is one function body and therefore one transaction. A failure at step 4 —
-- a show that has since been unpublished, say — rolls back the delete at step
-- 3, so a refused write leaves the crawl exactly as it was rather than
-- emptying it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_crawl_stops(
  p_crawl_id        uuid,
  p_exhibition_ids  uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  me    uuid   := (SELECT auth.uid());
  ids   uuid[] := coalesce(p_exhibition_ids, ARRAY[]::uuid[]);
  n     integer := coalesce(array_length(ids, 1), 0);
  prior jsonb;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'not_signed_in'
      USING HINT = 'Sign in to edit a crawl.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.crawls c
     WHERE c.id = p_crawl_id AND c.user_id = me
  ) THEN
    RAISE EXCEPTION 'crawl_not_found'
      USING HINT = 'That crawl does not exist, or is not yours.';
  END IF;

  -- The ceiling is a CHECK on position as well, but a list of thirty arriving
  -- here should be refused by name rather than as a constraint violation on
  -- the twenty-sixth row. It is not an arbitrary number: every extra stop is
  -- another walking-directions request when the route is drawn, and twenty-five
  -- is also Mapbox's own waypoint ceiling for a single Directions call.
  IF n > 25 THEN
    RAISE EXCEPTION 'crawl_too_many_stops'
      USING HINT = 'A crawl holds twenty-five stops at most.';
  END IF;

  -- A NULL in the middle of the array would become a NOT NULL violation three
  -- statements later, by which point the stops have already been deleted and
  -- the error names a column instead of the mistake.
  IF EXISTS (SELECT 1 FROM unnest(ids) AS u(id) WHERE u.id IS NULL) THEN
    RAISE EXCEPTION 'crawl_bad_input'
      USING HINT = 'That list of stops has an empty slot in the middle of it.';
  END IF;

  -- The primary key would catch this, but as a 23505 naming an index. The same
  -- show twice is an ordinary thing for a UI to get wrong, so it gets its own
  -- answer.
  IF n <> (SELECT count(DISTINCT u.id) FROM unnest(ids) AS u(id)) THEN
    RAISE EXCEPTION 'crawl_duplicate_stop'
      USING HINT = 'A show cannot be two stops on the same crawl.';
  END IF;

  -- Step 2: what is already there, so a move keeps the date it was added.
  -- jsonb rather than a temp table because a temp table inside a SECURITY
  -- DEFINER function is a shared name waiting to collide.
  SELECT coalesce(jsonb_object_agg(s.exhibition_id::text, s.created_at), '{}'::jsonb)
    INTO prior
    FROM public.crawl_stops s
   WHERE s.crawl_id = p_crawl_id;

  -- Step 3: vacate every slot.
  DELETE FROM public.crawl_stops s WHERE s.crawl_id = p_crawl_id;

  -- Step 4: lay the new order down. WITH ORDINALITY IS the position — the
  -- array's order is the route, which is what makes reordering a matter of
  -- sending the same ids differently arranged, and what makes 1..n gap-free
  -- by construction rather than by hope.
  INSERT INTO public.crawl_stops (crawl_id, exhibition_id, position, created_at)
  SELECT
    p_crawl_id,
    x.id,
    x.ord::smallint,
    coalesce((prior ->> x.id::text)::timestamptz, now())
  FROM unnest(ids) WITH ORDINALITY AS x(id, ord);

  -- Step 5: the crawl was edited. The trigger in section 3 writes the clock.
  UPDATE public.crawls c SET updated_at = now() WHERE c.id = p_crawl_id;
END;
$$;

COMMENT ON FUNCTION public.set_crawl_stops(uuid, uuid[]) IS
  'Replace a crawl''s stops with this list, in order: element 1 is stop 1. An empty array clears them. Always a crawl the CALLER owns — ownership comes from auth.uid() and there is no user_id argument. Every id must be a published exhibition or the whole write is refused. Reordering is this function with the same ids rearranged, which is why no two-step swap can violate the one-show-per-slot constraint and why positions are always 1..n with no gaps.';

GRANT EXECUTE ON FUNCTION public.set_crawl_stops(uuid, uuid[]) TO authenticated;

COMMIT;
