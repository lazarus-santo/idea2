import type { SupabaseClient } from '@supabase/supabase-js'
import { CRAWL_MAX_STOPS, type EditableCrawlStatus, type TravelMode } from '@/lib/crawl-types'

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
 * THE STOPS — replaced as a WHOLE LIST, through set_crawl_route() (v67; it
 * carries each leg's walk/drive choice too, and replaced v66's
 * set_crawl_stops(), which survives as a wrapper). Not a convenience layered
 * on top: there are no INSERT, UPDATE or DELETE grants on crawl_stops for
 * anybody but service_role, so there is no other way in.
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
 * ── PHASE 2: COMPLETING, AND OTHER PEOPLE'S CRAWLS ─────────────────────────
 *
 * Completing goes through complete_crawl() — never a status update, which the
 * database refuses — because it also logs every stop as seen. Recreating goes
 * through recreate_crawl(). Likes and saves are single rows straight to
 * PostgREST, like follows: there is no list-level rule to protect, and the
 * INSERT policies refuse a crawl the caller cannot see or owns.
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
  // v67. A completed route is a fixed record.
  if (message.includes('crawl_completed')) {
    return 'This crawl is completed, so its stops can no longer change. Recreate it to make an editable copy.'
  }
  if (message.includes('crawl_empty')) {
    return 'Add at least one stop before marking a crawl completed.'
  }
  // A direct status write to or from 'completed' — the UI never sends one, so
  // this means the page went stale.
  if (message.includes('crawls_completed_at_consistent') || message.includes('crawls_status_values')) {
    return 'That crawl changed somewhere else. Reload and try again.'
  }
  // A like or save on a crawl the caller can no longer see — they were
  // unfollowed, or it was deleted, since the page loaded. Worded without
  // saying which.
  if (message.includes('row-level security')) {
    return 'That crawl is no longer available.'
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
 * Neither state changes who can see it — both are owner-only. This is the
 * owner's note to themselves that they have stopped fiddling. 'completed' is
 * not accepted here by type, and the database would refuse it anyway: see
 * completeCrawl().
 */
export async function setCrawlStatus(
  supabase: SupabaseClient,
  crawlId: string,
  status: EditableCrawlStatus
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
 * Other people's likes and saves of it go too, through the same cascade.
 * Their log entries do not — completing a crawl logged shows into THEIR
 * OWN logs, which belong to them and not to the crawl — and copies made with
 * Recreate are independent crawls and are untouched.
 */
export async function deleteCrawl(
  supabase: SupabaseClient,
  crawlId: string
): Promise<CrawlWriteResult> {
  const { error } = await supabase.from('crawls').delete().eq('id', crawlId)

  return { error: error ? { message: explain(error.message) } : null }
}

/** One stop as the route is saved: the show, and how you get to it. */
export interface CrawlRouteStop {
  exhibition_id: string
  /** The leg INTO this stop. Ignored for the first stop. */
  arrive_by: TravelMode
}

/**
 * Replace a crawl's route with this list, in order: each stop with the mode of
 * the leg that arrives at it.
 *
 * An empty array clears it. There is no addStop(), no removeStop() and no
 * moveStop(), and adding one would be a mistake — see the header. Each of
 * those is this function with a different array, which is exactly why no
 * reorder can half-happen and why positions never develop a gap.
 *
 * A list of stops that each carry their own mode, never ids plus a separate
 * array of modes: two arrays can arrive misaligned by one and draw a driving
 * leg where somebody walked.
 *
 * There is no user_id argument. The function reads auth.uid() and checks the
 * crawl belongs to the caller before it writes anything, and refuses a
 * completed crawl.
 */
export async function saveCrawlRoute(
  supabase: SupabaseClient,
  crawlId: string,
  stops: CrawlRouteStop[]
): Promise<CrawlWriteResult> {
  const { error } = await supabase.rpc('set_crawl_route', {
    p_crawl_id: crawlId,
    p_stops: stops,
  })

  return { error: error ? { message: explain(error.message) } : null }
}

/** What complete_crawl() did, so the page can say it rather than guess. */
export interface CrawlCompletion {
  /** New 'seen' entries. */
  logged: number
  /** 'want_to_see' entries moved to 'seen'. */
  upgraded: number
  /** Already 'seen' — rating, like and comment untouched. */
  unchanged: number
  /** Stops whose show is no longer published, and so could not be logged. */
  skipped: number
  already_completed: boolean
}

/**
 * Mark a crawl completed, and log each of its shows as seen.
 *
 * One call to complete_crawl(), one transaction: the status, completed_at and
 * every log entry land together or not at all. A show already logged as seen
 * is left exactly as it was. Completing twice is harmless.
 *
 * Irreversible by design — the route becomes a fixed record other people can
 * see, like and copy. The page confirms before calling this.
 */
export async function completeCrawl(
  supabase: SupabaseClient,
  crawlId: string
): Promise<{ result: CrawlCompletion | null; error: { message: string } | null }> {
  const { data, error } = await supabase.rpc('complete_crawl', { p_crawl_id: crawlId })
  if (error) return { result: null, error: { message: explain(error.message) } }
  return { result: data as CrawlCompletion, error: null }
}

/**
 * Copy a completed crawl — yours or somebody else's you can see — into a new
 * draft of your own, and hand back its id.
 *
 * Copies the ordered stops and each leg's mode, and nothing personal: not the
 * original owner's logs, likes or dates. The copy has no link back to the
 * original.
 */
export async function recreateCrawl(
  supabase: SupabaseClient,
  crawlId: string
): Promise<CrawlCreateResult> {
  const { data, error } = await supabase.rpc('recreate_crawl', { p_crawl_id: crawlId })
  if (error) return { id: null, error: { message: explain(error.message) } }
  return { id: data as string, error: null }
}

/**
 * Like or unlike a completed crawl.
 *
 * A like is added with ignoreDuplicates (ON CONFLICT DO NOTHING) so a double
 * click is not an error, and removed by the caller's own row — which needs no
 * visibility check, so someone who has lost sight of a crawl can still take
 * their like back.
 */
export async function setCrawlLiked(
  supabase: SupabaseClient,
  userId: string,
  crawlId: string,
  liked: boolean
): Promise<CrawlWriteResult> {
  return setInterest(supabase, 'crawl_likes', userId, crawlId, liked)
}

/**
 * Save or unsave a completed crawl — the "want to do this" bookmark. Marks
 * interest only; nothing is copied. Same shape as a like.
 */
export async function setCrawlSaved(
  supabase: SupabaseClient,
  userId: string,
  crawlId: string,
  saved: boolean
): Promise<CrawlWriteResult> {
  return setInterest(supabase, 'crawl_saves', userId, crawlId, saved)
}

async function setInterest(
  supabase: SupabaseClient,
  table: 'crawl_likes' | 'crawl_saves',
  userId: string,
  crawlId: string,
  on: boolean
): Promise<CrawlWriteResult> {
  const { error } = on
    ? await supabase
        .from(table)
        .upsert({ user_id: userId, crawl_id: crawlId }, { onConflict: 'user_id,crawl_id', ignoreDuplicates: true })
    : await supabase.from(table).delete().eq('user_id', userId).eq('crawl_id', crawlId)

  return { error: error ? { message: explain(error.message) } : null }
}
