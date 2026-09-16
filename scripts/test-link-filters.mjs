#!/usr/bin/env node
/**
 * Unit tests for Agent 1's Section 3 rules (lib/link-filters.ts).
 *
 *     node scripts/test-link-filters.mjs
 *
 * Every case below is a real link, title or date string seen on a real listing
 * page during the 2026-09-15/16 work, not an invented example. Exit code 1 on any
 * failure. Needs Node 23.6+ (imports the TypeScript modules directly, no build).
 */
process.removeAllListeners('warning')

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const {
  dateEvidenceFor, dateCrossCheck, offsiteReason, childListingPathReason,
  detailCapForVenueType, selectWithinCap, MUSEUM_DETAIL_CAP, GALLERY_DETAIL_CAP,
  hasEndDateSignal, capExemptFor,
} = await import(join(ROOT, 'lib/link-filters.ts'))
// The real name forms the scraper passes in, not a stand-in.
const { venueNameForms } = await import(join(ROOT, 'lib/listing-page-checks.ts'))

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

const link = (o) => ({ title: '', url: '', classification: 'current', classification_reason: '', content_type: 'exhibition', location_hint: null, addresses: [], date_hint: null, ...o })

console.log('\ndateEvidenceFor — real date_hint strings')
check('Zwirner range', dateEvidenceFor(link({ date_hint: 'Now Open: September 10—October 17, 2026' })), 'dated')
check('MoMA through', dateEvidenceFor(link({ date_hint: 'Through Jan 2, 2027' })), 'dated')
check('MoMA season end', dateEvidenceFor(link({ date_hint: 'Apr 24, 2026–Fall 2026' })), 'dated')
check('Chapter NY numeric', dateEvidenceFor(link({ date_hint: '09.09.2026 - 10.17.2026' })), 'dated')
check('Bowery abbreviated', dateEvidenceFor(link({ date_hint: 'Sep. 8 - Oct. 3, 2026' })), 'dated')
check('MoMA member previews', dateEvidenceFor(link({ date_hint: 'Member Previews, Sep 17–19 Sep 20, 2026–May 2, 2027' })), 'dated')
check('MoMA ongoing', dateEvidenceFor(link({ date_hint: 'Ongoing' })), 'ongoing')
check('MoMA ongoing from', dateEvidenceFor(link({ date_hint: 'Ongoing from Oct 19' })), 'ongoing')
check('MoMA dated-then-ongoing', dateEvidenceFor(link({ date_hint: 'Mar 8, 2025–ongoing' })), 'ongoing')
check('long-term view', dateEvidenceFor(link({ date_hint: 'On long-term view' })), 'ongoing')
check('Kreps archive: none', dateEvidenceFor(link({ date_hint: null })), 'none')
check('reason citing dates', dateEvidenceFor(link({ date_hint: null, classification_reason: 'end date Oct 4 2026 has not passed' })), 'dated')
check('reason citing a label only', dateEvidenceFor(link({ date_hint: null, classification_reason: 'labeled On View' })), 'none')
check('section heading alone is not a date', dateEvidenceFor(link({ date_hint: null, classification_reason: 'section heading: Current' })), 'none')

console.log('\ndateCrossCheck — reports, never discards')
check('current with no dates is reported', typeof dateCrossCheck(link({ classification: 'current' }), 'none'), 'string')
check('dated current is silent', dateCrossCheck(link({ classification: 'current' }), 'dated'), null)
check('ongoing is silent', dateCrossCheck(link({ classification: 'current' }), 'ongoing'), null)
check('past is not this check’s business', dateCrossCheck(link({ classification: 'past' }), 'none'), null)

const KREPS_NAME = venueNameForms('Andrew Kreps Gallery')
const ZWIRNER_NAME = venueNameForms('David Zwirner 19th Street')

console.log('\noffsiteReason — fairs')
check('booth number', offsiteReason(link({ title: 'Frieze Masters', location_hint: 'Booth D12' }), KREPS_NAME)?.kind, 'fair')
check('named fair', offsiteReason(link({ title: 'Art Basel Miami Beach 2026' }), ZWIRNER_NAME)?.kind, 'fair')
check('armory show', offsiteReason(link({ title: 'The Armory Show 2026' }), venueNameForms('Casey Kaplan'))?.kind, 'fair')
check('own name does not clear a booth', offsiteReason(link({ title: 'David Zwirner at Frieze London' }), ZWIRNER_NAME)?.kind, 'fair')

