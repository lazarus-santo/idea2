-- migration_v44: the follow graph
--
-- HOW TO APPLY: paste into the Supabase SQL editor as role `postgres`
-- (dashboard/project/sgkycnecmdxvujybsuev/sql/new). There is no psql, no
-- Supabase CLI and no DATABASE_URL in this project.
--
-- ---------------------------------------------------------------------------
-- THE SHAPE, AND WHY IT IS NOT A BOOLEAN
--
-- v43 made private profiles findable and left them showing a locked state. The
-- promise that made was that privacy is a GATE: you can find a private account
-- and ASK, its owner answers, and an approved follower sees the profile in
-- full. A follow is therefore not a fact that either exists or does not — it
-- has a middle state, "asked and not yet answered", and a boolean cannot hold
-- one. So `status` is here from the first row written, not added later, because
-- adding it later means backfilling every edge in a live graph.
--
-- Following a PUBLIC profile skips the middle state and lands on 'approved'.
-- There is no one to ask.
--
-- ---------------------------------------------------------------------------
-- THE RULE THAT DRIVES THE POLICY DESIGN
--
-- Who has asked to follow a private account is private information about that
-- account — it is the list of people trying to get in. Its own owner must see
-- it; nobody else may, not even in aggregate.
--
-- That is why public.follows has NO public read policy at all. A person can
-- read only the edges they are an endpoint of. Everything a visitor legitimately
-- sees about somebody else's graph — the counts on a profile, the follower and
-- following lists — comes from SECURITY DEFINER functions further down, each
-- of which filters to `status = 'approved'` itself. A pending row is reachable
-- by exactly two people: the person who sent it and the person it was sent to.
--
-- ---------------------------------------------------------------------------
-- WHAT IS NOT HERE
--
-- No notifications: this database has no notification system of any kind, so a
-- follow request arrives silently and its owner finds it by visiting their own
-- profile. That is a real gap, deliberately left — building a notification
-- system to announce this feature would be a bigger build than the feature.
--
-- No blocking, no muting, no activity feed. The feed is the next build and
-- will read this graph; nothing here anticipates its schema.
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The table.
--
-- The PRIMARY KEY on the pair is the duplicate guard: one row per direction per
-- pair, so pressing Follow twice is a conflict rather than a second row, and
-- A→B is a different row from B→A.
--
-- The self-follow CHECK is a constraint rather than a UI rule because the UI is
-- not what writes here — the browser does, under RLS.
--
-- Foreign keys point at profiles rather than auth.users: a follow is between
-- two profiles, and profiles already cascades from auth.users, so deleting an
-- account still removes every edge it was part of, in both directions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.follows (
  follower_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  followed_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'pending',
  created_at  timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (follower_id, followed_id),
  CONSTRAINT follows_no_self_follow CHECK (follower_id <> followed_id),
  CONSTRAINT follows_status_values  CHECK (status IN ('pending', 'approved'))
);

COMMENT ON TABLE public.follows IS
  'One row per follow, per direction. status pending = requested and not yet answered (private targets only); approved = the follow is live. A denial DELETES the row rather than storing a third state, so the person may ask again later.';
COMMENT ON COLUMN public.follows.status IS
  'pending | approved. Set by the follows_status_from_privacy trigger from the TARGET profile privacy, never by the client — the INSERT grant does not include this column.';

-- The PK already indexes (follower_id, followed_id), which serves the
-- "who does this person follow" direction. The reverse direction — "who
-- follows this person", which is the follower count and the approval inbox —
-- needs its own.
CREATE INDEX IF NOT EXISTS idx_follows_followed_status
  ON public.follows(followed_id, status);

-- ---------------------------------------------------------------------------
-- 2. status is decided by the target's privacy, never by the caller.
--
-- THIS IS THE SECURITY BOUNDARY OF THE WHOLE FEATURE. Without it, anyone could
-- POST a row with status 'approved' against a private account and walk straight
-- through the gate. The column is withheld from the INSERT grant in section 5
-- as well, so a client cannot even name it; this trigger is what makes the
-- value correct rather than merely absent.
--
-- SECURITY DEFINER because the follower usually CANNOT read the target's
-- profile row — that is the whole point of a private account. Reading privacy
-- here has to happen with the function owner's privileges or every request to
-- a private profile would fail to find the row it is asking about.
--
-- BEFORE INSERT only. An UPDATE must not pass through here, or approving a
-- request would immediately reset it to pending.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.follows_set_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  target_privacy text;
BEGIN
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

