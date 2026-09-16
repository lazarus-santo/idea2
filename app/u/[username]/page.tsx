import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getSupabaseServer } from '@/lib/supabase-server'
import { getCurrentUser } from '@/lib/auth'
import {
  PROFILE_COLUMNS,
  normalizeUsername,
  profileDisplayName,
  type Profile,
} from '@/lib/profile'
import '@/app/account.css'

interface Props {
  params: Promise<{ username: string }>
}

/**
 * Somebody's profile.
 *
 * Read through the visitor's own session, so the privacy rules in
 * migration_v40 do the deciding: a public profile is readable by anyone, a
 * private or followers-only one only by its owner. Everyone else gets no row
 * back and lands on the 404 below — deliberately the same response as a
 * username nobody has claimed, so a hidden profile does not announce that it
 * exists.
 *
 * Nothing about exhibitions appears here yet. The log, ratings and following
 * are later phases.
 */
async function loadProfile(username: string): Promise<Profile | null> {
  const supabase = await getSupabaseServer()
  const { data, error } = await supabase
    .from('profiles')
    .select(PROFILE_COLUMNS)
    .eq('username', normalizeUsername(username))
    .maybeSingle()

  // A hidden profile and an unclaimed username both arrive here as no row, and
  // both should 404. A FAILURE must not look the same in the logs: without
  // this line, a dropped table or a broken policy reads as "no such person"
  // and nobody finds out.
  if (error) {
    console.error('[profile] lookup failed for', username, error.message)
    return null
  }

  return (data as Profile | null) ?? null
}

export async function generateMetadata({ params }: Props) {
  const { username } = await params
  const profile = await loadProfile(username)
  if (!profile) return { title: 'Not found — Idea 2' }

  return {
    title: `${profileDisplayName(profile)} — Idea 2`,
    description: profile.bio ?? undefined,
  }
}

export default async function ProfilePage({ params }: Props) {
  const { username } = await params
  const profile = await loadProfile(username)
  if (!profile) notFound()

  const viewer = await getCurrentUser()
  const isOwnProfile = viewer?.id === profile.id
  const joined = new Date(profile.created_at).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  })

  return (
    <div className="ac-page">
      <div className="ac-shell ac-shell--wide">
        <Link href="/" className="ac-back">Idea 2</Link>

        <div className="ac-profile-head">
          {profile.avatar_url
            // eslint-disable-next-line @next/next/no-img-element
            ? <img className="ac-avatar ac-avatar--large" src={profile.avatar_url} alt="" />
            : (
              <div className="ac-avatar ac-avatar--large ac-avatar--placeholder">
                {profileDisplayName(profile).charAt(0).toUpperCase()}
              </div>
            )}
          <div>
            <h1 className="ac-profile-name">{profileDisplayName(profile)}</h1>
            <p className="ac-profile-handle">@{profile.username}</p>
          </div>
        </div>

        {profile.bio
          ? <p className="ac-profile-bio">{profile.bio}</p>
          : <p className="ac-profile-empty">No bio yet.</p>}

        <p className="ac-meta">Joined {joined}</p>

        {isOwnProfile && (
          <div className="ac-btn-row" style={{ marginTop: 24 }}>
            <Link href="/settings" className="ac-btn ac-btn--secondary ac-btn--inline">
              Edit profile
            </Link>
            {profile.privacy !== 'public' && (
              <span className="ac-meta" style={{ alignSelf: 'center' }}>
                Only you can see this profile.
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
