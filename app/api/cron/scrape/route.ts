import { NextRequest, NextResponse } from 'next/server'
import { runAgent1, getInstitutionsDueForRefresh } from '@/lib/scraper'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'
import { getSupabaseAdmin } from '@/lib/supabase'

// GET /api/cron/scrape — drain slice: scrape venues whose check_back_date has passed
//
// There used to be a second, Monday-only variant of this cron
// (?force=true, nulling check_back_date on every active venue at once) meant
// to guarantee the whole roster got re-checked weekly. Removed entirely — it
// made Mondays specifically process ~4x the venues of an ordinary tick (69-70
// vs ~17), which is what pushed Monday runs into the 800s ceiling and drove
// the 22-31% killed-run rate documented in the Agent 1 timing investigation.
// It also wasn't fixing a real gap: every venue already gets check_back_date =
// sevenDaysFromNow() after every scrape attempt (success or failure — see
// scraper.ts), so each venue re-queues itself on its own 7-day cycle with no
// help needed. The force pass never even reached the venues that genuinely
// need attention (manual_entry_required=true ones are excluded from its query
// the same way they're excluded from the ordinary drain) — its only effect was
// re-synchronizing every healthy venue onto the same day, which is the
// opposite of what a spread-out queue wants. Manual full-roster re-scrapes are
// still available on demand via POST /api/scrape?force=true (the dashboard's
// "Run Now" button) — that path is untouched, and is not this mechanism: it's
// human-triggered with its own bounded budget, not an automatic weekly cron.
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

  // The drain cron fires every 15 minutes but a slice can run for 13, so
  // invocations would otherwise overlap and scrape the same venues twice.
  if (await anotherRunIsActive()) {
    return NextResponse.json({ message: 'Agent 1 already running — skipping this tick', skipped: true })
  }

  // FIX 4 CONFIRMED: getInstitutionsDueForRefresh filters
  // .eq('manual_entry_required', false), so Met/MoMA/Brooklyn Museum are
  // automatically excluded from the cron run.
  const institutions = await getInstitutionsDueForRefresh()

  if (institutions.length === 0) {
    // The common case: the queue drains in a few hours and then every
    // subsequent tick for the rest of the week costs one Supabase query.
    return NextResponse.json({ message: 'All institutions up to date', scraped: 0 })
  }

  console.log(`Cron scrape: ${institutions.length} institution(s) due — ${institutions.map((v) => v.name).join(', ')}`)

  // Awaited, not fire-and-forget. The previous Promise.resolve().then(...) let
  // the route return in milliseconds and the work continue in the background,
  // which is true of a long-lived dev server and false on Vercel: the instance
  // is frozen the moment the response is sent, so the scrape was going to be
  // killed a few hundred milliseconds in, every night, silently.
  const result = await runAgent1({ timeBudgetMs: TIME_BUDGET_MS })

  return NextResponse.json({
    message: `Scraped ${result.itemsSucceeded}/${result.itemsProcessed} institution(s)`,
    processed: result.itemsProcessed,
    succeeded: result.itemsSucceeded,
    failed: result.itemsFailed,
    remaining: result.summary?.remaining ?? 0,
  })
}
