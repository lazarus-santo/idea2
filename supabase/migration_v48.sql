-- migration_v48: mutes and blocks
--
-- HOW TO APPLY: paste into the Supabase SQL editor as role `postgres`
-- (dashboard/project/sgkycnecmdxvujybsuev/sql/new). There is no psql, no
-- Supabase CLI and no DATABASE_URL in this project.
--
-- ###########################################################################
-- PARTLY SUPERSEDED BY migration_v49 — DO NOT RE-RUN THIS ALONE.
--
-- Section 2 of this file creates public.block_between() and public.is_blocked()
-- and tries to keep them off the REST API with REVOKE. That did not hold: both
-- were callable with the anon key in production after this migration was
-- applied, which let any caller ask whether any two accounts had blocked each
-- other. v49 moves both into the `private` schema, which PostgREST does not
-- serve, and drops the public ones.
--
-- Re-running this file RECREATES them in `public`. If you have to, run v49
-- again straight afterwards. Everything else here is current.
-- ###########################################################################
--
-- ---------------------------------------------------------------------------
-- FOUR THINGS, AND THEY ARE NOT VARIATIONS ON ONE
--
-- Two of these need no schema at all, and saying so is half the design:
--
--   UNFOLLOW         delete your own row in public.follows. v44 already allows
--                    it; this migration adds nothing. The build adds the
--                    button to the Following list, that is all.
--   REMOVE FOLLOWER  delete the row where YOU are followed_id. v44 already
--                    allows that too — "DELETE: either end", and the comment
--                    there names removing a follower as one of the reasons.
--                    Soft on purpose: no notification, no record, and the
--                    person may follow again immediately if you are public or
--                    by a fresh request if you are private. Nothing below
--                    stores that they were removed, because storing it would
--                    turn a "no thanks" into the "never" that block is for.
--
-- The two that DO need schema are separate tables for a reason worth stating,
-- since a single `relationships` table with a `kind` column is the obvious
-- shortcut and it is wrong here:
--
--   MUTE    one-directional, silent, and touches NOTHING else. You may mute
--           somebody you follow, somebody who follows you, or a stranger. It
--           changes exactly one thing — whether their events reach your feed.
--           No access changes. Reversible. Its whole contract is "nothing
--           observable happens to the other person", so it must not share a
--           table with a row type that severs follows.
--   BLOCK   mutual and destructive. It severs the follow graph in BOTH
--           directions on insert, then makes the two accounts invisible to
--           each other in search and on profile pages.
--
-- A shared table would mean every query that cares about one has to remember
-- to filter on kind, and the day somebody forgets, a mute silently starts
-- behaving like a block. Two tables cannot make that mistake.
--
-- ---------------------------------------------------------------------------
-- BLOCK IS A SECOND GATE, NOT A REPLACEMENT FOR THE FIRST
--
-- v43 established that a private profile stays FINDABLE — you cannot ask to
-- follow an account you cannot locate. Block is a deliberate, scoped exception
-- to that rule and not a contradiction of it: privacy is about everyone, a
-- block is about one named person. So the order of the checks everywhere below
-- is: block first (are these two accounts invisible to each other?), then
-- privacy (may this particular caller see the contents?). Both run. Neither
-- replaces the other.
--
-- ---------------------------------------------------------------------------
-- NOBODY IS TOLD ANYTHING, WHICH IS ALSO WHY THE RLS LOOKS ASYMMETRIC
--
-- The blocked person is not notified, and — the part that is easy to get wrong
-- — must not be able to LOOK UP that they were blocked either. So the read
-- policy on public.blocks is first-person-as-BLOCKER only. Being the blocked_id
-- of a row does not entitle you to read it. Same for mutes and muter_id.
--
-- That is stricter than the follows policy in v44, which lets you read edges at
-- either end, and the difference is deliberate: a follow is a fact about a
-- relationship both people are part of, while a block is a fact about one
-- person's decision. The consequences are visible to the other party; the
-- decision is not.
--
-- ---------------------------------------------------------------------------
-- WHAT IS NOT HERE
--
-- Still no notifications, of anything, for anyone — the same gap v44 and v47
-- left open, and blocking is the one feature that is better off for it.
-- No reporting or moderation tooling beyond block itself. Nothing
-- exhibition-related. Nothing that restores a follow on unblock: unblocking
-- gives back visibility and nothing else, so following again is a fresh
-- request. That is in the UI's hands because there is deliberately nothing
-- stored to restore FROM — the follow rows were deleted, not flagged.
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The two tables.
--
-- Same shape as public.follows and for the same reasons: the pair is the
-- primary key, so pressing Block twice is a conflict rather than a second row;
-- the self CHECK is a constraint rather than a UI rule because the UI is not
-- what writes here; and the foreign keys point at profiles rather than
-- auth.users so that deleting an account takes its blocks and mutes with it in
-- both directions.
--
-- Neither table has a status column. A follow needed one because "asked and
-- not yet answered" is a real middle state. There is no middle state here —
-- you have blocked somebody or you have not, and the answer is nobody else's
-- to give.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mutes (
  muter_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  muted_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (muter_id, muted_id),
  CONSTRAINT mutes_no_self_mute CHECK (muter_id <> muted_id)
);

