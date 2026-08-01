import { NextResponse } from 'next/server'
import { getScrapeIssueVenues } from '@/lib/scraper'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'

// GET /api/admin/venues/issues — venues with scrape_failed or manual_entry_required
export async function GET(request: Request) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()

  try {
    const venues = await getScrapeIssueVenues()
    return NextResponse.json(venues)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
