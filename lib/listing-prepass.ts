// A cheap, pure pass over a fetched listing page, run before the Tier 1
// extraction call, so that call can be sized to the page in front of it rather
// than to three flat numbers that fit no real venue.
//
// Why this exists (measured on 51 real saved listing pages, 2026-09-16):
//  - The flat 600-character anchor window put a show's own date/address in view
//    for only 37% of links. Zwirner captured 17%, Whitney 5%, the five Gagosian
//    locations 13-14%.
//  - The flat 100,000-character cutoff truncated 33 of 51 pages. Andrew Kreps'
//    windowed text is 261,259 characters, so 62% of it never reached the model.
//  - The flat 4,096-token output ceiling silently destroyed whole venues: a
//    response that hits the ceiling stops mid-array, the array never closes,
//    scanBalancedJson returns null, and extractExhibitionLinks turns that into
//    an empty result with no error and no log — indistinguishable from a venue
//    with no shows on.
//
// No I/O and no model call: this is regex and arithmetic over markup we have
// already fetched, so it runs directly against saved pages in a test.

// ─── Tunables, each set from the measurements above ──────────────────────────

/** Never window smaller than the old flat value, so no venue can regress. */
export const WINDOW_FLOOR = 600

/**
 * Hard ceiling on the anchor window.
 *
 * Capture rate across 2,791 real links by ceiling: 600→37%, 1500→70%, 2000→74%,
 * 3000→81%, 4000→86%, 6000→91%, 8000→94%. 4000 is the knee — it more than
 * doubles the old capture rate, and going to 6000 buys 5 more points while
 * widening every window on every page by half again. The ceiling exists because
 * sizing is max-based: one link whose nearest date sits in an unrelated block
 * (the worst real page measured is 27,856 characters) would otherwise set the
 * window for every other link on that page.
 */
export const WINDOW_CEILING = 4000

/** Never send less than the old cutoff. */
export const PAGE_CUTOFF_FLOOR = 100_000

/**
 * Upper bound on characters handed to the model. Real listing markup measured
 * between 2.3 and 7 characters per token, so 300,000 characters is at worst
 * ~130k tokens — comfortably inside the 200k context with room for the output
 * ceiling below. Only 1 of 51 sampled pages (Bortolami, 1.3M) exceeds it.
 */
export const PAGE_CUTOFF_CEILING = 300_000

/** Measured cost of one returned link: 8,017 output tokens for 79 items. */
export const TOKENS_PER_ITEM = 101

/** Headroom over the estimate. Generous on purpose — see OUTPUT_FLOOR. */
export const OUTPUT_SAFETY = 1.6

/**
 * Floor for the output ceiling, double the old flat 4,096.
 *
 * max_tokens is a cap, not a charge: raising it costs nothing unless the model
 * actually emits more. Since the failure being fixed here is catastrophic and
 * silent while the cost of over-provisioning is zero, this errs high throughout.
 */
export const OUTPUT_FLOOR = 8192

/** Verified working against claude-sonnet-4-6 this session. */
export const OUTPUT_CEILING = 16_000

// ─── Page analysis ───────────────────────────────────────────────────────────

/**
 * A date a listing page would print next to a show.
 *
 * Abbreviated months count: "Sept. 17", "Mar 7", "Nov. 29" are how Amant, MAD
 * Museum and Eleventh Hour Art print theirs, and a full-name-only pattern read
 * those pages as having no dates at all and sized them at the floors.
 */
const DATE_TEXT =
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*\d{1,2}\b|\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\b|\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/gi

/** A street address, the other thing Tier 1 is asked to copy off the page. */
const ADDRESS_TEXT =
  /\b\d{1,4}\s+(?:[A-Z][a-z]+\s+){0,3}(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Broadway|Alley|Place|Pl\.?|Lane|Boulevard|Blvd\.?)\b/g

/**
 * How near show-shaped content must sit for a link to count as a show.
 *
 * Matched to WINDOW_CEILING: a link whose nearest title, date or address is
 * further away than the widest window we would ever open cannot be sized for
 * anyway, so counting it would only inflate the estimate.
 */
