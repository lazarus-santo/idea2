import { NextResponse } from 'next/server'
import { getVenueHealth } from '@/lib/venue-health'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'

// GET /api/admin/venues/health — per-venue output, failure stage and schedule for
// the Venue Health tab. Read-only; the tab's scrape button posts to the existing
// /api/admin/venues/[id]/scrape.
export async function GET(request: Request) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()

  try {
    return NextResponse.json(await getVenueHealth())
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
