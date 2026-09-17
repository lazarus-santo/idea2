'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { getSupabaseBrowser } from '@/lib/supabase-browser'
import { profileDisplayName, profilePath, type Profile } from '@/lib/profile'

/**
 * The nav's account item, placed after Search in every copy of the nav:
 * "Sign in" when signed out, your photo (or initial) when signed in, and
 * "Finish setup" for someone who signed up but never picked a username.
 *
 * A CLIENT component, reading the session in the browser. Seven of the eight
 * navs live inside client components, which cannot render a Server Component,
 * and reading cookies on the server would also force every page that shows the
 * nav to render per visitor instead of being cached. The profile is read under
 * the visitor's own session, so RLS returns their row even when it is private.
 *
 * Until the session is known the item renders invisibly at "Sign in" width, so
 * the nav neither jumps nor flashes the wrong label for a signed-in visitor.
 */

type NavProfile = Pick<Profile, 'username' | 'display_name' | 'avatar_url'>

type AccountState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; profile: NavProfile | null; failed: boolean }

/** Pages where "come back here after signing in" makes no sense. */
const NO_RETURN = ['/login', '/forgot-password', '/reset-password', '/onboarding', '/auth']

export default function AccountNav() {
  const pathname = usePathname()
  const [state, setState] = useState<AccountState>({ status: 'loading' })

  useEffect(() => {
    const supabase = getSupabaseBrowser()
    let cancelled = false

    async function load(userId: string | null) {
      if (!userId) {
        if (!cancelled) setState({ status: 'signed-out' })
        return
      }
      const { data, error } = await supabase
        .from('profiles')
        .select('username, display_name, avatar_url')
        .eq('id', userId)
        .maybeSingle<NavProfile>()
      if (error) console.error('[nav] own profile lookup failed:', error.message)
      if (!cancelled) setState({ status: 'signed-in', profile: data ?? null, failed: !!error })
    }

    // Fires once immediately with the current session (INITIAL_SESSION), then
    // again on sign-in/out in another tab. Token refreshes are ignored: the
    // person hasn't changed. The query is deferred because awaiting Supabase
    // calls inside this callback can deadlock the auth client.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'TOKEN_REFRESHED') return
      setTimeout(() => load(session?.user.id ?? null), 0)
    })

    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [])

  if (state.status === 'loading') {
    return (
      <span className="ep-nav-search ep-nav-account" style={{ visibility: 'hidden' }} aria-hidden="true">
        Sign in
      </span>
    )
  }

  if (state.status === 'signed-out') {
    const returnHere = pathname && pathname !== '/' && !NO_RETURN.some(p => pathname.startsWith(p))
    const href = returnHere ? `/login?next=${encodeURIComponent(pathname)}` : '/login'
    return <Link href={href} className="ep-nav-search ep-nav-account">Sign in</Link>
  }

  const { profile, failed } = state

  // Couldn't read the profile: don't claim setup is unfinished when it may not be.
  if (failed) {
    return <Link href="/settings" className="ep-nav-search ep-nav-account">Account</Link>
  }

  if (!profile?.username) {
    return (
      <Link href="/onboarding" className="ep-nav-search ep-nav-account">
        <span className="ep-nav-long">Finish&nbsp;</span>setup
      </Link>
    )
  }

  const name = profileDisplayName(profile)
  return (
    <Link
      href={profilePath(profile.username)}
      className="ep-nav-search ep-nav-account"
      title={name}
      aria-label={`Your profile (${name})`}
    >
      {profile.avatar_url
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={profile.avatar_url} alt="" className="ep-nav-avatar" />
        : <span className="ep-nav-initial" aria-hidden="true">{name.charAt(0).toUpperCase()}</span>}
    </Link>
  )
}
