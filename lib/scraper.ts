import Browserbase from '@browserbasehq/sdk'
import he from 'he'
import { appendFileSync, writeFileSync } from 'fs'
import { getSupabaseAdmin } from './supabase'
import {
  extractExhibitionLinks,
  extractExhibitionDetail,
  filterLinksByLocation,
  rankLinksBySoonestClosing,
  hintNamesNonNycCity,
  verifyExhibitionLocation,
  verifyTitleInHtml,
  generatePrereads,
  classifyExhibitionUrls,
} from './claude'
import { geocodeVenueIfNeeded } from './geocoding'
import { addressesNameNonNyc, resolveShowLocation } from './show-location'
import {
  detectBlockPage,
  isDefinitiveBlock,
  isSectionPageUrl,
  listingPageTitleReason,
  venueNameForms,
} from './listing-page-checks'
import {
  capExemptFor,
  childListingPathReason,
  dateCrossCheck,
  dateEvidenceFor,
  detailCapForVenueType,
  offsiteReason,
  selectWithinCap,
} from './link-filters'
import { decideArtists } from './artist-rules'
import { isWarningMuted } from './venue-warnings'
import { generateMuseumCoverage, crossLinkCoverageToReadings, coverageItemToPrereadRow } from './museum-coverage'
import { startAgentRun, finishAgentRun, failAgentRun, type AgentRunError, type AgentRunResult } from './agent-runs'
import { pickedReferenceIds } from './editor-picks'
import {
  decideQueueEligibility,
  estimateVenueScrapeMs,
  hasTimeFor,
  nextScheduledScrapeDate,
  type ScrapeStatus,
} from './venue-scrape-schedule'
import {
  claimVenueScrape,
  finishVenueScrape,
  loadAttemptHistory,
  sweepStaleClaims,
  type ScrapeClaim,
  type VenueScrapeOutcome,
} from './venue-scrape-queue'
import type { VenueRecord, ExhibitionRaw, ExhibitionLink, ExhibitionDetailExtracted } from './types'

// Stable identity key for an exhibition within a venue — used for upsert matching
// instead of show_title, which is re-extracted by Claude on every scrape and can
// drift slightly (subtitle, punctuation, whitespace) between runs of the same show.
function normalizeDetailUrl(url: string): string {
  try {
    const u = new URL(url)
    u.protocol = u.protocol.toLowerCase()
    u.hostname = u.hostname.toLowerCase()
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '')
    return u.toString()
  } catch {
    return url.trim()
  }
}

// Wix: strip /v1/fill/... transform suffix to get the master file.
// CloudFront auto_image: bump resize width to 2000 for highest available res.
function upgradeImageUrl(url: string | null): string | null {
  if (!url) return null
  const wixMatch = url.match(/^(https:\/\/static\.wixstatic\.com\/media\/[^/]+)/)
  if (wixMatch) return wixMatch[1]
  if (url.includes('cloudfront.net/auto_image/')) {
    return url.replace(/resize=width:\d+/, 'resize=width:2000')
  }
  return url
}

// A real sign-off carries an actual contact token — an address or a phone
// number. Phrases alone are weaker evidence: "for more information" turns up
// mid-sentence in ordinary prose ("…and for more information the essay by Susan
// Casey is reproduced in full"), and matching on the phrase anywhere in a
// paragraph deleted substantive text along with it.
const CONTACT_TOKEN = /@[a-z0-9.-]+\.[a-z]{2,}|\+?\d[\d\s().-]{7,}\d/i
// The noun forms only. The bare stem also matched "inquiring" and "inquiry",
// which are ordinary art-writing prose ("an inquiry into materiality"), so a
// short closing paragraph of real text was still being deleted. A sign-off that
// says "inquiry" almost always carries an address too, and the token path above
// catches that case.
const CONTACT_PHRASE = /inquir(?:ies|e)\b|enquir(?:ies|e)\b|please\s+(reach\s+out|contact)|for\s+more\s+information|press\s+(office|contact|release\s+contact)|media\s+contact|rsvp/i

// The strongest signal is not length but how the paragraph opens. A sign-off
// announces itself — "For press inquiries…", "Contact…" — whereas a paragraph
// that merely happens to contain an address opens as ordinary prose. Length is
// the fallback for sign-offs phrased less conventionally.
const CONTACT_OPENER =
  /^\s*(?:for\s+(?:press\s+|more\s+|further\s+)?(?:information|inquiries|enquiries|details)|press\s+(?:inquiries|enquiries|office|contact)|media\s+(?:inquiries|enquiries|contact)|contact\b|inquiries\b|enquiries\b|to\s+request|images?\s+(?:are\s+)?available)/i

// A contact block is a line or two. Anything longer is prose doing other work,
// so the thresholds are deliberately tight — keeping a stray sign-off costs a
// sentence, deleting a real paragraph costs the press release.
const CONTACT_TOKEN_MAX_CHARS = 200
const CONTACT_PHRASE_MAX_CHARS = 120

function isContactBlock(paragraph: string): boolean {
  const p = paragraph.trim()
  if (!p) return true
  // Opens as a sign-off, and carries contact detail of some kind — remove it
  // whatever its length.
  if (CONTACT_OPENER.test(p) && (CONTACT_TOKEN.test(p) || CONTACT_PHRASE.test(p))) return true
  if (CONTACT_TOKEN.test(p)) return p.length <= CONTACT_TOKEN_MAX_CHARS
  if (CONTACT_PHRASE.test(p)) return p.length <= CONTACT_PHRASE_MAX_CHARS
  return false
}

function cleanPressRelease(text: string | null): string | null {
  if (!text) return null
  const paragraphs = text.split(/\n{2,}/)
  while (paragraphs.length > 0 && isContactBlock(paragraphs[paragraphs.length - 1])) {
    paragraphs.pop()
  }
  const cleaned = paragraphs.join('\n\n').trim()

  // Guardrail: a cleanup pass must never be the reason a press release
  // disappears. If every paragraph matched — a single-block release ending in a
  // contact line, or text separated by single newlines so the split never fired
  // — keep the original rather than returning nothing. Removing a genuine
  // trailing contact block is still wanted; wiping the whole release is not.
  if (!cleaned) return text.trim() || null

  return cleaned
}

// ─── Validation helpers (Req #1, #3, #4, #5) ─────────────────────────────────

// The URL-level section page check (isSectionPageUrl) lives in
// listing-page-checks.ts, next to the title-level check that shares its list.
// Section 3 now applies both, along with the symmetric self-link/child-path
// guard, so a link that reaches the detail stage has already passed them. The
// HTML-level check that used to run here after the fetch — and its
// SECTION_TITLE_RE / SECTION_H1_RE / SHORT_WORDS constants — went with it: a
// second opinion on a question already settled upstream, paid for after the
// page had been downloaded.

// Req #1: Fast string check for title presence — avoids Claude call when possible.
// Claude is inconsistent about preserving typographic punctuation verbatim —
// sometimes it keeps a source's curly quotes/em-dashes exactly as they appear,
// sometimes it normalizes them to plain ASCII on its own initiative (and vice
// versa — a page can use a plain hyphen where Claude's output uses an en-dash).
// Canonicalizing both the page text and the extracted sample to the same
// plain-ASCII form before comparing means punctuation style never causes a
// false mismatch — we only care whether the real words came from the page, not
// typographic fidelity.
// Both sides of the hallucination check pass through here before comparison.
// This used to decode ten hand-picked entities, which meant any other
// entity-encoded character failed to match: Fredericks & Freiser writes
// "Anastasya Pe&ntilde;a" in its source, Claude reads "Anastasya Peña", and a
// perfectly correct extraction was thrown away as invented. he.decode handles
// the whole entity table, matching what Agent 3 already does on RSS fields.
//
// NFKC follows so that a precomposed "ñ" and an "n" plus a combining tilde
// compare equal — a real encoding difference rather than a semantic one.
// Accents are deliberately preserved, not folded away: this is a containment
// check on short samples, and folding would make genuinely different words
// compare equal for no gain.
function canonicalizeForMatch(s: string): string {
  return he
    .decode(s)
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/\u00a0/g, ' ')
}

// Tag-stripping can insert whitespace at inline-element boundaries that the
// source didn't visually have — e.g. a date range split across <span> tags
// ("<span>2021</span>–<span>2025</span>") becomes "2021– 2025" once tags are
// replaced with spaces, while Claude reads it visually as "2021–2025" with no
// space. Stripping whitespace entirely (not just collapsing runs of it) avoids
// false negatives from this — we only care whether the real words came from the
// page, not exact spacing fidelity.
function titleAppearsInHtml(title: string, html: string): boolean {
  const decoded = canonicalizeForMatch(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, '')
    .toLowerCase()

  const norm = canonicalizeForMatch(title).replace(/\s+/g, '').toLowerCase()
  if (decoded.includes(norm)) return true
  // Partial match for long titles
  if (norm.length > 25 && decoded.includes(norm.slice(0, 25))) return true
  return false
}

// Req #1: Fast string check for description presence.
function descriptionAppearsInHtml(description: string, html: string): boolean {
  const decoded = canonicalizeForMatch(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, '')
    .toLowerCase()
  const sample = canonicalizeForMatch(description).replace(/\s+/g, '').toLowerCase().slice(0, 80)
  return sample.length > 0 && decoded.includes(sample)
}

// Does this artist's name actually appear on the page? Same canonicalized
// containment test the title and description use, so entity-encoded and
// typographic differences ("Anastasya Pe&ntilde;a") don't read as absent.
//
// No partial-match fallback, unlike titles: a name is short enough that a prefix
// of it is a different person, and accepting one would let a first name alone
// confirm a full credit.
// Galleries routinely link the press release rather than printing it. Finds the
// first anchor whose visible text or href says "press release", so that one page
// can be fetched. Returns an absolute URL, or null when the phrase appears on the
// page but not inside a link — which is the "found, but not clickable" case that
// deliberately does nothing.
function findPressReleaseLink(html: string, baseUrl: string): string | null {
  const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = anchorRe.exec(html)) !== null) {
    const href = m[1]
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    if (!/press\s*release/i.test(text) && !/press[-_]?release/i.test(href)) continue
    try { return new URL(href, baseUrl).href } catch { continue }
  }
  return null
}

export function artistAppearsInHtml(name: string, html: string): boolean {
  const decoded = canonicalizeForMatch(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, '')
    .toLowerCase()
  const norm = canonicalizeForMatch(name).replace(/\s+/g, '').toLowerCase()
  return norm.length > 2 && decoded.includes(norm)
}

// Req #5: Image URL validation — discards placeholders, logos, and relative URLs.
// Logos and icons arrive in two shapes, and they fail differently:
//
//   /logo/header.png            — the word is its own path segment
//   Banner-Logo-2026-1024x234.jpg — the word is inside the filename
//
// Both need matching. The long-standing pattern only had the first form, so the
// second went through as an exhibition image; replacing it with a form that
// required the word and the extension in ONE segment then dropped the first,
// because there "logo" and ".png" are in different segments. So: two alternatives.
//
// Neither fires on a real word that merely contains those letters. The segment
// form demands a slash right after ("logogram-gallery/" does not qualify), and
// the filename form cannot cross a slash, so logogram-gallery/show-view.jpg —
// where the letters and the extension are in different segments — is left alone.
const IMAGE_DISCARD_RE = /placeholder|default[^/]*\.(jpe?g|png|webp|gif|svg)|\/(?:logo|icon)s?\/|\/[^/]*(?:logo|icon)[^/]*\.(jpe?g|png|webp|svg)|avatar|blank|spacer/i

function validateImageUrl(url: string | null, baseUrl: string): string | null {
  if (!url) return null
  if (url.startsWith('data:')) return null

  // Resolve relative URLs
  let absolute = url
  if (!url.startsWith('http')) {
    try { absolute = new URL(url, baseUrl).href } catch { return null }
  }

  if (IMAGE_DISCARD_RE.test(absolute)) return null
  return absolute
}

// Req #4: Temporal classification — past shows are discarded, far-future are 'upcoming'.
function classifyShowByDates(
  startDate: string | null,
  endDate: string | null
): 'current' | 'past' | 'upcoming' {
  const today = new Date().toISOString().split('T')[0]
  const farFuture = new Date()
  farFuture.setDate(farFuture.getDate() + 90)
  const farFutureStr = farFuture.toISOString().split('T')[0]

  if (endDate && endDate < today) return 'past'
  if (startDate && startDate > farFutureStr) return 'upcoming'
  return 'current'
}

