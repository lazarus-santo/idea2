// Museum and fair coverage, as the public exhibition page shows it.
//
// Since the 2026-09-01 unification (commit 373a606, migration_v35) coverage has
// been written only to prereads. The page kept reading the old
// exhibitions.coverage jsonb, which nothing writes any more — so every show
// covered after that date displayed nothing, and blanking a row (migration_v53)
// could not hide anything. This reads prereads, the same table and the same
// visibility rule as the gallery path.
//
// Pure (no database access) so it can be checked against live rows directly.

import { publicationImportanceRank } from './coverage-ranking'
import type { CoverageDisplayItem } from './types'

export interface CoveragePrereadRow {
  id: string
  article_url: string | null
  article_title: string | null
  publication: string | null
  author: string | null
  published_date: string | null
  thumbnail_url: string | null
  item_coverage_type: string | null
  row_status: string
}

// The generator's own order, rebuilt from what each row records. The old jsonb
// kept the array in the order generateMuseumCoverage / generateFairCoverage chose,
// and prereads has no column for that — rows copied in on 2026-09-01 even share one
// created_at. But the generators order by coverage kind (the show-level search
// first, then per-artist profiles, then past shows) and within a kind by
// publication importance, and both of those ARE on the row. Checked against every
// published show with both copies: this reproduces the old order for 54 of 63.
// The rest were ordered by Exa's relevance ranking within one kind, which was never
// stored anywhere. Newest-first and URL only make ties stable between loads.
const KIND_RANK: Record<string, number> = {
  show_coverage: 0,
  artist_profile: 1,
  artist_interview: 1,
  past_show: 2,
  general: 3,
}

export function prereadsToCoverageDisplay(
  rows: CoveragePrereadRow[],
  readingIdByUrl: Map<string, string>
): CoverageDisplayItem[] {
  return rows
    // Blanked rows (flagged by Agent 2, or hidden by an admin) stay admin-only.
    .filter((r): r is CoveragePrereadRow & { article_url: string } => !!r.article_url && r.row_status === 'active')
    .sort((a, b) => {
      const kind = (KIND_RANK[a.item_coverage_type ?? ''] ?? 9) - (KIND_RANK[b.item_coverage_type ?? ''] ?? 9)
      if (kind !== 0) return kind
      const importance = publicationImportanceRank(a.article_url) - publicationImportanceRank(b.article_url)
      if (importance !== 0) return importance
      const da = a.published_date ? Date.parse(a.published_date) : -Infinity
      const db = b.published_date ? Date.parse(b.published_date) : -Infinity
      if (da !== db) return db - da
      return a.article_url.localeCompare(b.article_url)
    })
    .map((r) => ({
      preread_id: r.id,
      url: r.article_url,
      title: r.article_title,
      author: r.author,
      publication: r.publication,
      published_date: r.published_date,
      thumbnail_url: r.thumbnail_url,
      reading_id: readingIdByUrl.get(r.article_url),
    }))
}
