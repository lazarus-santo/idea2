-- migration_v49: put the block helpers where PostgREST cannot reach them
--
-- HOW TO APPLY: paste into the Supabase SQL editor as role `postgres`
-- (dashboard/project/sgkycnecmdxvujybsuev/sql/new). Safe to re-run.
--
-- APPLY THIS EVEN IF v48 LOOKS FINE. It is a security fix to v48, not an
-- addition, and until it runs the two helper functions below answer questions
-- over the REST API that nobody should be able to ask.
--
-- ---------------------------------------------------------------------------
-- WHAT WENT WRONG
--
-- v48 tried to keep public.block_between(a, b) unreachable with grants:
--
--   REVOKE EXECUTE ON FUNCTION public.block_between(uuid, uuid) FROM PUBLIC;
--   REVOKE EXECUTE ON FUNCTION public.block_between(uuid, uuid) FROM anon, authenticated;
--
-- Probed against production after v48 was applied, with the anon key and no
-- session at all:
--
--   POST /rest/v1/rpc/block_between {"a": "<uuid>", "b": "<uuid>"}   -> false
--   POST /rest/v1/rpc/is_blocked    {"other": "<uuid>"}              -> false
--
-- Both answered. A signed-out caller holding the anon key — which ships in
-- every browser — could ask whether ANY TWO accounts had blocked each other.
-- That is the third-party disclosure the build was explicitly not allowed to
-- create: nobody may see who someone has blocked but the person who blocked
-- them.
--
-- WHY THE REVOKE DID NOT HOLD IS NOT ESTABLISHED. The likeliest explanation is
-- that the copy of v48 applied predates the revoke being added to it, and the
-- second is that something re-grants EXECUTE on functions in `public` after
-- the DDL. It does not matter which, and that is the point of this migration:
--
--   A GRANT IS THE WRONG TOOL FOR THIS. Every function in an exposed schema is
--   an HTTP endpoint by default, and keeping one private then depends on a
--   revoke that has to be right, stay right, and survive the next person who
--   runs CREATE OR REPLACE without it. A function in a schema PostgREST does
--   not serve has no endpoint to revoke.
--
-- Supabase exposes `public` and `graphql_public`. Everything else is invisible
-- over REST whatever its privileges, so moving these two into `private` is
-- enforced by routing rather than by permission, and a later edit that forgets
-- the revoke cannot undo it.
--
-- ---------------------------------------------------------------------------
-- A CORRECTION TO WHAT v48's HEADER CLAIMS
--
-- v48 argued at length that granting is_blocked(other) to `authenticated` was
-- an acceptable price, because a blocked person who kept your id could use it
-- to tell "they blocked me" from "they deleted their account" — a distinction
-- every other surface deliberately conflates. That reasoning is now moot:
-- is_blocked moves too, and after this migration there is no REST call that
-- answers the question at all. The RLS policy still calls it, from inside the
-- database, where the caller has no say in the argument.
--
-- Nothing about the BEHAVIOUR of blocking, muting, unfollowing or removing a
-- follower changes here. The bodies below are v48's, verbatim, with
-- public.block_between renamed to private.block_between.
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. A schema PostgREST does not serve.
--
-- REVOKE FROM PUBLIC first: a new schema grants nothing to PUBLIC by default,
-- but saying so makes the intent survive a copy-paste into a database
-- configured differently.
--
-- `authenticated` gets USAGE because section 4's policy on public.profiles
-- calls private.is_blocked(), and a policy expression runs as the querying
-- user — a role that cannot reach the function cannot read the table. USAGE on
-- the schema is not exposure: PostgREST serves the schemas it is configured
-- with, and this is not one of them.
--
-- `anon` gets nothing. A signed-out visitor is nobody, has blocked no one and
-- can be blocked by no one, so the anon half of the profiles policy never asks.
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS private;

