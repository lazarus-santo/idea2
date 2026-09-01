#!/usr/bin/env node
/**
 * ONE-TIME backfill — unpack exhibitions.coverage (jsonb) into prereads rows.
 *
 * Renamed from backfill-museum-coverage.mjs: the query is generic over
 * exhibitions.coverage IS NOT NULL, so it always covered fairs too (they write
 * to the same column — migration_v29) alongside museums. The old name implied
 * a scope narrower than what the script actually does.
 *
 * Part of unifying museum AND fair coverage into the same prereads table
 * galleries already use (migration_v35 adds the four columns this needs:
 * artist_name, item_coverage_type, author, published_date). Not wired into any
 * cron or admin action, and does not run automatically — review the dry-run
 * output first, then run for real:
 *
 *     node scripts/backfill-coverage-to-prereads.mjs            # dry run — prints only
 *     node scripts/backfill-coverage-to-prereads.mjs --execute  # actually inserts
 *
 * SCOPE
 * Every exhibition with a non-null, non-empty exhibitions.coverage array —
 * museum or fair, whichever institution type produced it. Each array item
 * becomes one prereads row, exhibition_id preserved.
 *
 * FIELD MAPPING (as specified — nothing added beyond it)
 *   url            -> article_url
 *   title          -> article_title
 *   publication    -> publication
 *   thumbnail_url  -> thumbnail_url
 *   artist_name    -> artist_name
 *   coverage_type  -> item_coverage_type   (NOT prereads.coverage_type — no such
 *                                           column; exhibitions' own coverage_type
 *                                           is the unrelated Type A-D tier and is
 *                                           untouched by this script)
 *   author         -> author               (real column as of migration_v35 —
 *                                           earlier draft folded this into
 *                                           summary as "By {author}"; that
 *                                           workaround is gone)
 *   published_date -> published_date       (real column as of migration_v35,
 *                                           timestamptz — earlier draft dropped
 *                                           this field entirely)
 *
 * IDEMPOTENCY
 * Skips inserting any item whose (exhibition_id, article_url) pair already
 * exists in prereads — safe to review, adjust, and re-run without duplicating
 * rows if run more than once, or if generateMuseumCoverage's / the fair
 * routes' new prereads-table insert paths have already written some of these
 * live between when this script was written and when it's run.
 *
 * KNOWN PRE-EXISTING DATA NOTE
 * At least one coverage_only exhibition already holds unrelated stray rows in
 * prereads from an earlier, separate incident (not from this script, not from
 * generateMuseumCoverage — traced to a different cause during the diagnostic
 * session that preceded this task). This script does not touch or clean up
 * existing prereads rows; it only adds the coverage-array items that aren't
 * already present by URL. Cleaning up stray rows is out of scope here.
 *
 * exhibitions.coverage is NOT modified or dropped by this script.
 */
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })

const EXECUTE = process.argv.includes('--execute')

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

async function main() {
  const { data: exhibitions, error } = await db
    .from('exhibitions')
    .select('id, show_title, coverage, venues(institutions(type))')
    .not('coverage', 'is', null)

  if (error) {
    console.error('Failed to load exhibitions:', error.message)
    process.exit(1)
  }

  const withItems = (exhibitions ?? []).filter(
    (e) => Array.isArray(e.coverage) && e.coverage.length > 0
  )

  const byType = {}
  for (const e of withItems) {
    const t = e.venues?.institutions?.type ?? 'unknown'
    byType[t] = (byType[t] ?? { exhibitions: 0, items: 0 })
    byType[t].exhibitions++
    byType[t].items += e.coverage.length
  }

  console.log(`${EXECUTE ? 'EXECUTING' : 'DRY RUN'} — ${withItems.length} exhibition(s) with a non-empty coverage array (of ${exhibitions?.length ?? 0} with coverage non-null)`)
  console.log('By institution type:', JSON.stringify(byType, null, 2))
  console.log()

  let totalItems = 0
  let totalSkippedExisting = 0
  let totalToInsert = 0
  let totalFailed = 0
  let missingAuthor = 0
  let missingPublishedDate = 0

  for (const ex of withItems) {
    const { data: existing } = await db
      .from('prereads')
      .select('article_url')
      .eq('exhibition_id', ex.id)
    const existingUrls = new Set((existing ?? []).map((r) => r.article_url))

    const rows = []
    for (const item of ex.coverage) {
      totalItems++
      if (!item.author) missingAuthor++
      if (!item.published_date) missingPublishedDate++
      if (item.url && existingUrls.has(item.url)) {
        totalSkippedExisting++
        continue
      }
      rows.push({
        exhibition_id: ex.id,
        article_title: item.title ?? null,
        publication: item.publication ?? null,
        article_url: item.url ?? null,
        thumbnail_url: item.thumbnail_url ?? null,
        summary: null,
        artist_name: item.artist_name ?? null,
        item_coverage_type: item.coverage_type ?? null,
        author: item.author ?? null,
        published_date: item.published_date ?? null,
      })
    }

    if (rows.length === 0) continue
    totalToInsert += rows.length

    const type = ex.venues?.institutions?.type ?? 'unknown'
    console.log(`"${ex.show_title}" [${type}] — ${rows.length} row(s) to insert:`)
    for (const r of rows) {
      console.log(`  [${r.item_coverage_type ?? 'null'}] ${r.artist_name ?? '(no artist)'} — ${r.article_title} — by ${r.author ?? '(no author)'} (${r.published_date ?? 'no date'})`)
    }

    if (EXECUTE) {
      const { error: insertError } = await db.from('prereads').insert(rows)
      if (insertError) {
        totalFailed += rows.length
        console.error(`  INSERT FAILED for "${ex.show_title}": ${insertError.message}`)
      }
    }
  }

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`Exhibitions with coverage items: ${withItems.length}`)
  console.log(`Total coverage items seen:       ${totalItems}`)
  console.log(`  items missing author:           ${missingAuthor}`)
  console.log(`  items missing published_date:   ${missingPublishedDate}`)
  console.log(`Already present (skipped):       ${totalSkippedExisting}`)
  console.log(`${EXECUTE ? 'Inserted' : 'Would insert'}:${' '.repeat(EXECUTE ? 18 : 12)}${totalToInsert - totalFailed}`)
  if (EXECUTE && totalFailed > 0) console.log(`Failed inserts:                  ${totalFailed}`)
  if (!EXECUTE) console.log(`\nRe-run with --execute to actually write these rows.`)
}

main()