console.log('\noffsiteReason — loans and collaborations')
check('on view at another museum', offsiteReason(link({ title: 'Dyani White Hawk', location_hint: 'On view at the Walker Art Center' }), venueNameForms('Chapter NY'))?.kind, 'offsite')
check('on loan to', offsiteReason(link({ title: 'Nara', location_hint: 'On loan to the Dallas Museum of Art' }), venueNameForms('Pace New York'))?.kind, 'offsite')
// The case testing item 4 is about: a museum collaboration held at the gallery itself.
check('collaboration at own space is kept', offsiteReason(link({ title: 'Kenneth Victor Young', location_hint: 'Organized with the Studio Museum at Andrew Kreps Gallery' }), KREPS_NAME), null)
check('plain NYC hint is kept', offsiteReason(link({ title: 'Scott Kahn: Silent Night', location_hint: 'New York: 19th Street' }), ZWIRNER_NAME), null)
check('no hint is kept', offsiteReason(link({ title: 'Head Stretch' }), KREPS_NAME), null)
check('a museum venue’s own show is kept', offsiteReason(link({ title: 'Odili Donald Odita: Songs from Life', location_hint: 'The Museum of Modern Art' }), venueNameForms('MoMA')), null)

console.log('\nchildListingPathReason — the Kreps/Lisson descendant gap')
const KREPS = 'https://www.andrewkreps.com/exhibitions'
check('year-range archive', typeof childListingPathReason('https://www.andrewkreps.com/exhibitions/past/all/2026-2024', KREPS), 'string')
check('past/all/all', typeof childListingPathReason('https://www.andrewkreps.com/exhibitions/past/all/all', KREPS), 'string')
check('real Kreps show kept', childListingPathReason('https://www.andrewkreps.com/exhibitions/andrea-bowers7', KREPS), null)
check('real Kreps show kept 2', childListingPathReason('https://www.andrewkreps.com/exhibitions/see-you-tomorrow-under-other-skies', KREPS), null)
// The regression the corpus caught once: a numeric page id is not a date.
check('MoMA numeric id kept', childListingPathReason('https://www.moma.org/calendar/exhibitions/5919', 'https://www.moma.org/calendar/exhibitions'), null)
check('MoMA past section caught', typeof childListingPathReason('https://www.moma.org/calendar/exhibitions/past', 'https://www.moma.org/calendar/exhibitions'), 'string')
check('the listing page itself is not a descendant', childListingPathReason(KREPS, KREPS), null)
check('other host ignored', childListingPathReason('https://example.com/exhibitions/past', KREPS), null)
check('no base URL is a no-op', childListingPathReason('https://www.andrewkreps.com/exhibitions/past', null), null)
check('trailing slash on the base still matches', typeof childListingPathReason('https://www.andrewkreps.com/exhibitions/past/all/2023-2021', 'https://www.andrewkreps.com/exhibitions/'), 'string')

console.log('\ncap')
check('museum cap', detailCapForVenueType('museum'), MUSEUM_DETAIL_CAP)
check('gallery cap', detailCapForVenueType('gallery'), GALLERY_DETAIL_CAP)
check('nonprofit uses gallery cap', detailCapForVenueType('nonprofit'), GALLERY_DETAIL_CAP)
check('missing type uses gallery cap', detailCapForVenueType(undefined), GALLERY_DETAIL_CAP)