COMMENT ON SCHEMA private IS
  'Helpers that must run inside the database but must never be callable over the REST API. PostgREST serves public and graphql_public only, so nothing here has an HTTP endpoint regardless of its grants. Put a function here when the wrong caller asking it directly would disclose something — see private.block_between.';

REVOKE ALL ON SCHEMA private FROM PUBLIC;
GRANT USAGE ON SCHEMA private TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. The two helpers, moved.
--
-- Bodies unchanged from v48 section 2. SECURITY DEFINER for the same reason as
-- before: the whole point is to see a block from the side that is not allowed
-- to read it, because a caller may read only the blocks they made and the
-- checks have to consider the ones made against them too.
--
-- block_between gets no grant at all. It is called only from SECURITY DEFINER
-- functions owned by postgres, which execute it as their owner, so no role
-- needs the privilege — and now no role could use it if it had it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.block_between(a uuid, b uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.blocks bl
     WHERE (bl.blocker_id = a AND bl.blocked_id = b)
        OR (bl.blocker_id = b AND bl.blocked_id = a)
  );
$$;

COMMENT ON FUNCTION private.block_between(uuid, uuid) IS
  'Is there a block between these two profiles, in either direction? Order-independent, false when either argument is NULL. Lives in `private` because it answers about ANY two accounts: exposed over REST it would let anyone ask who has blocked whom. Called only from the SECURITY DEFINER functions in public that enforce blocks.';

