-- migration_v41: remove a person's uploaded files when their account is deleted
--
-- ############################################################################
-- ## DO NOT APPLY. THIS MIGRATION IS WRONG AND WAS REVERTED BY v42.         ##
-- ##                                                                        ##
-- ## Applied 2026-09-17 and rolled back within minutes: it BROKE ACCOUNT    ##
-- ## DELETION ENTIRELY. Supabase guards storage.objects against direct      ##
-- ## DELETE ("42501: Direct deletion from storage tables is not allowed.    ##
-- ## Use the Storage API instead."), SECURITY DEFINER does not bypass it,   ##
-- ## and the guard rejects the statement even when it matches no rows — so  ##
-- ## every deletion failed, including for users with no avatar.             ##
-- ##                                                                        ##
-- ## Kept only as the record of what was tried. See migration_v42.sql for   ##
-- ## the rollback and for the approaches that can actually work (all of     ##
-- ## them go through the Storage API, not the database).                    ##
-- ############################################################################
--
-- HOW TO APPLY: paste into the Supabase SQL editor as role `postgres`
-- (dashboard/project/sgkycnecmdxvujybsuev/sql/new). There is no psql, no
-- Supabase CLI and no DATABASE_URL in this project.
--
-- ---------------------------------------------------------------------------
-- THE GAP THIS CLOSES
--
-- public.profiles is removed by the ON DELETE CASCADE from auth.users
-- (migration_v40), so the database side of an account deletion already tidies
-- itself. Storage does not: an avatar lives in the `avatars` bucket under
-- <uid>/<file>, and nothing links it back to the account. Delete the account
-- and the image stays in the bucket with no owner.
--
-- That is not hypothetical — a leftover avatar from a test account deleted
-- days earlier was found still sitting in the bucket, and it got there by the
-- most ordinary route imaginable: deleting the user from the dashboard. Any
-- fix that lives only in the app's own delete-account endpoint would have
-- missed it, which is why this is a database trigger.
--
-- WHY storage.objects DIRECTLY
--
-- Supabase keeps each file's metadata as a row in storage.objects, an ordinary
-- table in this same database. A trigger can therefore delete the row with
-- plain SQL — no HTTP call, and no service key stored in the database, which
-- is what a pg_net or Edge Function approach would need.
--
-- KNOWN LIMIT, worth stating plainly: removing the row removes the object from
-- the bucket — it stops being listed, served, or counted by the storage API.
-- Whether the underlying bytes are also reclaimed from the storage backend is
-- Supabase's business and not guaranteed by this delete. If the project ever
-- needs certified byte-level deletion (a GDPR erasure request, say), do it
-- through the storage API as well — which is exactly what the app's
-- /api/account/delete route already does, and is one reason to keep it.
--
-- BOTH TABLES ON PURPOSE
--
-- Deleting an auth user cascades to the profile, so a trigger on either one
-- would catch the ordinary path. They are both here because the two tables
-- can be deleted independently: the dashboard's Authentication screen removes
-- an auth.users row, while its table editor can remove a profiles row on its
-- own. Whichever goes first, the files go with it. Running twice is harmless —
-- the second delete simply matches nothing.
-- ---------------------------------------------------------------------------

BEGIN;

-- Scoped to the buckets that hold per-user uploads, keyed by the convention
-- those uploads follow: the first path segment is the owner's uuid, which is
-- also what the storage RLS policies in migration_v40 match on.
-- ADD NEW BUCKETS HERE when per-user uploads grow beyond avatars.
CREATE OR REPLACE FUNCTION public.delete_user_storage_objects(target_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, storage, pg_temp
AS $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM storage.objects
  WHERE bucket_id IN ('avatars')
    AND (storage.foldername(name))[1] = target_user_id::text;

  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

COMMENT ON FUNCTION public.delete_user_storage_objects(uuid) IS
  'Deletes every per-user uploaded file owned by the given uuid. Called by the account-deletion triggers; safe to call directly for cleanup.';

CREATE OR REPLACE FUNCTION public.handle_deleted_user_storage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, storage, pg_temp
AS $$
BEGIN
  PERFORM public.delete_user_storage_objects(OLD.id);
  RETURN OLD;
END;
$$;

-- auth.users: covers the app's own delete-account route, the dashboard's
-- Authentication → Users → Delete, and admin.deleteUser from any script.
DROP TRIGGER IF EXISTS on_auth_user_deleted_clear_storage ON auth.users;
CREATE TRIGGER on_auth_user_deleted_clear_storage
  BEFORE DELETE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_deleted_user_storage();

-- public.profiles: covers deleting the profile row on its own, e.g. from the
-- dashboard's table editor, which never touches auth.users.
DROP TRIGGER IF EXISTS on_profile_deleted_clear_storage ON public.profiles;
CREATE TRIGGER on_profile_deleted_clear_storage
  AFTER DELETE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.handle_deleted_user_storage();

COMMIT;

-- ---------------------------------------------------------------------------
-- VERIFY (after committing):
--
--   -- both triggers present
--   SELECT tgname, tgrelid::regclass
--   FROM pg_trigger
--   WHERE tgname IN ('on_auth_user_deleted_clear_storage',
--                    'on_profile_deleted_clear_storage');
--
--   -- nothing in the bucket without a matching account
--   SELECT o.name
--   FROM storage.objects o
--   WHERE o.bucket_id = 'avatars'
--     AND NOT EXISTS (
--       SELECT 1 FROM auth.users u
--       WHERE u.id::text = (storage.foldername(o.name))[1]
--     );
-- ---------------------------------------------------------------------------
