import { NextRequest, NextResponse } from 'next/server'
import { scrapeFairExhibitors } from '@/lib/fair-scraper'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'

// POST /api/admin/fairs/scrape  { url }
//
// One-time exhibitor extraction for a single fair page. Deliberately not part of
// any cron: fairs happen a few times a year and their exhibitor list is published
// once and then static, so re-polling on a schedule would spend a Browserbase
// session and a Sonnet call to re-read an unchanged page.
//
// Returns the extraction for review. Nothing is written — the admin confirms the
// list, then POSTs to /api/admin/fairs to create the records.

export const maxDuration = 300

export async function POST(request: NextRequest) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()

  const { url } = await request.json().catch(() => ({ url: null }))
  if (!url || typeof url !== 'string') {
    return NextResponse.json({ error: 'url is required' }, { status: 400 })
  }
  try {
    new URL(url)
  } catch {
    return NextResponse.json({ error: 'url is not a valid URL' }, { status: 400 })
  }

  const result = await scrapeFairExhibitors(url)

  if (result.method === 'none') {
    return NextResponse.json({ error: 'Could not fetch the page via Browserbase or plain HTTP', ...result }, { status: 502 })
  }

  return NextResponse.json(result)
}
