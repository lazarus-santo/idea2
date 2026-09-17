import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getSupabase } from '@/lib/supabase'
import { getSupabaseServer } from '@/lib/supabase-server'
import { getCurrentUser } from '@/lib/auth'
import {
  getFollowCounts,
  getFollowRelationship,
  getPendingRequests,
} from '@/lib/follows'
import {
  PROFILE_COLUMNS,
  normalizePrivacy,
  normalizeUsername,
  profileDisplayName,
  type Profile,
  type ProfileCard,
} from '@/lib/profile'
import FollowButton from '@/components/account/FollowButton'
import FollowCounts from '@/components/account/FollowCounts'
import FollowRequests from '@/components/account/FollowRequests'
import '@/app/account.css'

interface Props {
  params: Promise<{ username: string }>
}

/**
 * What a visitor gets to see: either the whole profile, or the locked header.
 *
 * `card` is present whenever the username is claimed — it is what makes the
 * page exist at all. `profile` is present only when this visitor is allowed
 * the contents: the profile is public, it is their own, or they are an
 * approved follower of it.
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
 * The FULL row comes from public.profiles through the visitor's own session, so
 * the policies decide: public to anyone, private to its owner, and — since
 * migration_v44 — private to anyone whose follow request was approved. Nothing
 * here re-implements that check, which is exactly why approving a request
 * unlocks this page with no code in it that knows what approval means.
 *
 * The CARD comes from public.profile_card() (migration_v45), which answers for
 * every claimed username carrying only id, username, display_name, avatar_url
 * and privacy. A private profile answers here and nowhere else, which is what
 * lets a stranger find it and ask. It replaced a view of the same shape: the
 * view was GRANTed, so PostgREST let anyone page through the whole of it in one
 * request; a function answers one handle at a time.
 *
 * A username nobody has claimed still 404s, because it has no card.
 */
async function loadProfile(username: string): Promise<ProfileView | null> {
  const handle = normalizeUsername(username)

  const supabase = await getSupabaseServer()
  const [cardRes, profileRes] = await Promise.all([
    // The function returns the same row to everyone, so this one is read as
    // plain `anon` rather than through the visitor's session.
    getSupabase().rpc('profile_card', { handle }),
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

  // A set-returning function comes back as an array; the handle is unique, so
  // there is at most one.
  const card = ((cardRes.data ?? []) as ProfileCard[])[0] ?? null
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
  // component interprets for itself. An approved follower is unlocked here
  // without this line changing, because the policy changed instead.
  const locked = profile === null

  // The approval queue is only ever fetched for your own profile, and the
  // function behind it answers only about whoever is calling it.
  const [counts, relationship, requests] = await Promise.all([
    getFollowCounts(card.id),
    getFollowRelationship(viewer?.id ?? null, card.id),
    isOwnProfile ? getPendingRequests() : Promise.resolve([]),
  ])

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
          <div className="ac-profile-id">
            <h1 className="ac-profile-name">{profileDisplayName(card)}</h1>
            <p className="ac-profile-handle">@{card.username}</p>
            {/* Counts sit above the fold on every profile, locked or not. The
                lists behind them open only when this visitor got the contents. */}
            <FollowCounts profileId={card.id} counts={counts} listsOpen={!locked} />
          </div>

          <div className="ac-profile-action">
            <FollowButton
              targetId={card.id}
              targetUsername={card.username}
              relationship={relationship}
            />
          </div>
        </div>

        {locked ? (
          <div className="ac-locked">
            <p className="ac-locked-title">This profile is private</p>
            <p className="ac-locked-note">
              {relationship === 'pending'
                ? <>Your request to follow {profileDisplayName(card)} is waiting to be approved.</>
                : <>Follow {profileDisplayName(card)} to ask for access.</>}
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
          <>
            <div className="ac-btn-row" style={{ marginTop: 24 }}>
              <Link href="/settings" className="ac-btn ac-btn--secondary ac-btn--inline">
                Edit profile
              </Link>
              {card.privacy === 'private' && (
                <span className="ac-meta" style={{ alignSelf: 'center' }}>
                  People can find you in search, but only approved followers see this page.
                </span>
              )}
            </div>

            {/* Nobody is told a request arrived — there is no notification
                system yet — so the queue lives on the page its owner already
                visits. See the note in FollowRequests. */}
            <FollowRequests requests={requests} />
          </>
        )}
      </div>
    </div>
  )
}
