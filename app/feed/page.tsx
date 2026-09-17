import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { getFeedEvents } from '@/lib/feed'
import { cursorAfter, FEED_PAGE_SIZE } from '@/lib/feed-types'
import FeedList from '@/components/feed/FeedList'
import '@/app/account.css'
import '@/app/feed.css'

/**
 * The activity feed.
 *
 * DELIBERATELY NOT IN THE NAV. Reachable at /feed and nowhere else for now,
 * the same way the sign-in link was held back until it had somewhere to go.
 * There are no event types yet, so every account would find an empty page —
 * not worth making it somebody's first impression of the product. The link
 * goes in when the first real event type does; there is nothing else to change
 * at that point, which is the whole reason to build the plumbing now.
 *
 * Sign-in only. A feed is the activity of the accounts YOU follow, so there is
 * no signed-out version of this page to render — requireUser() sends visitors
 * to sign in rather than showing an empty feed that would be empty for a
 * different reason than everyone else's.
 */

export const metadata = {
  title: 'Feed — Idea 2',
  // Nothing to index: it is a different page per person and sign-in only.
  robots: { index: false, follow: false },
}

// The feed is per-person and changes as the people you follow do things, so
// there is nothing here to cache between requests.
export const dynamic = 'force-dynamic'

export default async function FeedPage() {
  await requireUser()

  const events = await getFeedEvents()

  return (
    <div className="ac-page">
      <div className="ac-shell ac-shell--wide">
        <Link href="/" className="ac-back">Idea 2</Link>

        <h1 className="ac-title">Feed</h1>
        <p className="ac-subtitle">What the people you follow have been doing.</p>

        <div className="fd-body">
          <FeedList
            initialEvents={events}
            initialCursor={cursorAfter(events, FEED_PAGE_SIZE)}
          />
        </div>
      </div>
    </div>
  )
}
