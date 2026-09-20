-- migration_v65: adding and removing ONE Top Four item
--
-- HOW TO APPLY: paste into the Supabase SQL editor as role `postgres`
-- (dashboard/project/sgkycnecmdxvujybsuev/sql/new). There is no psql, no
-- Supabase CLI and no DATABASE_URL in this project. Safe to re-run.
--
-- REQUIRES migration_v64, which must already be applied. The guard below
-- refuses to run otherwise rather than half-installing — see PRECONDITION.
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS A MIGRATION OF ITS OWN
--
-- These four functions were first written INTO v64, which was a mistake worth
-- recording because it cost a failed test run to find.
--
-- v64 had already been applied to production. An applied migration is a
-- historical fact — it is the record of what was done to the database and
-- when — so editing it afterwards produces a file that no longer describes any
-- event. Worse, it produces two different files with the same name: the one
-- that ran, and the one on disk. Anyone re-reading the repo would believe
-- production had functions it did not have, which is exactly what happened:
-- the app shipped calls to add_to_top_four_exhibition() while the database had
-- never heard of it.
--
-- So migrations here are append-only. A change to an applied migration is a
-- new migration, whatever it is, and the number going up is how the database
-- and the repo stay in step.
--
-- ---------------------------------------------------------------------------
-- WHAT THESE ARE, AND WHY THEY ARE NOT A SECOND WRITE PATH
--
-- v64 made the LIST the unit of write: top_four_exhibitions and
-- top_four_content take no INSERT, UPDATE or DELETE grants at all, and the
-- only way in is set_top_four_exhibitions() / set_top_four_content(), which
-- empty the list and lay a new order down inside one transaction. That is what
-- makes a reorder safe — the one-per-slot constraint is precisely what a
-- two-step swap violates in the middle, and sending the finished list means
-- there is no middle.
--
-- It is also a poor thing to make a person live by. The commonest action is
-- adding the show they are already looking at, and requiring them to restate
-- the other three slots to do it is making them keep the books.
--
-- So each function below is a WRAPPER. It reads the caller's current list,
-- applies its single change, and hands the finished list to v64's function to
-- write. NOT ONE OF THEM TOUCHES A TABLE DIRECTLY.
--
-- That is the entire point. The atomic delete-then-place, the one-transaction
-- rollback, the eligibility triggers, the size and duplicate rules — none of
-- it is reimplemented here, so none of it can drift. A per-item add is still a
-- whole-list write; the caller simply no longer composes the list. The
-- guarantee is preserved by construction rather than by care, and v64 needed
-- no change to allow it, which is the test of whether the seam was in the
-- right place.
--
-- ---------------------------------------------------------------------------
-- THEY COMPACT THE SLOTS, AND v64'S DOWNGRADE TRIGGER DOES NOT
--
-- Because the new list is rebuilt in order, these renumber from 1 with no
-- gaps. v64 section 4's trigger, by contrast, is a bare DELETE and leaves a
-- hole — a list at 1,2,3,4 that loses its second item sits at 1,3,4.
--
-- Both are correct, and the difference is invisible: what the profile draws is
-- the ORDER of the rows, numbering them as it goes, so a gap is never seen.
-- The trigger stays a plain DELETE because it fires inside somebody else's
-- write — a downgrade — and must be as close to free as possible; the hole it
-- leaves is healed by the next edit of the list.
--
-- ---------------------------------------------------------------------------
-- FULL MEANS REFUSED, NOT BUMPED
--
-- Adding a fifth raises. The alternative — quietly dropping whatever is in
-- slot 4 to make room — would throw away a choice the person made without
-- asking, and a Top Four is nothing but choices. They are told to make room.
--
-- The full check runs BEFORE the eligibility trigger has a chance to speak, so
-- adding an unlogged show to a full list reports the list as full rather than
-- the show as ineligible. That ordering only matters in a race, because the UI
-- offers the action on logged items alone, and "make room first" is still the
-- true and actionable half of the answer.
--
-- ---------------------------------------------------------------------------
-- ADDING TWICE, OR REMOVING WHAT IS NOT THERE, DOES NOTHING
--
-- Both are silent no-ops rather than errors. A double-clicked button and a
-- stale tab are ordinary, and neither describes a state the person needs to
-- act on — the item is in the list, or it is not, which is what they wanted
-- either way. Without this, v64's duplicate rule would turn a second click
-- into an error about a mistake nobody made.
--
-- ---------------------------------------------------------------------------
-- WHAT IS NOT HERE
--
-- Nothing in v64 changes: not the tables, not the eligibility foreign key, not
-- the status triggers, not the downgrade triggers, not the read functions, not
-- the grants. This file only adds. No feed event type, no notifications,
-- nothing in Agent 1, 2, 3 or 4.
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- PRECONDITION.
--
-- Everything below calls v64's functions, so without them this file would
-- install four wrappers around nothing — they would create cleanly and fail at
-- the first click, which is the worst possible time to find out.
--
-- This is the direct lesson of how v65 came to exist. The app was deployed
-- believing functions were present that were not, and the failure surfaced as
-- 35 red assertions rather than as anything that named the cause. A migration
-- that depends on another should say so in a way that stops, not in a comment.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regproc('public.set_top_four_exhibitions') IS NULL
     OR to_regproc('public.set_top_four_content') IS NULL THEN
    RAISE EXCEPTION 'migration_v64 is not applied'
      USING HINT = 'Apply supabase/migration_v64.sql first: this file is only wrappers around its functions.';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 1. Add one show.
