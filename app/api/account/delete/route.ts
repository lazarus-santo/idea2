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
  const { data: files } = await admin.storage.from('avatars').list(user.id)
  if (files?.length) {
    await admin.storage
      .from('avatars')
      .remove(files.map((f) => `${user.id}/${f.name}`))
  }

  const { error: deleteError } = await admin.auth.admin.deleteUser(user.id)
  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 500 })
  }

  // Clear the cookies of the account that no longer exists.
  await supabase.auth.signOut()

  return NextResponse.json({ ok: true })
}
