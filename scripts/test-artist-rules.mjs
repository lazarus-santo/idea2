#!/usr/bin/env node
/**
 * Unit tests for Agent 1's artist decision table (lib/artist-rules.ts).
 *
 *     node scripts/test-artist-rules.mjs
 *
 * Covers all eight branches of the inferred/credited × solo/group/6+/absent
 * table, plus the venue mute. Exit code 1 on any failure. Needs Node 23.6+.
 */
process.removeAllListeners('warning')

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { decideArtists, LARGE_GROUP_MIN, GROUP_WARNING_TYPE } =
  await import(join(ROOT, 'lib/artist-rules.ts'))

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

const SOLO = ['Andrea Bowers']
const SMALL = ['Andrea Bowers', 'Kenneth Victor Young', 'Eileen Agar']
const BIG = ['A One', 'B Two', 'C Three', 'D Four', 'E Five', 'F Six']
const HUGE = Array.from({ length: 40 }, (_, i) => `Artist ${i + 1}`)

const decide = (o) => decideArtists({ venueGroupWarningMuted: false, ...o })

console.log('\nINFERRED — names read out of the title or prose')
check('solo + appears -> publish',
  decide({ extracted: SOLO, verified: SOLO, provenance: 'inferred' }),
  { artists: SOLO, hideNames: false, pendingReason: null, recordGroupWarning: false })

const inferredGroup = decide({ extracted: SMALL, verified: SMALL, provenance: 'inferred' })
check('group + appears -> pending anyway', typeof inferredGroup.pendingReason, 'string')
check('group + appears -> names kept, not hidden', [inferredGroup.artists.length, inferredGroup.hideNames], [3, false])

const inferredMissing = decide({ extracted: SMALL, verified: [], provenance: 'inferred' })
check('does not appear -> artists emptied', inferredMissing.artists, [])
check('does not appear -> pending', typeof inferredMissing.pendingReason, 'string')

console.log('\nCREDITED — names from a dedicated list or credit line')
check('solo + appears -> publish',
  decide({ extracted: SOLO, verified: SOLO, provenance: 'credited' }),
  { artists: SOLO, hideNames: false, pendingReason: null, recordGroupWarning: false })

check('group of 3 + appears -> publish, names shown',
  decide({ extracted: SMALL, verified: SMALL, provenance: 'credited' }),
  { artists: SMALL, hideNames: false, pendingReason: null, recordGroupWarning: false })

// Exactly at the boundary: 5 publishes normally, 6 hides.
const five = SMALL.concat(['D Four', 'E Five'])
check('group of 5 is not a large group', decide({ extracted: five, verified: five, provenance: 'credited' }).hideNames, false)

const firstBig = decide({ extracted: BIG, verified: BIG, provenance: 'credited' })
check('first 6+ at a venue -> pending for confirmation', typeof firstBig.pendingReason, 'string')
check('first 6+ -> names hidden', firstBig.hideNames, true)
check('first 6+ -> names still stored', firstBig.artists.length, 6)
check('first 6+ -> records the venue warning', firstBig.recordGroupWarning, true)

const mutedBig = decide({ extracted: BIG, verified: BIG, provenance: 'credited', venueGroupWarningMuted: true })
check('muted venue, 6 artists -> publishes straight through', mutedBig.pendingReason, null)
check('muted venue -> still hides names', mutedBig.hideNames, true)
check('muted venue -> does not re-record', mutedBig.recordGroupWarning, false)

// The mute is keyed to the venue and warning type, never the count.
const mutedHuge = decide({ extracted: HUGE, verified: HUGE, provenance: 'credited', venueGroupWarningMuted: true })
check('muted venue, 40 artists -> still no prompt', mutedHuge.pendingReason, null)
check('muted venue, 40 artists -> hidden and stored', [mutedHuge.hideNames, mutedHuge.artists.length], [true, 40])

const creditedMissing = decide({ extracted: BIG, verified: BIG.slice(0, 5), provenance: 'credited' })
check('one name missing -> whole set emptied', creditedMissing.artists, [])
check('one name missing -> pending', typeof creditedMissing.pendingReason, 'string')
check('one name missing -> no warning recorded', creditedMissing.recordGroupWarning, false)

console.log('\nedges')
check('no artists at all is not a failure',
  decide({ extracted: [], verified: [], provenance: 'credited' }),
  { artists: [], hideNames: false, pendingReason: null, recordGroupWarning: false })
check('blank strings are ignored',
  decide({ extracted: ['  ', ''], verified: [], provenance: 'inferred' }).pendingReason, null)
check('verification is case-insensitive',
  decide({ extracted: ['Andrea Bowers'], verified: ['andrea bowers'], provenance: 'credited' }).artists,
  ['Andrea Bowers'])
check('names are trimmed',
  decide({ extracted: ['  Andrea Bowers  '], verified: ['Andrea Bowers'], provenance: 'credited' }).artists,
  ['Andrea Bowers'])
check('large-group threshold is 6', LARGE_GROUP_MIN, 6)
check('warning type is stable', GROUP_WARNING_TYPE, 'non_inferred_group_6_plus')

console.log(failures === 0 ? '\nAll artist-rule tests passed.' : `\n${failures} test(s) FAILED.`)
process.exit(failures > 0 ? 1 : 0)