export const SHOW_CONTENT_PROXIMITY = 4000

/** Path endings that are site furniture rather than a show, at any depth. */
const NAV_SEGMENTS = new Set([
  'about', 'contact', 'artists', 'artist', 'news', 'press', 'shop', 'store', 'cart',
  'search', 'privacy', 'terms', 'subscribe', 'newsletter', 'account', 'login',
  'fairs', 'art-fairs', 'publications', 'viewing-room', 'viewing-rooms', 'home',
])

/**
 * The heading that starts a page's archive. Present on 17 of 51 real pages,
 * including both venues whose extraction was confirmed broken this session.
 * Matched as a whole heading element so a show titled "Past Lives" cannot fire it.
 */
const PAST_HEADING =
  /<h[1-5][^>]*>\s*(?:<[^>]+>\s*)*(?:past|archive|previous)(?:\s+(?:exhibitions?|shows?))?\s*(?:<[^>]*>\s*)*<\/h[1-5]>/i

export interface ListingAnalysis {
  /** Length of the cleaned markup this was measured on. */
  pageChars: number
  /** Same-domain links with show-shaped content beside them — candidate shows. */
  linkCount: number
  /** Character offset of the archive heading, or null when there is none. */
  boundaryIndex: number | null
  linksBeforeBoundary: number
  linksAfterBoundary: number
  /** Largest distance from a candidate link to its nearest date or address. */
  maxDistance: number
  medianDistance: number
  /** How many candidate links have any date/address text on the page at all. */
  measuredLinks: number
  /**
   * Per-link distance to the nearest date or address, ascending.
   *
   * Exposed so a capture-rate measurement uses this module's own candidate set
   * rather than re-implementing the rule alongside it — the two drifting apart is
   * what produced the depth-based undercount this counting replaced.
   */
  distances: number[]
}

function matchOffsets(html: string, pattern: RegExp): number[] {
  const re = new RegExp(pattern.source, pattern.flags)
  const out: number[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) out.push(m.index)
  return out
}

/**
 * Measures one already-cleaned listing page.
 *
 * Takes the same markup the anchor window will run over, so the distances it
 * reports are the distances that window will actually face.
 */
export function analyzeListingPage(cleanHtml: string, baseUrl: string): ListingAnalysis {
  const targets = [...matchOffsets(cleanHtml, DATE_TEXT), ...matchOffsets(cleanHtml, ADDRESS_TEXT)]

  const boundaryMatch = cleanHtml.match(PAST_HEADING)
  const boundaryIndex = boundaryMatch ? cleanHtml.indexOf(boundaryMatch[0]) : null

  let baseHost: string | null = null
  let basePathname = ''
  try {
    const u = new URL(baseUrl)
    baseHost = u.hostname.replace(/^www\./, '')
    basePathname = u.pathname.replace(/\/$/, '')
  } catch { baseHost = null }

  // Headings count as show-shaped content too: on many sites the card's title is
  // the only thing next to the link, with the dates further down the page.
  const headings = matchOffsets(cleanHtml, /<h[1-5]\b/gi)
  const contentMarkers = [...targets, ...headings].sort((a, b) => a - b)

  const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi
  const distances: number[] = []
  let linkCount = 0
  let before = 0
  let after = 0
  let am: RegExpExecArray | null

  while ((am = anchorRe.exec(cleanHtml)) !== null) {
    const href = am[1]
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue
    if (/^https?:\/\//i.test(href) && baseHost) {
      try {
        if (new URL(href).hostname.replace(/^www\./, '') !== baseHost) continue
      } catch { continue }
    }

    let pathname: string
    try { pathname = new URL(href, baseUrl).pathname } catch { continue }
    const segments = pathname.split('/').filter(Boolean)
    // The site's own furniture, at any depth. Never a show.
    if (segments.length === 0) continue
    if (NAV_SEGMENTS.has(segments[segments.length - 1])) continue
    if (pathname.replace(/\/$/, '') === basePathname) continue

    // Content-based, not depth-based. A show link is one with show-shaped content
    // beside it — its own title, a date, or an address. Depth was the wrong
    // signal: Deborah Bell Photographs puts every real show at a single-segment
    // URL, so a depth rule counted 0 of its 70 real links and quietly handed the
    // sizing back to the floors this module exists to replace.
    let nearestContent = Infinity
    for (const m of contentMarkers) nearestContent = Math.min(nearestContent, Math.abs(m - am.index))
    if (nearestContent > SHOW_CONTENT_PROXIMITY) continue

    linkCount++
    if (boundaryIndex !== null) (am.index < boundaryIndex ? before++ : after++)

    // Measured against dates and addresses only, and deliberately not capped at
    // the proximity above: a link can qualify on its heading while its date sits
    // much further away, and that farther distance is exactly what the window
    // needs to be told about.
    let nearest = Infinity
    for (const t of targets) nearest = Math.min(nearest, Math.abs(t - am.index))
    if (nearest !== Infinity) distances.push(nearest)
  }

  distances.sort((a, b) => a - b)
  return {
    pageChars: cleanHtml.length,
    linkCount,
    boundaryIndex,
    linksBeforeBoundary: before,
    linksAfterBoundary: after,
    maxDistance: distances.length ? distances[distances.length - 1] : 0,
    medianDistance: distances.length ? distances[Math.floor(distances.length / 2)] : 0,
    measuredLinks: distances.length,
    distances,
  }
}

