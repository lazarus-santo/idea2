import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getSupabase } from '@/lib/supabase'
import { getSupabaseServer } from '@/lib/supabase-server'
import { getCurrentUser } from '@/lib/auth'
import {
  PROFILE_CARD_COLUMNS,
  PROFILE_COLUMNS,
  normalizePrivacy,
  normalizeUsername,
  profileDisplayName,
  type Profile,
  type ProfileCard,
} from '@/lib/profile'
import '@/app/account.css'

interface Props {
  params: Promise<{ username: string }>
}

/**
 * What a visitor gets to see: either the whole profile, or the locked header.
 *
 * `card` is present whenever the username is claimed — it is what makes the
 * page exist at all. `profile` is present only when this visitor is allowed
 * the contents: the profile is public, or it is their own.
 */
interface ProfileView {
  card: ProfileCard
  profile: Profile | null
}

/**
 * Somebody's profile.
 *
 * Two reads, and the difference between them is the privacy model.
 *
 * The FULL row comes from public.profiles through the visitor's own session,
 * so the policies in migration_v40 decide: a public profile is readable by
 * anyone, a private one only by its owner. Nothing here re-implements that
 * check, and nothing here can accidentally widen it.
 *
 * The CARD comes from public.profile_cards (migration_v43), a view of every
 * claimed username carrying only id, username, display_name, avatar_url and
 * privacy. A private profile answers here and nowhere else. That is deliberate
 * and it is a change from v40, which 404'd a private profile at this route to
 * avoid admitting it existed. Hiding it that thoroughly also made it
 * impossible to ask its owner for access, which is the thing privacy is
 * supposed to allow — so a private profile is now a locked door with a name on
 * it rather than a blank wall.
 *
 * A username nobody has claimed still 404s, because it has no card.
 */
async function loadProfile(username: string): Promise<ProfileView | null> {
  const handle = normalizeUsername(username)

  const supabase = await getSupabaseServer()
  const [cardRes, profileRes] = await Promise.all([
    // The view returns the same rows to everyone, so this one is read as plain
    // `anon` rather than through the visitor's session.
    getSupabase()
      .from('profile_cards')
      .select(PROFILE_CARD_COLUMNS)
      .eq('username', handle)
      .maybeSingle(),
    supabase
      .from('profiles')
      .select(PROFILE_COLUMNS)
      .eq('username', handle)
      .maybeSingle(),
  ])

  // A locked profile and an unclaimed username both arrive as no row from the
  // TABLE, which is why the card is what decides whether the page exists. A
  // FAILURE must not look like either: without these lines, a dropped view or
  // a broken policy reads as "no such person" and nobody finds out.
  if (cardRes.error) {
    console.error('[profile] card lookup failed for', username, cardRes.error.message)
    return null
  }
  if (profileRes.error) {
    console.error('[profile] lookup failed for', username, profileRes.error.message)
    return null
  }

  const card = cardRes.data as ProfileCard | null
  if (!card) return null

  return {
    card: { ...card, privacy: normalizePrivacy(card.privacy) },
    profile: (profileRes.data as Profile | null) ?? null,
  }
}

export async function generateMetadata({ params }: Props) {
  const { username } = await params
  const view = await loadProfile(username)
  if (!view) return { title: 'Not found — Idea 2' }

  // The bio is the description only when this page is showing it. On a locked
  // profile there is no bio in hand, and the title is the name and handle the
  // locked header already displays — nothing the page itself withholds.
  return {
    title: `${profileDisplayName(view.card)} — Idea 2`,
    description: view.profile?.bio ?? undefined,
  }
}

export default async function ProfilePage({ params }: Props) {
  const { username } = await params
  const view = await loadProfile(username)
  if (!view) notFound()

  const { card, profile } = view
  const viewer = await getCurrentUser()
  const isOwnProfile = viewer?.id === card.id

  // Locked when the contents did not come back. Whether that is because the
  // profile is private or because a policy said no, the answer on the page is
  // the same, and it is the read that decides it — not a privacy flag this
  // component interprets for itself.
  const locked = profile === null

  return (
    <div className="ac-page">
      <div className="ac-shell ac-shell--wide">
        <Link href="/" className="ac-back">Idea 2</Link>

        <div className="ac-profile-head">
          {card.avatar_url
            // eslint-disable-next-line @next/next/no-img-element
            ? <img className="ac-avatar ac-avatar--large" src={card.avatar_url} alt="" />
            : (
              <div className="ac-avatar ac-avatar--large ac-avatar--placeholder">
                {profileDisplayName(card).charAt(0).toUpperCase()}
              </div>
            )}
          <div>
            <h1 className="ac-profile-name">{profileDisplayName(card)}</h1>
            <p className="ac-profile-handle">@{card.username}</p>
          </div>
        </div>

        {locked ? (
          // No follow button yet — there is no follow graph to attach one to.
          // When there is, the request to follow belongs right here.
          <div className="ac-locked">
            <p className="ac-locked-title">This profile is private</p>
            <p className="ac-locked-note">
              Only {profileDisplayName(card)} can see what is on it.
            </p>
          </div>
        ) : (
          <>
            {profile.bio
              ? <p className="ac-profile-bio">{profile.bio}</p>
              : <p className="ac-profile-empty">No bio yet.</p>}

            <p className="ac-meta">
              Joined {new Date(profile.created_at).toLocaleDateString('en-US', {
                month: 'long',
                year: 'numeric',
              })}
            </p>
          </>
        )}

        {isOwnProfile && (
          <div className="ac-btn-row" style={{ marginTop: 24 }}>
            <Link href="/settings" className="ac-btn ac-btn--secondary ac-btn--inline">
              Edit profile
            </Link>
            {card.privacy === 'private' && (
              <span className="ac-meta" style={{ alignSelf: 'center' }}>
                People can find you in search, but only you can see this page.
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
