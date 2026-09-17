-- migration_v42: revert migration_v41 — a trigger cannot delete from storage
--
-- APPLIED 2026-09-17, immediately after v41, because v41 broke account
-- deletion in production.
--
-- ---------------------------------------------------------------------------
-- WHAT WENT WRONG
--
-- v41 assumed storage.objects is an ordinary table that a SECURITY DEFINER
-- trigger could DELETE from. It is not. Supabase installs a guard on it:
--
--   42501: Direct deletion from storage tables is not allowed.
--          Use the Storage API instead.
--   hint:  This prevents accidental data loss from orphaned objects.
--
-- SECURITY DEFINER does not bypass it, and the guard rejects the DELETE
-- statement itself rather than any row it happens to match — so it fired even
-- for a user with no avatar at all. The result was that EVERY account
-- deletion failed, by both paths:
--
--   * deleting a profiles row  -> 42501, as above
--   * admin.deleteUser(...)    -> "Database error deleting user"
--
-- Real accounts were left undeletable and the app's Delete Account button
-- would have failed for anyone who pressed it. The fix was to roll back, not
-- to fix forward, so that deletion was working again within minutes.
--
-- The Storage API itself was never affected: upload and remove through the API
-- were re-verified working while the trigger was still installed.
--
-- WHAT THIS MEANS FOR THE ORIGINAL PROBLEM
--
-- The gap v41 tried to close is still open: deleting an account does not
-- remove that person's avatar from the bucket, so a file can outlive its
-- owner. It cannot be closed inside the database. Any real fix has to go
-- through the Storage API, which means app or platform code:
--
--   * a Database Webhook on auth.users DELETE calling an Edge Function that
--     uses the Storage API — the only option that catches a dashboard
--     deletion at the moment it happens;
--   * a scheduled sweep that lists bucket folders with no matching account and
--     removes them via the API — simple and catches everything eventually,
--     but not immediately;
--   * the app's own /api/account/delete route, which already does this
--     correctly and is unaffected by any of the above — but only covers
--     deletions made through the app.
-- ---------------------------------------------------------------------------

BEGIN;

DROP TRIGGER IF EXISTS on_auth_user_deleted_clear_storage ON auth.users;
DROP TRIGGER IF EXISTS on_profile_deleted_clear_storage ON public.profiles;
DROP FUNCTION IF EXISTS public.handle_deleted_user_storage();
DROP FUNCTION IF EXISTS public.delete_user_storage_objects(uuid);

COMMIT;

-- ---------------------------------------------------------------------------
-- VERIFY (after committing):
--
--   -- no triggers left
--   SELECT tgname, tgrelid::regclass FROM pg_trigger
--   WHERE tgname IN ('on_auth_user_deleted_clear_storage',
--                    'on_profile_deleted_clear_storage');
--   -- expect: 0 rows
--
--   -- and deletion works again: create a throwaway in the dashboard and
--   -- delete it. It should delete without error.
-- ---------------------------------------------------------------------------