// Scans the FULL raw listing-page HTML for exhibition-like hrefs.
// FIX 3 CONFIRMED: this function receives `listingHtml` — the complete HTML string
// returned by fetchListingPage — NOT the 60K-sliced version used by extractExhibitionLinks.
// Slicing only happens inside extractExhibitionLinks (in claude.ts). This scan is
// therefore unaffected by the slice window and will find links anywhere in the page.
// `sectionPagesOut`, when supplied, collects the URLs dropped by the terminal-segment
// check below so the caller can log and count them. The scan stays pure — it has no
// access to the run's diagnostics or venue name — following the same accumulator
// pattern scrapeInstitution already uses for `errors`.
function scanExhibitionHrefs(html: string, venueUrl: string, sectionPagesOut?: string[]): string[] {
  const base = (() => { try { return new URL(venueUrl).origin } catch { return '' } })()
  const selfPathname = (() => { try { return new URL(venueUrl).pathname.replace(/\/$/, '') } catch { return '' } })()

  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])
  const seen = new Set<string>()
  const results: string[] = []

  for (const href of hrefs) {
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) continue
    let absolute: string
    try {
      absolute = href.startsWith('http') ? href : new URL(href, base).href
    } catch { continue }

    // Same-domain only
    if (base && !absolute.startsWith(base)) continue
    if (seen.has(absolute)) continue
    seen.add(absolute)

    let pathname: string
    try { pathname = new URL(absolute).pathname.replace(/\/$/, '') } catch { continue }

    // Skip self-referential and parent paths
    if (pathname === selfPathname) continue
    if (selfPathname && selfPathname.startsWith(pathname + '/') && pathname.length > 1) continue

    // Skip section pages — same check as Tier 1's links (numbered variants and
    // dated archive segments included).
    if (isSectionPageUrl(absolute)) {
      sectionPagesOut?.push(absolute)
      continue
    }

    // Must be at least two path segments deep (not just the homepage)
    if (pathname.split('/').filter(Boolean).length < 2) continue

    // The URL must look like an individual show page — path contains an exhibition-like word
    if (!/(exhibition|show|display|on-view|exhibit)/.test(pathname.toLowerCase())) continue

    results.push(absolute)
  }

  return results
}

// ─── Browserbase session helpers ──────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms)
    ),
  ])
}

async function createBrowserSession() {
  const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY! })
  const session = await withTimeout(
    bb.sessions.create({ projectId: process.env.BROWSERBASE_PROJECT_ID! }),
    20000,
    'Browserbase session create'
  )
  const puppeteer = await import('puppeteer')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const browser = await withTimeout<any>(
    (puppeteer as any).connect({ browserWSEndpoint: session.connectUrl }),
    15000,
    'puppeteer.connect'
  )
  const pages = await browser.pages()
  const page = pages[0] ?? await browser.newPage()
  return { browser, page }
}

const FETCH_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// Step 1: Fetch listing page. Uses Browserbase for JS rendering + pagination clicks;
// falls back to plain HTTP if Browserbase fails.
async function fetchListingPage(url: string, timeoutMs = 30000): Promise<{ html: string; success: boolean; method: 'browserbase' | 'http_fallback' | 'none' }> {
  let browser: Awaited<ReturnType<typeof createBrowserSession>>['browser'] | null = null
  try {
    const session = await createBrowserSession()
    browser = session.browser
    const page = session.page

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })

    // Network-idle wait: gives SPA / Wix / React sites time to inject all anchor tags.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (page as any).waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => {})

    for (let i = 0; i < 3; i++) {
      const clicked = await page.evaluate(() => {
        const re = /load more|next page|see more|show more/i
        const els = Array.from(document.querySelectorAll('button, a[href], [role="button"]'))
        const btn = els.find((el) => re.test(el.textContent?.trim() ?? ''))
        if (btn) { ;(btn as HTMLElement).click(); return true }
        return false
      })
      if (!clicked) break
      await new Promise((r) => setTimeout(r, 2000))
    }

    let html = await page.content()

    // If the Browserbase render is still sparse, try an alternate URL form:
    // some sites respond better to www.domain.com than bare domain.com or vice versa.
    if (html.length < 5000) {
      try {
        const parsed = new URL(url)
        const altHost = parsed.hostname.startsWith('www.')
          ? parsed.hostname.slice(4)
          : `www.${parsed.hostname}`
        const altUrl = `${parsed.protocol}//${altHost}${parsed.pathname}${parsed.search}`
        console.warn(`Listing page sparse (${html.length}B) — trying alternate host: ${altUrl}`)
        await page.goto(altUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (page as any).waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => {})
        const altHtml = await page.content()
        if (altHtml.length > html.length) html = altHtml
      } catch {}
    }

    return { html, success: html.length > 1000, method: 'browserbase' }
  } catch (err) {
    console.error(`Listing page Browserbase failed for ${url} — trying plain HTTP:`, (err as Error).message)
    // Plain HTTP fallback for SSR sites
    try {
      const res = await fetch(url, { headers: { 'User-Agent': FETCH_UA }, signal: AbortSignal.timeout(15000) })
      const html = await res.text()
      if (res.ok && html.length > 3000) return { html, success: true, method: 'http_fallback' }
      // A refusal that is a recognisable block page is handed back as fetched, so
      // the venue is recorded as blocked rather than as a network failure — the
      // Vercel checkpoint arrives as an HTTP 429.
      if (!res.ok && isDefinitiveBlock(detectBlockPage(html))) {
        return { html, success: true, method: 'http_fallback' }
      }
    } catch (httpErr) {
      console.error(`Listing page plain HTTP also failed for ${url}:`, (httpErr as Error).message)
    }
    return { html: '', success: false, method: 'none' }
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
}

// Step 2: Fetch detail page. Tries plain HTTP first (fast, free); falls back to
// Browserbase only when the plain response is too short to be a real page.
async function fetchDetailPage(url: string): Promise<{ html: string; success: boolean; method: 'http' | 'browserbase_fallback' | 'none' }> {
  // Plain HTTP first — works for SSR sites (Drupal, WordPress, etc.) and avoids Browserbase quota
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': FETCH_UA },
      signal: AbortSignal.timeout(15000),
    })
    if (res.ok) {
      const html = await res.text()
      if (html.length > 5000) {
        console.log(`[plain HTTP] ${url} — ${html.length} chars`)
        return { html, success: true, method: 'http' }
      }
    }
  } catch (err) {
    console.warn(`Plain HTTP failed for ${url}:`, (err as Error).message)
  }

  // Fallback: Browserbase (JS-rendered sites). Some sites redirect our session
  // away from the requested page after a few seconds (e.g. Cloudflare diverting
  // flagged automated traffic to an unrelated "safe" page) — a fresh session gets
  // an independent chance each time, so retry a couple times before giving up.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await attemptBrowserbaseDetailFetch(url)
    if (result.success) return result
    if (attempt < 3) console.warn(`Browserbase detail fetch attempt ${attempt} failed for ${url} — retrying`)
  }
  return { html: '', success: false, method: 'none' }
}

// Threshold well above any observed Cloudflare interstitial (seen up to ~6.7KB)
// and well below any real detail page (seen 100KB+ across every venue this
// session) — used both for the network-capture rescue and for deciding whether
// page.content() has actually settled on real content yet.
const MIN_REAL_DETAIL_HTML_LENGTH = 50000

async function attemptBrowserbaseDetailFetch(url: string): Promise<{ html: string; success: boolean; method: 'http' | 'browserbase_fallback' | 'none' }> {
  let browser: Awaited<ReturnType<typeof createBrowserSession>>['browser'] | null = null
  try {
    const session = await createBrowserSession()
    browser = session.browser
    const page = session.page

    // Some sites (bot-protected or otherwise) redirect away from the requested
    // page after a few seconds of dwell time — e.g. an idle/inactivity redirect
    // that our headless browser triggers just by sitting on the page while it
    // waits for network idle. page.content() reflects wherever the DOM ends up,
    // so it can get silently swapped out from under us. The raw network response
    // for our own request doesn't have that problem — it's the real bytes the
    // server sent for the URL we asked for, independent of what the DOM does
    // afterward. Keep the latest one seen (a Cloudflare-style challenge can
    // serve an interstitial first, then a real response for the same URL once
    // it clears) as a rescue source for when the DOM has moved on.
    const requestedPath = new URL(url).pathname.replace(/\/$/, '')
    let networkCapturedHtml: string | null = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(page as any).on('response', (response: any) => {
      void (async () => {
        try {
          const req = response.request()
          const respPath = new URL(response.url()).pathname.replace(/\/$/, '')
          if (req.resourceType() !== 'document' || respPath !== requestedPath) return
          const body = await response.text()
          // Threshold well above any observed Cloudflare interstitial (seen up to
          // ~6.7KB) and well below any real detail page (seen 100KB+ across every
          // venue this session) — a low threshold risks capturing a bigger decoy/
          // interim challenge page as if it were real content.
          if (body.length > MIN_REAL_DETAIL_HTML_LENGTH) networkCapturedHtml = body
        } catch {
          // redirect/preflight responses have no readable body — nothing to capture
        }
      })()
    })

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })

    const samePage = () => {
      try { return new URL(page.url()).pathname.replace(/\/$/, '') === requestedPath } catch { return false }
    }

    let html = await page.content().catch(() => '')
    const readyOnPage = () => samePage() && html.length > MIN_REAL_DETAIL_HTML_LENGTH

    // page.goto() only waits for domcontentloaded, which can fire on an interim
    // challenge page — and a Cloudflare-style challenge can revisit the correct
    // URL path multiple times (interstitial, then redirect, then real content)
    // before finally settling. Matching the path alone isn't enough: the DOM can
    // briefly be "on the right page" while still showing a small interim state.
    // Keep re-checking actual content size, not just the URL, before deciding
    // we're done — and give the network listener real time to receive the
    // genuine response as a fallback source.
    if (!readyOnPage()) {
      const deadline = Date.now() + 10000
      while (Date.now() < deadline && !networkCapturedHtml && !readyOnPage()) {
        await new Promise((r) => setTimeout(r, 500))
        if (samePage()) html = await page.content().catch(() => html)
      }
    }

    if (!readyOnPage()) {
      if (networkCapturedHtml) {
        console.warn(`Detail page redirected away from ${url} to ${page.url()} — using network-captured response instead`)
        return { html: networkCapturedHtml, success: true, method: 'browserbase_fallback' }
      }
      console.warn(`Detail page redirected away from ${url} to ${page.url()} — discarding`)
      return { html: '', success: false, method: 'none' }
    }

    // Best-effort enrichment: wait for network idle and click any expand/read-more
    // buttons, then re-capture — but only trust the re-capture if we're still on
    // the page we asked for. If the site has redirected us elsewhere by now, keep
    // the earlier capture rather than silently ingesting the wrong page's content.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (page as any).waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => {})

      if (samePage()) {
        await page.evaluate(() => {
          const re = /read more|full description|press release|view more|show more|expand/i
          document.querySelectorAll('button, a, [role="button"], details summary').forEach((el) => {
            if (re.test(el.textContent?.trim() ?? '')) (el as HTMLElement).click()
          })
        })
      }

      if (samePage()) {
        const enriched = await page.content()

        // Sparsity check: measure visible text AFTER stripping scripts/styles so that
        // JS-bundle content doesn't mask an empty DOM (Next.js SSR pattern where
        // content lives in <script> until React hydrates into actual DOM elements).
        const strippedForCheck = enriched
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
        const visibleTextLen = strippedForCheck.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().length
        if (visibleTextLen < 500) {
          console.log(JSON.stringify({
            tag: 'AGENT1', url, event: 'SPARSE_CONTENT',
            html_length: enriched.length,
            visible_text_after_strip: visibleTextLen,
          }))
          // React hydration is CPU-bound — wait for h1 to appear (up to 8s), then re-capture.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (page as any).waitForSelector('h1, [class*="title"], [class*="heading"]', { timeout: 8000 }).catch(() => {})
          await new Promise((r) => setTimeout(r, 500))
          if (samePage()) html = await page.content()
        } else {
          html = enriched
        }
      }
    } catch (err) {
      console.warn(`Detail page enrichment skipped for ${url} (non-fatal):`, (err as Error).message)
    }

    if (!samePage()) {
      console.warn(`Detail page redirected away from ${url} to ${page.url()} — discarding enrichment, keeping initial capture`)
    }

    return { html, success: true, method: 'browserbase_fallback' }
  } catch (err) {
    console.error(`Detail page fetch failed for ${url}:`, err)
    return { html: '', success: false, method: 'none' }
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
}

// ─── Artist upsert ────────────────────────────────────────────────────────────

