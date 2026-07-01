import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getSupabaseAdmin } from '@/lib/supabase'

interface PageProps {
  params: Promise<{ id: string }>
}

function formatDate(dateStr: string | null): string | null {
  if (!dateStr) return null
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

export default async function ReadingPage({ params }: PageProps) {
  const { id } = await params

  const { data: reading, error } = await getSupabaseAdmin()
    .from('readings')
    .select('id, headline, article_url, author, published_at, rss_summary, publications(name)')
    .eq('id', id)
    .single()

  if (error || !reading) notFound()

  // Fetch the most recently opened linked exhibition
  const { data: coverageRows } = await getSupabaseAdmin()
    .from('exhibition_coverage')
    .select(`
      exhibitions!inner(
        id, show_title, start_date,
        venues!inner(institutions(name), name)
      )
    `)
    .eq('reading_id', id)
    .order('created_at', { ascending: false })

  // Pick the exhibition with the most recent start_date
  type CoverageRow = {
    exhibitions: {
      id: string
      show_title: string
      start_date: string | null
      venues: { institutions: { name: string } | null; name: string }
    }
  }
  const rows = (coverageRows ?? []) as unknown as CoverageRow[]
  const relatedExhibition = rows
    .map((r) => r.exhibitions)
    .sort((a, b) => {
      const da = a.start_date ? new Date(a.start_date).getTime() : 0
      const db = b.start_date ? new Date(b.start_date).getTime() : 0
      return db - da
    })[0] ?? null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pub = (reading as any).publications?.name ?? null
  const pubDate = formatDate(reading.published_at)

  return (
    <div className="rp-body">
      <nav className="ep-nav" aria-label="Site navigation">
        <div className="ep-nav-inner">
          <Link href="/" className="ep-wordmark">Idea 2</Link>
          <div className="ep-nav-links">
            <Link href="/exhibitions">Exhibitions</Link>
            <Link href="/readings">Readings</Link>
            <Link href="/editors-picks">Editor&apos;s Picks</Link>
          </div>
          <Link href="/search" className="ep-nav-search">Search</Link>
        </div>
      </nav>

      <div className="rp-content">
        <div className="rp-meta">
          {pub && <span className="rp-publication">{pub}</span>}
          {reading.author && <span className="rp-author">{reading.author}</span>}
          {pubDate && <span className="rp-date">{pubDate}</span>}
        </div>

        <h1 className="rp-headline">{reading.headline}</h1>

        {reading.rss_summary && (
          <p className="rp-summary">{reading.rss_summary}</p>
        )}

        <a
          href={reading.article_url}
          target="_blank"
          rel="noopener noreferrer"
          className="rp-read-link"
        >
          Read article &rsaquo;
        </a>

        {relatedExhibition && (
          <div className="rp-related-exhibition">
            <p className="rp-related-label">Related Exhibition</p>
            <Link
              href={`/exhibitions/${relatedExhibition.id}`}
              className="rp-related-link"
            >
              <span className="rp-related-title">{relatedExhibition.show_title}</span>
              <span className="rp-related-institution">
                {relatedExhibition.venues.institutions?.name ?? relatedExhibition.venues.name}
              </span>
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}
