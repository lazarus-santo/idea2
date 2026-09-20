import 'server-only'

import { getSupabaseServer } from '@/lib/supabase-server'

/**
 * Reading the exhibition log from the server.
 *
 * WRITES ARE NOT HERE. Marking, rating, liking and commenting all happen in
 * the browser against the policies in migration_v62, the same arrangement
 * follows and profile edits use — see lib/exhibition-log-writes.ts. The
 * database is what enforces the gating rule and the privacy rule, so routing
 * writes through a server module would add a layer that cannot refuse anything
 * the constraints already refuse.
 *
 * The two reads below are deliberately different shapes, because they answer
 * different questions:
 *
 *   getOwnLog()          YOUR row for one show, read straight from the table
 *                        under RLS. First-person, so no function is needed —
 *                        the policy already narrows it to you.
 *   getProfileLog()      SOMEBODY'S log, read through profile_exhibition_logs(),
 *                        which is the ONLY way to see another person's rows.
 *                        The table has no policy that returns them.
 */

export type LogStatus = 'want_to_see' | 'seen'
export type CommentVisibility = 'public' | 'private'

/** The signed-in person's own entry for one exhibition. */
export interface OwnExhibitionLog {
  exhibition_id: string
  status: LogStatus
  rating: number | null
  liked: boolean
  comment: string | null
  comment_visibility: CommentVisibility | null
}

/**
 * One row of somebody's log, as a given visitor is allowed to see it.
 *
 * `comment` is null both when there was never a comment and when there is one
 * this visitor may not read. Those are indistinguishable here ON PURPOSE:
 * a field that said "there is a private comment" would announce the thing
 * privacy is meant to withhold.
 */
export interface ProfileLogEntry {
  exhibition_id: string
  status: LogStatus
  rating: number | null
  liked: boolean
  comment: string | null
  /**
   * Non-null only when `comment` is — the function masks the two together, so
   * this can label your own note "only you" without ever revealing that
   * somebody else has one you cannot read.
   */
  comment_visibility: CommentVisibility | null
  logged_at: string
  show_title: string
  start_date: string | null
  end_date: string | null
  image_url: string | null
  venue_name: string | null
}

/**
 * What the signed-in person has already said about this show, if anything.
 *
 * Returns null when signed out, when they have not logged it, and when the
 * read fails — but the failure is logged first. A silent null would render as
 * "not logged" and invite the person to log it again, which the primary key
 * would then refuse in a way they could not act on.
 */
export async function getOwnLog(
  userId: string | null,
  exhibitionId: string
): Promise<OwnExhibitionLog | null> {
  if (!userId) return null

  const supabase = await getSupabaseServer()
  const { data, error } = await supabase
    .from('exhibition_logs')
    .select('exhibition_id, status, rating, liked, comment, comment_visibility')
    .eq('user_id', userId)
    .eq('exhibition_id', exhibitionId)
    .maybeSingle<OwnExhibitionLog>()

  if (error) {
    console.error('[exhibition-logs] own entry lookup failed:', error.message)
    return null
  }

  return data ?? null
}

/**
 * Somebody's log, filtered for whoever is asking.
 *
 * Nothing here decides who may see what. The function applies profile privacy
 * (via can_view_profile, the same one the follower lists and the feed ask) and
 * comment visibility itself, and it reads auth.uid() to do it — which is why
 * this goes through the VISITOR'S session and must never be handed the admin
 * client. With the service key it would bypass the policies and return every
 * private comment to everyone.
 *
 * An empty array therefore means one of three things — no logs, a profile this
 * visitor may not see, or a block — and the profile page does not need to tell
 * them apart, because it has already decided whether to show the locked state
 * from its own read.
 */
export async function getProfileLog(profileId: string): Promise<ProfileLogEntry[]> {
  const supabase = await getSupabaseServer()
  const { data, error } = await supabase.rpc('profile_exhibition_logs', {
    profile_id: profileId,
  })

  // A failure must not read as "this person has logged nothing". Logged loudly;
  // the caller still gets an empty list, which is the safe direction to fail —
  // showing nothing rather than showing something the policies did not approve.
  if (error) {
    console.error('[exhibition-logs] profile log lookup failed:', error.message)
    return []
  }

  return (data ?? []) as ProfileLogEntry[]
}