async function upsertArtist(name: string): Promise<string | null> {
  const db = getSupabaseAdmin()
  const { data: existing } = await db.from('artists').select('id').eq('name', name).maybeSingle()
  if (existing) return existing.id

  const { data: inserted, error } = await db.from('artists').insert({ name }).select('id').single()
  if (error || !inserted) {
    console.error(`Failed to upsert artist "${name}":`, error?.message)
    return null
  }
  return inserted.id
}

// ─── Main scrape function ─────────────────────────────────────────────────────

// Anchor-window rungs for the location_hint retry ladder. Only climbs, never
// shrinks: a venue that needed 3,000 once will need it again, and re-narrowing
// would just re-lose the hints. Capped at three rungs because past ~3,000 the
// window starts pulling in the *neighbouring* card's location, which is worse
// than no hint at all — the detail-stage verifier is the real safety net.
const LOCATION_WINDOW_LADDER = [600, 1500, 3000] as const

// Persists what console logs previously lost on serverless exit: which method
// (http/browserbase) fetched a given detail page, its html_length, and how far
// it got through the pipeline. Lets admin trace a pending exhibition's missing
// fields back to how it was scraped, not just that it's missing.
async function logDetailFetch(
  db: ReturnType<typeof getSupabaseAdmin>,
  entry: {
    venueId: string
    institutionId?: string
    url: string
    title?: string | null
    method: string
    htmlLength: number
    outcome: string
    exhibitionId?: string
  }
): Promise<void> {
  try {
    await db.from('agent1_fetch_logs').insert({
      venue_id: entry.venueId,
      institution_id: entry.institutionId ?? null,
      exhibition_id: entry.exhibitionId ?? null,
      url: entry.url,
      title: entry.title ?? null,
      method: entry.method,
      html_length: entry.htmlLength,
      outcome: entry.outcome,
    })
  } catch (err) {
    console.error('Failed to write agent1_fetch_logs row:', err)
  }
}

/** What the listing stage found, at whichever point the run stopped. */
export interface ListingReport {
  method: string
  html_length: number
  /** The block-page signal that ended or colored the run, e.g. "fingerprint:vercel-security-checkpoint". */
  block_signal: string | null
  links: { title: string; url: string; date_hint: string | null }[]
  /** What the cap did, so a listing-only run can be checked without any writes.
   *  Null when the venue never reached the cap (no links, or a failure first). */
  cap: {
    limit: number
    candidates: number
    processing: number
    exempt_no_end_date: number
    deferred: string[]
  } | null
  discard_reasons: Record<string, number>
}

export interface ScrapeInstitutionResult {
  upserted: number
  /** Set when the venue as a whole could not be scraped (no URL, unreachable,
   *  bot-walled, no links found). Individual shows failing does not set it. */
  failureReason: string | null
  listing?: ListingReport
}

export interface ScrapeInstitutionOptions {
  /** Stop once the links to scrape are known, and write nothing. For testing the
   *  listing stage against live sites; link extraction and the location filter
   *  still call Claude, and fetching still opens Browserbase sessions. */
  listingOnly?: boolean
}

