import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireOnboardedProfile } from '@/lib/auth'
import { getOwnCrawl } from '@/lib/crawls'
import { getCrawlStopDetails } from '@/lib/crawl-stops'
import CrawlBuilder from '@/components/CrawlBuilder'
import '@/app/crawls.css'

export const metadata = { title: 'Crawl — Idea 2' }

interface Props {
  params: Promise<{ id: string }>
}

/**
 * One crawl, open for editing.
 *
 * NOT FOUND COVERS THREE CASES and deliberately does not tell them apart: no
 * such crawl, somebody else's crawl, and a failed read. Both reads below go
 * through the visitor's session, so RLS is what returns nothing for the middle
 * one — there is no ownership check written out in this file, because a
 * hand-written one would be a second privacy model able to drift from
 * migration_v66's.
 *
 * THE BUILDER IS HANDED THE SAVED STOPS AS PROPS rather than fetching them.
 * It holds a local draft, and after a save it calls router.refresh(), which
 * re-runs this component and sends the new details down. That keeps one read
 * path for the stops instead of a server one and a browser one that could
 * disagree about what is saved.
 */
export default async function CrawlPage({ params }: Props) {
  await requireOnboardedProfile()

  const { id } = await params

  const [crawl, stops] = await Promise.all([
    getOwnCrawl(id),
    getCrawlStopDetails(id),
  ])

  if (!crawl || !stops) notFound()

  return (
    <div className="cb-page">
      <nav className="cb-nav">
        <Link href="/" className="cl-back">Idea 2</Link>
        <Link href="/crawls" className="cb-nav-up">All crawls</Link>
      </nav>
      <CrawlBuilder crawl={crawl} initialStops={stops} />
    </div>
  )
}
