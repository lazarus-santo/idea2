import { NextResponse } from 'next/server'
import { getScrapedFailedInstitutions } from '@/lib/scraper'

// GET /api/admin/venues?scrape_failed=true — venues where last scrape failed
export async function GET() {
  try {
    const venues = await getScrapedFailedInstitutions()
    return NextResponse.json(venues)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
