import Link from 'next/link'
import { requireOnboardedProfile } from '@/lib/auth'
import { getOwnCrawls } from '@/lib/crawls'
import NewCrawlButton from '@/components/NewCrawlButton'
import '@/app/crawls.css'

export const metadata = { title: 'Crawls — Idea 2' }

/**
 * The signed-in person's crawls.
 *
 * requireOnboardedProfile() is the real gate: it sends signed-out visitors to
 * sign in and half-finished accounts to onboarding. proxy.ts bounces the
 * signed-out case too, but that check is optimistic — it only looks at whether
 * a cookie parses — so arriving here is never proof of anything.
 *
 * The list itself is read under the visitor's own session and RLS returns
 * their rows and no others. There is no user id in the query and there should
 * not be one: a page that takes whose-crawls as an argument is a page somebody
 * will eventually point somewhere else.
 */
export default async function CrawlsPage() {
  const profile = await requireOnboardedProfile()
  const crawls = await getOwnCrawls()

  return (
    <div className="cl-page">
      <div className="cl-shell">
        <Link href="/" className="cl-back">Idea 2</Link>

        <div className="cl-head">
          <div>
            <h1 className="cl-title">Crawls</h1>
            <p className="cl-subtitle">
              A crawl is a walking route between shows — pick the stops, put them
              in order, and the walk between them is drawn on the map.
            </p>
          </div>
          <NewCrawlButton userId={profile.id} />
        </div>

        <p className="cl-privacy">
          Crawls are yours alone for now. Nobody else can see them, including
          people who follow you.
        </p>

        {crawls.length === 0 ? (
          <p className="cl-empty">
            No crawls yet. Start one and add the first stop.
          </p>
        ) : (
          <ul className="cl-list">
            {crawls.map((crawl) => (
              <li key={crawl.id} className="cl-row">
                <Link href={`/crawls/${crawl.id}`} className="cl-row-link">
                  <span className="cl-row-title">{crawl.title}</span>
                  <span className="cl-row-meta">
                    <span className={`cl-badge cl-badge--${crawl.status}`}>
                      {crawl.status === 'draft' ? 'Draft' : 'Planned'}
                    </span>
                    <span>
                      {crawl.stop_count} stop{crawl.stop_count === 1 ? '' : 's'}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
