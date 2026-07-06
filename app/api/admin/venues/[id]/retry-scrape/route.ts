import { NextRequest, NextResponse } from 'next/server'
import { scrapeInstitution, getVenueById } from '@/lib/scraper'

// POST /api/admin/venues/[id]/retry-scrape — manually retry a failed or
// manual-entry-flagged institution. Looked up directly by id (not filtered
// through getActiveInstitutions) so manual_entry_required venues are reachable —
// scrapeInstitution() itself decides whether to re-flag or clear it.
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const venue = await getVenueById(id)

  if (!venue) {
    return NextResponse.json({ error: 'Venue not found or inactive' }, { status: 404 })
  }

  // Fire-and-forget; caller gets immediate confirmation
  Promise.resolve().then(async () => {
    try {
      const count = await scrapeInstitution(venue)
      console.log(`Retry scrape ${venue.name}: ${count} exhibition(s)`)
    } catch (err) {
      console.error(`Retry scrape failed for ${venue.name}:`, err)
    }
  })

  return NextResponse.json({ message: `Retry scrape started for ${venue.name}` })
}
