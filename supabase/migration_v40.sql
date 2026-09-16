-- migration_v40: identity — public.profiles, auto-creation on signup, RLS
--
-- Phase 1 of the social features track: accounts only. No log, no ratings, no
-- follow graph, no exhibition references. Nothing in this file touches an
-- existing table, so it cannot affect Agent 1/2/3 or the public site.
--
-- HOW TO APPLY: paste into the Supabase SQL editor as role `postgres`
-- (dashboard/project/sgkycnecmdxvujybsuev/sql/new). There is no psql, no
-- Supabase CLI and no DATABASE_URL in this project — every migration here is
-- applied by hand. Verify afterwards by probing PostgREST with the anon key
-- rather than trusting the editor's "Success".
--
-- ---------------------------------------------------------------------------
-- WHY A SEPARATE TABLE FROM auth.users
--
-- auth.users is Supabase's own table. It holds the login identity (email,
-- provider, hashed password) and is not safely readable by the browser. Public
-- profile data therefore lives in public.profiles, one row per account, keyed
-- by the same uuid.
--
-- WHY THE PROFILE ROW IS CREATED BY A TRIGGER, NOT BY APP CODE
--
-- If the app created it as a second step after signup, any failure between the
-- two — a closed tab, a network drop, a provider redirect that never lands —
-- produces an account that can log in but has no profile row, and every page
-- that reads a profile then has to handle a user who does not exist. The
-- trigger makes the two atomic: auth.users and public.profiles are written in
-- the same transaction, so the profile cannot be missing.
--
-- WHY THE TRIGGER COPIES NOTHING FROM THE PROVIDER
--
-- Sign in with Apple lets a person hide their real name and email. When they
-- do, Apple sends a relay address and either no name or a placeholder, and it
-- sends the name ONLY on the very first authorization — never again. A trigger
-- that trusted that payload would store a blank or throwaway display name and
-- have no way to correct it. So the row is created empty and every visible
-- field is confirmed by the person during onboarding. The provider's values
-- may be offered as a pre-filled suggestion in the UI; they are never written
-- here.
--
-- WHY username IS NULLABLE
--
-- It cannot be known at signup — the person picks it during onboarding, which
-- happens after the account exists. Postgres allows many NULLs in a UNIQUE
-- column, so unclaimed usernames do not collide. A NULL username is the
-- marker for "has not finished onboarding"; the app sends those people to
-- /onboarding.
--
-- FORWARD-LOOKING (no action here)
--
-- Gallery/org accounts will be a SEPARATE table later, not a role flag on this
-- one. Nothing in this file assumes profiles is the only kind of account:
-- there is no `type`/`is_gallery` column to unpick, and no other table points
-- at profiles yet. When galleries arrive, the one thing to decide is whether
-- the two share a username namespace; if they do, the migration is to extract
-- the UNIQUE(username) constraint here into a shared handles table. That is a
-- mechanical change while profiles is the only claimant, which is the point.
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Reserved usernames.
--
-- A table rather than a CHECK constraint so the list can grow without a
-- migration — every new top-level route added to the app is a name that must
-- not already belong to a person. Seeded with the current app routes plus the
-- usual impersonation risks.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reserved_usernames (
  username text PRIMARY KEY
);

COMMENT ON TABLE public.reserved_usernames IS
  'Usernames nobody may claim: app routes and impersonation risks. Enforced by the profiles_username_not_reserved trigger. Add a row here whenever a new top-level route is added.';

INSERT INTO public.reserved_usernames (username) VALUES
  -- current and planned app routes
  ('admin'), ('api'), ('auth'), ('login'), ('logout'), ('signin'), ('signup'),
  ('settings'), ('onboarding'), ('u'), ('user'), ('users'), ('profile'),
  ('profiles'), ('account'), ('accounts'), ('exhibitions'), ('exhibition'),
  ('readings'), ('reading'), ('editors-picks'), ('editorspicks'), ('map'),
  ('search'), ('venues'), ('venue'), ('artists'), ('artist'), ('institutions'),
  ('institution'), ('galleries'), ('gallery'), ('museum'), ('museums'),
  ('crawl'), ('crawls'), ('log'), ('logs'), ('feed'), ('follow'), ('followers'),
  ('following'), ('reset-password'), ('new'), ('edit'), ('delete'),
  -- brand and impersonation
  ('idea2'), ('idea-2'), ('official'), ('staff'), ('team'), ('support'),
  ('help'), ('contact'), ('moderator'), ('mod'), ('root'), ('system'),
  ('about'), ('terms'), ('privacy'), ('legal'), ('security'), ('abuse'),
  -- technical lookalikes
  ('static'), ('public'), ('assets'), ('favicon'), ('robots'), ('sitemap'),
  ('rss'), ('www'), ('me'), ('null'), ('undefined'), ('anonymous'), ('everyone')