export async function scrapeInstitution(
  venue: VenueRecord,
  skipPrereads = false,
  errors: AgentRunError[] = [],
  options: ScrapeInstitutionOptions = {}
): Promise<ScrapeInstitutionResult> {
  const vn = venue.name
  console.log(`[${vn}] Starting scrape — ${venue.exhibitions_url}`)
  const db = getSupabaseAdmin()
  const isMuseum = venue.type === 'museum'
  const listingOnly = options.listingOnly === true
  const updateVenue = async (fields: Record<string, unknown>) => {
    if (listingOnly) return
    await db.from('venues').update(fields).eq('id', venue.id)
  }

  // A venue can reach the database with no exhibitions_url: Manual Entry allows
  // it, and the CSV import leaves it blank on the second venue of a
  // multi-location gallery rather than repeating a guess that the insert would
  // dedup away. Fetching an empty URL fails as a network error, which reads as
  // the gallery's site being down rather than as missing data — so it gets its
  // own reason. Like every venue-level failure it counts toward error3, after
  // which the venue leaves the rotation until someone fixes it.
  if (!venue.exhibitions_url?.trim()) {
    console.warn(`[${vn}] No exhibitions_url set — nothing to scrape`)
    errors.push({ item: vn, step: 'fetch', message: 'Venue has no exhibitions URL' })
    await updateVenue({ scrape_failed: true, scrape_failure_reason: 'no_exhibitions_url' })
    return { upserted: 0, failureReason: 'no_exhibitions_url' }
  }

  // Diagnostic counters for SCRAPE_COMPLETE summary
  const diag = {
    shows_found_on_listing: 0,
    shows_after_classification: 0,
    shows_after_guards: 0,
    shows_fetched: 0,
    shows_extracted: 0,
    shows_passed_hallucination: 0,
    shows_passed_temporal: 0,
    // Stale-pending wipe outcome. Tracked because this silently failed for months.
    pending_wipe: { deleted: 0, failed: false, error_code: null as string | null },
    // Retry-ladder telemetry. Separate from discard_reasons because nothing here
    // is a discard — it records how hard we had to work to see a location.
    location_ladder: {
      eligible: false,        // institution.is_multi_city
      triggered: false,       // did it climb at all
      started_at: 0,          // window size the run began with
      resolved_at: 0,         // window size that produced hints (0 = never)
      extra_tier1_calls: 0,
      hints_found: 0,
      links_missing_hint: 0,
    },
    discard_reasons: {
      guard_failed: 0,
      fetch_failed: 0,
      extraction_failed: 0,
      hallucination_rejected: 0,
      temporal_discarded: 0,
      location_rejected: 0,
      section_page_tier1: 0,
      section_page_tier2: 0,
      title_check_tier1: 0,
      title_check_tier2: 0,
      non_nyc_tier1: 0,
      upsert_failed: 0,
      // Section 3 additions: shows that are real but not on at this venue, deeper
      // listing pages under the venue's own URL, and candidates that had no date
      // evidence on either the listing page or their own detail page.
      offsite_fair: 0,
      offsite_institution: 0,
      child_listing_path: 0,
      no_date_evidence: 0,
    },
  }

  // A link whose whole title is listing-page language ("Past Exhibitions", "View
  // All", "Hauser & Wirth Exhibitions") leads to another listing, not a show.
  const dropListingTitles = (links: ExhibitionLink[], tier: 'tier1' | 'tier2'): ExhibitionLink[] =>
    links.filter((link) => {
      const reason = listingPageTitleReason(link.title, { venueName: vn, url: link.url })
      if (!reason) return true
      console.log(JSON.stringify({
        tag: 'AGENT1', venue: vn, url: link.url, event: 'GUARD_FAILED',
        guard: `listingTitle:${tier}`, reason, title: link.title,
      }))
      diag.discard_reasons[tier === 'tier1' ? 'title_check_tier1' : 'title_check_tier2']++
      return false
    })

  if (!listingOnly) await geocodeVenueIfNeeded(venue.id, venue.address ?? null, venue.latitude, venue.longitude)

  // ─── Step 1: listing page ─────────────────────────────────────────────────
  let { html: listingHtml, success: listingSuccess, method: listingMethod } =
    await fetchListingPage(venue.exhibitions_url)

  // Retry once, with a fresh browser session and a 60s timeout, when the fetch
  // failed, came back under 10KB, or looks like a block page by any one signal
  // (listing-page-checks.ts): a known fingerprint, a challenge phrase, or a large
  // page with almost no text. Size alone missed the 32KB Vercel checkpoint.
  const firstBlock = listingSuccess ? detectBlockPage(listingHtml) : null
  const firstUnder10KB = listingSuccess && listingHtml.length < 10000
  if (!listingSuccess || firstUnder10KB || firstBlock) {
    const reason = !listingSuccess ? 'fetch_failed' : firstBlock ? `${firstBlock.kind}:${firstBlock.label}` : 'under_10kb'
    console.warn(`[${vn}] Retrying listing fetch with a fresh session (${reason})`)
    console.log(JSON.stringify({
      tag: 'AGENT1', venue: vn, event: 'LISTING_RETRY', reason, html_length: listingHtml.length,
    }))
    const retry = await fetchListingPage(venue.exhibitions_url, 60000)
    const retryBlock = retry.success ? detectBlockPage(retry.html) : null
    const useRetry = retry.success && (
      !listingSuccess ||                                        // the first attempt failed outright
      (firstBlock !== null && retryBlock === null) ||           // the retry got past the block
      (retryBlock === null && retry.html.length > listingHtml.length) // more page, and not a block
    )
    if (useRetry) {
      listingHtml = retry.html
      listingSuccess = retry.success
      listingMethod = retry.method
    }
  }

  console.log(JSON.stringify({
    tag: 'AGENT1', venue: vn, event: 'LISTING_FETCH',
    method: listingMethod,
    status: listingSuccess ? 'success' : 'failed',
    html_length: listingHtml.length,
  }))

  // Set when the page looked like a block page; returned in the listing report,
  // and decides how a venue that yields no links is recorded.
  let blockNote: string | null = null
  // Filled in when the cap runs, which is before the listing-only return so a test
  // run can see the cap's decision without fetching a single show page.
  let capReport: ListingReport['cap'] = null
  const listingReport = (links: ExhibitionLink[]): ListingReport => ({
    method: listingMethod,
    html_length: listingHtml.length,
    block_signal: blockNote,
    links: links.map((l) => ({ title: l.title, url: l.url, date_hint: l.date_hint })),
    cap: capReport,
    discard_reasons: { ...diag.discard_reasons },
  })

  // Every venue-level failure below returns a failureReason and writes nothing
  // else: the queue (finishVenueScrape) turns it into error1 → error2 → error3.
  if (!listingSuccess) {
    console.error(`[${vn}] Listing page fetch failed after retry — marking scrape_failed`)
    errors.push({ item: vn, step: 'fetch', message: 'Listing page fetch failed after retry' })
    await updateVenue({ scrape_failed: true, scrape_failure_reason: 'fetch_failed' })
    return { upserted: 0, failureReason: 'fetch_failed', listing: listingReport([]) }
  }

  // A fingerprint or phrase match is proof: the venue is recorded as blocked and
  // link extraction, which could only find nothing, is skipped. A page that is
  // merely suspicious — a large page with almost no text, or one still under 10KB
  // — goes on to link extraction, because JavaScript-shell sites look the same
  // before rendering. It only counts as blocked if no links come out of it.
  const blockSignal = detectBlockPage(listingHtml)
  if (isDefinitiveBlock(blockSignal)) {
    blockNote = `${blockSignal!.kind}:${blockSignal!.label}`
    console.log(JSON.stringify({
      tag: 'AGENT1', venue: vn, event: 'BOT_WALL_DETECTED',
      html_size: listingHtml.length, signal: blockNote,
    }))
    errors.push({ item: vn, step: 'fetch', message: `Bot wall detected (${blockNote})` })
    await updateVenue({ scrape_failed: true, scrape_failure_reason: 'bot_protected' })
    return { upserted: 0, failureReason: 'bot_protected', listing: listingReport([]) }
  }
  if (blockSignal) blockNote = `${blockSignal.kind}:${blockSignal.label}`
  else if (listingHtml.length < 10000) blockNote = `under_10kb:${listingHtml.length}B`

  // Logged so a note's effect is legible in the run output: if a venue keeps
  // failing you need to know whether the hint was actually in play, and if it
  // starts working you need to know whether the hint is why.
  if (venue.scrape_notes?.trim()) {
    console.log(JSON.stringify({
      tag: 'AGENT1', venue: vn, event: 'SCRAPE_NOTES_APPLIED', note: venue.scrape_notes.trim(),
    }))
  }

  // ─── Tier 1, with the location_hint retry ladder ──────────────────────────
  // Gated purely on the institution's manually-set is_multi_city. A single-address
  // NYC gallery has nothing to disambiguate, so no amount of extra context earns
  // its cost there. Multi-city institutions climb until every link carries a
  // location_hint, or until the ladder runs out.
  const ladderEligible = venue.is_multi_city === true
  const startIdx = (() => {
    const stored = venue.location_window_size
    if (!stored) return 0
    const i = LOCATION_WINDOW_LADDER.findIndex((w) => w >= stored)
    return i === -1 ? LOCATION_WINDOW_LADDER.length - 1 : i
  })()

  let windowIdx = startIdx
  let allLinks = await extractExhibitionLinks(
    listingHtml, vn, venue.exhibitions_url, venue.scrape_notes, LOCATION_WINDOW_LADDER[windowIdx]
  )

  diag.location_ladder.eligible = ladderEligible
  diag.location_ladder.started_at = LOCATION_WINDOW_LADDER[startIdx]

  const missingHint = (links: ExhibitionLink[]) =>
    links.filter((l) => !l.location_hint).length

  if (ladderEligible) {
    while (windowIdx < LOCATION_WINDOW_LADDER.length - 1 && allLinks.length > 0 && missingHint(allLinks) > 0) {
      const from = LOCATION_WINDOW_LADDER[windowIdx]
      windowIdx++
      const to = LOCATION_WINDOW_LADDER[windowIdx]
      console.log(JSON.stringify({
        tag: 'AGENT1', venue: vn, event: 'LOCATION_LADDER_RETRY',
        from_window: from, to_window: to,
        links: allLinks.length, links_missing_hint: missingHint(allLinks),
      }))
      diag.location_ladder.triggered = true
      diag.location_ladder.extra_tier1_calls++
      allLinks = await extractExhibitionLinks(
        listingHtml, vn, venue.exhibitions_url, venue.scrape_notes, to
      )
    }
  }

  const hintsFound = allLinks.filter((l) => l.location_hint).length
  diag.location_ladder.hints_found = hintsFound
  diag.location_ladder.links_missing_hint = missingHint(allLinks)
  diag.location_ladder.resolved_at = hintsFound > 0 ? LOCATION_WINDOW_LADDER[windowIdx] : 0

  console.log(JSON.stringify({
    tag: 'AGENT1', venue: vn, event: 'LOCATION_LADDER',
    eligible: ladderEligible,
    started_at: LOCATION_WINDOW_LADDER[startIdx],
    ended_at: LOCATION_WINDOW_LADDER[windowIdx],
    extra_tier1_calls: diag.location_ladder.extra_tier1_calls,
    links: allLinks.length,
    hints_found: hintsFound,
    still_missing: missingHint(allLinks),
    resolved: hintsFound > 0 ? 'yes' : 'no — detail-stage verifier remains the safety net',
  }))

  // Persist the rung that worked so the next scrape starts here instead of
  // re-climbing. Only widens: a smaller stored value is never written back.
  const endedAt = LOCATION_WINDOW_LADDER[windowIdx]
  if (ladderEligible && hintsFound > 0 && endedAt !== (venue.location_window_size ?? 0)) {
    if (!listingOnly) await db.from('venues').update({ location_window_size: endedAt }).eq('id', venue.id)
    console.log(`[${vn}] Stored location window size ${endedAt} for future scrapes`)
  }

  // Tier 1 is a content extraction rather than a URL scan, so unlike the two href
  // scan below it has never been filtered against SECTION_TERMINAL_SEGMENTS —
  // scanExhibitionHrefs applies it inline as it builds its candidate list. Until now a Tier 1 link ending in /past or /archive was only
  // stopped in Step 2's per-link loop, after classification, content-type,
  // location and self-link filtering had already been spent on it. Same function,
  // same set, just applied where Tier 1's links are produced.
  //
  // Runs before the two fallbacks below on purpose: if Tier 1 returned nothing but
  // section pages, the venue should fall through to the href scans rather than
  // proceed with an empty list.
  allLinks = allLinks.filter((link) => {
    if (!isSectionPageUrl(link.url)) return true
    console.log(JSON.stringify({
      tag: 'AGENT1', venue: vn, url: link.url, event: 'GUARD_FAILED',
      guard: 'isSectionPageUrl:tier1',
      reason: 'URL last segment matches section terminal list',
      title: link.title,
    }))
    diag.discard_reasons.section_page_tier1++
    return false
  })

  // Tier 1's titles are read off the listing page itself. Checked here, before the
  // fallback, for the same reason as the URL check above.
  allLinks = dropListingTitles(allLinks, 'tier1')

  // Tier 2: if Tier 1 found nothing, scan the full HTML for exhibition-shaped hrefs
  // and let a cheap model sort them. Recovers venues whose shows sit past Tier 1's
  // text window. (Tier 3, a scan of every link on the page, was removed 2026-09-15:
  // no exhibition on record depends on it, and it once took a JavaScript bundle for
  // a show.)
  if (allLinks.length === 0) {
    console.warn(`[${vn}] extractExhibitionLinks returned 0 — trying exhibition href scan`)
    const tier2SectionPages: string[] = []
    const candidateUrls = scanExhibitionHrefs(listingHtml, venue.exhibitions_url, tier2SectionPages)
    // Previously a bare `continue` inside the scan: section pages were dropped with no
    // log line and no counter, so this guard was invisible in every run it fired in.
    for (const dropped of tier2SectionPages) {
      console.log(JSON.stringify({
        tag: 'AGENT1', venue: vn, url: dropped, event: 'GUARD_FAILED',
        guard: 'isSectionPageUrl:tier2',
        reason: 'URL last segment matches section terminal list',
      }))
      diag.discard_reasons.section_page_tier2++
    }
    console.log(JSON.stringify({
      tag: 'AGENT1', venue: vn, event: 'HREF_SCAN_FALLBACK',
      candidates_found: candidateUrls.length,
      candidates: candidateUrls.slice(0, 20),
    }))
    if (candidateUrls.length > 0) {
      const tier2Links = await classifyExhibitionUrls(candidateUrls.slice(0, 60), vn, venue.exhibitions_url)
      // Tier 2's titles are guessed from the URL slug rather than read from the
      // page — a weaker signal, checked the same way.
      allLinks = dropListingTitles(tier2Links, 'tier2')
    }
  }

  // No links anywhere. A page that looked suspicious (large with almost no text,
  // or under 10KB) is recorded as blocked; any other page as zero links.
  if (allLinks.length === 0) {
    const failureReason = blockNote ? 'bot_protected' : 'zero_links_after_retry'
    const message = blockNote
      ? `No exhibition links on a suspected block page (${blockNote})`
      : 'No exhibition links found after href scan'
    console.warn(`[${vn}] ${message} — marking scrape_failed`)
    errors.push({ item: vn, step: 'fetch', message })
    await updateVenue({ scrape_failed: true, scrape_failure_reason: failureReason })
    return { upserted: 0, failureReason, listing: listingReport([]) }
  }

  // Dedup by URL — Claude's Step-1 classification can return the same detail
  // page twice (e.g. featured in a carousel and again in the main grid). Left
  // unfiltered, both copies flow through to Step 2 and can produce two
  // exhibition rows for the same real-world show.
  const seenLinkUrls = new Set<string>()
  const dedupedLinks = allLinks.filter((l) => {
    const key = normalizeDetailUrl(l.url)
    if (seenLinkUrls.has(key)) return false
    seenLinkUrls.add(key)
    return true
  })
  if (dedupedLinks.length < allLinks.length) {
    console.log(`[${vn}] Deduped ${allLinks.length - dedupedLinks.length} repeated URL(s) from listing extraction`)
  }
  allLinks = dedupedLinks

  // Early non-NYC discard using the place text Tier 1 read off the listing page.
  // Purely a cost saving: every link removed here would otherwise have paid for a
  // detail-page fetch and a Sonnet extraction before the detail-stage verifier
  // caught it. Deliberately one-directional — hintNamesNonNycCity only ever
  // reports "this names somewhere else", and returns null for a hint that is
  // absent, ambiguous, prose-length, or that also mentions a NYC place. Anything
  // it lets through is unchanged and still faces the authoritative check after
  // its detail page is downloaded; nothing here marks a link as confirmed-NYC.
  allLinks = allLinks.filter((link) => {
    // Street addresses read off the listing page count too — only when every one
    // of them is elsewhere, and only the text after the street ("88 Hudson
    // Street" is not Hudson, NY).
    const city = hintNamesNonNycCity(link.location_hint, link.title) ?? addressesNameNonNyc(link.addresses)
    if (!city) return true
    console.log(JSON.stringify({
      tag: 'AGENT1', venue: vn, url: link.url, event: 'GUARD_FAILED',
      guard: 'locationHint:tier1',
      reason: `listing-page place text names ${city}, not NYC`,
      title: link.title,
      location_hint: link.location_hint,
      addresses: link.addresses,
    }))
    diag.discard_reasons.non_nyc_tier1++
    return false
  })

  // What the listing page said about each show's dates, recorded before anything
  // is filtered. This is a cross-check, not a gate: a listing page not printing
  // dates is not evidence that a show has closed, so a link with no date signal is
  // flagged and still proceeds. Only the detail page, in check #4, may discard on
  // dates — which is where the flag is read again.
  for (const link of allLinks) {
    link.date_evidence = dateEvidenceFor(link)
    // A current show with no announced closing date skips the cap further down.
    // Separate from date_evidence on purpose: this decides cap position only, and
    // changes nothing about the check #4 discard.
    link.cap_exempt = capExemptFor(link)
    const note = dateCrossCheck(link, link.date_evidence)
    if (note) {
      console.log(JSON.stringify({
        tag: 'AGENT1', venue: vn, url: link.url, event: 'DATE_CROSS_CHECK',
        title: link.title, classification: link.classification,
        date_hint: link.date_hint, date_evidence: link.date_evidence, note,
      }))
    }
  }

  const currentLinks = allLinks.filter(
    (l) => l.classification === 'current' || l.classification === 'upcoming'
  )

  diag.shows_found_on_listing = allLinks.length
  diag.shows_after_classification = currentLinks.length

  console.log(JSON.stringify({
    tag: 'AGENT1', venue: vn, event: 'LINKS_EXTRACTED',
    total_found: allLinks.length,
    classified_current: allLinks.filter((l) => l.classification === 'current').length,
    classified_upcoming: allLinks.filter((l) => l.classification === 'upcoming').length,
    classified_past: allLinks.filter((l) => l.classification === 'past').length,
    classified_permanent: allLinks.filter((l) => l.classification === 'permanent').length,
    links_proceeding: currentLinks.map((l) => l.url),
    // The dates the listing page printed, as printed — kept for Section 3 and for
    // checking the detail stage's parsed dates against what the page actually said.
    listing_dates: currentLinks.filter((l) => l.date_hint).map((l) => ({ url: l.url, date_hint: l.date_hint })),
  }))

  console.log(`[${vn}] Listing: ${allLinks.length} links → ${currentLinks.length} current/upcoming`)

  if (currentLinks.length === 0) {
    console.log(`[${vn}] No current shows — updating check_back_date`)
    await updateVenue({ check_back_date: nextScheduledScrapeDate(venue.scrape_day_of_week ?? null, new Date()), scrape_failed: false, manual_entry_required: false, scrape_failure_reason: null })
    console.log(JSON.stringify({
      tag: 'AGENT1', venue: vn, event: 'SCRAPE_COMPLETE',
      shows_found_on_listing: diag.shows_found_on_listing,
      shows_after_classification: diag.shows_after_classification,
      shows_after_guards: 0, shows_fetched: 0, shows_extracted: 0,
      shows_passed_hallucination: 0, shows_passed_temporal: 0, shows_upserted: 0,
      shows_discarded: diag.shows_found_on_listing,
      discard_reasons: diag.discard_reasons,
      location_ladder: diag.location_ladder,
      pending_wipe: diag.pending_wipe,
    }))
    return { upserted: 0, failureReason: null, listing: listingReport([]) }
  }

  // Content-type filter: only exhibitions of physical artwork proceed to Step 2.
  // 'event' and 'online_only' links never become pending exhibition records —
  // they're logged to agent1_discarded_items for visibility only. 'unclear'
  // links get the benefit of the doubt and proceed like normal exhibitions.
  // Tier 1 labels fairs and off-site loans from the listing text; offsiteReason is
  // a deterministic second pass over that same text for the ones it still called
  // 'exhibition'. It reads title, place text and Tier 1's own reasoning — never the
  // URL, because these sit interspersed among ordinary shows at ordinary URLs. A
  // collaboration held at this venue's own space is left alone.
  const ownNameForms = venueNameForms(vn)
  for (const link of currentLinks) {
    if (link.content_type !== 'exhibition' && link.content_type !== 'unclear') continue
    const offsite = offsiteReason(link, ownNameForms)
    if (!offsite) continue
    console.log(JSON.stringify({
      tag: 'AGENT1', venue: vn, url: link.url, event: 'OFFSITE_RECLASSIFIED',
      title: link.title, from: link.content_type, to: offsite.kind, reason: offsite.reason,
    }))
    link.content_type = offsite.kind
  }

  const exhibitionLinks = currentLinks.filter(
    (l) => l.content_type === 'exhibition' || l.content_type === 'unclear'
  )
  const discardedByContentType = currentLinks.filter(
    (l) => l.content_type === 'event' || l.content_type === 'online_only'
      || l.content_type === 'fair' || l.content_type === 'offsite'
  )

  if (discardedByContentType.length > 0) {
    for (const l of discardedByContentType) {
      if (l.content_type === 'fair') diag.discard_reasons.offsite_fair++
      else if (l.content_type === 'offsite') diag.discard_reasons.offsite_institution++
    }
    console.log(JSON.stringify({
      tag: 'AGENT1', venue: vn, event: 'CONTENT_TYPE_DISCARDED',
      count: discardedByContentType.length,
      items: discardedByContentType.map((l) => ({ title: l.title, url: l.url, content_type: l.content_type })),
    }))
    if (!listingOnly) await db.from('agent1_discarded_items').insert(
      discardedByContentType.map((l) => ({
        institution_id: venue.institution_id ?? null,
        title: l.title,
        url: l.url,
        content_type: l.content_type,
      }))
    )
  }

  if (exhibitionLinks.length === 0) {
    console.log(`[${vn}] All current/upcoming links were events or online-only — updating check_back_date`)
    await updateVenue({ check_back_date: nextScheduledScrapeDate(venue.scrape_day_of_week ?? null, new Date()), scrape_failed: false, manual_entry_required: false, scrape_failure_reason: null })
    return { upserted: 0, failureReason: null, listing: listingReport([]) }
  }

  // Req #2: Location filter — remove shows at fairs, partner venues, other cities
  const nycLinks = await filterLinksByLocation(exhibitionLinks, vn)
  console.log(`[${vn}] After location filter: ${nycLinks.length}/${exhibitionLinks.length} links`)

  // Log each link dropped by the location filter
  for (const link of exhibitionLinks) {
    if (!nycLinks.some((n) => n.url === link.url)) {
      console.log(JSON.stringify({
        tag: 'AGENT1', venue: vn, url: link.url, event: 'GUARD_FAILED',
        guard: 'filterLinksByLocation',
        reason: 'removed by location filter (non-NYC or fair)',
      }))
      diag.discard_reasons.guard_failed++
    }
  }

  // Guard: exclude any link whose URL is the listing page itself or a parent path of it.
  // Prevents the venue's own exhibitions_url from being scraped as a show detail page.
  const selfPathname = (() => {
    try { return new URL(venue.exhibitions_url).pathname.replace(/\/$/, '') } catch { return null }
  })()
  const guardedLinks = nycLinks.filter((link) => {
    // The other direction of the same guard. The self-referential test below only
    // ever looked at the listing URL itself and its ancestors, so descendants like
    // /exhibitions/past/all/2026-2024 — a year filter into the archive — went
    // through as though they were shows.
    const childReason = childListingPathReason(link.url, venue.exhibitions_url)
    if (childReason) {
      console.log(JSON.stringify({
        tag: 'AGENT1', venue: vn, url: link.url, event: 'GUARD_FAILED',
        guard: 'child_listing_path', reason: childReason, title: link.title,
      }))
      diag.discard_reasons.child_listing_path++
      return false
    }

    if (!selfPathname) return true
    try {
      const linkPath = new URL(link.url).pathname.replace(/\/$/, '')
      const isSelf = linkPath === selfPathname
      const isParent = selfPathname.startsWith(linkPath + '/') && linkPath.length > 1
      if (isSelf || isParent) {
        console.log(`[${vn}] Skipping self-referential URL: ${link.url}`)
        console.log(JSON.stringify({
          tag: 'AGENT1', venue: vn, url: link.url, event: 'GUARD_FAILED',
          guard: 'self_referential',
          reason: `linkPath "${linkPath}" equals or is parent of exhibitionsUrl "${selfPathname}"`,
        }))
        diag.discard_reasons.guard_failed++
        return false
      }
      return true
    } catch { return true }
  })

  diag.shows_after_guards = guardedLinks.length

  console.log(JSON.stringify({
    tag: 'AGENT1', venue: vn, event: 'AFTER_GUARDS',
    links_remaining: guardedLinks.length,
    links: guardedLinks.map((l) => l.url),
  }))

  if (guardedLinks.length === 0) {
    console.warn(`[${vn}] No current links remain after location + self-referential filtering`)
    await updateVenue({ check_back_date: nextScheduledScrapeDate(venue.scrape_day_of_week ?? null, new Date()), scrape_failed: false, manual_entry_required: false, scrape_failure_reason: null })
    const totalDiscarded = diag.shows_found_on_listing
    console.log(JSON.stringify({
      tag: 'AGENT1', venue: vn, event: 'SCRAPE_COMPLETE',
      shows_found_on_listing: diag.shows_found_on_listing,
      shows_after_classification: diag.shows_after_classification,
      shows_after_guards: 0, shows_fetched: 0, shows_extracted: 0,
      shows_passed_hallucination: 0, shows_passed_temporal: 0, shows_upserted: 0,
      shows_discarded: totalDiscarded,
      discard_reasons: diag.discard_reasons,
      location_ladder: diag.location_ladder,
      pending_wipe: diag.pending_wipe,
    }))
    return { upserted: 0, failureReason: null, listing: listingReport([]) }
  }

  // Museums run far more concurrent shows than galleries, and one shared cap of 15
  // was silently truncating the largest ones.
  const detailCap = detailCapForVenueType(venue.type)
  // Rank before cutting, so what survives is what closes soonest rather than
  // whatever order the listing page happened to print. Only worth a call when the
  // cap actually binds; it fails open to the listing order.
  const orderedLinks = guardedLinks.length > detailCap
    ? await rankLinksBySoonestClosing(guardedLinks, vn)
    : guardedLinks
  const { selected: linksToProcess, deferred, exemptCount } = selectWithinCap(orderedLinks, detailCap)

  capReport = {
    limit: detailCap,
    candidates: guardedLinks.length,
    processing: linksToProcess.length,
    exempt_no_end_date: exemptCount,
    deferred: deferred.map((l) => l.url),
  }

  if (deferred.length > 0 || exemptCount > 0) {
    console.warn(`[${vn}] Cap ${detailCap} (${venue.type}): ${guardedLinks.length} candidates → ${linksToProcess.length} processing, ${deferred.length} deferred`)
    console.log(JSON.stringify({
      tag: 'AGENT1', venue: vn, event: 'DETAIL_CAP',
      venue_type: venue.type, cap: detailCap,
      candidates: guardedLinks.length,
      processing: linksToProcess.length,
      // Current shows with no announced closing date never compete for a slot: a
      // soonest-closing order has nothing to rank them by, so it would push them
      // behind every dated show and drop them every single run.
      exempt_no_end_date: exemptCount,
      deferred: deferred.map((l) => l.url),
    }))
  }

  // Listing-only mode ends here, before the stale-pending wipe and any show page.
  // It runs the cap first (just above) so a no-write test run exercises the museum
  // limit, the soonest-closing ranking and the ongoing bypass for real.
  if (listingOnly) {
    return { upserted: 0, failureReason: null, listing: listingReport(linksToProcess) }
  }

  // Wipe stale pending entries for this venue before inserting fresh ones.
  // Published and upcoming exhibitions are intentionally left untouched.
  //
  // The result is checked rather than discarded. This call used to fail silently:
  // agent1_fetch_logs.exhibition_id referenced exhibitions with no ON DELETE
  // action, so any pending row that had ever been fetch-logged rejected the
  // delete with 23503 and the run carried on as though the wipe had worked.
  // migration_v34 changes that FK to ON DELETE SET NULL; this logging is what
  // makes a future regression visible instead of silent.
  // An exhibition an editor's pick points at is never wiped — live pick or retired.
  // editor_picks.reference_id is a bare uuid with no foreign key, so nothing at the
  // database level stops this, and it has already cost one pick: the 2026-05-31
  // exhibition pick pointed at a show that no longer existed. A pick usually points
  // at a published show, which this wipe already spares, but unpublishing one puts
  // it straight back in range.
  const pickedExhibitions = await pickedReferenceIds('exhibition')

  if (pickedExhibitions.error) {
    // Skipping the wipe leaves stale pending rows for one run, and the next run
    // clears them. Wiping without this list risks deleting a picked show, which
    // nothing can restore.
    console.error(`[${vn}] Stale-pending wipe SKIPPED — could not read editor_picks:`, pickedExhibitions.error)
    console.log(JSON.stringify({
      tag: 'AGENT1', venue: vn, event: 'PENDING_WIPE_SKIPPED',
      error_message: pickedExhibitions.error,
    }))
    errors.push({
      item: vn,
      step: 'upsert',
      message: `Stale-pending wipe skipped — editor_picks lookup failed: ${pickedExhibitions.error}`,
    })
    diag.pending_wipe.failed = true
  } else {
    let wipeQuery = db
      .from('exhibitions')
      .delete({ count: 'exact' })
      .eq('venue_id', venue.id)
      .eq('status', 'pending')

    if (pickedExhibitions.ids.length > 0) {
      wipeQuery = wipeQuery.not('id', 'in', `(${pickedExhibitions.ids.join(',')})`)
    }

    const { error: wipeError, count: wipedCount } = await wipeQuery

    if (wipeError) {
      console.error(`[${vn}] Stale-pending wipe FAILED — stale rows will survive this run:`, wipeError.message)
      console.log(JSON.stringify({
        tag: 'AGENT1', venue: vn, event: 'PENDING_WIPE_FAILED',
        error_code: wipeError.code, error_message: wipeError.message,
        details: wipeError.details ?? null,
      }))
      errors.push({
        item: vn,
        step: 'upsert',
        message: `Stale-pending wipe failed (${wipeError.code}): ${wipeError.message}`,
      })
      diag.pending_wipe.failed = true
      diag.pending_wipe.error_code = wipeError.code ?? null
    } else {
      diag.pending_wipe.deleted = wipedCount ?? 0
      console.log(JSON.stringify({
        tag: 'AGENT1', venue: vn, event: 'PENDING_WIPE',
        deleted: wipedCount ?? 0,
      }))
    }
  }

  // ─── Step 2: detail pages ─────────────────────────────────────────────────
  let upsertedCount = 0

  for (const link of linksToProcess) {
    // No section-page check here any more, by URL or by content. Section 3 owns
    // that question now and answers it before a page is ever fetched.
    console.log(`[${vn}] Detail: "${link.title}" — ${link.url}`)

    const detailFetchResult = await fetchDetailPage(link.url)
    let detailHtml = detailFetchResult.html
    let detailMethod = detailFetchResult.method
    const detailSuccess = detailFetchResult.success

    console.log(JSON.stringify({
      tag: 'AGENT1', venue: vn, url: link.url, event: 'DETAIL_FETCH',
      method: detailMethod,
      status: detailSuccess ? 'success' : 'failed',
      html_length: detailHtml.length,
    }))

    if (!detailSuccess) {
      console.error(`[${vn}] Detail fetch failed for "${link.title}"`)
      errors.push({ item: link.title || link.url, step: 'fetch', message: 'Detail page fetch failed' })
      diag.discard_reasons.fetch_failed++
      await logDetailFetch(db, {
        venueId: venue.id, institutionId: venue.institution_id, url: link.url, title: link.title,
        method: detailMethod, htmlLength: detailHtml.length, outcome: 'fetch_failed',
      })
      continue
    }

    diag.shows_fetched++

    let detail = await extractExhibitionDetail(detailHtml, link.url)

    // Some sites (JS-only SPAs like guggenheim.org) return a plain-HTTP response
    // large enough to pass fetchDetailPage's length check, but it's just a
    // noscript shell + JS bundle with none of the real page content — dates and
    // description come back empty not because the show lacks them, but because
    // they only exist in the client-rendered DOM. That signature (a plain-HTTP
    // fetch with nothing dated or descriptive extracted) is worth one Browserbase
    // retry before accepting it as a genuinely dateless show.
    // Title and dates own this retry, and nothing else does. Artists are
    // deliberately not part of the test: institutions label group shows too
    // inconsistently for artist extraction to say anything reliable about whether
    // the page was read properly.
    //
    // Installations are exempt from the DATES half only. An installation page
    // saying "Ongoing" or "On Long-term View" has no dates by design, not because
    // the read failed — four published shows (Camille Norment, Dyani White Hawk,
    // Christopher Myers, Artist Installations) re-extract with a correct title and
    // genuinely no dates, and this gate was discarding all four.
    //
    // Keyed on show_type === 'installation', the same test isInstallation/isOngoing
    // already use further down, so this is that one rule applied earlier rather
    // than a second carve-out with its own idea of what "ongoing" means. A
    // dateless installation still lands in pending there, via start_date and
    // end_date in missing_fields — exempt from being thrown away, not from review.
    //
    // The title half is unchanged: an installation whose title is missing or
    // unverifiable is still discarded like anything else.
    const coreMissing = (d: ExhibitionDetailExtracted) =>
      !d.title?.trim() || (d.show_type !== 'installation' && !d.start_date && !d.end_date)

    if (detailMethod === 'http' && coreMissing(detail)) {
      console.warn(`[${vn}] Plain HTTP detail page had no title/dates — retrying via Browserbase: ${link.url}`)
      const retryFetch = await attemptBrowserbaseDetailFetch(link.url)
      if (retryFetch.success && retryFetch.html.length > detailHtml.length) {
        const retryDetail = await extractExhibitionDetail(retryFetch.html, link.url)
        // Accept the retry whenever it recovered any of the three — a page that
        // now has a description but still no dates is still a better record.
        if (retryDetail.start_date || retryDetail.end_date || retryDetail.description || retryDetail.title?.trim()) {
          detail = retryDetail
          detailHtml = retryFetch.html
          detailMethod = retryFetch.method
        }
      }
    }

    console.log(JSON.stringify({
      tag: 'AGENT1', venue: vn, url: link.url, event: 'EXTRACTION',
      status: detail.title?.trim() ? 'success' : 'failed',
      title_extracted: detail.title ?? null,
      dates_extracted: { start_date: detail.start_date, end_date: detail.end_date, date_notes: detail.date_notes },
      image_url: detail.image_url ?? null,
      description_length: detail.description ? detail.description.length : null,
    }))

    // Still no title, or still no dates at all, after the Browserbase retry above.
    // Both are core: a record with neither a name nor a run is not an exhibition.
    if (coreMissing(detail)) {
      const why = !detail.title?.trim() ? 'no title' : 'no dates'
      console.warn(`[${vn}] Extraction incomplete (${why}) for "${link.title}" — discarding`)
      errors.push({ item: link.title || link.url, step: 'extraction', message: `Detail extraction incomplete: ${why}` })
      diag.discard_reasons.extraction_failed++
      await db.from('agent1_discarded_items').insert({
        institution_id: venue.institution_id ?? null,
        title: detail.title?.trim() || link.title,
        url: link.url,
        content_type: `extraction_incomplete:${why.replace(/\s+/g, '_')}`,
      })
      try {
        appendFileSync('/tmp/scrape-diag.jsonl', JSON.stringify({
          tag: 'AGENT1', venue: vn, url: link.url, event: 'EXTRACTION_FAILED',
          link_title: link.title,
          detail_html_length: detailHtml.length,
          detail_snippet: detailHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300),
        }) + '\n')
      } catch {}
      await logDetailFetch(db, {
        venueId: venue.id, institutionId: venue.institution_id, url: link.url, title: link.title,
        method: detailMethod, htmlLength: detailHtml.length, outcome: 'extraction_failed',
      })
      continue
    }

    diag.shows_extracted++
    // coreMissing above already refused anything without a title; the fallback
    // keeps this honest for the type checker rather than asserting non-null.
    const cleanTitle = (detail.title ?? '').trim()

    // Req #1: Anti-hallucination — title must appear in the page HTML
    let titleConfirmed = titleAppearsInHtml(cleanTitle, detailHtml)
    if (!titleConfirmed) {
      console.warn(`[${vn}] String check failed for "${cleanTitle}" — running Claude verification`)
      titleConfirmed = await verifyTitleInHtml(cleanTitle, detailHtml)
    }

    console.log(JSON.stringify({
      tag: 'AGENT1', venue: vn, url: link.url, event: 'HALLUCINATION_CHECK',
      title: cleanTitle,
      found_in_html: titleConfirmed,
      result: titleConfirmed ? 'passed' : 'rejected',
    }))

    if (!titleConfirmed) {
      console.warn(`[${vn}] hallucination_detected: "${cleanTitle}" — discarding`)
      diag.discard_reasons.hallucination_rejected++
      await logDetailFetch(db, {
        venueId: venue.id, institutionId: venue.institution_id, url: link.url, title: cleanTitle,
        method: detailMethod, htmlLength: detailHtml.length, outcome: 'hallucination_rejected',
      })
      continue
    }

    diag.shows_passed_hallucination++

    // The old "unclear + no artists + no dates" guard is gone. It used artist
    // count as a discard signal, which the rebuilt artist handling explicitly
    // rejects, and its dates half is now covered above — a record with no dates
    // never gets this far.

    // Req #1: Description must appear in page HTML; null it out if it doesn't
    let verifiedDescription = detail.description
    if (verifiedDescription && !descriptionAppearsInHtml(verifiedDescription, detailHtml)) {
      console.warn(`[${vn}] Description not found in HTML for "${cleanTitle}" — nulling`)
      verifiedDescription = null
    }

    // Req #4: Temporal validation — discard past shows, mark far-future as upcoming
    const dateClass = classifyShowByDates(detail.start_date, detail.end_date)

    console.log(JSON.stringify({
      tag: 'AGENT1', venue: vn, url: link.url, event: 'TEMPORAL_VALIDATION',
      start_date: detail.start_date,
      end_date: detail.end_date,
      date_notes: detail.date_notes ?? null,
      // What the listing page said, for comparison — logged only; the classification
      // above is the detail page's dates, unchanged.
      listing_date_hint: link.date_hint,
      result: dateClass === 'past' ? 'discarded_past' : (!detail.start_date && !detail.end_date ? 'missing_dates' : 'kept'),
      reason: `classified as ${dateClass}${dateClass === 'past' ? ` (end: ${detail.end_date})` : ''}`,
    }))

    // Section 3 let this candidate through on purpose: the listing page printed no
    // dates, and that is not evidence a show has closed. This is where that debt is
    // settled. The real page has now been fetched and extracted, and if it has no
    // dates either, nothing anywhere says this is a current show — which is exactly
    // what an archive or listing link looks like. Candidates that did have listing
    // dates are untouched here and still become pending with missing_fields.
    if (link.date_evidence === 'none' && !detail.start_date && !detail.end_date) {
      console.log(JSON.stringify({
        tag: 'AGENT1', venue: vn, url: link.url, event: 'GUARD_FAILED',
        guard: 'no_date_evidence',
        reason: 'no date text on the listing page and no dates on the detail page either',
        title: cleanTitle,
      }))
      diag.discard_reasons.no_date_evidence++
      await db.from('agent1_discarded_items').insert({
        institution_id: venue.institution_id ?? null,
        title: cleanTitle,
        url: link.url,
        content_type: 'no_date_evidence',
      })
      await logDetailFetch(db, {
        venueId: venue.id, institutionId: venue.institution_id, url: link.url, title: cleanTitle,
        method: detailMethod, htmlLength: detailHtml.length,
        outcome: 'no_date_evidence',
      })
      continue
    }

    // Both directions discard now. A show that has closed is over; a show opening
    // more than 90 days out is not yet worth a record. At a 7-day re-scrape
    // cadence a show just past that line gets roughly a dozen more chances to be
    // picked up before it matters, so dropping it now costs nothing and keeps
    // pending review free of shows nobody can visit. This is what removed the
    // held "upcoming" status entirely.
    if (dateClass === 'past' || dateClass === 'upcoming') {
      const which = dateClass === 'past' ? 'past' : 'far-future'
      console.log(`[${vn}] Skipping ${which} show: "${cleanTitle}" (start: ${detail.start_date}, end: ${detail.end_date})`)
      diag.discard_reasons.temporal_discarded++
      await db.from('agent1_discarded_items').insert({
        institution_id: venue.institution_id ?? null,
        title: cleanTitle,
        url: link.url,
        content_type: dateClass === 'past' ? 'temporal_past' : 'temporal_far_future',
      })
      await logDetailFetch(db, {
        venueId: venue.id, institutionId: venue.institution_id, url: link.url, title: cleanTitle,
        method: detailMethod, htmlLength: detailHtml.length,
        outcome: dateClass === 'past' ? 'temporal_discarded_past' : 'temporal_discarded_far_future',
      })
      continue
    }

    diag.shows_passed_temporal++

    // Location re-check against the detail page we just downloaded.
    // filterLinksByLocation ran back at Step 1 on the link's title and URL alone
    // and defaults to NYC when neither names a city — which is how shows at a
    // gallery's London/LA/Paris branch, at its seasonal or off-site space, or at
    // another institution entirely reach this point. This is the first moment the
    // page that actually states the location is in hand, so it is the last honest
    // chance to check. No extra fetch: it reads the HTML already in memory.
    //
    // resolveShowLocation then settles the show's own address: it weighs any
    // street address from the listing page (T1) and this page (check #4) against
    // the page check, and uses the venue address only when neither page gave one.
    const pageLocation = await verifyExhibitionLocation(
      detailHtml,
      cleanTitle,
      vn,
      venue.address ?? null
    )
    const location = await resolveShowLocation({
      listingAddresses: link.addresses,
      detailAddresses: detail.addresses,
      pageCheck: pageLocation,
      venue,
    })

    console.log(JSON.stringify({
      tag: 'AGENT1', venue: vn, url: link.url, event: 'LOCATION_CHECK',
      title: cleanTitle,
      verdict: location.verdict,
      city: location.city,
      page_verdict: pageLocation.verdict,
      source: pageLocation.source,
      evidence: pageLocation.evidence,
      show_locations: location.locations.map((l) => l.address),
      show_location_source: location.source,
      flags: location.flags,
      ...location.trace,
    }))

    if (location.verdict === 'non_nyc') {
      console.warn(`[${vn}] non_nyc_rejected: "${cleanTitle}" is in ${location.city} — discarding`)
      errors.push({
        item: cleanTitle,
        step: 'location',
        message: `Show is in ${location.city ?? 'a non-NYC location'}, not New York`,
      })
      diag.discard_reasons.location_rejected++
      await db.from('agent1_discarded_items').insert({
        institution_id: venue.institution_id ?? null,
        title: cleanTitle,
        url: link.url,
        content_type: `non_nyc:${location.city ?? 'unknown'}`,
      })
      await logDetailFetch(db, {
        venueId: venue.id, institutionId: venue.institution_id, url: link.url, title: cleanTitle,
        method: detailMethod, htmlLength: detailHtml.length,
        outcome: `location_rejected:${location.city ?? 'non_nyc'}`,
      })
      continue
    }

    // Req #5: Image URL validation — discard placeholders, logos, relative URLs
    const validatedImage = validateImageUrl(detail.image_url, link.url)

    // Nothing on the page, but a link offering it. Follow that link ONCE and
    // extract from what it returns. If that page links onward to yet another
    // "press release" — a PDF landing page, a redirect — it is not followed:
    // whatever this one hop yields is the answer, and an empty result leaves the
    // field empty exactly as before.
    //
    // Galleries only. A museum's press material is usually a PDF, which this
    // cannot read, so museums are left out rather than quietly half-served —
    // whether they should get their own PDF handling is still open.
    if (!verifiedDescription && !isMuseum) {
      const prLink = findPressReleaseLink(detailHtml, link.url)
      if (prLink && normalizeDetailUrl(prLink) !== normalizeDetailUrl(link.url)) {
        console.log(JSON.stringify({
          tag: 'AGENT1', venue: vn, url: link.url, event: 'PRESS_RELEASE_HOP', to: prLink,
        }))
        const hop = await attemptBrowserbaseDetailFetch(prLink)
        if (hop.success) {
          const hopDetail = await extractExhibitionDetail(hop.html, prLink)
          // Same hallucination check as the page itself: the text has to be on the
          // page it came from.
          if (hopDetail.description && descriptionAppearsInHtml(hopDetail.description, hop.html)) {
            verifiedDescription = hopDetail.description
          }
        }
      }
    }

    const prCleaned = cleanPressRelease(verifiedDescription)

    // Installations commonly run indefinitely ("on long-term view", "ongoing") —
    // that's their normal state, not missing data, so end_date isn't required for
    // them the way it is for a dated exhibition. start_date is still required for both.
    const isInstallation = detail.show_type === 'installation'
    const isOngoing = isInstallation && !!detail.start_date && !detail.end_date

    // ─── Artists ──────────────────────────────────────────────────────────────
    // Every name is checked against the page, whatever its provenance — nothing
    // skips verification. The decision table itself is in lib/artist-rules.ts;
    // this only supplies the evidence and carries out the verdict.
    const verifiedArtistNames = detail.artists.filter((n) => artistAppearsInHtml(n, detailHtml))
    const groupWarningMuted = await isWarningMuted(venue.id)
    const artistDecision = decideArtists({
      extracted: detail.artists,
      verified: verifiedArtistNames,
      provenance: detail.artists_inferred ? 'inferred' : 'credited',
      venueGroupWarningMuted: groupWarningMuted,
    })

    console.log(JSON.stringify({
      tag: 'AGENT1', venue: vn, url: link.url, event: 'ARTIST_CHECK',
      title: cleanTitle,
      extracted: detail.artists.length,
      verified: verifiedArtistNames.length,
      provenance: detail.artists_inferred ? 'inferred' : 'credited',
      stored: artistDecision.artists.length,
      hide_names: artistDecision.hideNames,
      venue_muted: groupWarningMuted,
      first_large_group: artistDecision.recordGroupWarning,
      pending_reason: artistDecision.pendingReason,
    }))

    const missingFields: string[] = []
    // From resolveShowLocation: 'location_unverified' when nothing places the show
    // (no address, and a gallery with branches elsewhere; or an address no borough
    // can be found for), 'address_error' when the listing page and show page give
    // different addresses, when an extracted address is a corrupted merge, or when
    // an address placed only by its zip meets a page naming another city. Either
    // one holds the show in pending. Several clean addresses are never a flag.
    // 'upcoming' is gone from this list: a far-future show is discarded above and
    // never reaches here, so the flag had no way to be set and nothing to mean.
    missingFields.push(...location.flags)
    if (!detail.start_date) missingFields.push('start_date')
    if (!detail.end_date && !isOngoing) missingFields.push('end_date')
    if (!prCleaned) missingFields.push('press_release')
    if (!validatedImage) missingFields.push('image_url')
    // Artists are not a "missing field" — but an artist result that needs a
    // person's eye holds the show, under its own value rather than borrowing one.
    // 'artist_group_confirm' is the once-per-venue confirmation that hiding a big
    // credited list is right here; 'artist_review' is everything else.
    if (artistDecision.pendingReason) {
      missingFields.push(artistDecision.recordGroupWarning ? 'artist_group_confirm' : 'artist_review')
    }

    // DB constraint only allows 'pending' | 'published'. Every show reaching here
    // is current — past and far-future were both discarded above — so the gate is
    // simply whether anything is missing. Artists are deliberately not in that
    // list: a suppressed-but-stored artist list on a large group show is working
    // as designed, not missing data.
    const status = missingFields.length === 0 ? 'published' : 'pending'

    console.log(`[${vn}] "${cleanTitle}" — ${status}, missing: [${missingFields.join(', ')}]`)

    // ─── Step 3: upsert to Supabase ─────────────────────────────────────────
    // Matched on (venue_id, detail_url) rather than show_title — title is a fresh
    // Claude extraction every scrape and drifts slightly between runs, which
    // previously caused the same real-world show to be inserted twice.
    const normalizedUrl = normalizeDetailUrl(link.url)

    const { data: existingByUrl } = await db
      .from('exhibitions')
      .select('id, status')
      .eq('venue_id', venue.id)
      .eq('detail_url', normalizedUrl)
      .maybeSingle()

    // Legacy rows (pre-migration_v22) have detail_url: null, so the lookup above
    // never matches them — fall back to a case-insensitive title match so those
    // don't get duplicated. This can't rely on the (venue_id, show_title) DB
    // constraint alone: that constraint is case-sensitive text equality, but
    // show_title is a fresh Claude extraction every scrape and its casing can
    // drift run to run, so a differing-case title never trips the constraint
    // and silently inserts a real duplicate instead of erroring.
    const { data: existingByTitle } = existingByUrl
      ? { data: null }
      : await db
          .from('exhibitions')
          .select('id, status')
          .eq('venue_id', venue.id)
          .ilike('show_title', cleanTitle)
          .maybeSingle()

    const existing = existingByUrl ?? existingByTitle

    const payload = {
      venue_id: venue.id,
      detail_url: normalizedUrl,
      show_title: cleanTitle,
      show_type: detail.show_type,
      start_date: detail.start_date,
      end_date: detail.end_date,
      date_notes: detail.date_notes,
      press_release: prCleaned,
      image_url: upgradeImageUrl(validatedImage),
      status,
      is_ongoing: isOngoing,
      missing_fields: missingFields,
      // Display only. The names are still written to exhibition_artists below and
      // are still read by Agent 2's coverage and preread matching.
      hide_artist_names: artistDecision.hideNames,
      preread_type: isMuseum ? 'coverage_only' : 'full',
      // Up to three locations; only the first is geocoded — it's the map pin.
      show_location: location.locations[0]?.address ?? null,
      show_location_latitude: location.locations[0]?.latitude ?? null,
      show_location_longitude: location.locations[0]?.longitude ?? null,
      show_location_neighborhood: location.locations[0]?.neighborhood ?? null,
      show_location_2: location.locations[1]?.address ?? null,
      show_location_3: location.locations[2]?.address ?? null,
      show_location_source: location.source,
    }

    let exhibitionId: string

    if (existing) {
      // Never overwrite admin-approved content — leave published exhibitions intact,
      // except end_date: galleries commonly extend a show's run, and a re-scrape
      // should be able to pick that up. start_date never changes once published,
      // and only a real extracted date (never a blank) may replace end_date.
      //
      // is_ongoing rides along with it. "Ongoing" is a separate flag set at
      // publish time when no closing date was known, and every date formatter
      // reads it BEFORE the dates — so leaving it set means the real end_date
      // lands in the row and is then ignored on screen. Worse, "Closing Soon"
      // reads end_date and ignores the flag, so the same show can sit in that
      // filter while its own card still says Ongoing.
      if ((existing as { id: string; status: string }).status !== 'published') {
        await db.from('exhibitions').update(payload).eq('id', existing.id)
      } else if (detail.end_date) {
        await db.from('exhibitions')
          .update({ end_date: detail.end_date, is_ongoing: false })
          .eq('id', existing.id)
      }
      exhibitionId = existing.id
    } else {
      const { data: inserted, error } = await db
        .from('exhibitions')
        .insert(payload)
        .select('id')
        .single()

      if (error?.code === '23505') {
        // Unique violation — two possible sources: (a) another concurrent run
        // (e.g. cron + manual "scrape now") inserted this exhibition first under
        // the same detail_url, or (b) a pre-existing (venue_id, show_title)
        // constraint on this table (added directly in Supabase, predates
        // detail_url matching) conflicting with a legacy row that has no
        // detail_url yet. Check both before giving up.
        const { data: racedByUrl } = await db
          .from('exhibitions')
          .select('id, status')
          .eq('venue_id', venue.id)
          .eq('detail_url', normalizedUrl)
          .maybeSingle()
        const { data: racedByTitle } = racedByUrl
          ? { data: null }
          : await db
              .from('exhibitions')
              .select('id, status')
              .eq('venue_id', venue.id)
              .ilike('show_title', cleanTitle)
              .maybeSingle()
        const raced = racedByUrl ?? racedByTitle
        if (raced) {
          if ((raced as { id: string; status: string }).status !== 'published') {
            await db.from('exhibitions').update(payload).eq('id', raced.id)
          } else if (detail.end_date) {
            // Same end_date + is_ongoing pairing as the non-raced path above.
            await db.from('exhibitions')
              .update({ end_date: detail.end_date, is_ongoing: false })
              .eq('id', raced.id)
          }
          exhibitionId = raced.id
        } else {
          console.log(JSON.stringify({
            tag: 'AGENT1', venue: vn, url: link.url, event: 'UPSERT_FAILED',
            error_code: error.code, error_message: error.message, error_details: error.details ?? null,
            title: cleanTitle,
          }))
          errors.push({ item: cleanTitle, step: 'upsert', message: `Unresolved unique violation: ${error.message}` })
          diag.discard_reasons.upsert_failed++
          continue
        }
      } else if (error || !inserted) {
        console.log(JSON.stringify({
          tag: 'AGENT1', venue: vn, url: link.url, event: 'UPSERT_FAILED',
          error_code:    error?.code    ?? null,
          error_message: error?.message ?? 'no data returned',
          error_details: error?.details ?? null,
          title: cleanTitle,
        }))
        errors.push({ item: cleanTitle, step: 'upsert', message: error?.message ?? 'Insert returned no data' })
        diag.discard_reasons.upsert_failed++
        await logDetailFetch(db, {
          venueId: venue.id, institutionId: venue.institution_id, url: link.url, title: cleanTitle,
          method: detailMethod, htmlLength: detailHtml.length, outcome: 'upsert_failed',
        })
        continue
      } else {
        exhibitionId = inserted.id
      }
    }

    // Sync artists. The decided set, which is the extracted set unless verification
    // failed — hiding names never means storing fewer of them.
    for (const artistName of artistDecision.artists.slice(0, 20)) {
      if (!artistName?.trim()) continue
      const artistId = await upsertArtist(artistName.trim())
      if (!artistId) continue

      const { count } = await db
        .from('exhibition_artists')
        .select('id', { count: 'exact', head: true })
        .eq('exhibition_id', exhibitionId)
        .eq('artist_id', artistId)

      if ((count ?? 0) === 0) {
        await db.from('exhibition_artists').insert({ exhibition_id: exhibitionId, artist_id: artistId })
      }

      // Only write bio for solo shows — with multiple artists on the page we can't
      // reliably tell which extracted bio text belongs to which artist without risking
      // a misattribution (the same failure mode Agent 2's disambiguation ran into).
      // Never overwrites an existing bio.
      if (detail.artist_bio && detail.artists.length === 1) {
        const { data: artistRow } = await db.from('artists').select('bio').eq('id', artistId).maybeSingle()
        if (!artistRow?.bio?.trim()) {
          await db.from('artists').update({ bio: detail.artist_bio }).eq('id', artistId)
        }
      }
    }

    // Generate prereads / coverage only if not already present
    if (!skipPrereads) {
      const exhibitionRaw: ExhibitionRaw = {
        show_title: cleanTitle,
        // The stored set, so Agent 2 sees exactly what is in exhibition_artists —
        // including on a show whose names are hidden from the public site.
        artists: artistDecision.artists,
        start_date: detail.start_date,
        end_date: detail.end_date,
        description: null,
        press_release: prCleaned,
        image_url: validatedImage,
      }

      if (!isMuseum) {
        const { count: prereadCount } = await db
          .from('prereads')
          .select('id', { count: 'exact', head: true })
          .eq('exhibition_id', exhibitionId)

        if ((prereadCount ?? 0) === 0) {
          try {
            const { prereads, hasShowCoverage } = await generatePrereads({
              ...exhibitionRaw,
              venue_name: venue.name,
              venue_url: venue.exhibitions_url,
              exhibition_id: exhibitionId,
            })
            if (prereads.length > 0) {
              await db.from('prereads').insert(prereads.map((p) => ({ ...p, exhibition_id: exhibitionId })))
            }
            if (!hasShowCoverage && !missingFields.includes('show_coverage')) {
              await db
                .from('exhibitions')
                .update({ missing_fields: [...missingFields, 'show_coverage'] })
                .eq('id', exhibitionId)
            }
          } catch (err) {
            console.error(`[${vn}] Preread generation failed for "${cleanTitle}":`, err)
            errors.push({
              item: cleanTitle,
              step: 'preread',
              message: err instanceof Error ? err.message : String(err),
            })
          }
        }
      } else {
        // Mirrors the gallery gate above exactly: a real row count against
        // prereads, not a "has this ever been classified" flag. Coverage items
        // now live in the same table galleries use (migration_v35) instead of
        // exhibitions.coverage, so this can finally be a count like the gallery
        // side always had, rather than the weaker coverage_type IS NULL check
        // that couldn't tell "ran and found nothing" from "never ran."
        const { count: coverageCount } = await db
          .from('prereads')
          .select('id', { count: 'exact', head: true })
          .eq('exhibition_id', exhibitionId)

        if ((coverageCount ?? 0) === 0) {
          try {
            const { coverage, coverageType } = await generateMuseumCoverage(cleanTitle, venue.name, detail.artists, exhibitionId)
            // coverage_type (the Type A/B/C-small/C-large/D classification tier)
            // still lives on the exhibition row — only the per-item array moves.
            await db.from('exhibitions').update({ coverage_type: coverageType }).eq('id', exhibitionId)
            if (coverage.length > 0) {
              await db.from('prereads').insert(
                coverage.map((c) => coverageItemToPrereadRow(exhibitionId, c))
              )
              await crossLinkCoverageToReadings(exhibitionId, coverage)
            }
          } catch (err) {
            console.error(`[${vn}] Museum coverage generation failed for "${cleanTitle}":`, err)
            errors.push({
              item: cleanTitle,
              step: 'coverage',
              message: err instanceof Error ? err.message : String(err),
            })
          }
        }
      }
    }

    const upsertResult = existing
      ? (existing as { id: string; status: string }).status === 'published' ? 'skipped_published' : 'updated'
      : 'inserted'

    console.log(JSON.stringify({
      tag: 'AGENT1', venue: vn, url: link.url, event: 'UPSERT',
      result: upsertResult,
      exhibition_id: exhibitionId,
      status,
      missing_fields: missingFields,
    }))

    await logDetailFetch(db, {
      venueId: venue.id, institutionId: venue.institution_id, url: link.url, title: cleanTitle,
      method: detailMethod, htmlLength: detailHtml.length,
      outcome: `${upsertResult}:${status}${missingFields.length ? `:missing[${missingFields.join(',')}]` : ''}`,
      exhibitionId,
    })

    upsertedCount++
  }

  await db
    .from('venues')
    .update({ check_back_date: nextScheduledScrapeDate(venue.scrape_day_of_week ?? null, new Date()), scrape_failed: false, manual_entry_required: false, scrape_failure_reason: null })
    .eq('id', venue.id)

  const totalDiscarded = (diag.shows_found_on_listing - diag.shows_after_classification)
    + Object.values(diag.discard_reasons).reduce((a, b) => a + b, 0)

  const completeEntry = {
    tag: 'AGENT1', venue: vn, event: 'SCRAPE_COMPLETE',
    shows_found_on_listing: diag.shows_found_on_listing,
    shows_after_classification: diag.shows_after_classification,
    shows_after_guards: diag.shows_after_guards,
    shows_fetched: diag.shows_fetched,
    shows_extracted: diag.shows_extracted,
    shows_passed_hallucination: diag.shows_passed_hallucination,
    shows_passed_temporal: diag.shows_passed_temporal,
    shows_upserted: upsertedCount,
    shows_discarded: totalDiscarded,
    discard_reasons: diag.discard_reasons,
    location_ladder: diag.location_ladder,
    pending_wipe: diag.pending_wipe,
  }

  console.log(JSON.stringify(completeEntry))
  try { appendFileSync('/tmp/scrape-diag.jsonl', JSON.stringify(completeEntry) + '\n') } catch {}

  console.log(`[${vn}] Done: ${upsertedCount}/${linksToProcess.length} processed`)
  return { upserted: upsertedCount, failureReason: null }
}

