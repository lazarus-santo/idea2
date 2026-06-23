import { NextRequest, NextResponse } from 'next/server'

// GET /api/og-image?url=... — extracts og:image from an article URL server-side
export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get('url')
  if (!url) return NextResponse.json({ image_url: null })

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)',
        Accept: 'text/html',
      },
      signal: AbortSignal.timeout(6000),
    })

    if (!res.ok) return NextResponse.json({ image_url: null })

    const html = await res.text()

    // Extract og:image
    const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)

    const image_url = ogMatch?.[1] ?? null

    return NextResponse.json({ image_url }, {
      headers: { 'Cache-Control': 'public, max-age=86400' },
    })
  } catch {
    return NextResponse.json({ image_url: null })
  }
}
