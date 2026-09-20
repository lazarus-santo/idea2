'use client'

import { useCallback, useEffect, useState } from 'react'
import { getSupabaseBrowser } from '@/lib/supabase-browser'
import {
  readingKey,
  type OwnReadingLog,
  type ReadingContentType,
} from '@/lib/reading-log-types'

/**
 * The signed-in person's own reading log, read in the browser.
 *
 * The Readings page is a client component that fetches its articles from
 * /api/readings and /api/river, so there is no server render to hang an own-log
 * read off — the exhibition page's arrangement (read it in the page, pass it
 * down) does not apply. This reads the same rows through the visitor's own
 * session instead, under the first-person policies in migration_v63. The anon
 * key cannot see anybody else's log, so nothing here needs to filter.
 *
 * ── WHY IT FETCHES THE WHOLE LOG RATHER THAN THE IDS ON SCREEN ──────────────
 *
 * The obvious version passes the visible article ids and queries for those.
 * It would re-query on every tab switch, every River group filter and every
 * page of results, for a table that holds at most a few hundred rows per
 * person. One read of the lot, kept in memory, is fewer round trips and makes
 * the toggles instant when the person moves between Top Stories and the River.
 *
 * The cap is a safety rail rather than paging: someone who has logged more
 * than LIMIT items sees the most recent ones marked and the rest unmarked,
 * which is wrong in the harmless direction — a toggle that says "not saved"
 * saves again, and the upsert resolves it to the same one row.
 */
const LIMIT = 500

export interface ReadingLogStore {
  /** null while the session is still unknown, and when signed out. */
  viewerId: string | null
  /** Keyed `${content_type}:${content_id}` — use readingKey(). */
  logs: Map<string, OwnReadingLog>
  /** False until the session has been resolved, so nothing renders the wrong state first. */
  ready: boolean
  /** Re-read after a write. Cheap, and simpler than predicting what the database did. */
  refresh: () => void
}

export function useReadingLogs(): ReadingLogStore {
  const [viewerId, setViewerId] = useState<string | null>(null)
  const [logs, setLogs] = useState<Map<string, OwnReadingLog>>(new Map())
  const [ready, setReady] = useState(false)
  const [nonce, setNonce] = useState(0)

  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  // The session first. Same pattern as AccountNav: onAuthStateChange fires
  // once immediately with the current session, then again on sign-in or
  // sign-out in another tab. The read is deferred to the next tick because
  // awaiting Supabase calls inside this callback can deadlock the auth client.
  useEffect(() => {
    const supabase = getSupabaseBrowser()
    let cancelled = false

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'TOKEN_REFRESHED') return
      setTimeout(() => {
        if (cancelled) return
        setViewerId(session?.user.id ?? null)
        if (!session) { setLogs(new Map()); setReady(true) }
      }, 0)
    })

    return () => { cancelled = true; subscription.unsubscribe() }
  }, [])

  useEffect(() => {
    if (!viewerId) return
    let cancelled = false

    ;(async () => {
      const { data, error } = await getSupabaseBrowser()
        .from('reading_logs')
        .select('content_type, content_id, status, rating, liked, comment, comment_visibility')
        .eq('user_id', viewerId)
        .order('updated_at', { ascending: false })
        .limit(LIMIT)

      if (cancelled) return
      if (error) {
        // Loud, then carry on unmarked. A failed read must not look like an
        // empty log in the console as well as on screen.
        console.error('[reading-logs] own log lookup failed:', error.message)
        setReady(true)
        return
      }

      const next = new Map<string, OwnReadingLog>()
      for (const row of (data ?? []) as OwnReadingLog[]) {
        next.set(readingKey(row.content_type, row.content_id), row)
      }
      setLogs(next)
      setReady(true)
    })()

    return () => { cancelled = true }
  }, [viewerId, nonce])

  return { viewerId, logs, ready, refresh }
}

/** One item's entry out of the store, or null. */
export function logFor(
  store: ReadingLogStore,
  contentType: ReadingContentType,
  contentId: string
): OwnReadingLog | null {
  return store.logs.get(readingKey(contentType, contentId)) ?? null
}
