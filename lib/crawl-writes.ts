import type { SupabaseClient } from '@supabase/supabase-js'
import { CRAWL_MAX_STOPS, type CrawlStatus } from '@/lib/crawl-types'

/**
 * The writes that change a crawl, in one place.
 *
 * NOT server-only, on purpose — these run in the browser, the same arrangement
 * the logs, the Top Four, follows and profile edits use. lib/crawls.ts is the
 * other half: it READS from the server and says at its top that writes are not
 * there.
 *
 * ── TWO SHAPES OF WRITE, AND THE DIFFERENCE IS NOT ARBITRARY ───────────────
 *
 * THE CRAWL ROW — created, renamed, marked planned and deleted one row at a
 * time, straight to PostgREST under RLS. A crawl row is a complete statement
 * on its own; its constraints only ever look at that one row, so a row is the
 * honest unit of write.
 *
 * THE STOPS — replaced as a WHOLE LIST, through set_crawl_stops(). Not a
 * convenience layered on top: migration_v66 grants no INSERT, UPDATE or DELETE
 * on crawl_stops to anybody but service_role, so there is no other way in.
 *
 * That is what makes a reorder safe. The two constraints the feature rests on
 * — one appearance per show, one show per slot — are precisely what a two-step
 * swap violates in the middle: move stop 3 up to slot 1 and, for an instant,
 * two rows claim slot 1 and the write is refused halfway through. Sending the
 * finished order means there is no middle. It is also what keeps positions
 * gap-free: the database numbers them 1..n itself from the array's order, so
 * a hole cannot be created by a caller that forgot to renumber.
 *
 * THE ORDER OF THE ARRAY IS THE ROUTE: element 0 is stop 1.
 *
 * ── WHY THE BUILDER HOLDS A DRAFT ──────────────────────────────────────────
 *
 * Arranging a route is one decision made out of many small moves, so the
 * builder keeps a local draft and saves once. Writing on every ↑ would save
 * three orders nobody chose on the way to moving a stop from fourth to first,
 * and each of those would redraw the walking route and spend another handful
 * of Directions requests.
 */

export type CrawlWriteResult = { error: { message: string } | null }
export type CrawlCreateResult = { id: string | null; error: { message: string } | null }

/**
 * Turn a database refusal into something a person can act on.
 *
 * The exception NAMES are the contract, as in every writer since v62 — matching
 * on prose would break the first time Postgres reworded anything, and the
 * constraint names are chosen to be matched on.
 *
 * Most of these are bugs rather than user mistakes: the builder filters its own
 * candidate list and numbers nothing itself, so a duplicate or an over-long
 * list means the draft went stale or the UI got it wrong. The wording says what
 * the rule is and what to do rather than blaming the person.
 */
function explain(message: string): string {
  if (message.includes('crawl_not_found')) {
    return 'That crawl is no longer there. Reload and try again.'
  }
  if (message.includes('crawl_too_many_stops')) {
    return `A crawl holds ${CRAWL_MAX_STOPS} stops at most.`
  }
  if (message.includes('crawl_duplicate_stop')) {
    return 'A show cannot be two stops on the same crawl.'
  }
  if (message.includes('crawl_bad_input')) {
    return 'Something went wrong with that list of stops. Reload and try again.'
  }
  // The published-only trigger. From the person's side this is a show that was
  // on the map a moment ago and has since been pulled — rare, and not their fault.
  if (message.includes('no_such_exhibition')) {
    return 'One of those shows is no longer available. Reload and try again.'
  }
  if (message.includes('crawls_title_not_blank')) {
    return 'A crawl needs a name.'
  }
  if (message.includes('crawls_title_length')) {
    return 'That name is too long — 120 characters at most.'
  }
  if (message.includes('crawls_status_values')) {
    return 'A crawl can be a draft or planned. Reload and try again.'
  }
  if (message.includes('not_signed_in')) {
    return 'Sign in to edit a crawl.'
  }
  return message
}

/**
 * Start a new crawl and hand back its id.
 *
 * user_id is sent explicitly because the INSERT policy's WITH CHECK compares
 * it to auth.uid() — it is not a parameter anybody chooses, it is the caller
 * proving the row is theirs, and a row claiming to be somebody else's is
 * refused by the database rather than by this function.
 *
 * It arrives as a DRAFT with no stops. That is the honest starting state:
 * somebody who has just clicked "new crawl" has planned nothing yet, and a
 * route with no stops should not be marked as though it were finished.
 */
export async function createCrawl(
  supabase: SupabaseClient,
  userId: string,
  title: string
): Promise<CrawlCreateResult> {
  const { data, error } = await supabase
    .from('crawls')
    .insert({ user_id: userId, title: title.trim(), status: 'draft' })
    .select('id')
    .single()

  if (error) return { id: null, error: { message: explain(error.message) } }
  return { id: (data as { id: string }).id, error: null }
}

/**
 * Rename a crawl.
 *
 * Trimmed here so that "  " is refused by the database's not-blank CHECK
 * rather than saved as a title made of spaces. The refusal is the database's
 * either way; trimming just means the two agree about what blank means.
 *
 * No user_id in the update and none available to put there: migration_v66
 * withholds the UPDATE grant on that column outright, so a rename cannot hand
 * a crawl to another account even before the policy is consulted.
 */
export async function renameCrawl(
  supabase: SupabaseClient,
  crawlId: string,
  title: string
): Promise<CrawlWriteResult> {
  const { error } = await supabase
    .from('crawls')
    .update({ title: title.trim() })
    .eq('id', crawlId)

  return { error: error ? { message: explain(error.message) } : null }
}

/**
 * Move a crawl between draft and planned.
 *
 * Neither state changes who can see it — in this phase both are owner-only.
 * This is the owner's note to themselves that they have stopped fiddling.
 */
export async function setCrawlStatus(
  supabase: SupabaseClient,
  crawlId: string,
  status: CrawlStatus
): Promise<CrawlWriteResult> {
  const { error } = await supabase
    .from('crawls')
    .update({ status })
    .eq('id', crawlId)

  return { error: error ? { message: explain(error.message) } : null }
}

/**
 * Delete a crawl, and its stops with it through the foreign key's cascade.
 *
 * Nothing else points at a crawl in this phase, so there is no orphan to
 * consider. Phase 2's likes and saves will, and will want the same cascade.
 */
export async function deleteCrawl(
  supabase: SupabaseClient,
  crawlId: string
): Promise<CrawlWriteResult> {
  const { error } = await supabase.from('crawls').delete().eq('id', crawlId)

  return { error: error ? { message: explain(error.message) } : null }
}

/**
 * Replace a crawl's stops with this list, in order.
 *
 * An empty array clears them. There is no addStop(), no removeStop() and no
 * moveStop(), and adding one would be a mistake — see the header. Each of
 * those is this function with a different array, which is exactly why no
 * reorder can half-happen and why positions never develop a gap.
 *
 * There is no user_id argument. The function reads auth.uid() and checks the
 * crawl belongs to the caller before it writes anything, so there is nothing
 * here that could be pointed at somebody else's route.
 */
export async function saveCrawlStops(
  supabase: SupabaseClient,
  crawlId: string,
  exhibitionIds: string[]
): Promise<CrawlWriteResult> {
  const { error } = await supabase.rpc('set_crawl_stops', {
    p_crawl_id: crawlId,
    p_exhibition_ids: exhibitionIds,
  })

  return { error: error ? { message: explain(error.message) } : null }
}
