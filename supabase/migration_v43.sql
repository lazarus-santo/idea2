-- migration_v43: two privacy states, and a profile that can be found while
-- staying private
--
-- HOW TO APPLY: paste into the Supabase SQL editor as role `postgres`
-- (dashboard/project/sgkycnecmdxvujybsuev/sql/new). There is no psql, no
-- Supabase CLI and no DATABASE_URL in this project.
--
-- ---------------------------------------------------------------------------
-- WHY
--
-- v40 shipped three privacy values. Two of them were a mistake.
--
-- 1. 'followers_only' never behaved differently from 'private'. There was no
--    follow graph to check it against, so section 5 of v40 read it as private
--    and the settings copy admitted as much. It was a label with no behaviour
--    behind it. It goes away here; every row holding it becomes 'private',
--    which is what it already meant.
--
-- 2. A private profile was invisible to `anon` entirely, so person search
--    could not return it. That is backwards. Nobody can ask to follow an
--    account they cannot find, so a private account that cannot be discovered
--    is not private — it is deleted, with extra steps. Privacy has to gate
--    what a profile SHOWS, not whether the profile can be found.
--
-- The fix is not to loosen the policy on public.profiles. RLS chooses rows and
-- the grant chooses columns, and the grant is one list for every row — so
-- letting `anon` read private ROWS out of that table would hand out private
-- BIOS with them. Instead this migration adds a narrow view, profile_cards,
-- carrying only what a search result and a locked profile header need:
-- id, username, display_name, avatar_url, privacy. No bio, no created_at.
-- The table's own policies are left exactly as v40 wrote them, so the full row
-- is still owner-only for a private profile.
--
-- ---------------------------------------------------------------------------
-- WHAT PRIVATE WILL MEAN NEXT (not built here — no follows table is created)
--
-- Private is meant to be a gate, not a wall: anyone may find a private profile
-- and REQUEST to follow it, the owner approves or denies, and an approved
-- follower sees the full profile. That makes a status column a REQUIREMENT of
-- the future follows table — pending | approved, never a bare boolean follow.
-- A boolean cannot express a request that has been made and not yet answered,
-- and retrofitting one onto a live follow graph means backfilling every
-- existing edge. Whoever builds that table: put the status in from the start.
--
-- Nothing in this migration creates, references or reserves that table.
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Collapse followers_only into private.
--
-- The UPDATE runs BEFORE the constraint is swapped, because the new CHECK
-- would reject the very rows we are here to fix. Rows already 'private' or
-- 'public' are untouched.
--
-- This is the whole data migration. No behaviour changes for these people:
-- followers_only already read as private, so their profile looked the same
-- yesterday as it will today. Only the label they see in settings changes.
-- ---------------------------------------------------------------------------
UPDATE public.profiles
   SET privacy = 'private'
 WHERE privacy = 'followers_only';

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_privacy_values;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_privacy_values
  CHECK (privacy IN ('public', 'private'));

COMMENT ON COLUMN public.profiles.privacy IS
  'public | private. Private gates what the profile page SHOWS, not whether the profile can be found: see public.profile_cards. When follows ship, an approved follower sees a private profile in full.';

-- ---------------------------------------------------------------------------
-- 2. profile_cards — the discoverable half of every profile.
--
-- Deliberately a view with security_invoker OFF (the Postgres default). It is
-- owned by postgres, so the RLS on public.profiles is evaluated as postgres
-- and does not filter what the view returns. That is the entire point: this is
-- the ONE way `anon` may learn that a private profile exists.
--
-- Supabase's linter flags this as a "security definer view". The flag is
-- correct about what it is and wrong about it being a mistake here. What keeps
-- it safe is the column list, not a policy: bio, created_at and updated_at are
-- not selected, so no amount of querying this view yields anything a locked
-- profile header does not already display to every visitor.
--
-- Rows without a username are excluded. Those are accounts that never finished
-- onboarding; they have no profile page to find and no handle to match.
--
-- security_barrier stops a caller's own cheap-but-leaky function from being
-- pushed down below the view's WHERE clause.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS public.profile_cards;

CREATE VIEW public.profile_cards
  WITH (security_barrier = true) AS
  SELECT id, username, display_name, avatar_url, privacy
    FROM public.profiles
   WHERE username IS NOT NULL;

COMMENT ON VIEW public.profile_cards IS
  'Every profile that has a username, whatever its privacy, limited to the columns a search result and a locked profile header show. Bio and created_at are deliberately absent — they stay behind the RLS on public.profiles. Read by lib/people-search.ts and app/u/[username]/page.tsx.';

-- v26 revoked every grant on schema public from anon and authenticated and
-- altered default privileges to keep revoking them, so a new view starts
-- unreadable and has to be granted back by name.
GRANT SELECT ON public.profile_cards TO anon, authenticated;
GRANT SELECT ON public.profile_cards TO service_role;

COMMIT;

-- PostgREST caches the schema, and a brand-new view is invisible over the REST
-- API until it reloads. Supabase normally fires this itself on DDL; this is
-- here so that "the view exists but /rest/v1/profile_cards 404s" is not a
-- mystery for the ten minutes before the cache turns over on its own.
NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- VERIFY
--
-- 1. No followers_only rows survive, and none can be written:
--
--      SELECT privacy, count(*) FROM public.profiles GROUP BY privacy;
--      -- expect only 'public' and 'private'
--
--      UPDATE public.profiles SET privacy = 'followers_only'
--       WHERE id = (SELECT id FROM public.profiles LIMIT 1);
--      -- expect 23514 profiles_privacy_values, then ROLLBACK
--
-- 2. With the ANON key (not in this editor, which runs as postgres):
--
--      a private profile's card IS returned:
--        GET /rest/v1/profile_cards?select=username,privacy&privacy=eq.private
--
--      the same profile's row is still NOT returned from the table:
--        GET /rest/v1/profiles?select=username,bio&privacy=eq.private
--        -- expect []
--
--      and the bio is not reachable through the view at all:
--        GET /rest/v1/profile_cards?select=bio
--        -- expect 42703, column does not exist
-- ---------------------------------------------------------------------------
