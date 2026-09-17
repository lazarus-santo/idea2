-- migration_v46: drop the profile_cards view
--
-- RUN THIS ONLY AFTER the code that uses migration_v45's functions is
-- DEPLOYED. Until then the live app still reads this view, and dropping it
-- early takes person search and every profile page down with it.
--
-- Nothing in the schema depends on it: migration_v44's functions read
-- public.profiles directly, and the only readers were lib/people-search.ts and
-- app/u/[username]/page.tsx, both of which now call profile_card() and
-- search_profile_cards() instead.
--
-- This is what clears the Security Advisor's "security definer view" finding.
-- The elevation it was pointing at has not disappeared — it moved into two
-- functions with fixed signatures and bounded results, which is the part that
-- actually reduces the risk. See the header of migration_v45 for the full
-- reasoning and for the evidence that the view was never leaking.

BEGIN;

DROP VIEW IF EXISTS public.profile_cards;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- VERIFY, with the anon key:
--   GET /rest/v1/profile_cards?select=*   -- expect 404: the view is gone
--   POST /rest/v1/rpc/profile_card {"handle":"<a private handle>"} -- expect one row
