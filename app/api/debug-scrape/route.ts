import { NextRequest, NextResponse } from 'next/server'
import { getActiveInstitutions } from '@/lib/scraper'
import { extractExhibitionsFromPage } from '@/lib/claude'

// GET /api/debug-scrape?venue=hannah+traore
// Runs extraction synchronously and returns raw Claude output for inspection.
export async function GET(request: NextRequest) {
  const filter = request.nextUrl.searchParams.get('venue')?.toLowerCase() ?? ''
  const institutions = await getActiveInstitutions()
  const institution = institutions.find((v) => v.name.toLowerCase().includes(filter))

  if (!institution) {
    return NextResponse.json(
      { error: `No institution matching "${filter}"`, available: institutions.map((v) => v.name) },
      { status: 404 }
    )
  }

  try {
    const res = await fetch(institution.exhibitions_url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    })
    const raw = await res.text()
    const stripped = raw
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')

    const exhibitions = await extractExhibitionsFromPage(raw, institution.name, institution.exhibitions_url)

    return NextResponse.json({
      venue: institution.name,
      raw_html_length: raw.length,
      stripped_length: stripped.length,
      html_sent_chars: stripped.slice(0, 20000).length,
      exhibitions_found: exhibitions.length,
      exhibitions,
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
