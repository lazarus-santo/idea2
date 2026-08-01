import { NextResponse } from 'next/server'
import { getScrapedFailedInstitutions } from '@/lib/scraper'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'

// GET /api/admin/venues?scrape_failed=true — venues where last scrape failed
export async function GET(request: Request) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()

  try {
    const venues = await getScrapedFailedInstitutions()
    return NextResponse.json(venues)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