--
-- ORDER BY position is what makes this an append rather than a reshuffle: the
-- existing ranking is preserved exactly and the newcomer goes last.
--
-- SECURITY DEFINER and NO user_id, exactly as v64's functions: the list is
-- always the caller's, read from auth.uid() and never from an argument, so
-- there is no parameter anybody could point at somebody else's profile.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.add_to_top_four_exhibition(p_exhibition_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  me          uuid := (SELECT auth.uid());
  current_ids uuid[];
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'not_signed_in'
      USING HINT = 'Sign in to change your Top Four.';
  END IF;

  IF p_exhibition_id IS NULL THEN
    RAISE EXCEPTION 'top_four_bad_input'
      USING HINT = 'No show was given to add.';
  END IF;

  SELECT coalesce(array_agg(t.exhibition_id ORDER BY t.position), ARRAY[]::uuid[])
    INTO current_ids
    FROM public.top_four_exhibitions t
   WHERE t.user_id = me;

  -- Already there: nothing to do, and nothing to complain about.
  IF p_exhibition_id = ANY (current_ids) THEN
    RETURN;
  END IF;

  -- array_length is NULL on an empty array, and NULL >= 4 is not true, so an
  -- empty list falls through correctly without a special case.
  IF array_length(current_ids, 1) >= 4 THEN
    RAISE EXCEPTION 'top_four_full'
      USING HINT = 'Your Top Four is full. Remove one to add another.';
  END IF;

  PERFORM public.set_top_four_exhibitions(current_ids || p_exhibition_id);
END;
$$;

COMMENT ON FUNCTION public.add_to_top_four_exhibition(uuid) IS
  'Append one show to the end of the caller''s exhibition Top Four. A wrapper around set_top_four_exhibitions() (migration_v64) — it composes the new list and that function writes it, so the atomic whole-list replace and every rule it enforces are unchanged. Raises top_four_full at four rather than bumping anything. Adding something already in the list does nothing.';

