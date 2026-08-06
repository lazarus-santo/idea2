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

  const body = await request.json().catch(() => null)

  // Accepts a single url, or several for fairs that split their roster by
  // exhibitor type across pages (The Armory Show: Galleries, Solo, Focus,
  // Presents, Platform, Not-For-Profit). All pages render in one Browserbase
  // session, so a sectioned fair costs the same session as a flat one.
  const raw: unknown[] = Array.isArray(body?.urls) ? body.urls : body?.url ? [body.url] : []
  if (raw.length === 0) {
    return NextResponse.json({ error: 'url or urls[] is required' }, { status: 400 })
  }

  const inputs: { url: string; section?: string | null }[] = []
  for (const entry of raw) {
    const url = typeof entry === 'string' ? entry : (entry as { url?: string })?.url
    const section = typeof entry === 'object' && entry !== null ? (entry as { section?: string }).section ?? null : null
    if (!url || typeof url !== 'string') return NextResponse.json({ error: 'each entry needs a url' }, { status: 400 })
    try { new URL(url) } catch { return NextResponse.json({ error: `not a valid URL: ${url}` }, { status: 400 }) }
    inputs.push({ url, section })
  }

  const result = await scrapeFairExhibitors(inputs)

  if (result.method === 'none') {
    return NextResponse.json({ error: 'Could not fetch the page via Browserbase or plain HTTP', ...result }, { status: 502 })
  }

  return NextResponse.json(result)
}
