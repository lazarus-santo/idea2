import { NextRequest, NextResponse } from 'next/server'
import { scrapeInstitution, getActiveInstitutions, getInstitutionsDueForRefresh } from '@/lib/scraper'
import { auditAndRepairPrereads, repairZeroPrereads } from '@/lib/audit'
import { getSupabaseAdmin } from '@/lib/supabase'

// GET /api/cron/scrape          — daily: scrape venues whose check_back_date has passed
// GET /api/cron/scrape?force=true — weekly (Sundays): force-scrape all active venues
// Called by Vercel Cron. Verified via Authorization: Bearer CRON_SECRET header.
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

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
    const scrapedInstitutionIds: string[] = []

    for (const institution of institutions) {
      try {
        const count = await scrapeInstitution(institution)
        console.log(`Scraped ${institution.name}: ${count} exhibition(s)`)
        scrapedInstitutionIds.push(institution.id)
      } catch (err) {
        console.error(`Error scraping ${institution.name}:`, err)
      }
    }

    if (scrapedInstitutionIds.length > 0) {
      try {
        const { data: freshExhibitions } = await getSupabaseAdmin()
          .from('exhibitions')
          .select('id')
          .in('venue_id', scrapedInstitutionIds)
          .eq('status', 'published')

        const ids = (freshExhibitions ?? []).map((e) => e.id)
        if (ids.length > 0) {
          const { report } = await auditAndRepairPrereads(ids)
          if (report.length > 0) console.log('Post-scrape preread repair:', JSON.stringify(report))
        }
      } catch (err) {
        console.error('Post-scrape audit failed:', err)
      }
    }

    try {
      const { attempted, report } = await repairZeroPrereads()
      if (attempted > 0) console.log(`Zero-preread retry: ${attempted} attempted, ${report.length} repaired`, JSON.stringify(report))
    } catch (err) {
      console.error('Zero-preread retry failed:', err)
    }

    console.log('Cron scrape complete.')
  })

  return NextResponse.json({
    message: `Scraping ${institutions.length} institution(s) in the background`,
    venues: institutions.map((v) => v.name),
    force,
  })
}