ON CONFLICT (username) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. The profiles table.
--
-- username is stored lower-case (enforced by the CHECK) so that UNIQUE is
-- itself case-insensitive — @Franklin and @franklin cannot both exist, which
-- is what stops username-lookalike impersonation. Display name carries the
-- capitalisation a person actually wants shown.
--
-- privacy is stored as text with a CHECK rather than a Postgres enum: adding a
-- value to an enum is a schema change that cannot run inside some transactions,
-- and this list will grow as the social features land.
--
-- 'followers_only' is a STORED VALUE ONLY in this phase. There is no follow
-- graph to check against, so section 5's read policy treats it exactly like
-- 'private'. When follows ship, only that policy changes — no data migration,
-- because people's choices are already recorded here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
  id           uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username     text UNIQUE,
  display_name text,
  avatar_url   text,
  bio          text,
  privacy      text NOT NULL DEFAULT 'public',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  -- 3-30 chars, lower-case letters/digits/underscore, no leading or trailing
  -- underscore. Mirrored in lib/profile.ts so the browser can show the same
  -- rule before a write is attempted; this constraint is what enforces it.
  CONSTRAINT profiles_username_format
    CHECK (username IS NULL OR username ~ '^[a-z0-9][a-z0-9_]{1,28}[a-z0-9]$'),
  CONSTRAINT profiles_display_name_length
    CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 50),
  CONSTRAINT profiles_bio_length
    CHECK (bio IS NULL OR char_length(bio) <= 300),
  CONSTRAINT profiles_avatar_url_length
    CHECK (avatar_url IS NULL OR char_length(avatar_url) <= 500),
  CONSTRAINT profiles_privacy_values
    CHECK (privacy IN ('public', 'private', 'followers_only'))
);

COMMENT ON TABLE public.profiles IS
  'One row per personal account, created automatically by handle_new_user() on auth.users insert. Gallery/org accounts will be a separate table, not a flag here.';
COMMENT ON COLUMN public.profiles.username IS
  'Lower-case handle, unique. NULL means onboarding is not finished yet.';
COMMENT ON COLUMN public.profiles.privacy IS
  'public | private | followers_only. followers_only is stored but reads as private until the follow graph exists.';

CREATE INDEX IF NOT EXISTS idx_profiles_username ON public.profiles(username);

-- Same helper as migration_v2; redeclared identically so this file can be
-- applied to a database where v2's function is missing.
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS profiles_updated_at ON public.profiles;
CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Reserved-name enforcement.
--
-- SECURITY DEFINER because the list itself is not readable by anon or
-- authenticated (no grant in section 6). The check has to run with the
-- function owner's privileges, or claiming any username would fail for lack of
-- read access to reserved_usernames.
--
-- search_path is pinned: a SECURITY DEFINER function without it can be tricked
-- into resolving `reserved_usernames` to a table the caller controls.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.profiles_reject_reserved_username()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.username IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.reserved_usernames r WHERE r.username = NEW.username)
  THEN
    RAISE EXCEPTION 'username_reserved'
      USING HINT = 'That username is reserved.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_username_not_reserved ON public.profiles;
CREATE TRIGGER profiles_username_not_reserved
  BEFORE INSERT OR UPDATE OF username ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_reject_reserved_username();

