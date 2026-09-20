import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getSupabaseAdmin } from '@/lib/supabase'
import AccountNav from '@/components/account/AccountNav'
import { getCurrentUser } from '@/lib/auth'
import { getOwnReadingLog } from '@/lib/reading-logs'
import { getOwnTopFourContentKeys } from '@/lib/top-four'
import { contentKey } from '@/lib/top-four-types'
import ReadingLog from '@/components/ReadingLog'

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
    .select('id, headline, article_url, author, published_at, publications(name)')
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

  // The page's own reads above use the service key, which is right for public
  // article data and wrong for anything about the visitor. The log is read
  // through their session instead, so RLS decides it: migration_v63 narrows
  // that table to the caller's own rows, and a person can only ever see their
  // own entry here. Other people's logs live on their profiles.
  const viewer = await getCurrentUser()
  const [ownLog, topFourReads] = await Promise.all([
    getOwnReadingLog(viewer?.id ?? null, 'reading', id),
    // Their own keys, read under the same first-person policy — enough for the
    // control below to know whether to offer Add or Remove.
    getOwnTopFourContentKeys(viewer?.id ?? null),
  ])

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
          <AccountNav />
        </div>
      </nav>

      <div className="rp-content">
        <div className="rp-meta">
          {pub && <span className="rp-publication">{pub}</span>}
          {reading.author && <span className="rp-author">{reading.author}</span>}
          {pubDate && <span className="rp-date">{pubDate}</span>}
        </div>

        <h1 className="rp-headline">{reading.headline}</h1>

        <a
          href={reading.article_url}
          target="_blank"
          rel="noopener noreferrer"
          className="rp-read-link"
        >
          Read article &rsaquo;
        </a>

        {/* The full block, not the pill: this page is about one article, so
            there is room for the thing the visitor DOES with it. */}
        <ReadingLog
          contentType="reading"
          contentId={id}
          title={reading.headline}
          viewerId={viewer?.id ?? null}
          log={ownLog}
          signInNext={`/readings/${id}`}
          inTopFour={topFourReads.includes(contentKey('reading', id))}
        />

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
