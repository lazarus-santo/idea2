import 'server-only'

import { getSupabaseServer } from '@/lib/supabase-server'
import { FEED_PAGE_SIZE, type FeedCursor, type FeedEvent } from '@/lib/feed-types'

/**
 * Reading the activity feed from the server.
 *
 * WRITES ARE NOT HERE, and not anywhere else either. Nothing in this app puts
 * rows in public.events — migration_v47 grants no INSERT to authenticated at
 * all, because a browser that can write events can invent activity that never
 * happened. The first real event type will be written by a database trigger or
 * a service-key route next to the write it is a side effect of.
 *
 * THERE ARE NO EVENT TYPES YET, so in production this returns [] for everyone.
 * That is the expected state, not a failure: the exhibition log it is waiting
 * for does not exist yet. Nothing below knows or cares what types exist —
 * that knowledge lives entirely in the renderer registry in
 * components/feed/renderers.tsx.
 */

/**
 * The events of the accounts this person follows, newest first.
 *
 * Everything that matters about scoping happens inside public.feed_events():
 * it takes no viewer id (so it cannot be pointed at somebody else's feed), it
 * joins only APPROVED follows (so asking to follow a private account does not
 * start showing you its activity), and it runs as the invoker (so RLS on
 * events, follows and profiles stays live underneath as an independent
 * backstop). Repeating any of those filters here would be a second copy of the
 * rule that could drift from the first.
 *
 * Never throws. A feed that fails to load should be an empty feed with a line
 * in the log, not a 500 on a page somebody just clicked.
 */
export async function getFeedEvents(
  cursor: FeedCursor | null = null,
  limit: number = FEED_PAGE_SIZE
): Promise<FeedEvent[]> {
  try {
    const supabase = await getSupabaseServer()
    const { data, error } = await supabase.rpc('feed_events', {
      max_rows: limit,
      before_time: cursor?.before_time ?? null,
      before_id: cursor?.before_id ?? null,
    })

    if (error) {
      console.error('[feed] events lookup failed:', error.message)
      return []
    }
    return (data ?? []) as FeedEvent[]
  } catch (err) {
    console.error('[feed] events lookup threw:', err)
    return []
  }
}
