'use client'

import { useRef, useState } from 'react'
import { getSupabaseBrowser } from '@/lib/supabase-browser'
import {
  cursorAfter,
  FEED_PAGE_SIZE,
  type FeedCursor,
  type FeedEvent,
} from '@/lib/feed-types'
import FeedEventCard from './FeedEventCard'

/**
 * The feed itself: a server-rendered first page, then more on request.
 *
 * Paging happens in the browser against public.feed_events() under the
 * visitor's own session — the same arrangement the follow buttons use. That
 * function takes no viewer id and answers only for whoever calls it, so there
 * is no id here to get wrong and no API route needed to hide one.
 *
 * NOT infinite scroll. A feed with no event types cannot be tested by
 * scrolling, and an explicit button keeps the number of queries equal to the
 * number of times somebody asked for more.
 */

interface Props {
  initialEvents: FeedEvent[]
  initialCursor: FeedCursor | null
}

export default function FeedList({ initialEvents, initialCursor }: Props) {
  const [events, setEvents] = useState(initialEvents)
  const [cursor, setCursor] = useState(initialCursor)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A ticket per request, so a slow first click cannot overwrite the result of
  // a fast second one. Deliberately a ref and not state: React may invoke a
  // state updater twice, which would burn two tickets for one request and make
  // every response look stale.
  const ticket = useRef(0)

  async function loadMore() {
    if (!cursor || loading) return

    const mine = ++ticket.current
    setLoading(true)
    setError(null)

    const { data, error } = await getSupabaseBrowser().rpc('feed_events', {
      max_rows: FEED_PAGE_SIZE,
      before_time: cursor.before_time,
      before_id: cursor.before_id,
    })

    if (mine !== ticket.current) return

    if (error) {
      console.error('[feed] load more failed:', error.message)
      setError('Could not load more just now.')
      setLoading(false)
      return
    }

    const page = (data ?? []) as FeedEvent[]

    // Append by id rather than trusting the cursor to have excluded everything
    // already on screen. The keyset makes a duplicate very unlikely; React
    // throwing on a repeated key would take the whole page down if one ever
    // arrived.
    setEvents(current => {
      const seen = new Set(current.map(e => e.id))
      return [...current, ...page.filter(e => !seen.has(e.id))]
    })
    setCursor(cursorAfter(page, FEED_PAGE_SIZE))
    setLoading(false)
  }

  /*
   * THE EMPTY STATE.
   *
   * It says the feed is empty and why, and it does not pretend something is
   * coming on a date nobody has set. There are no event types yet
   * (components/feed/renderers.tsx), so this is what every account sees today
   * — which is also why this page is not linked from the nav.
   */
  if (events.length === 0) {
    return (
      <div className="fd-empty">
        <p className="fd-empty-title">Nothing here yet</p>
        <p className="fd-empty-note">
          When the people you follow do something, it will show up here.
        </p>
      </div>
    )
  }

  return (
    <>
      <ul className="fd-events">
        {events.map(event => <FeedEventCard key={event.id} event={event} />)}
      </ul>

      {error && <p className="ac-follow-error">{error}</p>}

      {cursor && (
        <div className="fd-more">
          <button
            type="button"
            className="ac-btn ac-btn--secondary ac-btn--inline"
            onClick={loadMore}
            disabled={loading}
          >
            {loading ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </>
  )
}
