// Pure rules for Agent 1's Section 3 — the stage between link discovery
// (Tier 1/Tier 2) and the per-show detail fetch. No I/O, so every rule here runs
// directly against real links and titles in a test.
//
// The governing principle of this stage: it may only discard on evidence the
// listing page actually printed. Anything it is merely unsure about proceeds to
// Section 4, which fetches the real page and decides against ground truth. The
// one thing this stage must not do is guess a date — mechanically parsing
// listing-page date text is what dropped 18 real MoMA shows once already.

import type { DateEvidence, ExhibitionLink } from './types'

// ─── 1. Date evidence ────────────────────────────────────────────────────────

// Status words a listing page prints instead of dates for a show with no end.
const ONGOING_TEXT =
  /\b(?:ongoing|on\s+long[-\s]?term\s+view|long[-\s]?term(?:\s+view)?|permanent(?:ly)?\s+on\s+view|on\s+permanent\s+(?:view|display)|indefinitely|open[-\s]?ended|continuing)\b/i

// Any real calendar text. Deliberately a presence test, never a parse: knowing
// that dates are printed is all this stage needs, and reading them is what the
// detail stage does against the page itself.
const MONTH_NAME = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\b/i
const NUMERIC_DATE = /\b\d{1,2}\s*[./-]\s*\d{1,2}(?:\s*[./-]\s*\d{2,4})?\b/
const YEAR = /\b(?:19|20)\d{2}\b/
const SEASON = /\b(?:spring|summer|fall|autumn|winter)\b/i
// Words that carry a date even when the date itself sits elsewhere in the text.
const DATE_LANGUAGE = /\b(?:through|until|thru|closes?|closing|ends?|ending|opens?|opening|on\s+view|runs?)\b/i

function hasDateText(text: string | null | undefined): boolean {
  if (!text) return false
  return MONTH_NAME.test(text) || NUMERIC_DATE.test(text) || YEAR.test(text) || SEASON.test(text)
}

/**
 * What the listing page said about this show's dates.
 *
 * 'ongoing' wins over 'dated' when both appear ("Mar 8, 2025–ongoing"): the point
 * of the flag is that the show has no end date to close against, which is exactly
 * what makes it safe to exempt from the cap.
 */
export function dateEvidenceFor(link: Pick<ExhibitionLink, 'date_hint' | 'classification_reason'>): DateEvidence {
  if (ONGOING_TEXT.test(link.date_hint ?? '')) return 'ongoing'
  if (hasDateText(link.date_hint)) return 'dated'
  if (DATE_LANGUAGE.test(link.date_hint ?? '')) return 'dated'

  // Tier 1 is asked to justify its classification; when it cites real dates, the
  // page had dates near the link even if date_hint came back empty.
  const reason = link.classification_reason ?? ''
  if (hasDateText(reason) && DATE_LANGUAGE.test(reason)) return 'dated'
  if (ONGOING_TEXT.test(reason)) return 'ongoing'

  return 'none'
}

/**
 * Whether Tier 1's classification rests on anything the page printed.
 *
 * Returns a note for the log when a link was called 'current' with no date signal
 * behind it — Tier 1's own rule is "when ambiguous: default to 'current'", so this
 * is the case where an archive link used to sail through. It is reported, never
 * acted on: the detail page settles it.
 */
export function dateCrossCheck(
  link: Pick<ExhibitionLink, 'classification' | 'classification_reason' | 'date_hint'>,
  evidence: DateEvidence
): string | null {
  if (evidence !== 'none') return null
  if (link.classification !== 'current' && link.classification !== 'upcoming') return null
  return `classified ${link.classification} with no date text on the listing page — deferring to the detail page`
}

// ─── 1b. End-date signal, for the cap exemption ──────────────────────────────

// A real date token that can serve as the END of a run: a month, a numeric date,
// a year, or a season. Deliberately excludes "ongoing", "present", "TBD" and the
// like — those are the absence of an end date, which is the whole point here.
const END_TOKEN = String.raw`(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*\d{0,2}|\d{1,2}\s*[./]\s*\d{1,2}|(?:19|20)\d{2}|spring|summer|fall|autumn|winter)`

// "Through Jan 2, 2027", "on view through Oct 12", "closes Nov 8".
const CLOSING_WITH_DATE = new RegExp(
  String.raw`\b(?:through|thru|until|till|closes?|closing|ends?|ending)\b[^.;|]{0,24}?${END_TOKEN}`,
  'i'
)
// A range whose right-hand side is a real date: "Sep 27, 2026–Jun 13, 2027",
// "Sep. 8 - Oct. 3, 2026", "Apr 24, 2026–Fall 2026". A dash followed by "ongoing"
// does not match, so "Mar 8, 2025–ongoing" correctly reads as having no end.
const RANGE_WITH_END = new RegExp(String.raw`[–—-]\s*${END_TOKEN}`, 'i')

/**
 * Whether the listing text says when this show closes.
 *
 * Presence only — it never resolves the text into an actual date. Reading these
 * strings as dates at this stage is the bug that once dropped 18 real MoMA shows,
 * and all the cap needs to know is whether a closing date was printed at all.
 */
