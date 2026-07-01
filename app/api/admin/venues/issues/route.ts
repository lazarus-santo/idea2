import { NextResponse } from 'next/server'
import { getScrapeIssueVenues } from '@/lib/scraper'

// GET /api/admin/venues/issues — venues with scrape_failed or manual_entry_required
export async function GET() {
  try {
    const venues = await getScrapeIssueVenues()
    return NextResponse.json(venues)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