console.log('\nhasEndDateSignal — does the listing text name a closing date?')
check('Through Jan 2, 2027', hasEndDateSignal('Through Jan 2, 2027'), true)
check('On Partial view through Oct 12', hasEndDateSignal('On Partial view through Oct 12'), true)
check('full range', hasEndDateSignal('Sep 27, 2026–Jun 13, 2027'), true)
check('abbreviated range', hasEndDateSignal('Sep. 8 - Oct. 3, 2026'), true)
check('numeric range', hasEndDateSignal('09.09.2026 - 10.17.2026'), true)
check('season end still counts', hasEndDateSignal('Apr 24, 2026–Fall 2026'), true)
check('member previews then a real range', hasEndDateSignal('Member Previews, Sep 17–19 Sep 20, 2026–May 2, 2027'), true)
check('Now Open with a close date', hasEndDateSignal('Now Open: September 10—October 17, 2026'), true)
// The cases with no end: these are what the exemption is for.
check('dash-ongoing is NOT an end date', hasEndDateSignal('Mar 8, 2025–ongoing'), false)
check('Ongoing', hasEndDateSignal('Ongoing'), false)
check('Ongoing from Oct 19', hasEndDateSignal('Ongoing from Oct 19'), false)
check('Opens Sept 19 has no close', hasEndDateSignal('Opens Sept 19'), false)
check('a start date alone', hasEndDateSignal('Opened March 21, 2026'), false)
check('no date text at all', hasEndDateSignal(null), false)

console.log('\ncapExemptFor — current + no closing date, and nothing else')
// The real case: New Museum's "New Humans" during its no-end-date window — on
// view now, a real opening date printed, no close announced.
const newHumans = link({ title: 'New Humans: Memories of the Future', classification: 'current', date_hint: 'Opened March 21, 2026' })
check('New Humans pattern is exempt', capExemptFor(newHumans), true)
check('current with no date text at all is exempt', capExemptFor(link({ classification: 'current', date_hint: null })), true)
check('current with a close date is NOT exempt', capExemptFor(link({ classification: 'current', date_hint: 'Through Jan 2, 2027' })), false)
check('current mid-range is NOT exempt', capExemptFor(link({ classification: 'current', date_hint: 'Sep 27, 2026–Jun 13, 2027' })), false)
// Scope guards — these paths must be untouched by this change.
check('permanent is never exempt', capExemptFor(link({ classification: 'permanent', date_hint: 'Ongoing' })), false)
check('permanent with no dates is never exempt', capExemptFor(link({ classification: 'permanent', date_hint: null })), false)
check('upcoming is never exempt', capExemptFor(link({ classification: 'upcoming', date_hint: 'Opens Oct 22' })), false)
check('past is never exempt', capExemptFor(link({ classification: 'past', date_hint: null })), false)

const many = Array.from({ length: 20 }, (_, i) => ({ url: `u${i}`, cap_exempt: false }))
const withExempt = [...many, { url: 'ex1', cap_exempt: true }, { url: 'ex2', cap_exempt: true }]
const sel = selectWithinCap(withExempt, 15)
check('exempt bypass the cap entirely', sel.selected.filter((l) => l.cap_exempt).length, 2)
check('dated fill exactly the cap', sel.selected.filter((l) => !l.cap_exempt).length, 15)
check('exempt do not consume slots', sel.selected.length, 17)
check('the rest are deferred, not lost', sel.deferred.length, 5)
check('ranked order is preserved', sel.selected.slice(2, 5).map((l) => l.url), ['u0', 'u1', 'u2'])
check('under cap keeps everything', selectWithinCap(many.slice(0, 5), 15).deferred.length, 0)
check('a museum over the old cap now keeps 30', selectWithinCap(Array.from({ length: 34 }, (_, i) => ({ url: `m${i}`, cap_exempt: false })), MUSEUM_DETAIL_CAP).selected.length, 30)
// End to end: a New Humans-shaped show sitting last in a ranking still survives a
// full cap, which is the whole point of the fix.
const ranked = [
  ...Array.from({ length: 20 }, (_, i) => ({ url: `dated${i}`, cap_exempt: capExemptFor(link({ classification: 'current', date_hint: 'Through Dec 1, 2026' })) })),
  { url: 'new-humans', cap_exempt: capExemptFor(newHumans) },
]
check('New Humans survives a full cap from last place', selectWithinCap(ranked, 15).selected.some((l) => l.url === 'new-humans'), true)
check('and it is not counted against the 15', selectWithinCap(ranked, 15).selected.length, 16)

console.log(failures === 0 ? '\nAll link-filter tests passed.' : `\n${failures} test(s) FAILED.`)
process.exit(failures > 0 ? 1 : 0)
