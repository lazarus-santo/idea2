import { NextRequest, NextResponse } from 'next/server'
import { writeFileSync } from 'fs'
import { runAgent1, getActiveInstitutions, getInstitutionsDueForRefresh } from '@/lib/scraper'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'

// POST /api/scrape — scrape venues past check_back_date
// POST /api/scrape?force=true — re-scrape all active venues
// POST /api/scrape?venues=gagosian,pace — restrict to matching venues
// POST /api/scrape?limit=3 — cap how many venues this call processes
//
// Requires CRON_SECRET (bearer) or ADMIN_PASSWORD (x-admin-secret). Every call
// opens Browserbase sessions and Anthropic completions, so leaving this open on
// a public domain is a standing invitation to run up the bill.

export const maxDuration = 800

// Deliberately shorter than the cron route's budget. This is the dashboard's
// "Run Now" button, and a button that hangs for thirteen minutes reads as
// broken; four minutes of work per press, with the remaining count in the
// response, is a usable manual control. The nightly cron does the bulk drain.
const MANUAL_TIME_BUDGET_MS = 240_000

export async function POST(request: NextRequest) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()

  const params = request.nextUrl.searchParams
  const force = params.get('force') === 'true'
  const skipPrereads = params.get('skip_prereads') === 'true'
  const venueFilter = params.get('venues')?.split(',').map((v) => v.trim().toLowerCase()) ?? null
  const limitParam = Number(params.get('limit'))
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined

  // Peeked only to report the queue in the response; runAgent1() re-derives the
  // same list itself.
  let institutions = force
    ? await getActiveInstitutions()
    : await getInstitutionsDueForRefresh()

  if (venueFilter) {
    institutions = institutions.filter((v) => venueFilter.some((f) => v.name.toLowerCase().includes(f)))
  }

  if (institutions.length === 0) {
    return NextResponse.json({ message: 'All institutions up to date', scraped: 0 })
  }

  // Reset the diagnostic log file for this run
  try { writeFileSync('/tmp/scrape-diag.jsonl', '') } catch {}

  console.log(`Manual scrape (force=${force}): ${institutions.length} institution(s) queued`)

  // Awaited rather than fire-and-forget: on Vercel the instance is frozen once
  // the response is sent, so a backgrounded Promise never finishes. See the
  // note in app/api/cron/scrape/route.ts.
  const result = await runAgent1({ force, skipPrereads, venueFilter, limit, timeBudgetMs: MANUAL_TIME_BUDGET_MS })

  return NextResponse.json({
    message: `Scraped ${result.itemsSucceeded}/${result.itemsProcessed} institution(s)`,
    processed: result.itemsProcessed,
    succeeded: result.itemsSucceeded,
    failed: result.itemsFailed,
    remaining: result.summary?.remaining ?? 0,
    errors: result.errors,
  })
}
