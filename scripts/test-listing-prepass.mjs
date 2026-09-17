#!/usr/bin/env node
/**
 * Unit tests for the Tier 1 pre-pass (lib/listing-prepass.ts).
 *
 *     node scripts/test-listing-prepass.mjs
 *
 * Numbers in the expectations come from the 51 real saved listing pages measured
 * on 2026-09-16. Exit code 1 on any failure. Needs Node 23.6+.
 */
process.removeAllListeners('warning')

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const {
  analyzeListingPage, sizingFor,
  WINDOW_FLOOR, WINDOW_CEILING, PAGE_CUTOFF_FLOOR, PAGE_CUTOFF_CEILING,
  OUTPUT_FLOOR, OUTPUT_CEILING, TOKENS_PER_ITEM,
} = await import(join(ROOT, 'lib/listing-prepass.ts'))

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) { failures++; console.log(`  FAIL  ${name}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(expected === undefined ? actual : actual)}`) }
  else console.log(`  ok    ${name}`)
}

const analysis = (o) => ({
  pageChars: 50_000, linkCount: 10, boundaryIndex: null,
  linksBeforeBoundary: 0, linksAfterBoundary: 0,
  maxDistance: 800, medianDistance: 400, measuredLinks: 10, ...o,
})

console.log('\nwindow sizing — max-based, floored and capped')
check('uses the page max', sizingFor(analysis({ maxDistance: 2048 })).contextChars, 2048)
check('never below the old flat 600', sizingFor(analysis({ maxDistance: 71 })).contextChars, WINDOW_FLOOR)
check('a page with no dates still gets the floor', sizingFor(analysis({ maxDistance: 0 })).contextChars, WINDOW_FLOOR)
// Alisan Fine Arts, the worst real page measured.
check('one outlier cannot blow past the ceiling', sizingFor(analysis({ maxDistance: 27856 })).contextChars, WINDOW_CEILING)
check('exactly at the ceiling', sizingFor(analysis({ maxDistance: WINDOW_CEILING })).contextChars, WINDOW_CEILING)

console.log('\npage cutoff — scales to the real page')
check('small page is never truncated below the old cutoff', sizingFor(analysis({ pageChars: 9_522 })).pageCutoff, PAGE_CUTOFF_FLOOR)
// Andrew Kreps: 62% of its windowed text used to be thrown away.
check('Kreps-sized page is sent whole', sizingFor(analysis({ pageChars: 261_259 })).pageCutoff, 261_259)
// Bortolami, the only sampled page above the ceiling.
check('a 1.3M page is capped', sizingFor(analysis({ pageChars: 1_329_438 })).pageCutoff, PAGE_CUTOFF_CEILING)

console.log('\noutput ceiling — sized to expected items')
check('small page gets the floor', sizingFor(analysis({ linkCount: 5 })).maxTokens, OUTPUT_FLOOR)
check('79 items (real Kreps run) clears its measured 8017', sizingFor(analysis({ linkCount: 79 })).maxTokens >= 8017, true)
check('a huge archive-heavy page is capped', sizingFor(analysis({ linkCount: 500 })).maxTokens, OUTPUT_CEILING)
check('cost basis is the measured one', TOKENS_PER_ITEM, 101)

console.log('\nboundary coupling — sizing down only when the prompt also skips')
const kreps = analysis({ linkCount: 216, boundaryIndex: 5000, linksBeforeBoundary: 3, linksAfterBoundary: 213 })
check('Kreps: archive detected, so skip is on', sizingFor(kreps).skipPastSection, true)
check('Kreps: sized on the 3 real shows, floored', sizingFor(kreps).maxTokens, OUTPUT_FLOOR)
const noBoundary = analysis({ linkCount: 216, boundaryIndex: null })
check('no boundary: never skips', sizingFor(noBoundary).skipPastSection, false)
check('no boundary: sized on all links', sizingFor(noBoundary).maxTokens, OUTPUT_CEILING)
// The dangerous case: a heading exists but everything sits above it. Sizing on
// "links before" would be right, but skipping would be a no-op, so leave it off.
const allAbove = analysis({ linkCount: 40, boundaryIndex: 90_000, linksBeforeBoundary: 40, linksAfterBoundary: 0 })
check('heading with nothing under it: no skip', sizingFor(allAbove).skipPastSection, false)
const allBelow = analysis({ linkCount: 40, boundaryIndex: 10, linksBeforeBoundary: 0, linksAfterBoundary: 40 })
check('heading with nothing above it: no skip, sized on all', sizingFor(allBelow).skipPastSection, false)

