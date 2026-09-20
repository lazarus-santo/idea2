import 'server-only'

import { getSupabaseServer } from '@/lib/supabase-server'
import { contentKey, type TopFourExhibition, type TopFourContentItem } from '@/lib/top-four-types'

/**
 * Reading the Top Four lists from the server.
 *
 * WRITES ARE NOT HERE, for a stronger reason than in the log modules. There,
 * writes live in the browser because the policies can express the rule. Here
 * there are no write policies at all: migration_v64 grants `authenticated`
 * SELECT and nothing else, and the only way in is set_top_four_exhibitions()
 * and set_top_four_content(), which replace the whole list in one transaction.
 * lib/top-four-writes.ts is the browser half that calls them, and the reason
 * the list is the unit of write is written out at length in the migration.
 *
 * Both reads below go through SECURITY DEFINER functions that ask
 * can_view_profile() themselves — the same gate as the logs, the follower
 * lists and the feed. Nothing in this file decides who may see what, and
 * nothing in it should start to. They MUST go through the visitor's session,
 * never the admin client: the functions read auth.uid() to answer, and with
 * the service key they would hand a private profile's list to everybody.
 */

/**
 * Somebody's four favourite exhibitions, filtered for whoever is asking.
 *
 * An empty array means one of three things — nothing picked, a profile this
 * visitor may not see, or a block — and the profile page does not need to tell
 * them apart, because it has already decided whether to show the locked state
 * from its own read.
 *
 * A failure must not read as "this person has picked nothing", so it is logged
 * loudly and still returns empty: showing nothing is the safe direction to
 * fail, and showing something the policies did not approve is not.
 */
export async function getTopFourExhibitions(profileId: string): Promise<TopFourExhibition[]> {
  const supabase = await getSupabaseServer()
  const { data, error } = await supabase.rpc('profile_top_four_exhibitions', {
    profile_id: profileId,
  })

  if (error) {
    console.error('[top-four] exhibitions lookup failed:', error.message)
    return []
  }

  return (data ?? []) as TopFourExhibition[]
}

/**
 * Somebody's four favourite articles, filtered the same way.
 *
 * A FROZEN preread comes back here with the content the person actually read
 * and `superseded` true — profile_top_four_content() deliberately does not
 * filter it out. See migration_v64; hiding it would empty a slot on somebody's
 * profile because Agent 2 repaired an unrelated show.
 */
export async function getTopFourContent(profileId: string): Promise<TopFourContentItem[]> {
  const supabase = await getSupabaseServer()
  const { data, error } = await supabase.rpc('profile_top_four_content', {
    profile_id: profileId,
  })

  if (error) {
    console.error('[top-four] content lookup failed:', error.message)
    return []
  }

  return (data ?? []) as TopFourContentItem[]
}

/**
 * What the signed-in person already has in each list — the keys alone.
 *
 * This is what an "Add to Top Four" button on a log entry needs, and all it
 * needs: whether THIS item is already in, so the control can offer Remove
 * instead of Add.
 *
 * ── IT READS THE TABLE DIRECTLY RATHER THAN CALLING THE PROFILE FUNCTION ────
 *
 * Deliberate, and the difference matters. profile_top_four_*() answers "what
 * may this visitor see of that person", which means it joins the exhibition
 * and drops anything unpublished. That is right for a profile and wrong here:
 * a show that has been unpublished is still in your Top Four, still occupying
 * one of your four slots, and a button that offered to add it again would be
 * lying about a list the person cannot otherwise see. The first-person RLS
 * policy is the whole gate this read needs.
 *
 * Both return empty when signed out, which renders as no button at all.
 *
 * A failure is logged and returns empty, the same direction the reads above
 * fail in. The cost is a button that says Add for something already in the
 * list; the database refuses a duplicate silently, so the worst case is a
 * click that does nothing rather than a list that breaks.
 */
export async function getOwnTopFourExhibitionIds(userId: string | null): Promise<string[]> {
  if (!userId) return []

  const supabase = await getSupabaseServer()
  const { data, error } = await supabase
    .from('top_four_exhibitions')
    .select('exhibition_id')
    .eq('user_id', userId)

  if (error) {
    console.error('[top-four] own exhibition ids lookup failed:', error.message)
    return []
  }

  return (data ?? []).map((row) => row.exhibition_id as string)
}

/** The same, for articles. Keyed by the PAIR — an id alone is ambiguous. */
export async function getOwnTopFourContentKeys(userId: string | null): Promise<string[]> {
  if (!userId) return []

  const supabase = await getSupabaseServer()
  const { data, error } = await supabase
    .from('top_four_content')
    .select('content_type, content_id')
    .eq('user_id', userId)

  if (error) {
    console.error('[top-four] own content keys lookup failed:', error.message)
    return []
  }

  return (data ?? []).map((row) => contentKey(row.content_type, row.content_id))
}
