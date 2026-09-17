-- migration_v47: the activity feed's event log
--
-- HOW TO APPLY: paste into the Supabase SQL editor as role `postgres`
-- (dashboard/project/sgkycnecmdxvujybsuev/sql/new). There is no psql, no
-- Supabase CLI and no DATABASE_URL in this project.
--
-- ---------------------------------------------------------------------------
-- THIS MIGRATION SHIPS ZERO EVENT TYPES. THAT IS THE POINT.
--
-- There is nothing to put in a feed yet. The exhibition log does not exist —
-- it is blocked on exhibition ID stability in Agents 1 and 2 — and Crawls are
-- much further out. So this is infrastructure that starts empty, on purpose,
-- and the feed page says so honestly rather than inventing something to show.
--
-- Follows are deliberately NOT events. "X followed Y" is relationship noise,
-- not activity; a feed should only ever carry things people DID. Nothing in
-- migration_v44 writes here and nothing here reads it as an event source —
-- the follow graph is consulted only to decide WHOSE events a person sees.
--
-- ---------------------------------------------------------------------------
-- WHY ONE TABLE WITH A `type` COLUMN, RATHER THAN A TABLE PER THING
--
-- Modelled on GitHub's activity feed: a single append-only log, a type tag,
-- and rendering chosen per type in the app. The alternative — a table and a
-- query per event kind, UNIONed together at read time — means every new kind
-- of activity is a schema change, a new index, a rewritten feed query and a
-- new pagination bug. The whole reason to build this now, with nothing to put
-- in it, is so the log entry and (much later) the Crawl completion slot in
-- without any of that.
--
-- So: no columns for any specific event's data. `payload` is jsonb and each
-- type owns its own shape. The only things this table asserts about an event
-- are the three that are true of every event — somebody did it, it was of some
-- kind, and it happened at a time.
--
-- ---------------------------------------------------------------------------
-- THE PRIVACY RULE, WHICH IS THE SAME RULE AS EVERYWHERE ELSE
--
-- An event is exactly as visible as the person who did it. A public account's
-- activity is readable by anyone; a private account's activity is readable by
-- its owner and its approved followers, and nobody else. That is precisely the
-- question public.can_view_profile(uuid) already answers (migration_v44), so
-- the read policy below asks it rather than restating the privacy model in a
-- third place.
--
-- Note this is a separate question from "is it in your feed". Permission to
-- read an event and having it appear in your feed are different: the policy
-- decides the first, the feed function's join to follows decides the second.
-- Keeping them apart is what leaves room for a per-profile activity tab later
-- without loosening anything.
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The log.
--
-- A surrogate uuid primary key rather than a natural one: there is no natural
-- key for "a thing that happened", two identical-looking events are two
-- events, and the feed's keyset pagination needs a stable tiebreaker for rows
-- sharing a created_at.
--
-- actor_id points at profiles, not auth.users, for the same reason follows
-- does — profiles already cascades from auth.users, so deleting an account
-- still takes its activity with it, and every read here joins profiles anyway.
--
-- `type` is text with a CHECK that only constrains its SHAPE, not its values.
-- An enum would make adding an event type a migration on a live table, which
-- is the exact coupling this design exists to avoid; an unconstrained text
-- column invites '', ' ', and 300-character junk. So: lower-case, dotted,
-- bounded. The set of legal values lives in the app, next to the renderers.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  type       text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT events_type_shape CHECK (type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  CONSTRAINT events_type_length CHECK (char_length(type) BETWEEN 3 AND 64),
  -- jsonb permits a bare scalar or an array at the top level; a payload that
  -- is not an object has no keys for a renderer to read.
  CONSTRAINT events_payload_is_object CHECK (jsonb_typeof(payload) = 'object')
);

COMMENT ON TABLE public.events IS
  'Append-only activity log behind the feed. One row per thing somebody did. Generic on purpose: type names the kind, payload carries that kind''s data, and no column here is specific to any one event type. As of migration_v47 there are NO event types and nothing writes here — see the header.';
COMMENT ON COLUMN public.events.type IS
  'Dot-namespaced event kind, e.g. a future log.created. The legal set lives in the app beside the renderers (lib/feed-types.ts), not in a database enum, so adding a kind is not a migration.';
COMMENT ON COLUMN public.events.payload IS
  'Per-type jsonb. Each type owns its own shape; the feed query never looks inside it.';

-- The feed reads "events by these actors, newest first", so the index leads
-- with actor_id and carries the sort. created_at DESC, id DESC matches the
-- ORDER BY in feed_events() exactly, including the tiebreaker.
CREATE INDEX IF NOT EXISTS idx_events_actor_created
  ON public.events(actor_id, created_at DESC, id DESC);