console.log('\nanalyzeListingPage on real markup shapes')
// 56 Henry's real structure: the date sits inside the anchor.
const henry = `<h2>Current</h2><ul><li><a href="/exhibitions/waterloo"><h4>Christopher K. Ho</h4><h3>Waterloo!</h3><h5><time>Through October 23, 2026</time></h5></a></li></ul>
  <h2>Past</h2><ul><li><a href="/exhibitions/journey"><h4>Michele Cesaratto</h4><h5>May 20 – July 15, 2026</h5></a></li></ul>`
const a1 = analyzeListingPage(henry, 'https://56henry.nyc/exhibitions')
check('finds both show links', a1.linkCount, 2)
check('detects the Past heading', a1.boundaryIndex !== null, true)
check('one link above the boundary', a1.linksBeforeBoundary, 1)
check('one link below it', a1.linksAfterBoundary, 1)
check('date is close to its anchor', a1.maxDistance < 200, true)

// A show legitimately titled "Past Lives" must not be read as an archive heading.
const decoy = `<h3>Past Lives</h3><a href="/exhibitions/past-lives">Past Lives</a><p>March 3, 2026</p>`
check('a show titled "Past Lives" is not a boundary', analyzeListingPage(decoy, 'https://x.com/exhibitions').boundaryIndex, null)

// Off-domain links and site furniture are not candidates.
const mixed = `<a href="https://instagram.com/x/y">ig</a><a href="/about">about</a><a href="/exhibitions/real-show">show</a><p>April 4, 2026</p>`
check('off-domain and nav links are excluded', analyzeListingPage(mixed, 'https://g.com/exhibitions').linkCount, 1)

// The Deborah Bell case: real shows at SINGLE-segment URLs. The old depth rule
// counted 0 of these and handed sizing back to the floors.
const shallow = `<h2>Exhibitions</h2>
  <a href="/abstract-visions"><h3>Abstract Visions &amp; Uncommon Poetry</h3></a><p>March 3 – April 20, 2026</p>
  <a href="/five-west-coast"><h3>Five West Coast Photographers</h3></a><p>May 1 – June 14, 2026</p>
  <a href="/marvin-lazarus"><h3>Marvin Lazarus: Portraits</h3></a><p>July 2 – August 9, 2026</p>`
const shallowA = analyzeListingPage(shallow, 'https://deborahbellphotographs.com/exhibitions')
check('single-segment show URLs are counted', shallowA.linkCount, 3)
check('and they are sized, not floored to zero', shallowA.measuredLinks, 3)

// A link with nothing show-shaped anywhere near it does not count.
const lonely = '<a href="/somewhere">x</a>' + ' '.repeat(9000) + '<h3>Far away</h3>'
check('a link with no nearby content is not a show', analyzeListingPage(lonely, 'https://g.com/exhibitions').linkCount, 0)

// Qualifying on a heading must not cap the measured date distance — pages like
// Whitney (15,801) and Arton (26,516) still need the widest window.
const farDate = `<a href="/show-one"><h3>A Show</h3></a>` + 'x'.repeat(9000) + '<p>March 3, 2026</p>'
const farA = analyzeListingPage(farDate, 'https://g.com/exhibitions')
check('link qualifies on its heading', farA.linkCount, 1)
check('distance to a far date is still reported', farA.maxDistance > 8000, true)
check('and the window clamps to the ceiling', sizingFor(farA).contextChars, WINDOW_CEILING)

console.log(failures === 0 ? '\nAll pre-pass tests passed.' : `\n${failures} test(s) FAILED.`)
process.exit(failures > 0 ? 1 : 0)
