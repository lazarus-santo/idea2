import Link from 'next/link'
import { getOwnProfile } from '@/lib/auth'
import { profilePath, profileDisplayName } from '@/lib/profile'

/**
 * The nav's account item: "Sign in" when signed out, your photo when signed in.
 *
 * NOT WIRED INTO THE NAV YET, on purpose. The site's nav is copy-pasted into
 * nine components, and six of them (ExhibitionsPage, ExhibitionDetail,
 * StandaloneMap and others) currently hold uncommitted work from the
 * exhibition-address build. Editing them would tangle two unrelated changes in
 * the same files and make them impossible to commit separately.
 *
 * To add it once that work is committed, drop this into each nav beside the
 * Search link:
 *
 *   <AccountNav />
 *
 * It is a Server Component, so it can sit inside the existing server-rendered
 * navs unchanged.
 */
export default async function AccountNav() {
  const profile = await getOwnProfile()

  if (!profile) {
    return <Link href="/login" className="ep-nav-search">Sign in</Link>
  }

  // Signed up but never finished choosing a username.
  if (!profile.username) {
    return <Link href="/onboarding" className="ep-nav-search">Finish setup</Link>
  }

  return (
    <Link
      href={profilePath(profile.username)}
      className="ep-nav-search"
      title={profileDisplayName(profile)}
    >
      {profile.avatar_url
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={profile.avatar_url} alt="" width={28} height={28} style={{ borderRadius: '50%', objectFit: 'cover' }} />
        : `@${profile.username}`}
    </Link>
  )
}