// ─── Institution queries ──────────────────────────────────────────────────────

const VENUE_SELECT =
  'id, name, exhibitions_url, active, address, neighborhood, latitude, longitude, check_back_date, scrape_failed, manual_entry_required, scrape_failure_reason, scrape_notes, scrapable, location_window_size, scrape_day_of_week, scrape_status, scrape_status_changed_at, scrape_failures, institutions!inner(id, type, is_multi_city)'

function normalizeVenueRow(v: Record<string, unknown>): VenueRecord {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const institution = (v.institutions as any) ?? null
  return {
    id: v.id as string,
    name: v.name as string,
    exhibitions_url: v.exhibitions_url as string,
    type: (institution?.type ?? 'gallery') as VenueRecord['type'],
    active: v.active as boolean,
    institution_id: institution?.id ?? undefined,
    address: (v.address as string | null) ?? null,
    neighborhood: (v.neighborhood as string | null) ?? null,
    latitude: (v.latitude as number | null) ?? null,
    longitude: (v.longitude as number | null) ?? null,
    check_back_date: (v.check_back_date as string | null) ?? null,
    scrape_failed: (v.scrape_failed as boolean | null) ?? false,
    manual_entry_required: (v.manual_entry_required as boolean | null) ?? false,
    scrape_failure_reason: (v.scrape_failure_reason as string | null) ?? null,
    scrape_notes: (v.scrape_notes as string | null) ?? null,
    scrapable: (v.scrapable as boolean | null) ?? true,
    is_multi_city: institution?.is_multi_city === true,
    location_window_size: (v.location_window_size as number | null) ?? null,
    scrape_day_of_week: (v.scrape_day_of_week as number | null) ?? null,
    scrape_status: (v.scrape_status as ScrapeStatus | null) ?? 'not_started',
    scrape_status_changed_at: (v.scrape_status_changed_at as string | null) ?? null,
    scrape_failures: (v.scrape_failures as number | null) ?? 0,
  }
}