// ─── Sizing ──────────────────────────────────────────────────────────────────

export interface ListingSizing {
  /** Characters of windowed text to send. */
  pageCutoff: number
  /** Anchor-window half-width. */
  contextChars: number
  /** max_tokens for the extraction call. */
  maxTokens: number
  /**
   * Whether the prompt should tell the model to skip links under the archive
   * heading. Tied to the output sizing below and not independently useful: the
   * two must move together, or the sizing guarantees a truncated array.
   */
  skipPastSection: boolean
  /** Human-readable note for the run log. */
  basis: string
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)))

/**
 * Turns one page's measurements into the three limits for its extraction call.
 *
 * The output ceiling and skipPastSection are deliberately coupled. Sizing the
 * ceiling to the pre-archive links alone — which is the whole point, since
 * archive links are discarded downstream anyway — is only safe if the model is
 * also told to stop emitting them. Truncation does not return the first N links;
 * it returns an unterminated array, which the parser reads as zero links. Sizing
 * down without the instruction would cause exactly the silent failure this
 * replaces, so a page is only sized on its pre-archive count when it has a
 * detectable archive heading AND at least one link above it.
 */
export function sizingFor(analysis: ListingAnalysis): ListingSizing {
  const skipPastSection =
    analysis.boundaryIndex !== null &&
    analysis.linksBeforeBoundary > 0 &&
    analysis.linksAfterBoundary > 0

  const itemsToExpect = skipPastSection ? analysis.linksBeforeBoundary : analysis.linkCount

  const maxTokens = clamp(
    itemsToExpect * TOKENS_PER_ITEM * OUTPUT_SAFETY,
    OUTPUT_FLOOR,
    OUTPUT_CEILING
  )

  // Max-based, so the page's worst-placed link still gets its date in view;
  // the ceiling keeps one outlier from widening every window on the page.
  const contextChars = clamp(analysis.maxDistance, WINDOW_FLOOR, WINDOW_CEILING)

  // No truncation at all below the old cutoff; above it, send the page up to the
  // context-safe ceiling instead of cutting at a number unrelated to its size.
  const pageCutoff = clamp(analysis.pageChars, PAGE_CUTOFF_FLOOR, PAGE_CUTOFF_CEILING)

  const basis = skipPastSection
    ? `${analysis.linksBeforeBoundary} links before the archive heading (of ${analysis.linkCount}), max date distance ${analysis.maxDistance}`
    : `${analysis.linkCount} links, no archive boundary detected, max date distance ${analysis.maxDistance}`

  return { pageCutoff, contextChars, maxTokens, skipPastSection, basis }
}
