// Pure checks for Agent 1's listing-page stage (Section 2): is a fetched page a
// bot wall rather than the gallery's site, and is a found link's title the label
// of a listing page rather than a show? No I/O, so both run directly against
// saved pages and real show titles.

// ─── Block pages ─────────────────────────────────────────────────────────────

export type BlockSignalKind = 'fingerprint' | 'phrase' | 'text_ratio'

export interface BlockSignal {
  kind: BlockSignalKind
  label: string
}

/** Fingerprint and phrase matches are proof of a block page on their own.
 *  A text_ratio match is only suspicious: plenty of real listing pages are a
 *  large JavaScript shell with almost no text until they render. */
export function isDefinitiveBlock(signal: BlockSignal | null): boolean {
  return signal !== null && signal.kind !== 'text_ratio'
}

export function visibleText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#x27;|&#39;|&apos;|&rsquo;|&#8217;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

// Lower case, letters and digits only, with any per-request id ("iad1::1789…-x7Q")
// removed — so the same block page compares equal on every visit.
function textSignature(text: string): string {
  return text
    .toLowerCase()
    .replace(/[a-z0-9]+::[\w-]+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

// Known block pages, by their exact visible text.
const KNOWN_BLOCK_PAGES: { label: string; signature: string }[] = [
  {
    // Vercel's bot-protection interstitial (HTTP 429, ~32KB, 167 characters of
    // visible text). Served identically to The Met, Brooklyn Museum and all three
    // Hauser & Wirth New York locations as of 2026-09-15, which recorded them as
    // "zero links found" because the old 10KB size check never saw it.
    label: 'vercel-security-checkpoint',
    signature: 'vercel security checkpoint we re verifying your browser website owner click here to fix vercel security checkpoint',
  },
]

// Phrases that only appear on challenge and block pages. Checked only on pages
// with no exhibition links: Cloudflare and others inject challenge markup into
// pages they go on to serve normally.
const BLOCK_PHRASES: [RegExp, string][] = [
  [/cf-browser-verification/i, 'cf-browser-verification'],
  [/challenge-form/i, 'challenge-form'],
  [/<title[^>]*>[^<]*just\s+a\s+moment[^<]*<\/title>/i, 'cf-just-a-moment'],
  [/<title[^>]*>[^<]*attention\s+required[^<]*<\/title>/i, 'attention-required'],
  [/verifying\s+you\s+are\s+human/i, 'verifying-human'],
  [/checking\s+your\s+browser/i, 'checking-browser'],
  [/ddos\s+protection\s+by/i, 'ddos-protection'],
  [/too\s+many\s+requests/i, 'too-many-requests'],
  // Added 2026-09-15
  [/<title[^>]*>[^<]*security\s+checkpoint[^<]*<\/title>/i, 'security-checkpoint-title'],
  [/we(?:'|&#x27;|&#39;|’)?re\s+verifying\s+your\s+browser/i, 'verifying-your-browser'],
  [/<title[^>]*>[^<]*access\s+denied[^<]*<\/title>/i, 'access-denied-title'],
  [/<title[^>]*>\s*403\s+forbidden\s*<\/title>/i, '403-forbidden-title'],
  [/<title[^>]*>[^<]*pardon\s+our\s+interruption[^<]*<\/title>/i, 'imperva-pardon-our-interruption'],
  [/_incapsula_resource|incapsula\s+incident\s+id/i, 'incapsula'],
  [/px-captcha|access\s+to\s+this\s+page\s+has\s+been\s+denied/i, 'perimeterx'],
  [/captcha-delivery\.com/i, 'datadome'],
  [/sucuri\s+website\s+firewall/i, 'sucuri'],
  [/enable\s+javascript\s+and\s+cookies\s+to\s+continue/i, 'enable-js-and-cookies'],
  [/<title[^>]*>[^<]*(?:are\s+you\s+a\s+robot|human\s+verification|security\s+check)[^<]*<\/title>/i, 'robot-check-title'],
  [/unusual\s+traffic\s+from\s+your\s+(?:computer|network)/i, 'unusual-traffic'],
]

// A large file with almost no readable text, whatever its size. Calibrated on
// the 95 active venues' listing pages (2026-09-15): the Vercel checkpoint is
// 167 characters in 32KB (0.52%); no page that linked to exhibitions fell below
// these limits. Real JavaScript-shell sites do (New Museum, Guggenheim, Armory
// Show before rendering), which is why this signal is never proof on its own.
export const TEXT_RATIO_MIN_BYTES = 5_000
export const TEXT_RATIO_MAX_VISIBLE_CHARS = 400
export const TEXT_RATIO_MAX = 0.01

const EXHIBITION_LINK = /<a[^>]+href=["'][^"']*exhibit/i

export function detectBlockPage(html: string | null | undefined): BlockSignal | null {
  if (!html) return null
  const text = visibleText(html)

  const signature = textSignature(text)
  for (const known of KNOWN_BLOCK_PAGES) {
    if (signature === known.signature) return { kind: 'fingerprint', label: known.label }
  }

  if (EXHIBITION_LINK.test(html)) return null

  for (const [pattern, label] of BLOCK_PHRASES) {
    if (pattern.test(html)) return { kind: 'phrase', label }
  }

  if (
    html.length >= TEXT_RATIO_MIN_BYTES &&
    text.length <= TEXT_RATIO_MAX_VISIBLE_CHARS &&
    text.length / html.length <= TEXT_RATIO_MAX
  ) {
    return { kind: 'text_ratio', label: `${text.length} visible chars in ${Math.round(html.length / 1000)}KB` }
  }
  return null
}

// ─── Section / listing pages ─────────────────────────────────────────────────

/** URL path segments that name a section of a site rather than a show. */
export const SECTION_TERMINAL_SEGMENTS = new Set([
  'exhibitions', 'current', 'upcoming', 'past', 'on-view', 'on-going',
  'now-on-view', 'collection', 'programs', 'archive', 'view-all', 'shows',
])

// A section word with a number or ordinal tacked on — Squarespace and similar
// builders suffix duplicate page slugs ("exhibitions-two", "shows-2").
const NUMBER_SUFFIX = String.raw`[-_]?(?:\d+(?:st|nd|rd|th)?|one|two|three|four|five|six|seven|eight|nine|ten|ii|iii|iv|v|vi|vii|viii|ix|x)`
const SECTION_WORD_WITH_SUFFIX = new RegExp(
  `^(?:${[...SECTION_TERMINAL_SEGMENTS].join('|')})${NUMBER_SUFFIX}$`
)

// Years are 19xx/20xx only. Museums number their show pages too
// (moma.org/calendar/exhibitions/5919), and a four-digit id is not a date.
const YEAR = String.raw`(?:19|20)\d{2}`
const SEASON = String.raw`(?:spring|summer|fall|autumn|winter)`
const DATED = String.raw`${YEAR}\s*[-–—]\s*(?:${YEAR}|\d{2})|${SEASON}[-\s]?${YEAR}|${YEAR}[-\s]?${SEASON}`
/** A year range ("2026-2024", "2024–26") or a season-year ("Fall 2026") — never a lone year. */
const URL_DATED_LABEL = new RegExp(`^(?:${DATED})$`)
/** The same, or a single bare year: allowed where a title says it and the URL agrees. */
const TEMPORAL_LABEL = new RegExp(`^(?:${YEAR}|${DATED})$`)

function isSectionSegment(segment: string): boolean {
  return SECTION_TERMINAL_SEGMENTS.has(segment) || SECTION_WORD_WITH_SUFFIX.test(segment)
}

function pathSegments(url: string): string[] {
  try {
    return new URL(url).pathname
      .split('/')
      .filter(Boolean)
      .map((s) => {
        try { return decodeURIComponent(s).toLowerCase() } catch { return s.toLowerCase() }
      })
  } catch {
    return []
  }
}

/**
 * A URL whose last segment names a section ("…/past", "…/exhibitions-two"), or
 * is only a year range or season sitting under a section
 * ("…/exhibitions/past/all/2026-2024"). A date needs a section word above it — a
 * real show can live at "…/1960-1970" — and a lone year never counts on a URL,
 * because it can't be told apart from a numeric page id.
 */
export function isSectionPageUrl(url: string): boolean {
  const segments = pathSegments(url)
  const last = segments.at(-1) ?? ''
  if (isSectionSegment(last)) return true
  return URL_DATED_LABEL.test(last) && segments.slice(0, -1).some(isSectionSegment)
}

// Exact whole-title matches only. Checked against all 186 real show titles on
// record (2026-09-15): none matched, so nothing was removed from the starting list.
const BARE_SECTION_LABELS = new Set([
  'exhibitions', 'exhibition', 'shows', 'show', 'current', 'current exhibitions',
  'upcoming', 'upcoming exhibitions', 'past', 'past exhibitions', 'archive', 'archives',
  'on view', 'now on view', 'collection', 'the collection', 'permanent collection',
  'programs', 'public programs', 'events', 'calendar', 'press', 'news',
  'viewing room', 'viewing rooms', 'installations',
])
const NAVIGATION_LABELS = new Set(['all exhibitions', 'view all', 'see all', 'browse exhibitions'])
const GENERIC_INDEX_WORDS = new Set(['index', 'directory', 'listings', 'gallery', 'galleries'])

function normalizeTitle(title: string): string {
  return title
    .trim()
    .replace(/[‘’]/g, "'")
    .replace(/^["'“”]+|["'“”.:;!,]+$/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

// Venue names carry a location the site's own labels leave out:
// "Hauser & Wirth New York, 22nd Street" → also "hauser & wirth new york" and
// "hauser & wirth"; "Bowery Gallery — Bowery Gallery" → also "bowery gallery";
// "The Met" → also "met".
function venueNameForms(venueName: string): string[] {
  const full = normalizeTitle(venueName)
  const forms = new Set([full, full.split(/\s+[—–-]\s+/)[0], full.split(',')[0], full.split(/\s+new york\b/)[0]])
  for (const form of [...forms]) if (form.startsWith('the ')) forms.add(form.slice(4))
  return [...forms].filter(Boolean)
}

/**
 * Why a link's title marks it as a listing page rather than a show, or null.
 * Whole-title matches only — "Dreams of This Future: The Collection of Peggy
 * Cooper Cafritz" is a show, "The Collection" is not. A bare year, year range or
 * season is a plausible real title ("1997", "1960–1970"), so it only counts when
 * the URL is section-shaped too: its last segment is a section word or the same
 * kind of date label (…/exhibitions/2026, …/past, …/past/all/2026-2024).
 */
export function listingPageTitleReason(
  title: string | null | undefined,
  context: { venueName: string; url: string }
): string | null {
  if (!title) return null
  const t = normalizeTitle(title)
  if (!t) return null

  if (BARE_SECTION_LABELS.has(t)) return `bare section label "${title}"`
  if (NAVIGATION_LABELS.has(t)) return `navigation label "${title}"`
  if (GENERIC_INDEX_WORDS.has(t)) return `generic index word "${title}"`

  for (const venue of venueNameForms(context.venueName)) {
    if (t === `${venue} exhibitions` || t === `${venue} shows`) return `venue section label "${title}"`
  }

  if (TEMPORAL_LABEL.test(t)) {
    const last = pathSegments(context.url).at(-1) ?? ''
    if (isSectionSegment(last) || TEMPORAL_LABEL.test(last)) {
      return `year/season label "${title}" on a section-shaped URL`
    }
  }
  return null
}