CREATE OR REPLACE FUNCTION private.is_blocked(other uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT private.block_between((SELECT auth.uid()), other);
$$;

COMMENT ON FUNCTION private.is_blocked(uuid) IS
  'Are the caller and this profile invisible to each other? Called from the read policy on public.profiles, which is why `authenticated` may execute it. Lives in `private` so that it is reachable from a policy and from nowhere a browser can address: asked directly it would tell a blocked person they had been blocked, which nothing else in the schema will confirm.';

REVOKE ALL ON FUNCTION private.block_between(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.is_blocked(uuid)          FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.is_blocked(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Every caller repointed.
--
-- These four are v48's bodies with one identifier changed each. They are
-- re-issued in full rather than patched because a function body is text: there
-- is no ALTER that edits one, and reprinting it is the only way to be sure
-- what is in the database.
--
-- CREATE OR REPLACE keeps the existing privileges on each, so the grants v44,
-- v45 and v47 made still stand and are not restated here.
--
-- private.block_between is written out in full at every call site. The
-- `SET search_path = public, pg_temp` on these functions deliberately does NOT
-- include private: an unqualified name should fail loudly rather than resolve
-- to whatever a future search_path happens to contain.
-- ---------------------------------------------------------------------------

-- 3a. A block refuses a new follow, silently. (v48 section 4)
CREATE OR REPLACE FUNCTION public.follows_set_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  target_privacy text;
BEGIN
  -- Block first, privacy second. RETURN NULL drops the row without raising:
  -- an exception would be an announcement, and this is a backstop reached only
  -- by a stale tab or a hand-written request, since a blocked person has no
  -- profile page to press Follow on.
  IF private.block_between(NEW.follower_id, NEW.followed_id) THEN
    RETURN NULL;
  END IF;

  SELECT privacy INTO target_privacy
    FROM public.profiles
   WHERE id = NEW.followed_id;

  IF target_privacy IS NULL THEN
    RAISE EXCEPTION 'no_such_profile'
      USING HINT = 'That account does not exist.';
  END IF;

  -- Anything that is not 'public' is treated as private. If a privacy value is
  -- ever added that this function has not been taught, the safe reading is the
  -- one that asks permission.
  NEW.status := CASE WHEN target_privacy = 'public' THEN 'approved' ELSE 'pending' END;
  RETURN NEW;
END;
$$;

-- 3b. May the caller see what is ON this profile? (v48 section 6d)
CREATE OR REPLACE FUNCTION public.can_view_profile(target uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT NOT private.block_between((SELECT auth.uid()), target)
     AND EXISTS (
    SELECT 1
      FROM public.profiles p
     WHERE p.id = target
       AND (
         p.privacy = 'public'
         OR p.id = (SELECT auth.uid())
         OR EXISTS (
           SELECT 1 FROM public.follows f
            WHERE f.followed_id = target
              AND f.follower_id = (SELECT auth.uid())
              AND f.status = 'approved'
         )
       )
  );
$$;

-- 3c. Counts, zeroed across a block. (v48 section 6e)
CREATE OR REPLACE FUNCTION public.follow_counts(profile_id uuid)
RETURNS TABLE (followers integer, following integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    CASE WHEN private.block_between((SELECT auth.uid()), profile_id) THEN 0 ELSE
      (SELECT count(*)::int FROM public.follows
        WHERE followed_id = profile_id AND status = 'approved') END,
    CASE WHEN private.block_between((SELECT auth.uid()), profile_id) THEN 0 ELSE
      (SELECT count(*)::int FROM public.follows
        WHERE follower_id = profile_id AND status = 'approved') END;
$$;

-- 3d. The approval inbox. (v48 section 6g)
CREATE OR REPLACE FUNCTION public.pending_follow_requests()
RETURNS TABLE (id uuid, username text, display_name text, avatar_url text, requested_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p.id, p.username, p.display_name, p.avatar_url, f.created_at
    FROM public.follows f
    JOIN public.profiles p ON p.id = f.follower_id
   WHERE f.followed_id = (SELECT auth.uid())
     AND f.status = 'pending'
     AND p.username IS NOT NULL
     AND NOT private.block_between((SELECT auth.uid()), p.id)
   ORDER BY f.created_at DESC;
$$;

-- ---------------------------------------------------------------------------
-- 4. The profiles read policy, repointed.
--
-- A policy records a dependency on the function it names, so this has to be
-- rewritten BEFORE section 5 can drop the old one.
--
-- Unchanged in meaning from v48 section 6a: block first, then the three ways
-- a row may be read. private.is_blocked() reads ONLY public.blocks — it must
-- never read public.profiles, or invoking it from this policy would recurse.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS profiles_auth_read_visible ON public.profiles;

CREATE POLICY profiles_auth_read_visible ON public.profiles
  FOR SELECT TO authenticated
  USING (
    NOT private.is_blocked(id)
    AND (
      privacy = 'public'
      OR id = (SELECT auth.uid())
      OR public.is_approved_follower(id)
    )
  );

-- ---------------------------------------------------------------------------
-- 5. And the endpoints go away.
--
-- This is the line that actually closes the hole. Everything above is
-- preparation so that dropping these breaks nothing.
--
-- Postgres does not track dependencies between function BODIES, so if some
-- caller has been missed, the DROP still succeeds and that caller fails at run
-- time instead. The VERIFY block at the bottom exercises every one of them for
-- that reason.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.is_blocked(uuid);
DROP FUNCTION IF EXISTS public.block_between(uuid, uuid);

COMMIT;

-- PostgREST caches the schema, including which functions it will route to.
NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- VERIFY
--
-- 1. The endpoints are gone. With the ANON key and no session:
--      POST /rest/v1/rpc/block_between {"a":"<uuid>","b":"<uuid>"}
--      POST /rest/v1/rpc/is_blocked    {"other":"<uuid>"}
--      -- expect PGRST202 for both: no such function. Before this migration
--      -- they returned `false`, which is how the hole was found.
--
-- 2. Nothing else moved. scripts/test-relationships.mjs covers every caller
--    repointed above — the follow trigger, the counts, the inbox, the profile
--    policy — and should report the same passes as it did on v48, plus the
--    third-party probe that failed there:
--      node --env-file=.env.local scripts/test-relationships.mjs
--
-- 3. The profiles policy still works at all, which is the one thing that would
--    break loudly if section 2's grant were wrong. As any signed-in account:
--      GET /rest/v1/profiles?select=id,username&limit=1
--      -- expect a row, not 42501 on schema private
-- ---------------------------------------------------------------------------
