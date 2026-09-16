import 'server-only'

import { cache } from 'react'
import { redirect } from 'next/navigation'
import { getSupabaseServer } from '@/lib/supabase-server'
import { PROFILE_COLUMNS, type Profile } from '@/lib/profile'

/**
 * The one place the server asks "who is this, and are they allowed?".
 *
 * Next's docs call this a Data Access Layer, and the reason it exists rather
 * than an auth check in a layout is that layouts do not re-render on client
 * navigation — a check there is skipped on every link the person clicks after
 * the first. Checks belong next to the data instead, which is here.
 *
 * Each function is wrapped in React's cache(), so calling getCurrentUser() in
 * a page and again in a component costs one call per render, not two.
 */

/**
 * The signed-in user, verified with the auth server.
 *
 * getUser() is deliberate: getSession()/getClaims() read the cookie, which the
 * browser can edit. Anything that decides access uses this.
 */
export const getCurrentUser = cache(async () => {
  const supabase = await getSupabaseServer()
  const { data, error } = await supabase.auth.getUser()
  if (error) return null
  return data.user ?? null
})

/**
 * The signed-in person's own profile row.
 *
 * Read through their session, so RLS applies — the "own row" half of the
 * select policy is what lets this return a private profile to its owner.
 * Returns null when signed out. The row itself always exists for a signed-in
 * user: migration_v40's trigger creates it inside the signup transaction.
 */
export const getOwnProfile = cache(async (): Promise<Profile | null> => {
  const user = await getCurrentUser()
  if (!user) return null

  const supabase = await getSupabaseServer()
  const { data, error } = await supabase
    .from('profiles')
    .select(PROFILE_COLUMNS)
    .eq('id', user.id)
    .maybeSingle<Profile>()

  // Returning null here sends the person back through onboarding, so a
  // database failure would quietly look like a brand-new account. Log it.
  if (error) {
    console.error('[auth] own profile lookup failed:', error.message)
    return null
  }

  return data ?? null
})

/** For pages that require a session; sends signed-out visitors to sign in. */
export async function requireUser() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  return user
}

/**
 * For pages that require a finished account.
 *
 * A NULL username means signup completed but onboarding did not, so the person
 * has no handle and no profile page yet. They go to /onboarding until they do.
 */
export async function requireOnboardedProfile(): Promise<Profile> {
  await requireUser()
  const profile = await getOwnProfile()
  if (!profile) redirect('/login')
  if (!profile.username) redirect('/onboarding')
  return profile
}
