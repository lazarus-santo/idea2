#!/usr/bin/env node
/**
 * Unit tests for the preread write rules (lib/preread-writes.ts): what repair,
 * Replace and fair regeneration write when a row has been logged, and what they
 * write when it hasn't.
 *
 *     node scripts/test-preread-writes.mjs
 *
 * Exit code 1 on any failure. Needs Node 23.6+ (imports the TypeScript modules
 * directly, no build).
 */
process.removeAllListeners('warning')

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const {
  replacementOverwrite, replacementInsert, freezeUpdate, coverageKey, planFairCoverageWrites,
  // The real row builder the fair route passes in, not a stand-in.
  coverageItemToPrereadRow,
} = await import(join(ROOT, 'lib/preread-writes.ts'))

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    failures++
    console.log(`  FAIL  ${name}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`)
  } else {
    console.log(`  ok    ${name}`)
  }
}

// A replacement article as findReplacementPreread returns it.
const fresh = {
  article_title: 'Diego Marcon’s Unsettling Animations',
  publication: 'Artforum',
  article_url: 'https://www.artforum.com/events/diego-marcon-2026/',
  thumbnail_url: 'https://img.example/marcon.jpg',
  summary: 'A review of the new show.',
  artist_name: null,
  item_coverage_type: 'show_coverage',
  author: 'A Critic',
  published_date: '2026-09-10T00:00:00.000Z',
}

console.log('\nOne row’s replacement')

check('unlogged row: the article is written onto the row, flag cleared, row made visible',
  replacementOverwrite(fresh, null),
  { ...fresh, artist_name: null, quality_flag: null, row_status: 'active', repair_hold: false })

check('a per-artist row stays bound to its artist when the replacement names nobody',
  replacementOverwrite(fresh, 'Diego Marcon').artist_name,
  'Diego Marcon')

check('the replacement’s own artist is used when the row had none',
  replacementOverwrite({ ...fresh, artist_name: 'Marco Poloni' }, null).artist_name,
  'Marco Poloni')

check('logged row: the new article goes into a row of its own, on the same show',
  replacementInsert('exh-1', fresh, null),
  { ...fresh, artist_name: null, quality_flag: null, row_status: 'active', repair_hold: false, exhibition_id: 'exh-1' })

// The point of the whole exercise: the logged row is hidden and pointed at its
// replacement, and NOTHING else about it is written. Any extra key here would be
// a content field being rewritten under someone's log.
check('the frozen row is written with exactly two columns',
  Object.keys(freezeUpdate('new-row-id')).sort(),
  ['row_status', 'superseded_by'])
check('...blanked, pointing at the row that took over',
  freezeUpdate('new-row-id'),
  { row_status: 'blanked', superseded_by: 'new-row-id' })

console.log('\nMatching a regenerated fair article to its row')

check('same address, cosmetic differences', [
  coverageKey('https://www.artnews.com/art-fair/'),
  coverageKey('http://artnews.com/art-fair'),
  coverageKey('HTTPS://ArtNews.COM/art-fair '),
].every((k) => k === coverageKey('https://artnews.com/art-fair')), true)

check('a different path is a different article',
  coverageKey('https://artnews.com/art-fair-2') === coverageKey('https://artnews.com/art-fair'),
  false)

check('path case is significant', coverageKey('https://artnews.com/Art-Fair'), 'artnews.com/Art-Fair')
check('a query string is part of the address', coverageKey('https://artnews.com/p?id=2'), 'artnews.com/p?id=2')
check('no address, no key', [coverageKey(null), coverageKey('   ')], [null, null])
check('an unparseable address still matches itself', coverageKey('not a url/'), 'not a url')

console.log('\nRegenerating a fair’s coverage')

const item = (url, title) => ({
  url, title, author: null, publication: 'Artnews', published_date: null,
  coverage_type: 'general', artist_name: null, thumbnail_url: null,
})

const existing = [
  { id: 'row-still-there', article_url: 'https://artnews.com/frieze-review' },
  { id: 'row-gone', article_url: 'https://hyperallergic.com/old-take' },
  { id: 'row-gone-but-logged', article_url: 'https://artforum.com/logged-piece' },
]
const regenerated = [
  item('https://www.artnews.com/frieze-review/', 'Frieze, reviewed (updated headline)'),
  item('https://artnews.com/frieze-review?utm=x', 'the same article with tracking'),
  item('https://news.example/brand-new', 'Something new'),
]

const plan = planFairCoverageWrites(
  'exh-1', existing, regenerated, new Set(['row-gone-but-logged']), coverageItemToPrereadRow
)

check('an article that is still there keeps its id',
  plan.updates.map((u) => u.id), ['row-still-there'])

check('...and gets the fresh headline',
  plan.updates[0]?.row.article_title, 'Frieze, reviewed (updated headline)')

// article_url is the match key, so an update can only ever refresh metadata. If it
// were written, a regeneration could point a logged row at a different article.
check('...but never a new address, show or summary',
  ['article_url', 'exhibition_id', 'summary'].filter((k) => k in (plan.updates[0]?.row ?? {})),
  [])

check('a tracking parameter makes it a different article, so it is not merged',
  plan.inserts.map((r) => r.article_url),
  ['https://artnews.com/frieze-review?utm=x', 'https://news.example/brand-new'])

check('a row the regeneration no longer finds is deleted (migration_v54 logs it)',
  plan.deletes, ['row-gone'])

check('...unless someone logged it, and then it is only hidden',
  [plan.blanks, plan.deletes.includes('row-gone-but-logged')],
  [['row-gone-but-logged'], false])

// The whole regression this replaces: the old route deleted every row and
// reinserted, so nothing kept its id.
check('nothing that survived was deleted and recreated',
  plan.deletes.includes('row-still-there') || plan.inserts.some((r) => r.article_url?.includes('frieze-review/')),
  false)

const duplicate = planFairCoverageWrites('exh-1', [], [
  item('https://news.example/a', 'A'),
  item('https://news.example/a/', 'A again'),
], new Set(), coverageItemToPrereadRow)
check('the same article returned twice makes one row', duplicate.inserts.length, 1)

const unchanged = planFairCoverageWrites('exh-1', existing, [], new Set(), coverageItemToPrereadRow)
check('a search that comes back empty removes the rows it no longer finds, and adds none',
  [unchanged.inserts.length, unchanged.updates.length, unchanged.deletes.length],
  [0, 0, 3])

console.log(failures === 0 ? '\nAll passed.\n' : `\n${failures} failed.\n`)
process.exit(failures === 0 ? 0 : 1)
