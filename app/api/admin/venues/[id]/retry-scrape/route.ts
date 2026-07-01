import { NextRequest, NextResponse } from 'next/server'
import { scrapeInstitution, getActiveInstitutions } from '@/lib/scraper'

// POST /api/admin/venues/[id]/retry-scrape — manually retry a failed institution
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const all = await getActiveInstitutions()
  const venue = all.find((v) => v.id === id)

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
