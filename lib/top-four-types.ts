import type { ReadingContentType } from '@/lib/reading-log-types'

/**
 * The vocabulary of the Top Four lists — shared by the server and the browser.
 *
 * Its own file for the reason lib/reading-log-types.ts gives: lib/top-four.ts
 * starts with `import 'server-only'`, which is a build-time tripwire, and the
 * editor runs in the browser and needs contentKey(). A type imported from a
 * server-only module is erased and harmless; a FUNCTION imported from one
 * fails the build.
 *
 * ── TWO LISTS, NOT ONE ──────────────────────────────────────────────────────
 *
 * Four exhibitions and four articles, held in two tables, read by two
 * functions and edited separately. They are different kinds of claim — a show
 * you stood in front of, a piece you read — and the log tables they hang off
 * were already split the same way.
 *
 * ── WHAT "ELIGIBLE" MEANS, AND WHERE IT IS DECIDED ──────────────────────────
 *
 * Only something already logged as seen/read can go in a Top Four. The UI is
 * not what enforces that: migration_v64 makes it a foreign key into the log
 * table plus a status trigger, so a write naming anything else is REFUSED. The
 * editor filters the candidate list for the ordinary reason — offering a show
 * somebody has not seen would be offering them an error.
 */

/** Four slots. Named because it appears in the UI, the API and the CHECK. */
export const TOP_FOUR_SIZE = 4

/** One exhibition in somebody's Top Four, as this visitor may see it. */
export interface TopFourExhibition {
  position: number
  exhibition_id: string
  /** When it was PICKED — preserved across reorders, not the last edit. */
  picked_at: string
  rating: number | null
  liked: boolean
  show_title: string
  start_date: string | null
  end_date: string | null
  image_url: string | null
  venue_name: string | null
}

/** One article in somebody's Top Four, across prereads and readings. */
export interface TopFourContentItem {
  position: number
  content_type: ReadingContentType
  content_id: string
  picked_at: string
  rating: number | null
  liked: boolean
  title: string | null
  publication: string | null
  article_url: string | null
  thumbnail_url: string | null
  author: string | null
  published_at: string | null
  /** Prereads only — the show it was filed under, so the slot can link to it. */
  exhibition_id: string | null
  show_title: string | null
  /**
   * True when this preread has since been frozen and replaced (migration_v61).
   * The slot still renders the content beside it, because that IS what the
   * person picked — see profile_top_four_content() in migration_v64.
   */
  superseded: boolean
}

/**
 * The key an article is held under in the editor. The PAIR, never the id
 * alone: prereads and readings have independent id spaces, so an id on its own
 * cannot identify an item. Same rule as readingKey(), and deliberately the
 * same shape, but kept separate because this one is parsed back apart again by
 * the writer below — readingKey() is only ever a map key.
 */
export function contentKey(contentType: ReadingContentType, contentId: string): string {
  return `${contentType}:${contentId}`
}

/** The pair, recovered from a key the editor has been carrying around. */
export function parseContentKey(key: string): {
  contentType: ReadingContentType
  contentId: string
} {
  const split = key.indexOf(':')
  return {
    contentType: key.slice(0, split) as ReadingContentType,
    contentId: key.slice(split + 1),
  }
}

/**
 * One thing the editor can offer, flattened.
 *
 * The editor is one component serving both lists, so it does not know or care
 * whether a candidate is a show or an article — it holds keys in an order and
 * hands them back. Everything it needs to DRAW is here, and everything it
 * needs to SAVE is the key.
 */
export interface TopFourCandidate {
  key: string
  title: string
  subtitle: string | null
}

/**
 * Pad a list out to four, so the UI can draw the empty slots the brief asks
 * for without counting.
 *
 * The database returns only what is set — fewer than four rows when fewer are
 * picked — because a stored "slot 3 is empty" would be a row that has to be
 * kept in step with nothing. Emptiness is the absence of a row, and it becomes
 * visible here, at the edge, which is the only place it means anything.
 */
export function padToFour<T>(entries: T[]): (T | null)[] {
  const slots: (T | null)[] = []
  for (let i = 0; i < TOP_FOUR_SIZE; i++) slots.push(entries[i] ?? null)
  return slots
}
