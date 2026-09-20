import 'server-only'

import { getSupabaseServer } from '@/lib/supabase-server'
import {
  readingKey,
  type OwnReadingLog,
  type ProfileReadingLogEntry,
  type ReadingContentType,
  type ReadingRef,
} from '@/lib/reading-log-types'

/**
 * Reading the reading log from the server.
 *
 * The counterpart of lib/exhibition-logs.ts, and deliberately the same shape —
 * if you have read that file you have read this one. WRITES ARE NOT HERE: they
 * happen in the browser against the policies in migration_v63, the same
 * arrangement follows, profile edits and the exhibition log use. See
 * lib/reading-log-writes.ts.
 *
 * The TYPES are not here either, and that is not an aesthetic choice: this
 * module is server-only, and the browser needs readingKey(). They live in
 * lib/reading-log-types.ts, which explains itself, and are re-exported below so
 * a server caller still has one import to remember.
 */

export * from '@/lib/reading-log-types'

const OWN_COLUMNS =
  'content_type, content_id, status, rating, liked, comment, comment_visibility'

/**
 * What the signed-in person has already said about this one item, if anything.
 *
 * Returns null when signed out, when they have not logged it, and when the
 * read fails — but the failure is logged first. A silent null would render as
 * "not logged" and invite them to log it again, which the primary key would
 * then refuse in a way they could not act on.
 */
export async function getOwnReadingLog(
  userId: string | null,
  contentType: ReadingContentType,
  contentId: string
): Promise<OwnReadingLog | null> {
  if (!userId) return null

  const supabase = await getSupabaseServer()
  const { data, error } = await supabase
    .from('reading_logs')
    .select(OWN_COLUMNS)
    .eq('user_id', userId)
    .eq('content_type', contentType)
    .eq('content_id', contentId)
    .maybeSingle<OwnReadingLog>()

  if (error) {
    console.error('[reading-logs] own entry lookup failed:', error.message)
    return null
  }

  return data ?? null
}

/**
 * The person's entries for a whole list of items, keyed `${type}:${id}`.
 *
 * One query rather than one per row: an exhibition page can carry a dozen
 * prereads and the Readings page carries a hundred articles. RLS already
 * narrows this to the caller's own rows, so the user_id here is a filter
 * rather than a permission.
 *
 * Both content types in one call, because a page can show both — a museum
 * show's coverage is prereads rows while the same article may also be a
 * reading. `.in()` on each column separately would over-match across the two
 * id spaces, so the pair is re-checked as the map is built.
 */
export async function getOwnReadingLogs(
  userId: string | null,
  refs: ReadingRef[]
): Promise<Map<string, OwnReadingLog>> {
  const empty = new Map<string, OwnReadingLog>()
  if (!userId || refs.length === 0) return empty

  const wanted = new Set(refs.map((r) => readingKey(r.contentType, r.contentId)))

  const supabase = await getSupabaseServer()
  const { data, error } = await supabase
    .from('reading_logs')
    .select(OWN_COLUMNS)
    .eq('user_id', userId)
    .in('content_id', refs.map((r) => r.contentId))

  if (error) {
    console.error('[reading-logs] own entries lookup failed:', error.message)
    return empty
  }

  const byKey = new Map<string, OwnReadingLog>()
  for (const row of (data ?? []) as OwnReadingLog[]) {
    const key = readingKey(row.content_type, row.content_id)
    // Only the pairs that were asked for: `.in()` matched ids across both
    // types, and a prereads id colliding with a readings id is exactly the
    // ambiguity content_type exists to resolve.
    if (wanted.has(key)) byKey.set(key, row)
  }
  return byKey
}

/**
 * Somebody's reading log, filtered for whoever is asking.
 *
 * Nothing here decides who may see what. profile_reading_logs() applies
 * profile privacy (via can_view_profile — the SAME function the follower
 * lists, the feed and the exhibition log ask) and comment visibility itself,
 * and it reads auth.uid() to do it. That is why this goes through the
 * VISITOR'S session and must never be handed the admin client: with the
 * service key it would bypass the policies and return every private note to
 * everyone.
 *
 * An empty array therefore means one of three things — nothing logged, a
 * profile this visitor may not see, or a block — and the profile page does not
 * need to tell them apart, because it decided whether to show the locked state
 * from its own read.
 */
export async function getProfileReadingLog(
  profileId: string
): Promise<ProfileReadingLogEntry[]> {
  const supabase = await getSupabaseServer()
  const { data, error } = await supabase.rpc('profile_reading_logs', {
    profile_id: profileId,
  })

  // A failure must not read as "this person has logged nothing". Logged
  // loudly; the caller still gets an empty list, which is the safe direction
  // to fail — showing nothing rather than something the policies did not
  // approve.
  if (error) {
    console.error('[reading-logs] profile log lookup failed:', error.message)
    return []
  }

  return (data ?? []) as ProfileReadingLogEntry[]
}