export function hasEndDateSignal(dateHint: string | null | undefined): boolean {
  if (!dateHint) return false
  return CLOSING_WITH_DATE.test(dateHint) || RANGE_WITH_END.test(dateHint)
}

/**
 * Whether this candidate bypasses the cap.
 *
 * The case this protects is a show that is on NOW but has no announced closing
 * date — New Museum's "New Humans" had no end date for a period before one was
 * added. Such a show has nothing for a soonest-closing ranking to sort on, so it
 * sinks to the bottom of every run and is squeezed out by the cap forever, despite
 * being open the whole time.
 *
 * Strictly 'current': 'permanent' and 'past' never reach the cap (they are filtered
 * out at classification), 'event' and the off-site kinds are removed by the
 * content-type filter, and 'upcoming' has a start still ahead of it and can wait
 * for a later run. Nothing about those paths changes.
 *
 * This is NOT the discard rule. A candidate with no dates anywhere still dies at
 * check #4 if its own detail page also has none; this only stops the cap from
 * killing it first, before anything has looked at the real page.
 */
export function capExemptFor(link: Pick<ExhibitionLink, 'classification' | 'date_hint'>): boolean {
  if (link.classification !== 'current') return false
  return !hasEndDateSignal(link.date_hint)
}

// ─── 2. Off-site: fairs and loans ────────────────────────────────────────────

export type OffsiteKind = 'fair' | 'offsite'

// Fairs that actually appear in these listings. Matched as whole phrases so
// "Independent" alone (a common word) can't fire on its own.
const FAIR_NAMES =
  /\b(?:frieze|art\s+basel|basel\s+(?:miami|hong\s+kong|paris|qatar)|nada\s+(?:new\s+york|miami|art\s+fair)?|the\s+armory\s+show|armory\s+show|tefaf|fiac|art\s+cologne|arco(?:madrid)?|zona\s+maco|untitled\s+art|felix\s+art\s+fair|future\s+fair|spring\/?break|independent\s+(?:art\s+fair|new\s+york|20th\s+century)|expo\s+chicago|art\s+basel|paris\+|the\s+salon\s+art\s*\+\s*design|affordable\s+art\s+fair|art\s+toronto|dallas\s+art\s+fair|material\s+art\s+fair|liste)\b/i