COMMENT ON TABLE public.mutes IS
  'One row per mute, one direction. Hides the muted account''s events from the muter''s feed and does NOTHING else — no access change, no effect on follows, and no way for the muted person to observe it. Readable only by the muter.';

CREATE TABLE IF NOT EXISTS public.blocks (
  blocker_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (blocker_id, blocked_id),
  CONSTRAINT blocks_no_self_block CHECK (blocker_id <> blocked_id)
);

COMMENT ON TABLE public.blocks IS
  'One row per block, stored one direction but ENFORCED both ways: while this row exists the two accounts cannot see each other in search or on profile pages and cannot follow each other. Inserting it severs any existing follow in both directions (trigger blocks_sever_follows). Deleting it restores visibility only — never the follows. Readable only by the blocker.';

-- The PK indexes (blocker_id, blocked_id), which answers "who have I blocked".
-- Every enforcement check below also asks the reverse — "has this person
-- blocked ME" — and that direction needs its own index.
CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON public.blocks(blocked_id);

-- ---------------------------------------------------------------------------
-- 2. The two questions every gate below asks.
--
-- SECURITY DEFINER because the whole point is to see a block from the side
-- that is not allowed to read it. A caller can read only the blocks they made;
-- the checks have to consider the ones made against them too, or a block would
-- be enforced in one direction and be exactly the one-way mute it is not.
--
-- block_between(a, b) is order-independent and NULL-safe: with either argument
-- NULL it finds no rows and returns false, which is the right answer for a
-- signed-out visitor. is_blocked(other) is the same question asked about the
-- current caller, and exists so that policies and functions read as prose.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.block_between(a uuid, b uuid)
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

COMMENT ON FUNCTION public.block_between(uuid, uuid) IS
  'Is there a block between these two profiles, in either direction? Order-independent, and false when either argument is NULL. SECURITY DEFINER because a block must be enforced from the side that may not read it. NOT EXECUTABLE BY anon OR authenticated — it answers about any two accounts, which is the third-party question nobody may ask.';

