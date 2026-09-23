import 'server-only'

import { getSupabaseServer } from '@/lib/supabase-server'
import { getCurrentUser } from '@/lib/auth'
import type { Crawl, CrawlStatus, SavedCrawl } from '@/lib/crawl-types'

/**
 * Reading crawls from the server.
 *
 * WRITES ARE NOT HERE. lib/crawl-writes.ts is the browser half. The split is
 * the same one the logs and the Top Four use, and the reason is the same: the
 * signed-in person's session lives in the browser, so their own writes go
 * straight to PostgREST under Row Level Security rather than through an API
 * route that would have to re-decide who they are.
 *
 * EVERY READ BELOW GOES THROUGH THE VISITOR'S SESSION, never the admin client.
 * migration_v66/v67's policies are what decide who sees a crawl — the owner
 * sees all of theirs; anybody can_view_profile() lets through sees the
 * COMPLETED ones — and the service role bypasses every one of them.
 *
 * SINCE v67 RLS NO LONGER MEANS "MINE". A select on crawls with no filter now
 * returns the caller's own crawls AND every completed crawl they may see, so
 * each read below names the profile it is about. getOwnCrawls() in particular
 * must filter on the caller's id, or somebody's profile would list crawls by
 * the people they follow as though they were their own.
 *
 * A failure is logged loudly and returns empty. Showing nothing is the safe
 * direction to fail; showing something the policies did not approve is not.
 */

type CrawlRow = {
  id: string
  title: string
  status: CrawlStatus
  created_at: string
  updated_at: string
  completed_at: string | null
  crawl_stops: { count: number }[] | null
}

const CRAWL_COLUMNS = 'id, title, status, created_at, updated_at, completed_at, crawl_stops(count)'

/**
 * Like counts for the completed crawls in a list, via crawl_like_counts().
 *
 * Under the visitor's session — the function asks can_view_profile() for
 * itself and returns nothing for a crawl the visitor may not see. A failure
 * leaves the counts at zero rather than failing the list: a missing number is
 * a much smaller wrong than a missing section.
 */
async function likeCounts(ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map()
  const supabase = await getSupabaseServer()
  const { data, error } = await supabase.rpc('crawl_like_counts', { p_crawl_ids: ids })
  if (error) {
    console.error('[crawls] like counts failed:', error.message)
    return new Map()
  }
  return new Map(
    ((data ?? []) as { crawl_id: string; like_count: number }[]).map((r) => [r.crawl_id, r.like_count])
  )
}

async function toCrawls(rows: CrawlRow[]): Promise<Crawl[]> {
  const counts = await likeCounts(rows.filter((r) => r.status === 'completed').map((r) => r.id))
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
    // An aggregate embed comes back as an array with one object, and as an
    // empty array for a crawl with no stops at all. Both mean zero here.
    stop_count: row.crawl_stops?.[0]?.count ?? 0,
    like_count: row.status === 'completed' ? counts.get(row.id) ?? 0 : null,
  }))
}

/**
 * The signed-in person's crawls — every status — most recently edited first.
 *
 * updated_at rather than created_at for the ordering: set_crawl_route() touches
 * the crawl row, so "most recently edited" counts adding a stop and not only
 * renaming.
 */
export async function getOwnCrawls(): Promise<Crawl[]> {
  const user = await getCurrentUser()
  if (!user) return []

  const supabase = await getSupabaseServer()
  const { data, error } = await supabase
    .from('crawls')
    .select(CRAWL_COLUMNS)
    // Not optional — see the header.
    .eq('user_id', user.id)
    .order('updated_at', { ascending: false })

  if (error) {
    console.error('[crawls] list failed:', error.message)
    return []
  }
  return toCrawls((data ?? []) as CrawlRow[])
}

/**
 * Somebody else's crawls, as this visitor may see them: completed ones only,
 * most recently completed first.
 *
 * The status filter is for the ordering and for honesty about intent; it is not
 * what keeps drafts hidden. RLS is — a visitor's read of a draft returns no row
 * whatever this query asks for, and a visitor who may not see the profile at
 * all gets an empty list.
 */
export async function getProfileCrawls(profileId: string): Promise<Crawl[]> {
  const supabase = await getSupabaseServer()
  const { data, error } = await supabase
    .from('crawls')
    .select(CRAWL_COLUMNS)
    .eq('user_id', profileId)
    .eq('status', 'completed')
    .order('completed_at', { ascending: false })

  if (error) {
    console.error('[crawls] profile list failed:', error.message)
    return []
  }
  return toCrawls((data ?? []) as CrawlRow[])
}

/**
 * The completed crawls the signed-in person has bookmarked ("want to do
 * this"), most recently saved first.
 *
 * The save rows are first-person; the crawl behind each is embedded under RLS,
 * so a crawl the person can no longer see (unfollowed from a private profile,
 * say) comes back as null and is left out — the save stays in the table and
 * reappears if access does.
 */
export async function getSavedCrawls(): Promise<SavedCrawl[]> {
  const user = await getCurrentUser()
  if (!user) return []

  const supabase = await getSupabaseServer()
  const { data, error } = await supabase
    .from('crawl_saves')
    .select(`
      created_at,
      crawls(id, title, status, completed_at, crawl_stops(count),
        profiles!crawls_user_id_fkey(username, display_name))
    `)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[crawls] saved list failed:', error.message)
    return []
  }

  type Row = {
    created_at: string
    crawls: {
      id: string
      title: string
      status: CrawlStatus
      completed_at: string | null
      crawl_stops: { count: number }[] | null
      profiles: { username: string | null; display_name: string | null } | null
    } | null
  }

  return ((data ?? []) as unknown as Row[])
    .filter((r) => r.crawls && r.crawls.status === 'completed')
    .map((r) => ({
      id: r.crawls!.id,
      title: r.crawls!.title,
      completed_at: r.crawls!.completed_at,
      stop_count: r.crawls!.crawl_stops?.[0]?.count ?? 0,
      owner_username: r.crawls!.profiles?.username ?? null,
      owner_display_name: r.crawls!.profiles?.display_name ?? null,
      saved_at: r.created_at,
    }))
}
