/**
 * The shape of a feed event, shared by the server read and the browser.
 *
 * No 'server-only' here on purpose: lib/feed.ts is server-side, but the
 * "Load more" button pages through feed_events() from the browser under the
 * visitor's own session, so both sides need this type.
 *
 * NOTHING IN THIS FILE IS SPECIFIC TO AN EVENT TYPE, and there are no event
 * types yet — see supabase/migration_v47.sql for why the log ships empty. The
 * registry that maps a type to the thing that draws it is in
 * components/feed/renderers.tsx; this file is only the row itself.
 */

/**
 * One row of the activity log, with its actor already attached.
 *
 * `payload` is deliberately `unknown`-ish rather than a union of every event
 * type's shape. The feed query, this type and the list component never look
 * inside it — only a renderer registered for a particular `type` does, and it
 * is that renderer's job to narrow it. A union here would mean every new event
 * type edits this file, which is the coupling the whole design avoids.
 */
export interface FeedEvent {
  id: string
  type: string
  payload: Record<string, unknown>
  created_at: string
  actor_id: string
  username: string
  display_name: string | null
  avatar_url: string | null
}

/** How many events a page of the feed asks for. The database caps this at 100. */
export const FEED_PAGE_SIZE = 30

/**
 * The cursor for the next page: the created_at and id of the last row shown.
 *
 * Keyset rather than an offset, because a feed gets rows inserted at its head
 * while somebody is reading it and an offset silently repeats and skips under
 * exactly those conditions. Null means "from the top".
 */
export interface FeedCursor {
  before_time: string
  before_id: string
}

/** The cursor that continues after this page, or null when it was the last. */
export function cursorAfter(events: FeedEvent[], pageSize: number): FeedCursor | null {
  // A short page means the database had nothing more to give. A full page may
  // or may not have more behind it; asking again and getting nothing is the
  // only honest way to find out, and costs one query at the end of a feed.
  if (events.length < pageSize) return null

  const last = events[events.length - 1]
  return { before_time: last.created_at, before_id: last.id }
}