CREATE OR REPLACE FUNCTION public.is_blocked(other uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.block_between((SELECT auth.uid()), other);
$$;

COMMENT ON FUNCTION public.is_blocked(uuid) IS
  'Are the caller and this profile invisible to each other? Always about the CALLER — there is no pair of ids to ask about. Granted to authenticated only because the profiles read policy has to call it; see the grant note in migration_v48.';

-- ---------------------------------------------------------------------------
-- WHO MAY CALL THESE, WHICH IS A SHARPER QUESTION THAN IT LOOKS
--
-- block_between(a, b) IS NOT GRANTED TO ANYBODY. Handed to `authenticated` it
-- would be exactly the leak this whole feature is built to prevent: any signed-
-- in account could ask whether any two OTHER accounts have blocked each other.
-- "Nobody else should be able to see who someone has blocked" rules that out.
-- It stays callable only from inside the SECURITY DEFINER functions below,
-- which run as this function's owner and so need no grant of their own. The
-- REVOKE from PUBLIC is not decoration: Postgres grants EXECUTE on a new
-- function to PUBLIC by default, so creating it is publishing it.
--
-- is_blocked(other) IS granted to `authenticated`, and it has to be: section 6a
-- calls it from the read policy on public.profiles, and a policy expression
-- runs as the querying user, so a role that cannot execute the function cannot
-- read the table at all. What that grant costs, stated plainly rather than
-- discovered later:
--
--   A blocked person who KEPT your profile id from before the block can call
--   is_blocked(<your id>) and get `true`. That distinguishes "they blocked me"
--   from "they deleted their account", which every other surface deliberately
--   conflates — profile_card(), can_view_profile() and follow_counts() all
--   answer identically in the two cases.
--
-- Why that is an acceptable price, and not a hole worth contorting the schema
-- to close:
--
--   * it is not a NEW capability, only a cheaper one. Mutual invisibility is
--     detectable by anyone willing to compare a signed-in view with a
--     signed-out one: `anon` has no blocks, so an account that has vanished for
--     you while still appearing in a shared follower list to a logged-out
--     browser has told you the same thing. That is true of every product that
--     implements block this way and cannot be fixed without making blocks
--     visible to strangers, which is worse.
--   * it does not enumerate. The argument is an id, and an account that has
--     blocked you is invisible to you, so you cannot LOOK UP the id to ask
--     about — only one you already had.
--   * it says nothing about anyone else. There is no pair of ids to pass.
--
-- anon is granted neither. A signed-out visitor is not anybody, has blocked no
-- one and can be blocked by no one, and the anon half of the profiles policy
-- does not ask.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.block_between(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.block_between(uuid, uuid) FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.is_blocked(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_blocked(uuid) FROM anon;
GRANT  EXECUTE ON FUNCTION public.is_blocked(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Blocking severs the follow graph, both directions, in one action.
--
-- A TRIGGER rather than two DELETEs in the browser next to the INSERT. Three
-- reasons, in order of how much they would hurt:
--
--   * a browser that inserts the block and then loses its connection leaves a
--     block with a live follow under it — the follower keeps seeing events
--     from an account that believes it cut them off. In a trigger the two are
--     the same transaction and cannot come apart.
--   * the blocked person's follow of YOU is an edge you are allowed to delete
--     (v44, "DELETE: either end"), but relying on that means the severing is
--     correct only for as long as that policy stays written that way.
--   * anything else that ever inserts a block — an admin route, a moderation
--     action, a data migration — gets the severing for free instead of having
--     to remember it.
--
-- AFTER INSERT, not BEFORE: the block row should exist before the follows go,
-- so a concurrent follow attempt in another transaction meets the block rather
-- than slipping into the gap.
--
-- SECURITY DEFINER for the same reason as section 2 — this deletes a row the
-- blocker is an endpoint of either way, but the function should not depend on
-- the shape of the follows DELETE policy to do its job.
--
-- Pending requests are severed too, in both directions, and the DELETE does
-- not filter on status: a request that was never answered is still a
-- relationship, and leaving it would mean unblocking silently re-exposed a
-- pending ask that predates the block.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.blocks_sever_follows()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM public.follows
   WHERE (follower_id = NEW.blocker_id AND followed_id = NEW.blocked_id)
      OR (follower_id = NEW.blocked_id AND followed_id = NEW.blocker_id);
  RETURN NULL;  -- AFTER triggers ignore the return value.
END;
$$;

DROP TRIGGER IF EXISTS blocks_sever_follows ON public.blocks;
CREATE TRIGGER blocks_sever_follows
  AFTER INSERT ON public.blocks
  FOR EACH ROW EXECUTE FUNCTION public.blocks_sever_follows();

-- ---------------------------------------------------------------------------
-- 4. A block refuses a new follow — silently.
--
-- v44's BEFORE INSERT trigger already owns `status`; this is the second thing
-- it now decides. RETURN NULL drops the row without raising, which is the
-- unusual choice and the deliberate one.
--
-- An exception would be an announcement. 'blocked' in an error body, or even a
-- generic failure that happens only for this one account, tells the blocked
-- person exactly what they are not supposed to learn — and they would learn it
-- by pressing a button, which is as close to a notification as makes no
-- difference. Dropping the insert means the follow simply does not take: the
-- page re-reads the graph, finds no edge, and shows Follow again. Indis-
-- tinguishable from a write that lost a race.
--
-- In practice this is a backstop, not the main defence. A blocked person
-- cannot load the profile page (section 6) so there is no Follow button in
-- front of them; reaching this code means a stale tab or a hand-written
-- request. Backstops should be quiet.
--
-- The check is block_between(), not is_blocked(): this trigger also fires for
-- writes that are not the follower's own — the service role, an admin route —
-- and auth.uid() would be the wrong person or nobody at all.
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
  -- Block first, privacy second — the order named in this migration's header.
  IF public.block_between(NEW.follower_id, NEW.followed_id) THEN
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

-- ---------------------------------------------------------------------------
-- 5. RLS: your block list and your mute list are yours alone.
--
-- NO READ AT THE OTHER END. `blocked_id = auth.uid()` is deliberately absent
-- from the SELECT policy — see the header. The same for mutes and muted_id,
-- where it matters even more: a mute is supposed to be undetectable, and a
-- table the muted person could query would make it a public statement.
--
-- No UPDATE policy on either table. There is nothing to update: a row's two
-- columns are its identity, and changing your mind is a DELETE. Leaving UPDATE
-- ungranted means "unblock" cannot be quietly implemented as a rewrite that
-- points the block at somebody else.
-- ---------------------------------------------------------------------------
ALTER TABLE public.mutes  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blocks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mutes_auth_read_own   ON public.mutes;
DROP POLICY IF EXISTS mutes_auth_insert_own ON public.mutes;
DROP POLICY IF EXISTS mutes_auth_delete_own ON public.mutes;

CREATE POLICY mutes_auth_read_own ON public.mutes
  FOR SELECT TO authenticated
  USING (muter_id = (SELECT auth.uid()));

CREATE POLICY mutes_auth_insert_own ON public.mutes
  FOR INSERT TO authenticated
  WITH CHECK (muter_id = (SELECT auth.uid()));

CREATE POLICY mutes_auth_delete_own ON public.mutes
  FOR DELETE TO authenticated
  USING (muter_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS blocks_auth_read_own   ON public.blocks;
DROP POLICY IF EXISTS blocks_auth_insert_own ON public.blocks;
DROP POLICY IF EXISTS blocks_auth_delete_own ON public.blocks;

CREATE POLICY blocks_auth_read_own ON public.blocks
  FOR SELECT TO authenticated
  USING (blocker_id = (SELECT auth.uid()));

CREATE POLICY blocks_auth_insert_own ON public.blocks
  FOR INSERT TO authenticated
  WITH CHECK (blocker_id = (SELECT auth.uid()));

CREATE POLICY blocks_auth_delete_own ON public.blocks
  FOR DELETE TO authenticated
  USING (blocker_id = (SELECT auth.uid()));

-- v26 left this database deny-by-default for anon and authenticated, so new
-- tables start with no grants at all and have to be handed back by name.
-- created_at is not insertable: it is not a fact the client gets to assert.
-- anon gets nothing — both of these are decisions only an account can make.
GRANT SELECT (muter_id, muted_id, created_at) ON public.mutes  TO authenticated;
GRANT INSERT (muter_id, muted_id)             ON public.mutes  TO authenticated;
GRANT DELETE                                  ON public.mutes  TO authenticated;
GRANT ALL                                     ON public.mutes  TO service_role;

GRANT SELECT (blocker_id, blocked_id, created_at) ON public.blocks TO authenticated;
GRANT INSERT (blocker_id, blocked_id)             ON public.blocks TO authenticated;
GRANT DELETE                                      ON public.blocks TO authenticated;
GRANT ALL                                         ON public.blocks TO service_role;

-- ---------------------------------------------------------------------------
-- 6. The gates. Every place that already asked about privacy now asks about
--    blocks first.
--
-- These are REWRITES of functions from v44 and v45, not new ones, and that is
-- the point the scope note made: profile_card() and search_profile_cards()
-- are the only way anything reads a profile it may not read directly, so
-- adding a block check to them covers every caller at once. A new
-- block-aware function alongside them would leave the old pair as an open
-- door that happens not to be used today.
--
-- None of them read public.blocks through a policy — they are SECURITY DEFINER
-- and read it directly, because the block that has to be enforced here is
-- frequently the one made AGAINST the caller, which the caller cannot see.
-- ---------------------------------------------------------------------------

-- 6a. The profiles read policy.
--
-- v44 widened this to three cases; this narrows all three by one condition. It
-- has to be here and not only in the functions: public.profiles is readable
-- over PostgREST directly, so a blocked person could otherwise fetch the full
-- row — bio and all — of a public account that blocked them, just by asking
-- the table instead of the profile page.
--
-- is_blocked() reads ONLY public.blocks. It must never read public.profiles,
-- or invoking it from this policy would recurse — the same care v44 took with
-- is_approved_follower() for the same reason.
--
-- anon is untouched: a signed-out visitor is not anybody, so no block applies.
DROP POLICY IF EXISTS profiles_auth_read_visible ON public.profiles;

CREATE POLICY profiles_auth_read_visible ON public.profiles
  FOR SELECT TO authenticated
  USING (
    NOT public.is_blocked(id)
    AND (
      privacy = 'public'
      OR id = (SELECT auth.uid())
      OR public.is_approved_follower(id)
    )
  );

-- 6b. One card, by handle. Feeds /u/<username>.
--
-- A blocked profile returns NO ROW, which is what makes the profile page 404
-- rather than showing a locked state. That distinction is deliberate: "private"
-- is a state worth telling a visitor about, because there is something they can
-- do about it. A block is not, because there is not, and a page that said
-- "you are blocked" would be the announcement this whole feature avoids.
--
-- NOTE FOR THE CALLER: this function now depends on WHO IS ASKING, which it
-- did not before v48. It must be called through the visitor's own session
-- (lib/supabase-server.ts), never the shared anon client, or auth.uid() is
-- NULL and every block silently stops applying. app/u/[username]/page.tsx was
-- changed in this build for exactly that reason.
CREATE OR REPLACE FUNCTION public.profile_card(handle text)
RETURNS TABLE (
  id uuid,
  username text,
  display_name text,
  avatar_url text,
  privacy text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p.id, p.username, p.display_name, p.avatar_url, p.privacy
    FROM public.profiles p
   WHERE p.username = lower(btrim(handle))
     AND p.username IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.blocks b
        WHERE (b.blocker_id = p.id AND b.blocked_id = (SELECT auth.uid()))
           OR (b.blocker_id = (SELECT auth.uid()) AND b.blocked_id = p.id)
     )
   LIMIT 1;
$$;

COMMENT ON FUNCTION public.profile_card(text) IS
  'The discoverable half of one profile, by handle, whatever its privacy — unless a block stands between it and the caller, in which case no row comes back and the page 404s. Carries no bio and no created_at. MUST be called with the visitor''s session: it reads auth.uid().';

-- 6c. Cards matching a search. Feeds person search.
--
-- Mutual invisibility, not one-directional: the NOT EXISTS matches a block in
-- EITHER direction, so the person you blocked disappears from your results as
-- surely as you disappear from theirs. Half of that is the scope note's
-- explicit requirement and the other half is what stops block from being a
-- one-way mute with extra steps.
--
-- This is the same clause as 6b rather than a call to block_between(), so the
-- planner can turn it into one anti-join against the two indexes instead of a
-- STABLE function call per candidate row.
--
-- Everything else about this function is unchanged from v45: two-character
-- floor, caller's wildcards escaped here, result capped at 50, ranking left to
-- the application.
CREATE OR REPLACE FUNCTION public.search_profile_cards(q text, max_rows integer DEFAULT 50)
RETURNS TABLE (
  id uuid,
  username text,
  display_name text,
  avatar_url text,
  privacy text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH needle AS (
    SELECT '%' || replace(replace(replace(
             lower(btrim(regexp_replace(coalesce(q, ''), '^@+', ''))),
             '\', '\\'), '%', '\%'), '_', '\_') || '%' AS pattern,
           length(btrim(regexp_replace(coalesce(q, ''), '^@+', ''))) AS len
  )
  SELECT p.id, p.username, p.display_name, p.avatar_url, p.privacy
    FROM public.profiles p, needle n
   WHERE n.len >= 2
     AND p.username IS NOT NULL
     AND (p.username ILIKE n.pattern OR p.display_name ILIKE n.pattern)
     AND NOT EXISTS (
       SELECT 1 FROM public.blocks b
        WHERE (b.blocker_id = p.id AND b.blocked_id = (SELECT auth.uid()))
           OR (b.blocker_id = (SELECT auth.uid()) AND b.blocked_id = p.id)
     )
   ORDER BY p.username
   LIMIT LEAST(GREATEST(coalesce(max_rows, 50), 1), 50);
$$;

COMMENT ON FUNCTION public.search_profile_cards(text, integer) IS
  'Person search. Returns profiles of every privacy — a private account has to be findable to be asked for access — but never their bio, and never an account on the other side of a block from the caller, in either direction. Requires 2+ characters and caps at 50 rows. MUST be called with the visitor''s session: it reads auth.uid().';

-- 6d. May the caller see what is ON this profile?
--
-- Used by the follower/following lists below and, since v47, by the read policy
-- on public.events — so this one line is what keeps a blocked account's
-- activity out of reach as well.
CREATE OR REPLACE FUNCTION public.can_view_profile(target uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT NOT public.block_between((SELECT auth.uid()), target)
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

-- 6e. Counts.
--
-- Public for every profile, private ones included — unchanged. But zero for a
-- profile on the other side of a block, because the profile page it decorates
-- does not exist for that caller and a number arriving for a page that 404s is
-- a leak looking for somewhere to happen.
CREATE OR REPLACE FUNCTION public.follow_counts(profile_id uuid)
RETURNS TABLE (followers integer, following integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    CASE WHEN public.block_between((SELECT auth.uid()), profile_id) THEN 0 ELSE
      (SELECT count(*)::int FROM public.follows
        WHERE followed_id = profile_id AND status = 'approved') END,
    CASE WHEN public.block_between((SELECT auth.uid()), profile_id) THEN 0 ELSE
      (SELECT count(*)::int FROM public.follows
        WHERE follower_id = profile_id AND status = 'approved') END;
$$;

-- 6f. The follower and following lists.
--
-- Two block checks each, and they are different questions:
--
--   can_view_profile(profile_id)  — already there, now block-aware via 6d:
--                                   may the caller see this profile at all?
--   the NOT EXISTS on each ROW    — new: mutual invisibility has to hold
--                                   inside a THIRD party's list too. If you
--                                   and I have blocked each other, I must not
--                                   find you by opening the followers of
--                                   somebody we both follow.
--
-- Blocking already severed the follow between the two of you, so you will
-- never be in each OTHER'S lists. This is about everybody else's.
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
     AND NOT EXISTS (
       SELECT 1 FROM public.blocks b
        WHERE (b.blocker_id = p.id AND b.blocked_id = (SELECT auth.uid()))
           OR (b.blocker_id = (SELECT auth.uid()) AND b.blocked_id = p.id)
     )
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
     AND NOT EXISTS (
       SELECT 1 FROM public.blocks b
        WHERE (b.blocker_id = p.id AND b.blocked_id = (SELECT auth.uid()))
           OR (b.blocker_id = (SELECT auth.uid()) AND b.blocked_id = p.id)
     )
   ORDER BY f.created_at DESC
   LIMIT LEAST(GREATEST(max_rows, 1), 200);
$$;

-- 6g. The approval inbox.
--
-- Blocking severs pending requests, so in the ordinary course nothing here
-- could belong to a blocked account. The filter is for the race: a request
-- inserted in the instant between the block row landing and this query running
-- would otherwise sit in the inbox of somebody who has said they do not want
-- to hear from that person.
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
     AND NOT public.block_between((SELECT auth.uid()), p.id)
   ORDER BY f.created_at DESC;
$$;

-- ---------------------------------------------------------------------------
-- 7. The feed drops muted accounts.
--
-- A mute that did not change the feed would be a checkbox that does nothing,
-- so this is the entire observable effect of section 1's first table.
--
-- STILL NOT SECURITY DEFINER, and this is the reason it matters that it stayed
-- that way in v47: the caller can read their OWN rows in public.mutes under the
-- policy in section 5, so the filter needs no elevation. Everything underneath
-- — events, follows, profiles, mutes — keeps its RLS, and the clauses written
-- here are the product rule with the policies as an independent backstop.
--
-- Blocks need no clause here. Blocking severed the follow, and the join to
-- follows is what puts an actor in this feed at all; the read policy on events
-- refuses them a second time through can_view_profile(). Adding a third check
-- would be a copy of a rule that is already enforced twice.
--
-- The mute is applied at READ time rather than by deleting anything, which is
-- what makes it reversible: unmuting brings back the whole history, because
-- none of it ever went anywhere.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.feed_events(
  max_rows    integer     DEFAULT 30,
  before_time timestamptz DEFAULT NULL,
  before_id   uuid        DEFAULT NULL
)
RETURNS TABLE (
  id            uuid,
  type          text,
  payload       jsonb,
  created_at    timestamptz,
  actor_id      uuid,
  username      text,
  display_name  text,
  avatar_url    text
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT e.id, e.type, e.payload, e.created_at,
         p.id, p.username, p.display_name, p.avatar_url
    FROM public.events e
    JOIN public.follows f
      ON f.followed_id = e.actor_id
     AND f.follower_id = (SELECT auth.uid())
     AND f.status = 'approved'
    JOIN public.profiles p
      ON p.id = e.actor_id
   WHERE (SELECT auth.uid()) IS NOT NULL
     -- An account that never finished onboarding has no handle and no page to
     -- link an event to, the same exclusion the follower lists make.
     AND p.username IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.mutes m
        WHERE m.muter_id = (SELECT auth.uid())
          AND m.muted_id = e.actor_id
     )
     AND (
       before_time IS NULL
       OR (e.created_at, e.id) < (before_time, COALESCE(before_id, '00000000-0000-0000-0000-000000000000'::uuid))
     )
   ORDER BY e.created_at DESC, e.id DESC
   LIMIT LEAST(GREATEST(max_rows, 1), 100);
$$;

-- ---------------------------------------------------------------------------
-- 8. Reading your own two lists.
--
-- Both take NO ARGUMENT, for the reason spelled out at length on
-- pending_follow_requests() in v44: a function with a profile id can be
-- pointed at somebody else's, and a block list is the single most sensitive
-- thing this schema holds. Keyed on auth.uid() there is no id to substitute,
-- and "whose list is this" stops being a question the code has to get right.
--
-- SECURITY DEFINER is unavoidable for blocked_profiles(): the caller may not
-- read the profile row of somebody they have blocked — section 6a's policy
-- says so — and yet they must see a name and a face next to Unblock, or the
-- list is a column of UUIDs. muted_profiles() keeps the same shape for
-- symmetry; a mute changes no access, so its rows would mostly be readable
-- anyway, except for the private account you muted and do not follow.
--
-- Both return the same five columns as a profile card, and no bio, so neither
-- becomes a way to read something the rest of the schema withholds.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.blocked_profiles()
RETURNS TABLE (id uuid, username text, display_name text, avatar_url text, privacy text, created_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p.id, p.username, p.display_name, p.avatar_url, p.privacy, b.created_at
    FROM public.blocks b
    JOIN public.profiles p ON p.id = b.blocked_id
   WHERE b.blocker_id = (SELECT auth.uid())
   ORDER BY b.created_at DESC;
$$;

COMMENT ON FUNCTION public.blocked_profiles() IS
  'Who the CALLER has blocked, newest first. Takes no argument on purpose — there is no id to substitute, so this can never answer about anybody else. created_at is the block''s, not the profile''s.';

CREATE OR REPLACE FUNCTION public.muted_profiles()
RETURNS TABLE (id uuid, username text, display_name text, avatar_url text, privacy text, created_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p.id, p.username, p.display_name, p.avatar_url, p.privacy, m.created_at
    FROM public.mutes m
    JOIN public.profiles p ON p.id = m.muted_id
   WHERE m.muter_id = (SELECT auth.uid())
   ORDER BY m.created_at DESC;
$$;

COMMENT ON FUNCTION public.muted_profiles() IS
  'Who the CALLER has muted, newest first. Takes no argument, same reasoning as blocked_profiles(). created_at is the mute''s.';

REVOKE EXECUTE ON FUNCTION public.blocked_profiles() FROM anon;
REVOKE EXECUTE ON FUNCTION public.muted_profiles()   FROM anon;
GRANT  EXECUTE ON FUNCTION public.blocked_profiles() TO authenticated;
GRANT  EXECUTE ON FUNCTION public.muted_profiles()   TO authenticated;

COMMIT;

-- PostgREST caches the schema; new tables and functions are invisible over the
-- REST API until it reloads. Supabase normally fires this itself on DDL.
NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- VERIFY (with two real sessions — this editor runs as postgres and bypasses
-- every policy above). A and B are two accounts; A does the blocking.
--
-- 1. Nobody but the holder sees a block or a mute:
--      as B: GET /rest/v1/blocks?select=*   -- expect [] even though B is blocked_id
--      as B: GET /rest/v1/mutes?select=*    -- expect []
--      as A: GET /rest/v1/blocks?select=*   -- expect A's own rows
--
-- 2. One action severs both directions. With A following B AND B following A:
--      as A: POST /rest/v1/blocks {blocker_id: A, blocked_id: B}
--      as postgres: SELECT * FROM follows
--                    WHERE follower_id IN (A,B) AND followed_id IN (A,B);
--      -- expect zero rows
--
-- 3. Mutual invisibility, both directions, search and profile:
--      as B: POST /rest/v1/rpc/search_profile_cards {"q":"<A's handle>"} -- []
--      as B: POST /rest/v1/rpc/profile_card         {"handle":"<A>"}     -- []
--      as B: GET  /rest/v1/profiles?id=eq.<A>                            -- []
--      as A: the same three against B                                   -- []
--      and /u/<A> loaded as B in a browser 404s.
--
-- 4. A blocked account cannot follow, and is not told why:
--      as B: POST /rest/v1/follows {follower_id: B, followed_id: A}
--      -- expect NO error and NO row: SELECT confirms nothing was inserted
--
-- 5. Unblock restores visibility and NOT the follow:
--      as A: DELETE /rest/v1/blocks?blocked_id=eq.<B>
--      -- search and profile work again for both; follows is still empty
--
-- 6. Nobody can ask about two OTHER people:
--      as B: POST /rest/v1/rpc/block_between {"a":"<T>","b":"<A>"}
--      -- expect 42501, function not executable
--
-- 7. Mute changes the feed and nothing else. With A following B, an event by B
--    (insert it with the SERVICE key — nothing may write events from a browser):
--      as A: POST /rest/v1/rpc/feed_events {}          -- B's event present
--      as A: POST /rest/v1/mutes {muter_id: A, muted_id: B}
--      as A: POST /rest/v1/rpc/feed_events {}          -- B's event gone
--      as A: GET  /rest/v1/rpc/profile_card?...        -- B still fully visible
--      as B: nothing has changed at all — A still appears in B's followers,
--            B can still load A's profile, and B's blocks/mutes reads are []
--      as A: DELETE /rest/v1/mutes?muted_id=eq.<B>     -- the event is back
--
-- 8. Remove-follower is not a block. With B following A:
--      as A: DELETE /rest/v1/follows?follower_id=eq.<B>&followed_id=eq.<A>
--      as B: POST /rest/v1/follows {follower_id: B, followed_id: A}
--      -- expect a row: 'approved' if A is public, 'pending' if A is private
--
-- REMEMBER TO DELETE any test rows afterwards.
-- ---------------------------------------------------------------------------
