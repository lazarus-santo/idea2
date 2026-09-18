-- migration_v52: actually close the functions v44, v48 and v51 only thought
-- they had closed
--
-- HOW TO APPLY: paste into the Supabase SQL editor as role `postgres`
-- (dashboard/project/sgkycnecmdxvujybsuev/sql/new). Safe to re-run.
--
-- IT ENDS WITH A SELECT. Read what it prints — that is the verification, and
-- it is in the file precisely because three migrations in a row have claimed
-- to revoke something and not revoked it.
--
-- ---------------------------------------------------------------------------
-- WHAT IS WRONG, MEASURED RATHER THAN ASSUMED
--
-- Probed against production with the anon key and no session, after v51:
--
--   feed_events()             -> 42501  refused          (v47)
--   pending_follow_requests() -> []     ANSWERED         (v44)
--   blocked_profiles()        -> []     ANSWERED         (v48)
--   muted_profiles()          -> []     ANSWERED         (v48)
--   profile_followers()       -> rows   ANSWERED         (v51)
--
-- Every one of those was written the same way:
--
--   REVOKE EXECUTE ON FUNCTION f FROM anon;
--   GRANT  EXECUTE ON FUNCTION f TO authenticated;
--
-- One of the five refuses. The other four do not. So the line is not the gate
-- it reads as, and has not been since v44.
--
-- THE REASON: Postgres grants EXECUTE on a new function to PUBLIC. `anon` is a
-- login role like any other and is therefore a member of PUBLIC, so it holds
-- EXECUTE twice over — once through whatever explicit grant exists, and once
-- through PUBLIC. `REVOKE ... FROM anon` removes only the first. The second is
-- untouched and is sufficient on its own, which is why the call still
-- succeeds. Revoking from PUBLIC is the part that was missing.
--
-- (feed_events is the exception rather than the rule, and this migration does
-- not depend on knowing why — it revokes PUBLIC there too, which is a no-op if
-- something already did.)
--
-- HOW MUCH DID THIS LEAK: the three older ones, nothing. blocked_profiles(),
-- muted_profiles() and pending_follow_requests() all key on auth.uid() and take
-- no argument, so a caller with no session gets an empty set no matter who is
-- asking — the emptiness above is the function working, not the grant. They
-- were reachable, not revealing. profile_followers() and profile_following()
-- are the real exposure, because they take a profile id: before v51 that was
-- intended, and v51 is what failed to end it.
--
-- WHY v49 DID NOT CATCH THIS. v48 shipped the same broken line, the probe
-- caught it, and the fix was to move those two helpers into a schema PostgREST
-- does not serve. That worked, and it stopped the investigation one step early:
-- routing made the grant irrelevant instead of making it correct, so the
-- underlying mistake survived into v51. Moving a function out of reach is the
-- right answer when nothing should call it over HTTP. These five are different
-- — `authenticated` must reach them — so here the grant has to be right.
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Revoke from PUBLIC, which is the part that was missing, and from anon,
--    which is the part that was already there.
--
--    FROM PUBLIC is not a superset of FROM anon: an explicit grant to anon and
--    an implicit one through PUBLIC are separate entries, and both have to go.
--    Re-running either is harmless.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.profile_followers(uuid, integer)        FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.profile_following(uuid, integer)        FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.pending_follow_requests()               FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.blocked_profiles()                      FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.muted_profiles()                        FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.feed_events(integer, timestamptz, uuid) FROM PUBLIC, anon;

-- ---------------------------------------------------------------------------
-- 2. Hand back what should be there, explicitly.
--
--    Revoking PUBLIC takes EXECUTE away from everybody who was relying on it,
--    service_role included, so every role that needs these has to be named. The
--    owner (postgres) always can and needs nothing.
-- ---------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.profile_followers(uuid, integer)        TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.profile_following(uuid, integer)        TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pending_follow_requests()               TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.blocked_profiles()                      TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.muted_profiles()                        TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.feed_events(integer, timestamptz, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. The functions that stay open to anon, restated so that this file is the
--    whole picture and nobody has to diff five migrations to see it.
--
--    Each is deliberate: a profile must be findable by a stranger or search and
--    shared links break, counts are public by the decision in v44, and
--    can_view_profile() is called from the events read policy, which anon uses.
-- ---------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.profile_card(text)                  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_profile_cards(text, integer) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.follow_counts(uuid)                 TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_view_profile(uuid)              TO anon, authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- VERIFY — this runs here, in the editor, and prints the answer.
--
-- Expected: has_anon FALSE for the first six, TRUE for the last four, and
-- has_authed TRUE for all ten. Anything else means this migration did not do
-- what it says and should be reported before the app is trusted to match.
-- ---------------------------------------------------------------------------
SELECT p.proname AS function,
       has_function_privilege('anon',          p.oid, 'EXECUTE') AS has_anon,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS has_authed
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN (
     'profile_followers', 'profile_following', 'pending_follow_requests',
     'blocked_profiles', 'muted_profiles', 'feed_events',
     'profile_card', 'search_profile_cards', 'follow_counts', 'can_view_profile'
   )
 ORDER BY has_anon, p.proname;
