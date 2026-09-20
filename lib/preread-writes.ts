/**
 * What to write when a preread's article changes — decided here, applied by the
 * caller. Pure functions, so the rules are testable without a database
 * (scripts/test-preread-writes.mjs).
 *
 * The rule they all serve (migration_v61): a row someone has logged is never
 * overwritten. The fresh article goes into a new row and the logged row is
 * frozen — blanked, content untouched, pointing at its replacement — so the
 * log still resolves to the article the person actually read.
 */

import type { PrereadRow } from './claude'
import type { CoverageItem } from './types'

// ─── One row's replacement (repair + admin Replace) ──────────────────────────

/** The fields a replacement article writes. Shared by both paths so they cannot drift. */
function replacementFields(fresh: PrereadRow, boundArtist: string | null) {
  return {
    ...fresh,
    // A per-artist row stays bound to its artist even if the replacement came from
    // a custom query that didn't name them.
    artist_name: boundArtist ?? fresh.artist_name ?? null,
    quality_flag: null,
    row_status: 'active' as const,
    repair_hold: false,
  }
}

/** Unlogged row: the new article is written straight onto it, as it always was. */
export function replacementOverwrite(fresh: PrereadRow, boundArtist: string | null) {
  return replacementFields(fresh, boundArtist)
}

/**
 * Logged row: the new article goes into a row of its own, on the same show.
 * created_at is left to the database — the new row is new.
 */
export function replacementInsert(exhibitionId: string, fresh: PrereadRow, boundArtist: string | null) {
  return { ...replacementFields(fresh, boundArtist), exhibition_id: exhibitionId }
}

/**
 * ...and the logged row is frozen. Only these two columns are written: every
 * content field is left exactly as the person logged it, and the old
 * quality_flag stays too — superseded_by, not the flag, is what keeps the row
 * out of later repairs and out of the show's status.
 */
export function freezeUpdate(replacementId: string) {
  return { row_status: 'blanked' as const, superseded_by: replacementId }
}

// ─── The row a coverage item becomes ─────────────────────────────────────────

/** A museum/fair coverage item as a prereads row. */
export function coverageItemToPrereadRow(exhibitionId: string, item: CoverageItem) {
  return {
    exhibition_id: exhibitionId,
    article_title: item.title,
    publication: item.publication,
    article_url: item.url,
    thumbnail_url: item.thumbnail_url,
    summary: null,
    artist_name: item.artist_name,
    item_coverage_type: item.coverage_type,
    author: item.author,
    published_date: item.published_date,
  }
}

// ─── A fair's coverage, regenerated ──────────────────────────────────────────

/**
 * The key a regenerated coverage item is matched to its existing row by.
 *
 * article_url, normalized — the same idea as Agent 1 matching a scraped show to
 * its row by the page address it was found at (147d8ff), and for the same
 * reason: a title drifts between runs, an address does not. Normalizing the
 * scheme, a `www.`, the case of the host and a trailing slash keeps a cosmetic
 * difference in what Exa returned from splitting one article into two rows. The
 * path's case is left alone, since it is significant on many sites.
 */
export function coverageKey(url: string | null): string | null {
  if (!url) return null
  const trimmed = url.trim()
  if (!trimmed) return null
  try {
    const u = new URL(trimmed)
    const host = u.hostname.toLowerCase().replace(/^www\./, '')
    const path = u.pathname.replace(/\/+$/, '')
    return `${host}${path}${u.search}`
  } catch {
    return trimmed.toLowerCase().replace(/\/+$/, '')
  }
}

export interface ExistingCoverageRow {
  id: string
  article_url: string | null
}

export interface FairCoveragePlan {
  /** Matched rows: same id, refreshed metadata. */
  updates: { id: string; row: Record<string, unknown> }[]
  /** Coverage with no existing row. */
  inserts: Record<string, unknown>[]
  /** Logged rows the regeneration no longer finds: hidden, never deleted. */
  blanks: string[]
  /** Unlogged rows the regeneration no longer finds. migration_v54 logs each one. */
  deletes: string[]
}

/**
 * Match-and-update for a fair's coverage, replacing the delete-everything-then-
 * insert it used to do — which changed every id on every click, the same
 * delete-and-recreate shape Agent 1 had.
 *
 * A matched row keeps its id and gets fresh metadata. article_url is never
 * written: it IS the match key, so an update can only ever refresh the title,
 * thumbnail, author or date of the same article — never swap in a different
 * one. That is why a matched LOGGED row needs no freeze here; the log still
 * points at the article the person read.
 *
 * `summary` and `exhibition_id` are left out of updates too: a null from the
 * fair generator must not wipe something an admin wrote, and a row does not
 * change shows.
 */
/**
 * Columns an update never writes. article_url is the match key, so writing it
 * could only ever be a no-op — or, if the matching were ever loosened, the very
 * content swap this design exists to prevent. exhibition_id never changes, and
 * the fair generator's null summary must not wipe one an admin wrote.
 */
const NEVER_REFRESHED = ['exhibition_id', 'article_url', 'summary'] as const

export function planFairCoverageWrites(
  exhibitionId: string,
  existing: ExistingCoverageRow[],
  fresh: CoverageItem[],
  logged: Set<string>,
  toRow: (exhibitionId: string, item: CoverageItem) => Record<string, unknown>
): FairCoveragePlan {
  const byKey = new Map<string, ExistingCoverageRow>()
  for (const row of existing) {
    const key = coverageKey(row.article_url)
    // First row wins: a duplicate url in the table (possible before this existed)
    // leaves the later copy unmatched, so it ages out as stale rather than both
    // rows fighting over the same article.
    if (key && !byKey.has(key)) byKey.set(key, row)
  }

  const plan: FairCoveragePlan = { updates: [], inserts: [], blanks: [], deletes: [] }
  const matched = new Set<string>()
  const seenFresh = new Set<string>()

  for (const item of fresh) {
    const key = coverageKey(item.url)
    // A fair search returning the same article twice must not produce two rows.
    if (key && seenFresh.has(key)) continue
    if (key) seenFresh.add(key)

    const row = toRow(exhibitionId, item)
    const existingRow = key ? byKey.get(key) : undefined

    if (!existingRow) {
      plan.inserts.push(row)
      continue
    }

    matched.add(existingRow.id)
    const refreshable = { ...row }
    for (const column of NEVER_REFRESHED) delete refreshable[column]
    plan.updates.push({ id: existingRow.id, row: refreshable })
  }

  for (const row of existing) {
    if (matched.has(row.id)) continue
    if (logged.has(row.id)) plan.blanks.push(row.id)
    else plan.deletes.push(row.id)
  }

  return plan
}
