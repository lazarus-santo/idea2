import { NextRequest, NextResponse } from 'next/server'
import { runAgent1, getActiveInstitutions, getInstitutionsDueForRefresh } from '@/lib/scraper'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'

// GET /api/cron/scrape          — daily: scrape venues whose check_back_date has passed
// GET /api/cron/scrape?force=true — weekly (Sundays): force-scrape all active venues
// Called by Vercel Cron via Authorization: Bearer CRON_SECRET.
//
// Now shares the agent gate with the other three routes, which also accepts
// x-admin-secret. That is a deliberate widening: previously an unset CRON_SECRET
// made the comparison `authHeader !== 'Bearer undefined'`, so this route would
// have 401'd every legitimate cron call rather than failing loudly.
export async function GET(request: NextRequest) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()

  const force = request.nextUrl.searchParams.get('force') === 'true'
  // FIX 4 CONFIRMED: both getActiveInstitutions and getInstitutionsDueForRefresh
  // filter .eq('manual_entry_required', false), so Met/MoMA/Brooklyn Museum
  // are automatically excluded from both daily and force-scrape cron runs.
  const institutions = force ? await getActiveInstitutions() : await getInstitutionsDueForRefresh()

  if (institutions.length === 0) {
    return NextResponse.json({ message: 'All institutions up to date', scraped: 0 })
  }

  console.log(`Cron scrape (force=${force}): ${institutions.length} institution(s) — ${institutions.map((v) => v.name).join(', ')}`)

  Promise.resolve().then(async () => {
    try {
      await runAgent1({ force })
      console.log('Cron scrape complete.')
    } catch (err) {
      console.error('Agent 1 run failed:', err)
    }
  })

  return NextResponse.json({
    message: `Scraping ${institutions.length} institution(s) in the background`,
    venues: institutions.map((v) => v.name),
    force,
  })
}