// Looks up a single venue regardless of manual_entry_required — used by the
// admin per-venue retry, which must be able to target flagged venues too.
export async function getVenueById(id: string): Promise<VenueRecord | null> {
  const { data } = await getSupabaseAdmin()
    .from('venues')
    .select(VENUE_SELECT)
    .eq('id', id)
    .eq('active', true)
    .maybeSingle()

  return data ? normalizeVenueRow(data as Record<string, unknown>) : null
}

// Venues flagged manual_entry_required are excluded from automated scrape runs,
// as are venues a human has marked scrapable=false. Those two flags mean
// different things and are checked separately on purpose: the scraper clears
// manual_entry_required on any successful scrape, so a human decision stored
// there would be undone the first time the venue happened to work.
export async function getActiveInstitutions(): Promise<VenueRecord[]> {
  const { data } = await getSupabaseAdmin()
    .from('venues')
    .select(VENUE_SELECT)
    .eq('active', true)
    .eq('manual_entry_required', false)
    .eq('scrapable', true)
    .order('check_back_date', { ascending: true, nullsFirst: true })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data ?? []).map((v: any) => normalizeVenueRow(v))
}

// The venues the 15-minute queue should scrape right now: today's scheduled
// venues oldest-checked-first, then retries that have served their cooldown.
// Rules in decideQueueEligibility. error3 sets manual_entry_required, so those
// venues drop out at the query along with every other flagged venue.
export async function getScrapeQueue(now: Date): Promise<{ eligible: VenueRecord[]; unassignedDay: number }> {
  const { data, error } = await getSupabaseAdmin()
    .from('venues')
    .select(VENUE_SELECT)
    .eq('active', true)
    .eq('manual_entry_required', false)
    .eq('scrapable', true)
    .order('check_back_date', { ascending: true, nullsFirst: true })

  // Thrown rather than read as an empty queue: a silent empty result is what a
  // missing migration looks like, and it would stop all scraping unnoticed.
  if (error) throw new Error(`Scrape queue query failed: ${error.message}`)

  const scheduled: VenueRecord[] = []
  const retries: VenueRecord[] = []
  let unassignedDay = 0

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const venue of (data ?? []).map((v: any) => normalizeVenueRow(v))) {
    const decision = decideQueueEligibility({
      scrape_day_of_week: venue.scrape_day_of_week ?? null,
      check_back_date: venue.check_back_date ?? null,
      scrape_status: venue.scrape_status ?? 'not_started',
      scrape_status_changed_at: venue.scrape_status_changed_at ?? null,
      scrape_failures: venue.scrape_failures ?? 0,
    }, now)

    if (decision.eligible) (decision.reason === 'retry' ? retries : scheduled).push(venue)
    else if (decision.reason === 'no_day_assigned') unassignedDay++
  }

  return { eligible: [...scheduled, ...retries], unassignedDay }
}

