import { NextRequest, NextResponse } from 'next/server'
import { runAgent1 } from '@/lib/scraper'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'
import { getSupabaseAdmin } from '@/lib/supabase'

// GET /api/cron/scrape — Agent 1's venue queue, every 15 minutes (vercel.json).
//
// Each tick scrapes, one at a time, the venues due right now: those whose
// weekly scrape_day_of_week is today in New York and whose check_back_date has
// arrived, plus venues retrying after a failed attempt. It stops before any
// venue whose estimated duration no longer fits in what is left of the
// invocation. Rules: lib/venue-scrape-schedule.ts. Per-venue claims (the Run
// Lock shared with POST /api/admin/venues/[id]/scrape): lib/venue-scrape-queue.ts.
//
// Called by Vercel Cron via Authorization: Bearer CRON_SECRET. Shares the agent
// gate with the other trigger routes, which also accepts x-admin-secret.

// Hard ceiling for the function: the Fluid-compute maximum on Vercel Pro. On
// Hobby this is silently capped lower and the budget below would overrun it.
export const maxDuration = 800

// Venues may start only while their estimate fits in this. The last 60s are
// held back for recording the final attempt and the run's completion.
const VENUE_BUDGET_MS = maxDuration * 1000 - 60_000

// A stale 'running' row should not block the queue forever — a function killed
// by the platform never gets to write its completion. Same threshold as
// SCRAPE_STALE_MS for a venue's in_progress claim.
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

  // Run-level guard, kept alongside the venue claims: it stops a duplicate cron
  // delivery from doubling Browserbase concurrency. It reads then acts, so two
  // simultaneous deliveries can both pass it — the venue claims are what
  // guarantee neither scrapes a venue the other holds.
  if (await anotherRunIsActive()) {
    return NextResponse.json({ message: 'Agent 1 already running — skipping this tick', skipped: true })
  }

  // Awaited, not fire-and-forget: on Vercel the instance is frozen the moment
  // the response is sent, so backgrounded work is killed almost immediately.
  const result = await runAgent1({ budgetMs: VENUE_BUDGET_MS })

  if (!result) {
    return NextResponse.json({ message: 'No venues due', scraped: 0 })
  }

  return NextResponse.json({
    message: `Scraped ${result.itemsSucceeded}/${result.itemsProcessed} venue(s)`,
    processed: result.itemsProcessed,
    succeeded: result.itemsSucceeded,
    failed: result.itemsFailed,
    remaining: result.summary?.remaining ?? 0,
    stopped_for_time: result.summary?.stopped_for_time ?? null,
  })
}
