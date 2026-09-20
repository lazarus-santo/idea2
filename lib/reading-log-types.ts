/**
 * The vocabulary of the reading log — shared by the server and the browser.
 *
 * Its own file for one blunt reason: lib/reading-logs.ts starts with
 * `import 'server-only'`, which is a build-time tripwire, and the browser
 * needs readingKey(). A type imported from a server-only module is erased and
 * harmless; a FUNCTION imported from one fails the build. Rather than let that
 * decide where the key-building lives, the shared parts sit here and
 * lib/reading-logs.ts re-exports them, so server callers still have one import
 * to remember.
 *
 * ── WHAT "READING" MEANS ────────────────────────────────────────────────────
 *
 * Two kinds of thing, in two tables with independent id spaces, which is why
 * everything here carries a content_type as well as an id:
 *
 *   'preread'   a prereads row — the articles under a show on its exhibition
 *               page, written by Agent 2.
 *   'reading'   a readings row — Top Stories and the River, written by Agent 3.
 *
 * The PAIR is the identity. An id on its own is ambiguous and must never be
 * passed around without its type; that is also why it is the primary key in
 * migration_v63 rather than content_id alone.
 */

export type ReadingLogStatus = 'reading_list' | 'read'
export type CommentVisibility = 'public' | 'private'
export type ReadingContentType = 'preread' | 'reading'

/** The signed-in person's own entry for one item. */
export interface OwnReadingLog {
  content_type: ReadingContentType
  content_id: string
  status: ReadingLogStatus
  rating: number | null
  liked: boolean
  comment: string | null
  comment_visibility: CommentVisibility | null
}

/**
 * One row of somebody's reading log, as a given visitor is allowed to see it.
 *
 * `comment` is null both when there was never a note and when there is one
 * this visitor may not read. Those are indistinguishable ON PURPOSE: a field
 * that said "there is a private note" would announce the thing privacy is
 * meant to withhold. `comment_visibility` is masked in lockstep for the same
 * reason.
 */
export interface ProfileReadingLogEntry {
  content_type: ReadingContentType
  content_id: string
  status: ReadingLogStatus
  rating: number | null
  liked: boolean
  comment: string | null
  comment_visibility: CommentVisibility | null
  logged_at: string
  title: string | null
  publication: string | null
  article_url: string | null
  thumbnail_url: string | null
  author: string | null
  published_at: string | null
  /** Prereads only — the show the article was filed under, so the entry can link to it. */
  exhibition_id: string | null
  show_title: string | null
  /**
   * True when this preread has since been frozen and replaced (migration_v61).
   * The entry still renders with the content beside it, because that IS what
   * the person read — see the note on profile_reading_logs() in migration_v63.
   */
  superseded: boolean
}

/** The key an own-log lookup is made by. */
export interface ReadingRef {
  contentType: ReadingContentType
  contentId: string
}

/** The key own-log collections are held under. The pair, never the id alone. */
export function readingKey(contentType: ReadingContentType, contentId: string): string {
  return `${contentType}:${contentId}`
}