// Also returns venues marked scrapable=false, which have no "issue" as such —
// but this tab is the only place they can be seen or un-marked, and a venue that
// silently vanished from every list would be worse than one listed as skipped.
export async function getScrapeIssueVenues(): Promise<VenueRecord[]> {
  const { data } = await getSupabaseAdmin()
    .from('venues')
    .select(VENUE_SELECT)
    .eq('active', true)
    .or('scrape_failed.eq.true,manual_entry_required.eq.true,scrapable.eq.false')
    .order('name')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data ?? []).map((v: any) => normalizeVenueRow(v))
}

// Kept for the existing /api/admin/venues route
export async function getScrapedFailedInstitutions(): Promise<VenueRecord[]> {
  const { data } = await getSupabaseAdmin()
    .from('venues')
    .select(VENUE_SELECT)
    .eq('active', true)
    .eq('scrape_failed', true)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data ?? []).map((v: any) => normalizeVenueRow(v))
}

// ─── Single venue attempt ───────────────────────────────────────────────────
// Scrape one claimed venue, then record its duration and resulting status
// whatever happened. Shared by the queue and the admin's single-venue trigger.
export async function runVenueScrapeAttempt(
  venue: VenueRecord,
  claim: ScrapeClaim,
  errors: AgentRunError[]
): Promise<VenueScrapeOutcome> {
  let result: ScrapeInstitutionResult
  try {
    result = await scrapeInstitution(venue, false, errors)
  } catch (err) {
    console.error(`Error scraping ${venue.name}:`, err)
    errors.push({ item: venue.name, step: 'fetch', message: err instanceof Error ? err.message : String(err) })
    result = { upserted: 0, failureReason: 'exception' }
  }
  return finishVenueScrape(claim, result)
}