-- ---------------------------------------------------------------------------
-- 2. Remove one show.
--
-- NOT the same as un-logging it. This says "it is not one of my four";
-- un-logging says "I never saw it", and that removes it from here as well,
-- through v64's foreign key.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.remove_from_top_four_exhibition(p_exhibition_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  me          uuid := (SELECT auth.uid());
  current_ids uuid[];
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'not_signed_in'
      USING HINT = 'Sign in to change your Top Four.';
  END IF;

  SELECT coalesce(array_agg(t.exhibition_id ORDER BY t.position), ARRAY[]::uuid[])
    INTO current_ids
    FROM public.top_four_exhibitions t
   WHERE t.user_id = me;

  -- Not there: nothing to do. See the header.
  IF NOT (p_exhibition_id = ANY (current_ids)) THEN
    RETURN;
  END IF;

  -- array_remove takes every match; the primary key guarantees there is one.
  -- The survivors keep their relative order and are renumbered from 1, so
  -- removing the second of four leaves 1, 2, 3.
  PERFORM public.set_top_four_exhibitions(array_remove(current_ids, p_exhibition_id));
END;
$$;

COMMENT ON FUNCTION public.remove_from_top_four_exhibition(uuid) IS
  'Take one show out of the caller''s exhibition Top Four, closing the gap. A wrapper around set_top_four_exhibitions() (migration_v64). Removing something that is not in the list does nothing. This is NOT the same as un-logging the show, which removes it from here too, through the foreign key.';

