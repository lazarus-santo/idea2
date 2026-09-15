// Pure address rules for show-based locations (Agent 1, check #10). No I/O and
// no imports, so they can be exercised directly; lib/show-location.ts does the
// geocoding and model calls around them.

export type Borough = 'Manhattan' | 'Brooklyn' | 'Queens' | 'Bronx' | 'Staten Island'

// New York City zips by prefix. 110xx is almost all Nassau County — only 11004
// and 11005 are Queens — and 115xx and 117xx+ are Long Island.
export function boroughForZip(zip: string | null | undefined): Borough | null {
  if (!zip || !/^\d{5}$/.test(zip)) return null
  const prefix = zip.slice(0, 3)
  if (prefix === '100' || prefix === '101' || prefix === '102') return 'Manhattan'
  if (prefix === '103') return 'Staten Island'
  if (prefix === '104') return 'Bronx'
  if (prefix === '112') return 'Brooklyn'
  if (prefix === '111' || prefix === '113' || prefix === '114' || prefix === '116') return 'Queens'
  if (zip === '11004' || zip === '11005') return 'Queens'
  return null
}

// The last five-digit group, skipping one at the very start of the string,
// which is a house number rather than a zip.
export function extractZip(raw: string): string | null {
  const matches = [...raw.matchAll(/\b(\d{5})(?:-\d{4})?\b/g)].filter((m) => (m.index ?? 0) > 0)
  return matches.length ? matches[matches.length - 1][1] : null
}

const US_STATES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS',
  'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC',
  'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
])

// A trailing ", CA 90036" or ", NY" — the two-letter code only, and only at the end.
export function extractState(raw: string): string | null {
  const m = raw.match(/,\s*([A-Za-z]{2})\.?(?:\s+\d{5}(?:-\d{4})?)?\s*(?:,\s*(?:usa|us|united states))?\s*$/i)
  if (!m) return null
  const code = m[1].toUpperCase()
  return US_STATES.has(code) ? code : null
}

/**
 * Names why an address is outside NYC, or null. Explicit evidence only — a
 * different state, or a US zip that isn't a New York City zip. An address that
 * says nothing either way returns null. Foreign cities are caught separately by
 * the city list in lib/claude.ts (hintNamesNonNycCity).
 */
export function explicitNonNycReason(raw: string | null | undefined): string | null {
  if (!raw) return null
  const state = extractState(raw)
  if (state && state !== 'NY') return state
  const zip = extractZip(raw)
  if (zip && !boroughForZip(zip)) return `zip ${zip}`
  return null
}

// ─── Floor / suite ("line 2") ────────────────────────────────────────────────

