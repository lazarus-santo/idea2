-- migration_v51: a follower list is for people with accounts
--
-- HOW TO APPLY: paste into the Supabase SQL editor as role `postgres`
-- (dashboard/project/sgkycnecmdxvujybsuev/sql/new). Safe to re-run.
--
-- ---------------------------------------------------------------------------
-- WHAT CHANGES
--
-- Who somebody follows, and who follows them, now requires an account to see.
-- The two NUMBERS stay public — v44 made that call deliberately and nothing
-- here disturbs it. Knowing an account has forty followers reveals nothing
-- about who they are; the list of forty names is the part that does.
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS A GRANT AND NOT A CHANGE IN THE APP
--
-- The obvious version of this feature is to stop rendering the lists when
-- nobody is signed in. That would be theatre. public.profile_followers() and
-- public.profile_following() are GRANTed to `anon`, which means they are HTTP
-- endpoints that answer to the anon key — and the anon key ships inside every
-- browser that loads the site. A signed-out visitor who opened devtools would
-- still have both lists, with the UI politely declining to show them.
--
-- So the gate is the grant. After this, a caller with no session gets 42501
-- from Postgres, and the sign-in prompt in the UI is a description of what the
-- database will do rather than a substitute for it.
--
-- REFUSED, NOT EMPTIED. Both functions could have been left callable and
-- taught to return no rows without a session. An empty list and a forbidden
-- one are different facts, and a function that quietly returns nothing is
-- indistinguishable from an account with no followers — which is a bug report
-- waiting to happen and a lie in the meantime. v47 took the same position on
-- feed_events() for the same reason: the grant should say what the surface is.
--
-- ---------------------------------------------------------------------------
-- WHAT IS DELIBERATELY UNTOUCHED
--
-- follow_counts()      still anon. The numbers are public, as above.
-- profile_card()       still anon. A profile has to be findable by a stranger
--                      — including a signed-out one — or search and every
--                      shared link break.
-- search_profile_cards() still anon, for the same reason.
-- can_view_profile()   still anon. It answers about privacy and blocks and is
--                      called from the events read policy, which anon uses.
--
-- The privacy and block gates inside both functions stay exactly as they were.
-- This is a THIRD condition stacked in front of them, not a replacement: a
-- signed-in visitor still cannot read a private account's lists without being
-- an approved follower, and still cannot see anyone across a block.
-- ---------------------------------------------------------------------------

BEGIN;

REVOKE EXECUTE ON FUNCTION public.profile_followers(uuid, integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.profile_following(uuid, integer) FROM anon;

-- Restated rather than assumed: REVOKE above and GRANT here are the whole
-- policy for these two, so both halves should be visible in one place.
GRANT EXECUTE ON FUNCTION public.profile_followers(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.profile_following(uuid, integer) TO authenticated;

COMMENT ON FUNCTION public.profile_followers(uuid, integer) IS
  'A profile''s approved followers. Signed-in callers only (v51) — the anon key is in every browser, so a UI-only gate would not be one. Still refuses a private profile''s list to anyone who cannot see the profile, and still drops accounts on the other side of a block in either direction.';
COMMENT ON FUNCTION public.profile_following(uuid, integer) IS
  'The accounts a profile follows. Signed-in callers only (v51); same conditions as profile_followers.';

COMMIT;

-- PostgREST caches which functions it will route to, and for whom.
NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- VERIFY (with the ANON key and no session — this editor runs as postgres)
--
-- 1. The lists are refused:
--      POST /rest/v1/rpc/profile_followers {"profile_id":"<a public account>"}
--      POST /rest/v1/rpc/profile_following {"profile_id":"<a public account>"}
--      -- expect 42501 for both. Before this migration they returned the rows.
--
-- 2. The counts are NOT:
--      POST /rest/v1/rpc/follow_counts {"profile_id":"<the same account>"}
--      -- expect one row, unchanged
--
-- 3. Finding people still works signed out:
--      POST /rest/v1/rpc/profile_card {"handle":"<any handle>"}
--      POST /rest/v1/rpc/search_profile_cards {"q":"<two or more characters>"}
--      -- expect rows for both
--
-- 4. And a signed-in caller still gets the lists, still gated by privacy and
--    blocks: scripts/test-relationships.mjs covers that and should be
--    unchanged by this migration.
-- ---------------------------------------------------------------------------
