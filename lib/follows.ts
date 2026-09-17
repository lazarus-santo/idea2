import 'server-only'

import { getSupabase } from '@/lib/supabase'
import { getSupabaseServer } from '@/lib/supabase-server'
import type { ProfilePrivacy } from '@/lib/profile'

/**
 * Reading the follow graph from the server.
 *
 * WRITES ARE NOT HERE. Following, unfollowing, approving and denying all
 * happen in the browser against the policies in migration_v44, the same way
 * profile edits do — see components/account/FollowButton.tsx. The database is
 * the thing enforcing who may do what, so routing writes through here would add
 * a layer that cannot refuse anything the policies already allow.
 *
 * Everything below reads through a SECURITY DEFINER function rather than
 * querying public.follows. That table has no public read policy at all: a
 * person sees only edges they are an end of. The functions are the read
 * surface, and each filters to approved rows itself.
 */

/** pending = asked, not yet answered. approved = the follow is live. */
export type FollowStatus = 'pending' | 'approved'

/** How the signed-in visitor stands to the profile they are looking at. */
export type FollowRelationship = FollowStatus | 'none' | 'self' | 'signed-out'

export interface FollowCounts {
  followers: number
  following: number
}

/** A person as they appear in a follower list or an approval queue. */
export interface FollowPerson {
  id: string
  username: string
  display_name: string | null
  avatar_url: string | null
  privacy: ProfilePrivacy
}

export interface PendingRequest {
  id: string
  username: string
  display_name: string | null
  avatar_url: string | null
  requested_at: string
}

/**
 * Approved followers and approved follows, for any profile.
 *
 * Read as plain `anon` — the counts are public for every profile, private ones
 * included, so a session would not change the answer. A pending request is
 * never counted: a number that ticks up the moment somebody asks would
 * announce that they asked.
 *
 * Never throws. Counts failing should cost a profile page its two numbers, not
 * the whole page.
 */
export async function getFollowCounts(profileId: string): Promise<FollowCounts> {
  try {
    const { data, error } = await getSupabase()
      .rpc('follow_counts', { profile_id: profileId })
      .maybeSingle<FollowCounts>()

    if (error) {
      console.error('[follows] counts failed:', error.message)
      return { followers: 0, following: 0 }
    }
    return data ?? { followers: 0, following: 0 }
  } catch (err) {
    console.error('[follows] counts threw:', err)
    return { followers: 0, following: 0 }
  }
}

/**
 * Where the signed-in visitor stands with this profile.
 *
 * Read through the visitor's OWN session, because the row being looked for is
 * one they are an endpoint of — which is the only kind migration_v44 lets
 * anybody read. 'none' covers both "never asked" and "was denied": a denial
 * deletes the row, so a denied person is indistinguishable from a new one and
 * may ask again.
 */
export async function getFollowRelationship(
  viewerId: string | null,
  profileId: string
): Promise<FollowRelationship> {
  if (!viewerId) return 'signed-out'
  if (viewerId === profileId) return 'self'

  try {
    const supabase = await getSupabaseServer()
    const { data, error } = await supabase
      .from('follows')
      .select('status')
      .eq('follower_id', viewerId)
      .eq('followed_id', profileId)
      .maybeSingle<{ status: FollowStatus }>()

    if (error) {
      console.error('[follows] relationship lookup failed:', error.message)
      return 'none'
    }
    return data?.status ?? 'none'
  } catch (err) {
    console.error('[follows] relationship lookup threw:', err)
    return 'none'
  }
}

/**
 * Who has asked to follow the signed-in person, oldest request last.
 *
 * The underlying function takes no profile id — it answers only for whoever is
 * calling it — so there is no argument here to get wrong. Returns [] for a
 * signed-out visitor because the database has nobody to answer about.
 */
export async function getPendingRequests(): Promise<PendingRequest[]> {
  try {
    const supabase = await getSupabaseServer()
    const { data, error } = await supabase.rpc('pending_follow_requests')

    if (error) {
      console.error('[follows] pending requests failed:', error.message)
      return []
    }
    return (data ?? []) as PendingRequest[]
  } catch (err) {
    console.error('[follows] pending requests threw:', err)
    return []
  }
}

/**
 * A profile's approved followers, or the accounts it follows.
 *
 * Read through the visitor's session: the functions refuse a private profile's
 * lists to anyone who cannot see the profile itself, and that check needs to
 * know who is asking. The COUNT stays visible in that case — only the names are
 * withheld, the same split Instagram draws.
 */
export async function getFollowList(
  profileId: string,
  direction: 'followers' | 'following'
): Promise<FollowPerson[]> {
  const fn = direction === 'followers' ? 'profile_followers' : 'profile_following'

  try {
    const supabase = await getSupabaseServer()
    const { data, error } = await supabase.rpc(fn, { profile_id: profileId })

    if (error) {
      console.error(`[follows] ${direction} list failed:`, error.message)
      return []
    }
    return (data ?? []) as FollowPerson[]
  } catch (err) {
    console.error(`[follows] ${direction} list threw:`, err)
    return []
  }
}