// ─── Agent 1 queue run ──────────────────────────────────────────────────────
export interface RunAgent1Options {
  /**
   * Wall-clock this call may spend on venues, from its start. A venue only
   * starts if its estimated duration still fits (hasTimeFor), so the real
   * ceiling is this budget plus how far that estimate undershoots.
   */
  budgetMs: number
}

/**
 * One 15-minute tick of Agent 1. Returns null, without recording an agent_runs
 * row, when nothing is due — which is most ticks of any day.
 *
 * "Items" are venue attempts. A venue-level failure (unreachable, blocked, no
 * links) counts as failed; per-show problems stay in the errors array.
 */
export async function runAgent1(opts: RunAgent1Options): Promise<AgentRunResult | null> {
  const startedAt = Date.now()

  // Before building the queue, so a venue a killed invocation left in_progress
  // moves into its error cooldown instead of staying blocked.
  const staleRecovered = await sweepStaleClaims()
  const { eligible, unassignedDay } = await getScrapeQueue(new Date())

  if (unassignedDay > 0) {
    console.warn(`Agent 1: ${unassignedDay} venue(s) have no scrape_day_of_week and are never queued — run scripts/backfill-scrape-day-of-week.mjs`)
  }
  if (eligible.length === 0) return null

  const runId = await startAgentRun('agent1')
  const errors: AgentRunError[] = []
  let attempted = 0
  let succeeded = 0
  let skippedAtClaim = 0
  let totalUpserted = 0
  let stoppedForTime: Record<string, unknown> | null = null

  try {
    const history = await loadAttemptHistory(eligible.map((v) => v.id))

    for (const venue of eligible) {
      const elapsedMs = Date.now() - startedAt
      const { estimateMs, basis } = estimateVenueScrapeMs(history.get(venue.id) ?? [])

      if (!hasTimeFor(elapsedMs, estimateMs, opts.budgetMs, attempted === 0)) {
        stoppedForTime = { next_venue: venue.name, elapsed_ms: elapsedMs, estimate_ms: estimateMs, estimate_basis: basis }
        console.log(`Agent 1 stopping: ${venue.name} needs ~${Math.round(estimateMs / 1000)}s (${basis}), ${Math.round((opts.budgetMs - elapsedMs) / 1000)}s left`)
        break
      }

      // The claim re-checks eligibility on a fresh read; losing it means another
      // invocation or the admin trigger has this venue.
      const claimed = await claimVenueScrape(venue.id, { mode: 'queue', trigger: 'cron', agentRunId: runId })
      if (!claimed.ok) {
        skippedAtClaim++
        console.log(`Agent 1 skipping ${venue.name}: ${claimed.reason}${claimed.detail ? ` (${claimed.detail})` : ''}`)
        continue
      }

      attempted++
      const outcome = await runVenueScrapeAttempt(venue, claimed.claim, errors)
      totalUpserted += outcome.upserted
      if (outcome.failureReason === null) succeeded++
      console.log(`Agent 1 ${venue.name}: ${outcome.status ?? 'state changed elsewhere'} in ${Math.round(outcome.durationMs / 1000)}s (estimated ${Math.round(estimateMs / 1000)}s, ${basis})`)
    }

    const result: AgentRunResult = {
      itemsProcessed: attempted,
      itemsSucceeded: succeeded,
      itemsFailed: attempted - succeeded,
      errors,
      summary: {
        venues_scraped: succeeded,
        total_exhibitions_upserted: totalUpserted,
        remaining: eligible.length - attempted - skippedAtClaim,
        skipped_at_claim: skippedAtClaim,
        stopped_for_time: stoppedForTime,
        stale_claims_recovered: staleRecovered,
        venues_without_day: unassignedDay,
      },
    }
    await finishAgentRun(runId, result)
    return result
  } catch (err) {
    await failAgentRun(runId, err instanceof Error ? err.message : String(err))
    throw err
  }
}
