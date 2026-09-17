'use client'

import type { FeedEvent } from '@/lib/feed-types'

/**
 * THE REGISTRY: which component draws which kind of event.
 *
 * This is the file a new event type touches, and — apart from whatever writes
 * the row — it should be the ONLY file a new event type touches. The database
 * does not know what types exist (migration_v47 constrains the shape of `type`
 * and not its values), the feed query does not look inside `payload`, and
 * lib/feed.ts passes rows through untouched. All of that is so the answer to
 * "how do I add Crawl completions to the feed?" is: write the row, add a line
 * to FEED_RENDERERS, write the small component it points at.
 *
 * IT IS EMPTY, AND THAT IS CORRECT. There are no event types yet. The
 * exhibition log this feed is waiting for does not exist — it is blocked on
 * exhibition ID stability in Agents 1 and 2 — and Crawls are further out
 * still. Follows are deliberately not events: "X followed Y" is relationship
 * noise, not activity, and this feed only ever carries things people DID.
 *
 * Do not add a placeholder type to make the feed look populated. An empty feed
 * is the honest state and the page says so.
 *
 * ---------------------------------------------------------------------------
 * WHAT A RENDERER IS RESPONSIBLE FOR
 *
 * Only the sentence and body of one event — what happened. It does NOT draw
 * the avatar, the actor's name, the link to their profile or the timestamp:
 * FeedEventCard puts every event in that same frame, so those stay consistent
 * across types and a new type is a few lines rather than a whole card.
 *
 * A renderer receives the whole event and narrows `payload` itself. Payloads
 * are written by an earlier version of the app and live forever, so a renderer
 * should treat every field as possibly missing rather than assume the shape it
 * was written against. Rendering nothing is better than throwing inside a list.
 * ---------------------------------------------------------------------------
 */

export interface FeedRendererProps {
  event: FeedEvent
}

export type FeedRenderer = (props: FeedRendererProps) => React.ReactNode

/**
 * Event type → the component that draws its body.
 *
 * Keys are the dot-namespaced strings stored in events.type, e.g. a future
 * 'log.created'. Nothing validates this map against the database, by design —
 * a type with no entry here still renders (see below) rather than vanishing.
 */
export const FEED_RENDERERS: Record<string, FeedRenderer> = {
  // No event types yet. See the note above before adding one.
}

/**
 * What draws an event whose type nothing is registered for.
 *
 * The alternative is to drop unknown rows on the floor, and that is worse in
 * both directions: during development it makes a wiring mistake look like an
 * empty feed, and in production it would silently hide activity written by a
 * newer deploy from a browser running an older bundle — real events, gone with
 * no trace. Showing a plain, honest line means a row that exists is always
 * visible as something.
 *
 * It is also what makes the type-agnostic claim testable rather than a
 * statement about how the schema looks: insert a row of any invented type and
 * it renders, without a migration and without touching the feed query.
 */
function UnknownEvent({ event }: FeedRendererProps) {
  return (
    <p className="fd-event-body fd-event-body--unknown">
      <span className="fd-event-type">{event.type}</span>
    </p>
  )
}

/** The renderer for a type, falling back to the generic line above. */
export function rendererFor(type: string): FeedRenderer {
  return FEED_RENDERERS[type] ?? UnknownEvent
}