const BOOTH = /\b(?:booth|stand)\s*(?:no\.?|number|#)?\s*[a-z]?[-\s]?\d+[a-z]?\b/i
const FAIR_WORD = /\b(?:art\s+fair|fair\s+booth|at\s+the\s+fair)\b/i

// Language that places a show somewhere other than where it is listed.
const OFFSITE_PHRASE =
  /\b(?:on\s+view\s+at|presented\s+at|presented\s+by\s+[^,.]{1,40}\s+at|in\s+collaboration\s+with\s+[^,.]{1,40}\s+at|on\s+loan\s+to|loaned\s+to|travels?\s+to|traveling\s+to|touring\s+to|organized\s+by\s+[^,.]{1,40}\s+at|hosted\s+by|in\s+partnership\s+with\s+[^,.]{1,40}\s+at)\b/i

// Institution words that, when named as the host, mean another venue's building.
const INSTITUTION_WORD =
  /\b(?:museum|kunsthalle|kunstverein|biennale|biennial|triennial|foundation|fondation|fondazione|institute|institution|academy|akademie|pinacoteca|stiftung|palais|pavilion|centre|center)\b/i

function mentionsOwnVenue(text: string, ownNameForms: string[]): boolean {
  const haystack = text.toLowerCase()
  return ownNameForms.some((form) => form.length > 3 && haystack.includes(form.toLowerCase()))
}

/**
 * Why this candidate is a show somewhere other than the venue's own space, or null.
 *
 * Reads only what Tier 1 already returned from the anchor-context window — title,
 * the place text beside the link, and Tier 1's own classification reasoning. URL
 * shape is deliberately not consulted: these appear interspersed among ordinary
 * shows on the same listing page, at the same kind of URL.
 *
 * Fails open in the one case that matters: a gallery's collaboration with a museum
 * held at the gallery's own space names both parties, so any text naming this venue
 * is left alone.
 *
 * Takes the venue's name forms rather than its name so this module keeps no runtime
 * imports — that is what lets it be tested directly under Node's TypeScript
 * stripping, with no build step and no loader. Callers pass venueNameForms(name)
 * from lib/listing-page-checks.
 */
export function offsiteReason(
  link: Pick<ExhibitionLink, 'title' | 'location_hint' | 'classification_reason'>,
  ownNameForms: string[]
): { kind: OffsiteKind; reason: string } | null {
  const hint = link.location_hint ?? ''
  const title = link.title ?? ''
  const reasoning = link.classification_reason ?? ''
  const text = `${title} ${hint} ${reasoning}`

  // A fair booth is a fair booth even if the gallery's own name is next to it —
  // it is the gallery's booth, and it is not at the gallery.
  const fairHit = FAIR_NAMES.exec(text) ?? FAIR_WORD.exec(text)
  if (BOOTH.test(text)) {
    return { kind: 'fair', reason: `booth number in "${BOOTH.exec(text)?.[0]?.trim()}"` }
  }
  if (fairHit) {
    return { kind: 'fair', reason: `names the fair "${fairHit[0].trim()}"` }
  }

  // Everything below is about a host venue, so naming this venue clears it.
  if (mentionsOwnVenue(text, ownNameForms)) return null

  const offsiteHit = OFFSITE_PHRASE.exec(`${hint} ${reasoning}`)
  if (offsiteHit && INSTITUTION_WORD.test(`${hint} ${reasoning}`)) {
    return {
      kind: 'offsite',
      reason: `"${offsiteHit[0].trim()}" with another institution named in the listing text`,
    }
  }
  return null
}

// ─── 3. Child listing pages under the venue's own exhibitions URL ────────────

// Path segments that name a slice of an archive rather than a show. Matched whole:
// a real show can be called "all-that-is-solid", and "current" as an entire
// segment is a section, not a title.
const LISTING_SEGMENTS = new Set([
  'past', 'archive', 'archives', 'upcoming', 'current', 'on-view', 'onview',
  'all', 'view-all', 'viewall', 'page', 'index', 'list', 'browse', 'filter', 'year', 'years',
])

const YEAR_SEG = String.raw`(?:19|20)\d{2}`
const SEASON_SEG = String.raw`(?:spring|summer|fall|autumn|winter)`
// A year range or season-year as a whole segment ("2026-2024", "fall-2026").
const DATED_SEGMENT = new RegExp(
  `^(?:${YEAR_SEG}\\s*[-–—]\\s*(?:${YEAR_SEG}|\\d{2})|${SEASON_SEG}[-_]?${YEAR_SEG}|${YEAR_SEG}[-_]?${SEASON_SEG})$`
)

function segmentsOf(url: string): string[] | null {
  try {
    return new URL(url).pathname
      .split('/')
      .filter(Boolean)
      .map((s) => {
        try { return decodeURIComponent(s).toLowerCase() } catch { return s.toLowerCase() }
      })
  } catch {
    return null
  }
}

/**
 * Why this link is a deeper listing page under the venue's own exhibitions URL,
 * or null.
 *
 * The self-referential guard already catches the listing page itself and its
 * ancestors. This is the missing direction: descendants like
 * andrewkreps.com/exhibitions/past/all/2026-2024 sit *below* the base URL, so that
 * guard never looked at them, and they survived into the show queue as though they
 * were shows.
 *
 * Requires both halves — a descendant of the base path, and a listing word or a
 * date label in one of the segments below it. A descendant with neither
 * (moma.org/calendar/exhibitions/5919) is a real show page and is left alone.
 */
export function childListingPathReason(url: string, exhibitionsUrl: string | null | undefined): string | null {
  if (!exhibitionsUrl) return null
  const linkSegs = segmentsOf(url)
  const baseSegs = segmentsOf(exhibitionsUrl)
  if (!linkSegs || !baseSegs || baseSegs.length === 0) return null

  try {
    if (new URL(url).hostname.replace(/^www\./, '') !== new URL(exhibitionsUrl).hostname.replace(/^www\./, '')) {
      return null
    }
  } catch {
    return null
  }

  // Strictly below the base path.
  if (linkSegs.length <= baseSegs.length) return null
  if (!baseSegs.every((seg, i) => linkSegs[i] === seg)) return null

  for (const seg of linkSegs.slice(baseSegs.length)) {
    if (LISTING_SEGMENTS.has(seg)) return `listing segment "${seg}" below ${'/' + baseSegs.join('/')}`
    if (DATED_SEGMENT.test(seg)) return `date-range segment "${seg}" below ${'/' + baseSegs.join('/')}`
  }
  return null
}

// ─── 4. Cap ──────────────────────────────────────────────────────────────────

export const GALLERY_DETAIL_CAP = 15
// Museums run many more shows at once than a gallery, and the old shared cap of 15
// silently truncated the largest ones.
export const MUSEUM_DETAIL_CAP = 30

export function detailCapForVenueType(type: string | null | undefined): number {
  return type === 'museum' ? MUSEUM_DETAIL_CAP : GALLERY_DETAIL_CAP
}

export interface CapSelection<T> {
  selected: T[]
  deferred: T[]
  /** How many bypassed the cap as current-with-no-closing-date. */
  exemptCount: number
}

/**
 * Applies the cap to an already-ranked list.
 *
 * Candidates flagged cap_exempt bypass the cap rather than competing for a slot.
 * They are current shows with no announced closing date, so a soonest-closing
 * ranking has nothing to rank them by and would push them behind every dated show,
 * every single run — which is how an open show gets dropped forever.
 */
export function selectWithinCap<T extends { cap_exempt?: boolean }>(
  ranked: T[],
  cap: number
): CapSelection<T> {
  const exempt = ranked.filter((l) => l.cap_exempt === true)
  const rest = ranked.filter((l) => l.cap_exempt !== true)
  return {
    selected: [...exempt, ...rest.slice(0, cap)],
    deferred: rest.slice(cap),
    exemptCount: exempt.length,
  }
}
