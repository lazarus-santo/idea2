-- migration_v45: replace the profile_cards VIEW with two functions
--
-- RUN THIS ONE FIRST, BEFORE DEPLOYING THE MATCHING CODE. It only ADDS
-- functions; public.profile_cards is left in place so the currently-deployed
-- app keeps working. migration_v46 drops the view and must be run AFTER the
-- deploy, when nothing references it any more.
--
-- HOW TO APPLY: paste into the Supabase SQL editor as role `postgres`
-- (dashboard/project/sgkycnecmdxvujybsuev/sql/new).
--
-- ---------------------------------------------------------------------------
-- WHY, AND WHAT THE SECURITY ADVISOR WAS AND WAS NOT RIGHT ABOUT
--
-- Supabase's Security Advisor flags public.profile_cards as a SECURITY DEFINER
-- view. It is one, deliberately: v43 created it so that `anon` could learn a
-- private profile EXISTS — that is what makes a private account findable in
-- search and reachable at /u/<username>, which in turn is what makes the follow
-- request in v44 possible at all. Take the elevation away and a private account
-- becomes undiscoverable, which is where v43 started and why it was changed.
--
-- WAS IT LEAKING? No. Probed in production with the anon key before writing a
-- line of this:
--   * the view exposes exactly id, username, display_name, avatar_url, privacy
--   * asking it for `bio` returns 42703 — the column is not there to ask for
--   * no private bio appears in a full dump of the view
--   * public.profiles itself still returns only public rows to anon
--   * the view is not writable: UPDATE, DELETE and INSERT through it are all
--     refused 42501, because only SELECT was ever granted
-- So the advisor found a real property and drew the wrong conclusion from it.
-- The finding was a misconfiguration warning, not an exposure.
--
-- SO WHY CHANGE ANYTHING? Two reasons, neither of them the advisor's.
--
-- 1. A GRANTed view is a table to PostgREST: any caller can filter, order and
--    page through it freely. `GET /rest/v1/profile_cards?select=*` returns
--    EVERY account in one request. That is a user-list dump, available to
--    anyone holding the anon key, which is shipped in the browser. Harmless at
--    two accounts and not harmless later. A function exposes only the queries
--    it defines.
-- 2. A standing SECURITY DEFINER view is a maintenance hazard even when its
--    column list is right today. `CREATE OR REPLACE VIEW ... SELECT *` is one
--    careless edit away from publishing every column, and nothing would fail
--    loudly. The functions below name their five columns in a RETURNS TABLE
--    signature, so widening one is a deliberate act.
--
-- The privilege elevation itself does not go away and should not: it is the
-- mechanism. What changes is that it is now reachable only through two
-- specific questions — "show me the card for this handle" and "find cards
-- matching this search" — instead of through an open-ended table.
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. One card, by handle. Feeds /u/<username>.
--
-- Returns every claimed username whatever its privacy — that is the point.
-- bio and created_at are absent from the signature, so a private profile's
-- writing still cannot leave the database through here; the full row stays
-- behind the RLS on public.profiles, which this does not touch.
-- ---------------------------------------------------------------------------
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
   LIMIT 1;
$$;

COMMENT ON FUNCTION public.profile_card(text) IS
  'The discoverable half of one profile, by handle, whatever its privacy. Replaces the profile_cards view (v43). Deliberately SECURITY DEFINER: a private profile must be findable in order to be asked for access. Carries no bio and no created_at.';

-- ---------------------------------------------------------------------------
-- 2. Cards matching a search. Feeds person search.
--
-- Bounded on purpose, and this is the half that the old view could not do:
--
--   * a query shorter than 2 characters returns nothing, so there is no
--     "match everything" input
--   * max_rows is clamped to 50, so no caller can ask for the whole table
--
-- Neither makes enumeration impossible — anything searchable can be swept by
-- someone patient enough — but a single unauthenticated request can no longer
-- walk away with the user list, which is what the granted view allowed.
--
-- The ILIKE wildcards in the caller's text are escaped HERE rather than in the
-- browser, so the guarantee holds no matter who calls it. @handle is accepted
-- for the same reason: normalising in one place beats trusting every caller to.
-- Ranking stays in the application — it is presentation, and it is already
-- tested there.
-- ---------------------------------------------------------------------------
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
   ORDER BY p.username
   LIMIT LEAST(GREATEST(coalesce(max_rows, 50), 1), 50);
$$;

COMMENT ON FUNCTION public.search_profile_cards(text, integer) IS
  'Person search. Returns profiles of every privacy — a private account has to be findable to be asked for access — but never their bio. Requires 2+ characters and caps at 50 rows, so unlike the profile_cards view it cannot be used to dump the user list in one request.';

GRANT EXECUTE ON FUNCTION public.profile_card(text)                  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_profile_cards(text, integer) TO anon, authenticated;

-- Person search matches display_name as well as username, and neither is
-- indexed for it. Two rows today; this is the index to add when that changes:
--   CREATE EXTENSION IF NOT EXISTS pg_trgm;
--   CREATE INDEX idx_profiles_username_trgm     ON public.profiles USING gin (username gin_trgm_ops);
--   CREATE INDEX idx_profiles_display_name_trgm ON public.profiles USING gin (display_name gin_trgm_ops);

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- VERIFY (with the ANON key — this editor runs as postgres and bypasses RLS)
--
--   POST /rest/v1/rpc/profile_card          {"handle": "<a private handle>"}
--   -- expect one row, with privacy 'private' and no bio field
--
--   POST /rest/v1/rpc/search_profile_cards  {"q": "a"}
--   -- expect [] : one character is below the floor
--
--   GET  /rest/v1/profiles?select=bio
--   -- expect only public rows, unchanged by this migration
-- ---------------------------------------------------------------------------
