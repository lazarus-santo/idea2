import { NextRequest, NextResponse } from 'next/server'
import { scrapeGallery, getActiveInstitutions, getInstitutionsDueForRefresh } from '@/lib/scraper'
import { auditAndRepairPrereads } from '@/lib/audit'
import { getSupabaseAdmin } from '@/lib/supabase'

// POST /api/scrape — scrape venues past check_back_date
// POST /api/scrape?force=true — re-scrape all active venues
// Returns 202 immediately; scrape runs in the background.
export async function POST(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const force = params.get('force') === 'true'
  const skipPrereads = params.get('skip_prereads') === 'true'
  const venueFilter = params.get('venues')?.split(',').map((v) => v.trim().toLowerCase()) ?? null

  let institutions = force
    ? await getActiveInstitutions()
    : await getInstitutionsDueForRefresh()

  if (venueFilter) {
    institutions = institutions.filter((v) => venueFilter.some((f) => v.name.toLowerCase().includes(f)))
  }

  if (institutions.length === 0) {
    return NextResponse.json({ message: 'All institutions up to date', scraped: 0 })
  }

  if (!force) {
    console.log(`Refreshing ${institutions.length} institutions due for refresh:`, institutions.map((v) => v.name))
  }

  // Fire-and-forget — do not await, respond immediately
  Promise.resolve().then(async () => {
    const scrapedInstitutionIds: string[] = []

    for (const institution of institutions) {
      try {
        const count = await scrapeGallery(institution, skipPrereads)
        console.log(`Scraped ${institution.name}: ${count} exhibition(s)`)
        scrapedInstitutionIds.push(institution.id)
      } catch (err) {
        console.error(`Error scraping ${institution.name}:`, err)
      }
    }

    // Repair any exhibitions that ended up with missing or institution-domain prereads
    if (!skipPrereads && scrapedInstitutionIds.length > 0) {
      try {
        const { data: freshExhibitions } = await getSupabaseAdmin()
          .from('exhibitions')
          .select('id')
          .in('venue_id', scrapedInstitutionIds)
          .eq('status', 'published')

        const ids = (freshExhibitions ?? []).map((e) => e.id)
        if (ids.length > 0) {
          const { report } = await auditAndRepairPrereads(ids)
          if (report.length > 0) {
            console.log('Post-scrape preread repair:', JSON.stringify(report))
          }
        }
      } catch (err) {
        console.error('Post-scrape audit failed:', err)
      }
    }

    console.log('Scrape complete.')
  })

  return NextResponse.json({
    message: `Scraping ${institutions.length} institution(s) in the background`,
    venues: institutions.map((v) => v.name),
    scraped: institutions.length,
  })
}