-- ---------------------------------------------------------------------------
-- 3. Add one article.
--
-- The pair, never the id alone: prereads and readings have independent id
-- spaces, which is why v64's key is (content_type, content_id) and why the
-- containment test below is built on both halves.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.add_to_top_four_content(
  p_content_type text,
  p_content_id   uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  me            uuid := (SELECT auth.uid());
  current_items jsonb;
  entry         jsonb;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'not_signed_in'
      USING HINT = 'Sign in to change your Top Four.';
  END IF;

  IF p_content_type IS NULL OR p_content_id IS NULL THEN
    RAISE EXCEPTION 'top_four_bad_input'
      USING HINT = 'An article needs both a type and an id.';
  END IF;

  entry := jsonb_build_object('type', p_content_type, 'id', p_content_id);

  SELECT coalesce(
           jsonb_agg(jsonb_build_object('type', t.content_type, 'id', t.content_id)
                     ORDER BY t.position),
           '[]'::jsonb
         )
    INTO current_items
    FROM public.top_four_content t
   WHERE t.user_id = me;

  -- Containment on the PAIR. Both sides are built the same way, so the uuid is
  -- rendered canonically on both and a caller's odd casing cannot miss.
  IF current_items @> jsonb_build_array(entry) THEN
    RETURN;
  END IF;

  IF jsonb_array_length(current_items) >= 4 THEN
    RAISE EXCEPTION 'top_four_full'
      USING HINT = 'Your Top Four is full. Remove one to add another.';
  END IF;

  PERFORM public.set_top_four_content(current_items || jsonb_build_array(entry));
END;
$$;

COMMENT ON FUNCTION public.add_to_top_four_content(text, uuid) IS
  'Append one article to the end of the caller''s article Top Four. A wrapper around set_top_four_content() (migration_v64), so the atomic whole-list replace and every rule it enforces are unchanged. Raises top_four_full at four. Adding something already in the list does nothing.';

-- ---------------------------------------------------------------------------
-- 4. Remove one article.
--
-- Built already filtered, in slot order, so there is no membership test to
-- make first: removing something that is not in the list rewrites the same
-- list, which is the same no-op by a shorter route. created_at survives it,
-- because v64's function carries the old dates back over the replace.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.remove_from_top_four_content(
  p_content_type text,
  p_content_id   uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  me        uuid := (SELECT auth.uid());
  remaining jsonb;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'not_signed_in'
      USING HINT = 'Sign in to change your Top Four.';
  END IF;

  SELECT coalesce(
           jsonb_agg(jsonb_build_object('type', t.content_type, 'id', t.content_id)
                     ORDER BY t.position),
           '[]'::jsonb
         )
    INTO remaining
    FROM public.top_four_content t
   WHERE t.user_id = me
     AND NOT (t.content_type = p_content_type AND t.content_id = p_content_id);

  PERFORM public.set_top_four_content(remaining);
END;
$$;

COMMENT ON FUNCTION public.remove_from_top_four_content(text, uuid) IS
  'Take one article out of the caller''s article Top Four, closing the gap. A wrapper around set_top_four_content() (migration_v64). Removing something that is not in the list rewrites the same list and changes nothing. This is NOT the same as un-logging the article, which removes it from here too, through the foreign key.';

-- ---------------------------------------------------------------------------
-- 5. Grants.
--
-- EXECUTE goes to PUBLIC by default, which on a SECURITY DEFINER function is
-- worth undoing explicitly rather than relying on the auth.uid() check to turn
-- anon away at the door. `anon` is not granted: a signed-out visitor has no
-- Top Four to change, and the refusal should be "you cannot call this" rather
-- than an exception raised from inside it.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.add_to_top_four_exhibition(uuid)            FROM PUBLIC;
REVOKE ALL ON FUNCTION public.remove_from_top_four_exhibition(uuid)       FROM PUBLIC;
REVOKE ALL ON FUNCTION public.add_to_top_four_content(text, uuid)         FROM PUBLIC;
REVOKE ALL ON FUNCTION public.remove_from_top_four_content(text, uuid)    FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.add_to_top_four_exhibition(uuid)         TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_from_top_four_exhibition(uuid)    TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_to_top_four_content(text, uuid)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_from_top_four_content(text, uuid) TO authenticated;

COMMIT;

-- PostgREST caches the schema; new functions are invisible over the REST API
-- until it reloads. Supabase normally fires this itself on DDL — and when it
-- does not, the symptom is precisely "Could not find the function ... in the
-- schema cache", which is what the app saw before this file existed.
NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- DID IT LAND? Every column should say true.
--
-- `all_four_exist` is the one that matters, and the one whose absence started
-- this file. `callable_by_authenticated` is the other half: a function that
-- exists but was never granted fails at the first click rather than here.
-- ---------------------------------------------------------------------------
SELECT
  to_regproc('public.add_to_top_four_exhibition') IS NOT NULL      AS add_exhibition_exists,
  to_regproc('public.remove_from_top_four_exhibition') IS NOT NULL AS remove_exhibition_exists,
  to_regproc('public.add_to_top_four_content') IS NOT NULL         AS add_content_exists,
  to_regproc('public.remove_from_top_four_content') IS NOT NULL    AS remove_content_exists,
  (SELECT count(*) = 4
     FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname IN ('add_to_top_four_exhibition', 'remove_from_top_four_exhibition',
                      'add_to_top_four_content', 'remove_from_top_four_content'))
                                                                   AS all_four_exist,
  (SELECT count(*) = 4
     FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('add_to_top_four_exhibition', 'remove_from_top_four_exhibition',
                        'add_to_top_four_content', 'remove_from_top_four_content')
      AND has_function_privilege('authenticated', p.oid, 'EXECUTE'))
                                                                   AS callable_by_authenticated,
  -- v64 is untouched by this file, and this says so out loud: the tables must
  -- still take no direct writes, because that is what makes the wrappers above
  -- the only way in.
  (SELECT count(*) = 0
     FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name IN ('top_four_exhibitions', 'top_four_content')
      AND grantee = 'authenticated'
      AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE'))        AS v64_write_grants_still_absent;

-- ---------------------------------------------------------------------------
-- VERIFY
--
-- scripts/test-top-four.mjs covers v64 AND this file — sections 1-9 drive the
-- whole-list functions, sections 10 and 11 drive these four. Run it after
-- applying:
--
--   node --env-file=.env.local --import ./scripts/ts-resolve.mjs \
--     scripts/test-top-four.mjs
--
-- It must be a script and not a query in this editor, because the editor runs
-- as postgres and bypasses every policy and grant involved — including the
-- missing write grants on the tables, which are half the design.
-- ---------------------------------------------------------------------------
