#!/usr/bin/env node
/**
 * Regression check for Agent 1's link filters against the stored corpus
 * (test/fixtures/link-corpus.json).
 *
 *     node scripts/check-link-corpus.mjs            # summary + every known-bad slip
 *     node scripts/check-link-corpus.mjs --verbose  # also list every known-bad catch
 *
 * Runs the filters that decide whether a found link is a listing/section page
 * rather than a show — the same functions Agent 1 calls, imported directly:
 *   - isSectionPageUrl        (URL last segment; Tier 1 and Tier 2)
 *   - listingPageTitleReason  (whole-title listing language; Tier 1 and Tier 2)
 *
 * Exit code 1 if any known-good show is dropped — that is a regression. Known-bad
 * links that slip through are reported, not failed: the corpus records real
 * misses a filter hasn't been taught yet, and the count is the baseline to beat.
 *
 * Needs Node 23.6+ (imports the TypeScript module directly, no build step).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Importing a .ts file from a package without "type" prints a reparse notice.
process.removeAllListeners('warning')

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VERBOSE = process.argv.includes('--verbose')

const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 23 || (major === 23 && minor < 6)) {
  console.error(`Node ${process.versions.node} can't import TypeScript directly — use Node 23.6 or newer.`)
  process.exit(2)
}

const { isSectionPageUrl, listingPageTitleReason } = await import(join(ROOT, 'lib/listing-page-checks.ts'))
const corpus = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/link-corpus.json'), 'utf8'))

function whyDropped(entry) {
  if (isSectionPageUrl(entry.url)) return 'isSectionPageUrl'
  const reason = listingPageTitleReason(entry.title, { venueName: entry.venue, url: entry.url })
  return reason ? `listingPageTitleReason: ${reason}` : null
}

const goodDropped = corpus.known_good
  .map((entry) => ({ entry, reason: whyDropped(entry) }))
  .filter((x) => x.reason)

const badResults = corpus.known_bad.map((entry) => ({ entry, reason: whyDropped(entry) }))
const caught = badResults.filter((x) => x.reason)
const slipped = badResults.filter((x) => !x.reason)

console.log(`Link corpus captured ${corpus.captured_at}: ${corpus.known_good.length} known-good, ${corpus.known_bad.length} known-bad\n`)

console.log(`KNOWN-GOOD  ${corpus.known_good.length - goodDropped.length}/${corpus.known_good.length} kept`)
for (const { entry, reason } of goodDropped) {
  console.log(`  DROPPED (regression)  ${entry.venue} | ${entry.title} | ${entry.url}\n                        ${reason}`)
}

console.log(`\nKNOWN-BAD   ${caught.length}/${corpus.known_bad.length} caught, ${slipped.length} slip through`)
const byKind = new Map()
for (const { entry, reason } of badResults) {
  const k = byKind.get(entry.kind) ?? { caught: 0, total: 0 }
  k.total++
  if (reason) k.caught++
  byKind.set(entry.kind, k)
}
for (const [kind, { caught: c, total }] of byKind) console.log(`  ${kind.padEnd(34)} ${c}/${total} caught`)

if (VERBOSE) {
  console.log('\n  caught:')
  for (const { entry, reason } of caught) console.log(`    ${entry.title ?? '(no title)'} | ${entry.url}\n      ${reason}`)
}
console.log('\n  slip through:')
for (const { entry } of slipped) console.log(`    ${entry.title ?? '(no title)'} | ${entry.url}`)

process.exit(goodDropped.length > 0 ? 1 : 0)
