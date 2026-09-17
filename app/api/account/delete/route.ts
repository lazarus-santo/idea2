import { NextResponse } from 'next/server'
import { getSupabaseServer } from '@/lib/supabase-server'
import { getSupabaseAdmin } from '@/lib/supabase'

/**
 * Delete the signed-in person's account, for good.
 *
 * Removing a row from auth.users needs the service role, so this is one of the
 * few account paths that cannot run in the browser. The identity it deletes is
 * never taken from the request body — it is read from the verified session, so
 * the request can only ever delete its own sender.
 *
 * public.profiles is removed by the ON DELETE CASCADE in migration_v40; the
 * avatar files are not, so they are cleared first. Anything left behind there
 * would be an orphaned public image of someone who asked to be gone.
 */
export async function POST() {
  const supabase = await getSupabaseServer()

  // getUser(), not getSession(): this is an irreversible action, so the
  // identity is confirmed with the auth server rather than read from a cookie.
  const { data: { user }, error: userError } = await supabase.auth.getUser()
  if (userError || !user) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  }

  const admin = getSupabaseAdmin()

  // Avatars live under a folder named with the person's uuid.
  //
  // migration_v41 puts a trigger on auth.users and public.profiles that clears
  // these rows too, so this step is belt-and-braces. It stays for two reasons:
  // it makes the deletion legible without having to know a database trigger
  // exists, and it is the one place where a storage failure can be caught and
  // logged. It also goes through the storage API rather than deleting rows,
  // which is the supported route to reclaiming the bytes themselves.
  //
  // A failure here is logged and does NOT abort the deletion: someone asking
  // to be deleted should not be kept because an image would not go away. The
  // trigger is the backstop, and the log line is how we would find out.
  const { data: files, error: listError } = await admin.storage.from('avatars').list(user.id)
  if (listError) {
    console.error('[account/delete] could not list avatars for', user.id, listError.message)
  } else if (files?.length) {
    const paths = files.map((f) => `${user.id}/${f.name}`)
    const { error: removeError } = await admin.storage.from('avatars').remove(paths)
    if (removeError) {
      console.error('[account/delete] avatar removal failed for', user.id, removeError.message)
    } else {
      console.log('[account/delete] removed', paths.length, 'avatar file(s) for', user.id)
    }
  }

  const { error: deleteError } = await admin.auth.admin.deleteUser(user.id)
  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 500 })
  }

  // Clear the cookies of the account that no longer exists.
  await supabase.auth.signOut()

  return NextResponse.json({ ok: true })
}
