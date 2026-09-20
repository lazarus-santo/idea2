import 'server-only'

import { getSupabaseServer } from '@/lib/supabase-server'
import type { Crawl, CrawlStatus } from '@/lib/crawl-types'

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
 * That is not a style preference. migration_v66's policies are what make a
 * crawl owner-only in this phase, and the service role bypasses every one of
 * them — a crawl read with the admin client would come back for anybody who
 * knew its id. There is no function here that takes a user id, because there
 * is no version of these reads that should be able to be pointed at somebody
 * else's routes.
 *
 * A failure is logged loudly and returns empty or null. Showing nothing is the
 * safe direction to fail; showing something the policies did not approve is
 * not.
 */

/**
 * The signed-in person's crawls, most recently edited first.
 *
 * `stop_count` comes from PostgREST's embedded count rather than a second
 * query, and it is subject to the same RLS as everything else — the stops of a
 * crawl are readable by whoever may read the crawl, so a count that leaked
 * would have had to leak the rows first.
 *
 * updated_at rather than created_at for the ordering: set_crawl_stops() touches
 * the crawl row, so "most recently edited" counts adding a stop and not only
 * renaming. That is what somebody looking at the list means by recent.
 */
export async function getOwnCrawls(): Promise<Crawl[]> {
  const supabase = await getSupabaseServer()

  const { data, error } = await supabase
    .from('crawls')
    .select('id, title, status, created_at, updated_at, crawl_stops(count)')
    .order('updated_at', { ascending: false })

  if (error) {
    console.error('[crawls] list failed:', error.message)
    return []
  }

  type Row = {
    id: string
    title: string
    status: CrawlStatus
    created_at: string
    updated_at: string
    crawl_stops: { count: number }[] | null
  }

  return ((data ?? []) as Row[]).map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    // An aggregate embed comes back as an array with one object, and as an
    // empty array for a crawl with no stops at all. Both mean zero here.
    stop_count: row.crawl_stops?.[0]?.count ?? 0,
  }))
}

/**
 * One crawl, or null.
 *
 * Null covers three cases the caller does not need to tell apart — no such
 * crawl, somebody else's crawl, and a database failure — and the page turns
 * all three into a 404. Distinguishing "not yours" from "does not exist" would
 * confirm that an id names a real crawl belonging to someone, which is the
 * same disclosure set_crawl_stops() refuses to make.
 *
 * There is no user_id argument and there must never be one: RLS answers with
 * the caller's own row or with nothing.
 */
export async function getOwnCrawl(crawlId: string): Promise<Crawl | null> {
  const supabase = await getSupabaseServer()

  const { data, error } = await supabase
    .from('crawls')
    .select('id, title, status, created_at, updated_at, crawl_stops(count)')
    .eq('id', crawlId)
    .maybeSingle()

  if (error) {
    console.error('[crawls] lookup failed:', error.message)
    return null
  }
  if (!data) return null

  const row = data as {
    id: string
    title: string
    status: CrawlStatus
    created_at: string
    updated_at: string
    crawl_stops: { count: number }[] | null
  }

  return {
    id: row.id,
    title: row.title,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    stop_count: row.crawl_stops?.[0]?.count ?? 0,
  }
}
