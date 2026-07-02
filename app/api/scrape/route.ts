import { NextRequest, NextResponse } from 'next/server'
import { writeFileSync } from 'fs'
import { runAgent1, getActiveInstitutions, getInstitutionsDueForRefresh } from '@/lib/scraper'

// POST /api/scrape — scrape venues past check_back_date
// POST /api/scrape?force=true — re-scrape all active venues
// Returns 202 immediately; scrape runs in the background.
export async function POST(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const force = params.get('force') === 'true'
  const skipPrereads = params.get('skip_prereads') === 'true'
  const venueFilter = params.get('venues')?.split(',').map((v) => v.trim().toLowerCase()) ?? null

  // Peek at the institution list up front just to report it in the immediate response —
  // runAgent1() re-derives the same list itself when the background job actually runs.
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

  if (!force) {
    console.log(`Refreshing ${institutions.length} institutions due for refresh:`, institutions.map((v) => v.name))
  }

  // Fire-and-forget — do not await, respond immediately
  Promise.resolve().then(async () => {
    try {
      await runAgent1({ force, skipPrereads, venueFilter })
      console.log('Scrape complete.')
    } catch (err) {
      console.error('Agent 1 run failed:', err)
    }
  })

  return NextResponse.json({
    message: `Scraping ${institutions.length} institution(s) in the background`,
    venues: institutions.map((v) => v.name),
    scraped: institutions.length,
  })
}