-- For the eventual site-wide or per-type sweeps (moderation, backfills,
-- pruning) that do not start from an actor.
CREATE INDEX IF NOT EXISTS idx_events_created
  ON public.events(created_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- 2. RLS: an event is as visible as its actor.
--
-- can_view_profile() is SECURITY DEFINER and reads profiles and follows — it
-- does NOT read events, so invoking it from this table's own policy cannot
-- recurse. (This is the same care migration_v44 took with is_approved_follower
-- in the profiles policy, for the same reason.)
--
-- anon gets the same rule and therefore sees public accounts' events. Nothing
-- renders that yet — the feed is sign-in only, since a feed is by definition
-- personal — but a signed-out activity view would be legitimate and this does
-- not have to change for it. Private accounts stay closed to anon regardless:
-- can_view_profile() with no auth.uid() is true only for public profiles.
-- ---------------------------------------------------------------------------
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS events_read_visible_actors ON public.events;

CREATE POLICY events_read_visible_actors ON public.events
  FOR SELECT TO anon, authenticated
  USING (public.can_view_profile(actor_id));

-- NO INSERT, UPDATE OR DELETE POLICY, AND NO WRITE GRANT TO authenticated.
--
-- This is a decision, not an omission. A browser that can insert into this
-- table can choose its own `type` and its own `payload`, which means it can
-- manufacture activity that never happened — claim a show it did not log,
-- fabricate a completed Crawl. Every event type this log will carry is a
-- side effect of some other write that the database or a server route is
-- already performing, so events should be written there: by a trigger on the
-- table that actually changed, or by a route holding the service key.
--
-- When the first event type lands, it writes from one of those two places. If
-- some later type genuinely needs a client-originated write, it gets a narrow
-- SECURITY DEFINER function that hard-codes its own type and validates its own
-- payload — never a general INSERT grant on this table.
--
-- v26 left this database deny-by-default, so a new table starts with no grants
-- at all. Reads have to be handed back column by column even though the policy
-- above is what does the filtering.
GRANT SELECT (id, actor_id, type, payload, created_at)
  ON public.events TO anon, authenticated;
GRANT ALL ON public.events TO service_role;

-- ---------------------------------------------------------------------------
-- 3. The feed query.
--
-- Takes NO viewer argument, for the reason spelled out at length on
-- pending_follow_requests() in migration_v44: a function that accepts a
-- profile id can be pointed at somebody else's, and then the only thing
-- protecting a private account's feed is a WHERE clause nobody re-reads.
-- Keyed on auth.uid() there is no id to substitute.
--
-- NOT SECURITY DEFINER — and that is worth saying out loud, because every
-- other function in the follow graph is. This one does not need elevation:
--   * a person may already read their own edges in follows (they are the
--     follower), which is the only part of the graph this consults;
--   * section 2's policy already admits exactly the events they may see;
--   * the profiles join returns the actor because an approved follower may
--     read a private profile (migration_v44 section 4).
-- Running as the invoker means RLS applies to all three tables underneath, so
-- the approved-only filter below is the product rule and the policies remain
-- an independent backstop. A SECURITY DEFINER here would switch that backstop
-- off and leave one WHERE clause standing between a pending request and a
-- private account's activity.
--
-- WHY approved-only IS LOAD-BEARING: a pending request means you asked to
-- follow a private account and have not been let in. If its activity appeared
-- in your feed, the request would function as the approval — the gate would be
-- decorative. (RLS would in fact refuse those rows anyway; this filter means
-- the query does not depend on that to be correct.)
--
-- Self-events are NOT included: this returns the activity of accounts you
-- follow, and you do not follow yourself. If the product later wants your own
-- actions in your feed, that is one OR in this function and no schema change.
--
-- PAGINATION is keyset, not OFFSET: pass the created_at and id of the last row
-- you received. A feed has rows inserted at the head while somebody is reading
-- it, and OFFSET under those conditions silently repeats and skips rows. The
-- pair is compared as a tuple so events sharing a timestamp still page
-- correctly, which is why id is in the sort at all.
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
     AND (
       before_time IS NULL
       OR (e.created_at, e.id) < (before_time, COALESCE(before_id, '00000000-0000-0000-0000-000000000000'::uuid))
     )
   ORDER BY e.created_at DESC, e.id DESC
   LIMIT LEAST(GREATEST(max_rows, 1), 100);
$$;

-- anon is refused rather than simply returning nothing. A signed-out caller
-- has no auth.uid() and so would get an empty set regardless, but the feed is
-- a signed-in surface and the grant should say that rather than rely on a
-- coincidence of the query.
REVOKE EXECUTE ON FUNCTION public.feed_events(integer, timestamptz, uuid) FROM anon;
GRANT  EXECUTE ON FUNCTION public.feed_events(integer, timestamptz, uuid) TO authenticated;

COMMIT;

-- PostgREST caches the schema; new tables and functions are invisible over the
-- REST API until it reloads. Supabase normally fires this itself on DDL.
NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- VERIFY (with the anon key and a real session, not in this editor — the
-- editor runs as postgres and bypasses every policy above)
--
-- 1. Nobody can write activity from a browser:
--      POST /rest/v1/events {actor_id: me, type: 'test.event', payload: {}}
--      -- expect 42501: no INSERT grant to authenticated
--
-- 2. The feed is empty because there are no events, not because it is broken.
--    Insert one row with the SERVICE key, actor = somebody the test account
--    follows with status 'approved', then:
--      POST /rest/v1/rpc/feed_events {}
--      -- expect that one row, with the actor's username attached
--
-- 3. A pending request leaks nothing. Insert an event for a PRIVATE account
--    the test account has only asked to follow:
--      POST /rest/v1/rpc/feed_events {}
--      -- expect it absent; and
--      GET /rest/v1/events?actor_id=eq.<that private account>
--      -- expect [] as well, which is the policy refusing independently
--
-- 4. Approval turns it on: approve the request as the private account, repeat
--    both calls -- the event now appears in each.
--
-- REMEMBER TO DELETE the test rows: DELETE FROM public.events; -- while empty
-- ---------------------------------------------------------------------------
