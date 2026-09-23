import { NextResponse } from 'next/server'
import { getCrawlView } from '@/lib/crawl-stops'

/**
 * GET /api/crawls/[id]/stops — one crawl as the caller may see it: the crawl
 * (title, status, owner, like count, the caller's own like and save, whether
 * the caller owns it) and its stops, with what it takes to draw and label them.
 * See CrawlView in lib/crawl-types.ts.
 *
 * WHY A ROUTE RATHER THAN A SERVER COMPONENT PROP. /map is a client component
 * — it has to be, it owns a Mapbox instance — and it is a PUBLIC page that
 * loads for signed-out visitors. So the crawl a person opens from their
 * profile arrives as a query parameter and is fetched here, rather than being
 * handed down from a server render the way the retired builder page did it.
 *
 * WHY THE BROWSER CANNOT JUST READ crawl_stops ITSELF. It can read the three
 * columns — migration_v66 gives the owner a SELECT policy. What it cannot read
 * is the exhibitions behind them: v26 granted published exhibitions to `anon`
 * only, so `authenticated` has no read policy on that table at all.
 *
 * The map's own feed (/api/map-exhibitions) covers most stops, but only shows
 * that are CURRENTLY ON. A crawl saved in March whose second stop closed in
 * June would quietly come back one stop shorter, renumbering everything after
 * it — which is the silent rewrite lib/crawl-stops.ts exists to prevent. This
 * route returns every stop, closed ones included, flagged with on_view.
 *
 * ALL AUTHORISATION IS INSIDE getCrawlView(), which reads the crawl under the
 * caller's own session so migration_v66/v67's policies decide: the owner, or —
 * for a COMPLETED crawl — anybody can_view_profile() lets through, signed-out
 * visitors included for a public profile. There is no check written out here,
 * because a second one could drift from the first. null means "no such crawl,
 * or not one you may see" — deliberately the same answer, since telling them
 * apart would confirm that an id names a real crawl belonging to someone.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const view = await getCrawlView(id)
  if (!view) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  // Per viewer — the answer depends on who is asking — so never cached.
  return NextResponse.json(view, { headers: { 'Cache-Control': 'private, no-store' } })
}