-- ---------------------------------------------------------------------------
-- 4. Auto-create the profile row on signup.
--
-- AFTER INSERT on auth.users, in the same transaction as the signup itself.
-- Writes nothing but the id: see the header on why the provider payload is not
-- trusted. ON CONFLICT DO NOTHING so a replayed or manually-inserted user
-- cannot fail signup.
--
-- SECURITY DEFINER so the insert happens as the function owner (postgres);
-- the signup path itself runs as supabase_auth_admin, which has no privileges
-- on public.profiles.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.profiles (id) VALUES (NEW.id)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 5. Row Level Security.
--
-- migration_v26 set this database to deny-by-default for the browser-facing
-- roles: it revoked every grant on schema public from anon and authenticated
-- and altered default privileges to keep revoking them. A new table therefore
-- starts unreadable, and both halves have to be granted back deliberately —
-- the policy decides which ROWS, the grant (section 6) decides which COLUMNS.
--
-- Read rules:
--   anon           → public rows only.
--   authenticated  → public rows, plus their own row whatever its privacy.
-- private and followers_only rows are invisible to everyone else, with no
-- exception: there is no follow graph yet to make an exception against. A
-- hidden profile is not distinguishable from a username that was never
-- claimed, which is the stronger position anyway.
--
-- Write rules: a person may UPDATE only their own row, and the WITH CHECK
-- keeps them from moving the row to somebody else's id. There is deliberately
-- no INSERT or DELETE policy — creation belongs to the trigger in section 4,
-- and deletion to /api/account/delete, which holds the service role and
-- removes the auth.users row (this table cascades from it).
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reserved_usernames  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS profiles_anon_read_public          ON public.profiles;
DROP POLICY IF EXISTS profiles_auth_read_public_and_own  ON public.profiles;
DROP POLICY IF EXISTS profiles_auth_update_own           ON public.profiles;

CREATE POLICY profiles_anon_read_public ON public.profiles
  FOR SELECT TO anon
  USING (privacy = 'public');

CREATE POLICY profiles_auth_read_public_and_own ON public.profiles
  FOR SELECT TO authenticated
  USING (privacy = 'public' OR id = (SELECT auth.uid()));

CREATE POLICY profiles_auth_update_own ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = (SELECT auth.uid()))
  WITH CHECK (id = (SELECT auth.uid()));

-- reserved_usernames: RLS on, no policy, no grant — nobody but the service
-- role and the SECURITY DEFINER trigger can see it.

-- ---------------------------------------------------------------------------
-- 6. Column grants.
--
-- updated_at is withheld from readers: it is bookkeeping, and on a profile it
-- would broadcast when somebody last edited themselves. id is granted because
-- the avatar path is keyed by it and a future follow graph will join on it.
--
-- The UPDATE grant deliberately omits id, created_at and updated_at, so those
-- cannot be rewritten even by their owner.
-- ---------------------------------------------------------------------------
GRANT SELECT (id, username, display_name, avatar_url, bio, privacy, created_at)
  ON public.profiles TO anon, authenticated;

GRANT UPDATE (username, display_name, avatar_url, bio, privacy)
  ON public.profiles TO authenticated;

GRANT ALL ON public.profiles           TO service_role;
GRANT ALL ON public.reserved_usernames TO service_role;

-- ---------------------------------------------------------------------------
-- 7. Avatar storage.
--
-- One public bucket. Every file lives under a folder named with the owner's
-- uuid (`<uid>/<filename>`), which is what the policies match on, so nobody can
-- write into anybody else's folder. Public read because avatars appear on
-- public profiles; the 2MB cap and the mime list are enforced by storage
-- itself, not by the browser.
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('avatars', 'avatars', true, 2097152,
        ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE
  SET public             = EXCLUDED.public,
      file_size_limit    = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS avatars_public_read   ON storage.objects;
DROP POLICY IF EXISTS avatars_owner_insert  ON storage.objects;
DROP POLICY IF EXISTS avatars_owner_update  ON storage.objects;
DROP POLICY IF EXISTS avatars_owner_delete  ON storage.objects;

CREATE POLICY avatars_public_read ON storage.objects
  FOR SELECT TO anon, authenticated
  USING (bucket_id = 'avatars');

CREATE POLICY avatars_owner_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );

CREATE POLICY avatars_owner_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );

CREATE POLICY avatars_owner_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );

COMMIT;

-- ---------------------------------------------------------------------------
-- VERIFY (run after committing, with the anon key, not in the editor):
--
--   curl -s -o /dev/null -w '%{http_code}\n' \
--     "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/profiles?select=id&limit=1" \
--     -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY"
--   → 200 with [] (table exists, no public rows yet), NOT 404.
--
--   curl -s "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/reserved_usernames?select=username&limit=1" \
--     -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY"
--   → permission denied. The list is service-role only.
-- ---------------------------------------------------------------------------