DROP TRIGGER IF EXISTS follows_status_from_privacy ON public.follows;
CREATE TRIGGER follows_status_from_privacy
  BEFORE INSERT ON public.follows
  FOR EACH ROW EXECUTE FUNCTION public.follows_set_status();

-- ---------------------------------------------------------------------------
-- 3. An approved follower may read a private profile in full.
--
-- This is what "approve" actually buys. The function reads ONLY public.follows
-- — never public.profiles — which is what keeps it safe to call from the
-- profiles read policy in section 4. A helper that read profiles would be
-- invoked by that table's own policy and recurse.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_approved_follower(target uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.follows f
     WHERE f.followed_id = target
       AND f.follower_id = (SELECT auth.uid())
       AND f.status = 'approved'
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_approved_follower(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Widen the profiles read policy by exactly one clause.
--
-- v40 gave authenticated readers public rows plus their own. The third case is
-- new and is the entire payoff of the approval flow. anon is untouched: a
-- signed-out visitor has no follows, so there is nothing to widen.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS profiles_auth_read_public_and_own ON public.profiles;
DROP POLICY IF EXISTS profiles_auth_read_visible ON public.profiles;

CREATE POLICY profiles_auth_read_visible ON public.profiles
  FOR SELECT TO authenticated
  USING (
    privacy = 'public'
    OR id = (SELECT auth.uid())
    OR public.is_approved_follower(id)
  );

-- ---------------------------------------------------------------------------
-- 5. RLS on follows: you may read only the edges you are an end of.
--
-- There is deliberately no anon policy and no "approved edges are public"
-- policy. Everything a visitor sees about somebody else's graph goes through
-- the functions in section 6, which filter to approved themselves. Keeping the
-- table itself strictly first-person means a pending request cannot leak
-- through a query nobody thought to guard.
--
-- INSERT: only as yourself. The self-follow CHECK and the PK do the rest.
-- UPDATE: only the person being followed, which is what makes approve the
--   owner's decision and not the requester's. The grant narrows it to `status`,
--   so neither end of the edge can be rewritten to point somewhere else.
-- DELETE: either end. The follower deleting is an unfollow or a cancelled
--   request; the followed deleting is a denial, or removing a follower they
--   have changed their mind about.
-- ---------------------------------------------------------------------------
ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS follows_auth_read_own_edges   ON public.follows;
DROP POLICY IF EXISTS follows_auth_insert_own       ON public.follows;
DROP POLICY IF EXISTS follows_auth_update_incoming  ON public.follows;
DROP POLICY IF EXISTS follows_auth_delete_own_edges ON public.follows;

CREATE POLICY follows_auth_read_own_edges ON public.follows
  FOR SELECT TO authenticated
  USING (
    follower_id = (SELECT auth.uid())
    OR followed_id = (SELECT auth.uid())
  );

CREATE POLICY follows_auth_insert_own ON public.follows
  FOR INSERT TO authenticated
  WITH CHECK (follower_id = (SELECT auth.uid()));

CREATE POLICY follows_auth_update_incoming ON public.follows
  FOR UPDATE TO authenticated
  USING (followed_id = (SELECT auth.uid()))
  WITH CHECK (followed_id = (SELECT auth.uid()));

CREATE POLICY follows_auth_delete_own_edges ON public.follows
  FOR DELETE TO authenticated
  USING (
    follower_id = (SELECT auth.uid())
    OR followed_id = (SELECT auth.uid())
  );

-- v26 left this database deny-by-default for anon and authenticated, so a new
-- table starts with no grants and has to be handed back column by column.
--
-- status is NOT in the INSERT list on purpose: section 2's trigger owns it.
-- created_at is not either — a client-supplied timestamp would let somebody
-- backdate a request to the top of an inbox sorted by age.
GRANT SELECT (follower_id, followed_id, status, created_at)
  ON public.follows TO authenticated;
GRANT INSERT (follower_id, followed_id) ON public.follows TO authenticated;
GRANT UPDATE (status)                   ON public.follows TO authenticated;
GRANT DELETE                            ON public.follows TO authenticated;
GRANT ALL                               ON public.follows TO service_role;

-- ---------------------------------------------------------------------------
-- 6. The read surface for other people's graphs.
--
-- Every function here counts or lists ONLY approved rows. A pending request
-- must not move a count by one, because a count that ticks up the moment
-- somebody asks tells the whole internet that they asked.
-- ---------------------------------------------------------------------------

-- Counts are public for every profile, private ones included — the same
-- position Instagram takes, and the one the product asked for. Knowing that an
-- account has 40 followers reveals nothing about who they are.
CREATE OR REPLACE FUNCTION public.follow_counts(profile_id uuid)
RETURNS TABLE (followers integer, following integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    (SELECT count(*)::int FROM public.follows
      WHERE followed_id = profile_id AND status = 'approved'),
    (SELECT count(*)::int FROM public.follows
      WHERE follower_id = profile_id AND status = 'approved');
$$;

GRANT EXECUTE ON FUNCTION public.follow_counts(uuid) TO anon, authenticated;

-- May the caller see what is ON this profile?
--
-- The same question the locked state on /u/<username> answers, asked in SQL so
-- the list functions below can refuse before returning a single name.
CREATE OR REPLACE FUNCTION public.can_view_profile(target uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
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

GRANT EXECUTE ON FUNCTION public.can_view_profile(uuid) TO anon, authenticated;

-- WHO FOLLOWS THIS PROFILE, and WHO IT FOLLOWS.
--
-- Both refuse unless the caller may see the profile at all. That is a decision
-- worth naming: the COUNT on a private profile is public, but the LIST is not.
-- A follower list is contents, and v43's locked state exists to withhold
-- contents from people who have not been let in. To make these lists public
-- instead, delete the can_view_profile line from each — nothing else depends
-- on it.
--
-- Rows whose username is NULL are skipped: those accounts never finished
-- onboarding, so they have no profile page to link to.
CREATE OR REPLACE FUNCTION public.profile_followers(profile_id uuid, max_rows integer DEFAULT 200)
RETURNS TABLE (id uuid, username text, display_name text, avatar_url text, privacy text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p.id, p.username, p.display_name, p.avatar_url, p.privacy
    FROM public.follows f
    JOIN public.profiles p ON p.id = f.follower_id
   WHERE f.followed_id = profile_id
     AND f.status = 'approved'
     AND p.username IS NOT NULL
     AND public.can_view_profile(profile_id)
   ORDER BY f.created_at DESC
   LIMIT LEAST(GREATEST(max_rows, 1), 200);
$$;

CREATE OR REPLACE FUNCTION public.profile_following(profile_id uuid, max_rows integer DEFAULT 200)
RETURNS TABLE (id uuid, username text, display_name text, avatar_url text, privacy text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p.id, p.username, p.display_name, p.avatar_url, p.privacy
    FROM public.follows f
    JOIN public.profiles p ON p.id = f.followed_id
   WHERE f.follower_id = profile_id
     AND f.status = 'approved'
     AND p.username IS NOT NULL
     AND public.can_view_profile(profile_id)
   ORDER BY f.created_at DESC
   LIMIT LEAST(GREATEST(max_rows, 1), 200);
$$;

GRANT EXECUTE ON FUNCTION public.profile_followers(uuid, integer) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.profile_following(uuid, integer) TO anon, authenticated;

-- THE APPROVAL INBOX.
--
-- Takes NO ARGUMENT, on purpose. A function with a profile_id parameter can be
-- called with somebody else's id, and then the only thing standing between a
-- curious visitor and a private account's list of hopefuls is a WHERE clause
-- nobody re-reads. Keyed on auth.uid() alone, there is no id to substitute:
-- the question it answers is always "who has asked to follow ME".
--
-- The join to profiles needs SECURITY DEFINER for a reason worth spelling out:
-- a requester may themselves be private, and the owner of the account being
-- asked has no right to read that person's profile row. They do have a right
-- to see the name and face of somebody knocking on their door.
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
   ORDER BY f.created_at DESC;
$$;

REVOKE EXECUTE ON FUNCTION public.pending_follow_requests() FROM anon;
GRANT  EXECUTE ON FUNCTION public.pending_follow_requests() TO authenticated;

COMMIT;

-- PostgREST caches the schema; new tables and functions are invisible over the
-- REST API until it reloads. Supabase normally fires this itself on DDL.
NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- VERIFY (with the ANON key and with two real sessions, not in this editor —
-- the editor runs as postgres and bypasses every policy above)
--
-- 1. The status column cannot be chosen by the caller:
--      POST /rest/v1/follows {follower_id: me, followed_id: <private>, status: 'approved'}
--      -- expect 42501 on the column, and with status omitted, a row at 'pending'
--
-- 2. A stranger cannot read an account's pending requests:
--      GET /rest/v1/follows?followed_id=eq.<someone else>&status=eq.pending
--      -- expect [] for every caller but that account's owner
--
-- 3. Counts never move on a pending request:
--      SELECT * FROM follow_counts('<private account>');
--      -- unchanged until the request is approved
--
-- 4. Approval opens the profile:
--      as the requester, GET /rest/v1/profiles?id=eq.<private account>
--      -- [] while pending, one row once approved
-- ---------------------------------------------------------------------------
