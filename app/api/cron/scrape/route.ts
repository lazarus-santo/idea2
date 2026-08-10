import { NextRequest, NextResponse } from 'next/server'
import { runAgent1, getInstitutionsDueForRefresh } from '@/lib/scraper'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'
import { getSupabaseAdmin } from '@/lib/supabase'

// GET /api/cron/scrape           — drain slice: scrape venues whose check_back_date has passed
// GET /api/cron/scrape?force=true — weekly: requeue every active venue for the drain
//
// Called by Vercel Cron via Authorization: Bearer CRON_SECRET. Shares the agent
// gate with the other four trigger routes, which also accepts x-admin-secret.
// That is a deliberate widening: the previous inline check built
// `Bearer ${process.env.CRON_SECRET}`, so an unset secret would have rejected
// every legitimate cron call rather than failing loudly.

// Hard ceiling for the function. 800s is the Fluid-compute maximum on Vercel
// Pro; on Hobby this is silently capped at 300s (and 60s without Fluid), which
// is why the time budget below is expressed as a fraction rather than a
// constant — a truncated slice is recoverable, a killed one is not.
export const maxDuration = 800

// Stop *starting* venues at 70% of the ceiling. A venue takes 85–257s
// (agent_runs, three real runs), so the worst case is 560s of budget plus a
// 257s venue = 817s. That overruns 800s, so the budget is trimmed again below.
const TIME_BUDGET_MS = 500_000 // 500s in, worst-case venue out = 757s < 800s

// A stale 'running' row should not block the queue forever — a function killed
// by the platform never gets to write its completion.
const LOCK_STALE_MS = maxDuration * 1000 + 60_000

async function anotherRunIsActive(): Promise<boolean> {
  const { data } = await getSupabaseAdmin()
    .from('agent_runs')
    .select('started_at')
    .eq('agent', 'agent1')
    .eq('status', 'running')
    .order('started_at', { ascending: false })
    .limit(1)

  const row = data?.[0]
  if (!row) return false
  return Date.now() - new Date(row.started_at as string).getTime() < LOCK_STALE_MS
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()

  const force = request.nextUrl.searchParams.get('force') === 'true'

  // The drain cron fires every 15 minutes but a slice can run for 13, so
  // invocations would otherwise overlap and scrape the same venues twice.
  if (await anotherRunIsActive()) {
    return NextResponse.json({ message: 'Agent 1 already running — skipping this tick', skipped: true })
  }

  // The weekly force tick requeues rather than scrapes.
  //
  // A force pass is ~17 venues at 85–257s each, so it cannot finish in one
  // invocation, and "ignore check_back_date" is not resumable — every slice
  // would start from the top of the same list. Clearing the dates instead makes
  // the whole roster due, and the ordinary 15-minute drain finishes the pass
  // over the next few hours. One cheap invocation replaces an impossible one.
  if (force) {
    const { error } = await getSupabaseAdmin()
      .from('venues')
      .update({ check_back_date: null })
      .eq('active', true)
      .eq('manual_entry_required', false)
      .eq('scrapable', true)

    if (error) {
      return NextResponse.json({ error: `Requeue failed: ${error.message}` }, { status: 500 })
    }
    console.log('Weekly force: cleared check_back_date on all active auto-scraped venues.')
  }

  // FIX 4 CONFIRMED: both getActiveInstitutions and getInstitutionsDueForRefresh
  // filter .eq('manual_entry_required', false), so Met/MoMA/Brooklyn Museum
  // are automatically excluded from both daily and force-scrape cron runs.
  const institutions = await getInstitutionsDueForRefresh()

  if (institutions.length === 0) {
    // The common case: the queue drains in a few hours and then every
    // subsequent tick for the rest of the week costs one Supabase query.
    return NextResponse.json({ message: 'All institutions up to date', scraped: 0 })
  }

  console.log(`Cron scrape (requeued=${force}): ${institutions.length} institution(s) due — ${institutions.map((v) => v.name).join(', ')}`)

  // Awaited, not fire-and-forget. The previous Promise.resolve().then(...) let
  // the route return in milliseconds and the work continue in the background,
  // which is true of a long-lived dev server and false on Vercel: the instance
  // is frozen the moment the response is sent, so the scrape was going to be
  // killed a few hundred milliseconds in, every night, silently.
  const result = await runAgent1({ timeBudgetMs: TIME_BUDGET_MS })

  return NextResponse.json({
    message: `Scraped ${result.itemsSucceeded}/${result.itemsProcessed} institution(s)`,
    requeued: force,
    processed: result.itemsProcessed,
    succeeded: result.itemsSucceeded,
    failed: result.itemsFailed,
    remaining: result.summary?.remaining ?? 0,
  })
}