const LINE2_RE =
  /\b(\d+(?:st|nd|rd|th)\s+(?:floor|fl)\b\.?|(?:floor|fl|suite|ste|unit|room|rm|level)\b\.?\s*#?\s*[a-z0-9-]+\b|ground floor\b|lower level\b|penthouse\b|mezzanine\b)|#\s*[a-z0-9-]+\b/i

const LINE2_LABELS: Record<string, string> = {
  floor: 'Floor', fl: 'Floor', suite: 'Suite', ste: 'Suite',
  unit: 'Unit', room: 'Room', rm: 'Room', level: 'Level',
}

function formatLine2(unit: string): string {
  const u = unit.trim().replace(/\s+/g, ' ').replace(/\.$/, '')
  const ordinalFloor = u.match(/^(\d+)(st|nd|rd|th)\s+(?:floor|fl)$/i)
  if (ordinalFloor) return `${ordinalFloor[1]}${ordinalFloor[2].toLowerCase()} Floor`
  const labelled = u.match(/^(floor|fl|suite|ste|unit|room|rm|level)\.?\s*#?\s*([a-z0-9-]+)$/i)
  if (labelled) return `${LINE2_LABELS[labelled[1].toLowerCase()]} ${labelled[2].toUpperCase()}`
  if (u.startsWith('#')) return `#${u.replace(/^#\s*/, '').toUpperCase()}`
  return u.replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

export function splitSecondaryUnit(raw: string): { rest: string; line2: string | null } {
  const m = raw.match(LINE2_RE)
  if (!m || m.index === undefined) return { rest: raw, line2: null }
  const rest = (raw.slice(0, m.index) + raw.slice(m.index + m[0].length))
    .replace(/\s*,(\s*,)+/g, ',')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,]+|[\s,]+$/g, '')
  return { rest, line2: formatLine2(m[0]) }
}

// ─── Street ──────────────────────────────────────────────────────────────────

const TYPE_CANON: Record<string, string> = {
  street: 'street', st: 'street', str: 'street', avenue: 'avenue', ave: 'avenue', av: 'avenue',
  boulevard: 'boulevard', blvd: 'boulevard', place: 'place', pl: 'place', road: 'road', rd: 'road',
  drive: 'drive', dr: 'drive', lane: 'lane', ln: 'lane', parkway: 'parkway', pkwy: 'parkway',
  square: 'square', sq: 'square', terrace: 'terrace', ter: 'terrace', highway: 'highway', hwy: 'highway',
  court: 'court', ct: 'court', plaza: 'plaza', plz: 'plaza', broadway: 'broadway', bowery: 'bowery',
  way: 'way', slip: 'slip', alley: 'alley', row: 'row', walk: 'walk', loop: 'loop',
}
const DIRECTIONS: Record<string, string> = { w: 'west', e: 'east', n: 'north', s: 'south' }
const ORDINAL_WORDS: Record<string, string> = {
  first: '1', second: '2', third: '3', fourth: '4', fifth: '5', sixth: '6',
  seventh: '7', eighth: '8', ninth: '9', tenth: '10', eleventh: '11', twelfth: '12',
}
const CITY_WORDS = new Set(['new', 'nyc', 'manhattan', 'brooklyn', 'queens', 'bronx', 'staten', 'ny', 'usa'])

export interface ParsedAddress {
  houseNumber: string
  street: string
  line2: string | null
  zip: string | null
}

// Keeps the words of a "<number> <street...>" segment that belong to the street:
// up to its last street-type word, or up to where the city begins. "123 Queens
// Blvd" keeps "Queens Blvd"; "535 W 22nd St New York NY" keeps "W 22nd St";
// "1133 Avenue of the Americas New York" keeps "Avenue of the Americas".
function trimStreetWords(words: string[]): string[] {
  let lastType = -1
  for (let i = 1; i < words.length; i++) {
    if (TYPE_CANON[words[i].toLowerCase().replace(/\.$/, '')]) lastType = i
  }
  if (lastType >= 1) return words.slice(0, lastType + 1)
  const cityAt = words.findIndex((w, i) => i > 0 && CITY_WORDS.has(w.toLowerCase().replace(/\.$/, '')))
  return cityAt > 0 ? words.slice(0, cityAt) : words
}

// "NY 10011" at the end of a comma-less address. Only a real state code is
// stripped, so "535 W 22nd St 10011" doesn't lose its "St".
const TRAILING_STATE_ZIP_RE = new RegExp(`\\b(?:(?:${[...US_STATES].join('|')})\\s+)?\\d{5}(?:-\\d{4})?\\s*$`, 'i')

/** House number + street (+ floor/suite and zip when present), or null when the
 *  text holds no street address — a neighbourhood or city alone is not one. */
export function parseStreetAddress(raw: string | null | undefined): ParsedAddress | null {
  if (!raw?.trim()) return null
  const zip = extractZip(raw)
  const { rest, line2 } = splitSecondaryUnit(raw.replace(/\s+/g, ' ').trim())

  for (const segment of rest.split(',')) {
    const cleaned = segment.trim().replace(TRAILING_STATE_ZIP_RE, '').trim()
    const m = cleaned.match(/^(\d+[a-z]?(?:-\d+[a-z]?)?)\s+(.+)$/i)
    if (!m) continue
    const words = trimStreetWords(m[2].split(/\s+/))
    if (!words.some((w) => /[a-z]/i.test(w))) continue
    return { houseNumber: m[1], street: words.join(' ').replace(/[.,]+$/, ''), line2, zip }
  }
  return null
}

/** Comparison key for a street: lower case, abbreviations expanded, ordinals as
 *  bare numbers. "W 22nd St" and "West Twenty-second Street" don't meet here,
 *  but "W 22nd St", "West 22nd Street" and "west 22 street" all become
 *  "west 22 street". */
export function streetKey(street: string): string {
  const words = street.toLowerCase().replace(/[.,]/g, ' ').split(/\s+/).filter(Boolean)
  const key = words.map((w, i) => {
    const last = i === words.length - 1
    if (w === 'st' && !last) return 'saint'
    if (TYPE_CANON[w]) return TYPE_CANON[w]
    if (DIRECTIONS[w] && !last) return DIRECTIONS[w]
    if (ORDINAL_WORDS[w]) return ORDINAL_WORDS[w]
    const ordinal = w.match(/^(\d+)(?:st|nd|rd|th)$/)
    return ordinal ? ordinal[1] : w
  }).join(' ')
  return key.replace(/\bavenue of the americas\b/, '6 avenue')
}

/** The part of an address after its street, where a city, state or zip would be.
 *  Keeps a street named after a place — "88 Hudson Street", "Greenwich Street" —
 *  from reading as that place. Empty when the street can't be located. */
export function placeTextAfterStreet(raw: string, parsed: ParsedAddress): string {
  const flat = raw.replace(/\s+/g, ' ')
  const at = flat.toLowerCase().indexOf(parsed.street.toLowerCase())
  return at === -1 ? '' : flat.slice(at + parsed.street.length)
}

// "535-537" covers 535, 536 and 537. Queens house numbers are also hyphenated
// ("25-19") but never ascend like a range of the same width, so they don't match.
export function houseNumbersMatch(a: string, b: string): boolean {
  const na = a.toLowerCase()
  const nb = b.toLowerCase()
  if (na === nb) return true
  const inRange = (range: string, n: string) => {
    const m = range.match(/^(\d+)-(\d+)$/)
    if (!m || !/^\d+$/.test(n) || m[1].length !== m[2].length) return false
    const lo = Number(m[1])
    const hi = Number(m[2])
    return lo < hi && Number(n) >= lo && Number(n) <= hi
  }
  return inRange(na, nb) || inRange(nb, na)
}

export type AddressComparison = 'same' | 'inconclusive'

/**
 * Normalization-only comparison. 'same' when both parse to the same house
 * number and street — ignoring floor/suite, city, state, zip, abbreviation and
 * punctuation — or when one street is the other with trailing words dropped.
 * Everything else is 'inconclusive' and goes to the model; this function never
 * declares a mismatch on its own.
 */
export function compareAddresses(a: string, b: string): AddressComparison {
  const pa = parseStreetAddress(a)
  const pb = parseStreetAddress(b)
  if (!pa || !pb || !houseNumbersMatch(pa.houseNumber, pb.houseNumber)) return 'inconclusive'
  const ka = streetKey(pa.street)
  const kb = streetKey(pb.street)
  if (ka === kb) return 'same'
  const [shorter, longer] = ka.length <= kb.length ? [ka, kb] : [kb, ka]
  return longer.startsWith(`${shorter} `) ? 'same' : 'inconclusive'
}

// ─── Entries that hold more than one address ─────────────────────────────────
//
// Extraction asks for one address per list entry, but a model can still hand
// back two addresses joined in one string ("22 Cortlandt Alley & 394 Broadway"),
// or a merge cut off part-way ("533 West 19th Street & 537"). The two are told
// apart by whether every piece parses, not by the shape of the text:
//   • clean   — every piece between joiners is a complete street address (house
//               number + street). A joined line of complete addresses is split and
//               treated exactly like a list of separate entries. Not flagged.
//   • garbled — a joiner is followed by a house number that doesn't make a
//               complete address, or a street runs into a trailing house number
//               nothing could be split from. A corrupted merge: the pieces that did
//               parse are kept, and the entry is reported as garbled.
// Text with no house number at all ("New York: 19th Street") is not an address
// and is neither.

const HOUSE_THEN_WORD = String.raw`\d+[a-z]?(?:-\d+[a-z]?)?\s+[a-z]`
// A joiner immediately followed by "<number> <word>", where a second address
// would begin. "6th Floor" ("6" runs into "th") and a trailing zip don't match.
const JOINER_BEFORE_HOUSE = new RegExp(String.raw`\s*(?:&|\band\b|;|/|,)\s*(?=${HOUSE_THEN_WORD})`, 'i')
// A street-type word immediately followed by "<number> <word>", with no joiner:
// "533 West 19th Street 537 West 20th Street".
const STREET_THEN_HOUSE = new RegExp(
  String.raw`(?<=\b(?:${Object.keys(TYPE_CANON).join('|')})\.?)\s+(?=${HOUSE_THEN_WORD})`,
  'i'
)
// A joiner followed by a bare house number and nothing else — a truncated merge.
const DANGLING_HOUSE = /(?:&|\band\b|;|\/)\s*\d{1,4}[a-z]?(?:-\d+[a-z]?)?\s*(?:,|$)/i
const UNIT_ONLY_STREET = /^(?:fl|floor|suite|ste|unit|room|rm|level)\.?$/i

export interface AddressEntry {
  /** Each complete address in the entry, in order, with its own text. */
  addresses: { text: string; parsed: ParsedAddress }[]
  /** True when the entry looks like a corrupted merge rather than clean addresses. */
  garbled: boolean
}

export function splitAddressEntry(raw: string | null | undefined): AddressEntry {
  const flat = raw?.replace(/\s+/g, ' ').trim() ?? ''
  if (!flat) return { addresses: [], garbled: false }

  // One city/zip printed after several addresses belongs to all of them.
  const sharedZip = extractZip(flat)
  let garbled = DANGLING_HOUSE.test(splitSecondaryUnit(flat).rest)

  const pieces = flat.split(JOINER_BEFORE_HOUSE).flatMap((piece) => piece.split(STREET_THEN_HOUSE))
  const addresses: AddressEntry['addresses'] = []
  pieces.forEach((piece, index) => {
    const text = piece.trim()
    if (!text) return
    // A zip peeled off the end of a street ("Broadway 10012 New York").
    if (/^\d{5}(?:-\d{4})?\b/.test(text)) return
    const parsed = parseStreetAddress(text)
    if (parsed && !UNIT_ONLY_STREET.test(parsed.street)) {
      addresses.push({ text, parsed: { ...parsed, zip: parsed.zip ?? sharedZip } })
    } else if (index > 0 && /^\d/.test(text)) {
      // Something that starts like a second address but isn't one.
      garbled = true
    }
  })

  return { addresses, garbled }
}

// ─── Standard format ─────────────────────────────────────────────────────────

function titleWord(w: string): string {
  if (/^\d+(st|nd|rd|th)$/i.test(w)) return w.toLowerCase()
  if (/^\d/.test(w)) return w.toUpperCase()
  if (w !== w.toLowerCase() && w !== w.toUpperCase()) return w // McDonald, MacDougal
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
}

/** "W 22nd St" → "West 22nd Street". Leaves an already-written-out street alone. */
export function displayStreet(street: string): string {
  const words = street.replace(/[.,]/g, ' ').split(/\s+/).filter(Boolean)
  return words.map((w, i) => {
    const lw = w.toLowerCase()
    const last = i === words.length - 1
    if (lw === 'st' && !last) return 'St.'
    if (TYPE_CANON[lw]) return titleWord(TYPE_CANON[lw])
    if (DIRECTIONS[lw] && !last) return titleWord(DIRECTIONS[lw])
    if (i > 0 && (lw === 'of' || lw === 'the' || lw === 'and')) return lw
    return titleWord(w)
  }).join(' ')
}

/** The one place the stored format is defined:
 *  "<number> <Street>, [<Floor/Suite>, ]<Borough>, New York <zip>". */
export function formatStandardAddress(parts: {
  houseNumber: string
  street: string
  line2: string | null
  borough: Borough | null
  zip: string | null
}): string {
  return [
    `${parts.houseNumber} ${displayStreet(parts.street)}`,
    parts.line2,
    parts.borough,
    parts.zip ? `New York ${parts.zip}` : 'New York',
  ].filter(Boolean).join(', ')
}
