import Browserbase from '@browserbasehq/sdk'
import { appendFileSync, writeFileSync } from 'fs'
import { getSupabaseAdmin } from './supabase'
import {
  extractExhibitionLinks,
  extractExhibitionDetail,
  filterLinksByLocation,
  verifyTitleInHtml,
  generatePrereads,
  classifyExhibitionUrls,
} from './claude'
import { geocodeVenueIfNeeded } from './geocoding'
import type { VenueRecord, ExhibitionRaw } from './types'

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

const CONTACT_BOILERPLATE = /inquir|please\s+(reach\s+out|contact)|for\s+more\s+information|press\s+(office|contact|release\s+contact)|media\s+contact|rsvp|@[a-z0-9.-]+\.[a-z]{2,}/i

function cleanPressRelease(text: string | null): string | null {
  if (!text) return null
  const paragraphs = text.split(/\n{2,}/)
  while (paragraphs.length > 0 && CONTACT_BOILERPLATE.test(paragraphs[paragraphs.length - 1])) {
    paragraphs.pop()
  }
  const cleaned = paragraphs.join('\n\n').trim()
  return cleaned || null
}

// ─── Validation helpers (Req #1, #3, #4, #5) ─────────────────────────────────

// Req #3: URL-level section page check — runs before any Browserbase session.
const SECTION_TERMINAL_SEGMENTS = new Set([
  'exhibitions', 'current', 'upcoming', 'past', 'on-view', 'on-going',
  'now-on-view', 'collection', 'programs', 'archive', 'view-all',
])

function isSectionPageUrl(url: string): boolean {
  try {
    const lastSegment = new URL(url).pathname.replace(/\/$/, '').split('/').pop()?.toLowerCase() ?? ''
    return SECTION_TERMINAL_SEGMENTS.has(lastSegment)
  } catch {
    return false
  }
}

// Req #3: HTML-level section page check — runs after Browserbase fetch.
const SECTION_TITLE_RE = /\b(current\s+)?exhibitions?\s*[-–|:·]\s*(current|past|upcoming|on.?view|all)\b|\ball\s+exhibitions?\b|on\s+view\s*[-–|:·]\s*\w|current\s+exhibitions?\s*$/i

// Generic H1 words that appear on listing/section pages — case-insensitive via regex flag
const SECTION_H1_RE = /^(exhibitions?|galleries|gallery|current|on\s*view|upcoming|past|programs?|collection|all\s+shows?|archive|visit|about|news|events?|calendar)$/i

// Short articles/prepositions that should be skipped when picking the institution
// name word to match against H1 (e.g. "El Museo del Barrio" → use "museo", not "el")
const SHORT_WORDS = new Set(['el', 'la', 'le', 'de', 'du', 'the', 'new', 'a', 'an'])

function isSectionPageHtml(html: string, venueName?: string): boolean {
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i)
  const pageTitle = titleMatch?.[1] ?? ''
  if (SECTION_TITLE_RE.test(pageTitle)) return true

  // Positive signal: a single non-generic H1 strongly indicates a detail page.
  // If H1 is a real show title (not a generic section word, not the institution name)
  // we short-circuit and return false regardless of cross-link count.
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
  if (h1Match) {
    const h1Text = h1Match[1].replace(/<[^>]+>/g, '').trim()

    // Pick the first meaningful word from the institution name, skipping short articles
    // e.g. "El Museo del Barrio" → "museo", "The Met" → "met", "New Museum" → "museum"
    const words = (venueName ?? '').toLowerCase().split(/\s+/).filter(Boolean)
    const venueWord = words.find((w) => w.length >= 4 && !SHORT_WORDS.has(w)) ?? words[0] ?? ''

    // Match is case-insensitive (venueWord already lowercased, h1Text also lowercased)
    const matchesVenueName = venueWord.length > 2 && h1Text.toLowerCase().includes(venueWord)

    if (h1Text.length > 3 && !SECTION_H1_RE.test(h1Text) && !matchesVenueName) {
      return false
    }
  }

  // Count UNIQUE exhibition cross-links — repeated nav/footer links inflate the count
  const matches = html.match(/href="[^"]*\/(exhibitions?|shows?|on-view)\//g) ?? []
  const unique = new Set(matches)
  return unique.size >= 25
}

// Req #1: Fast string check for title presence — avoids Claude call when possible.
function titleAppearsInHtml(title: string, html: string): boolean {
  const decoded = html
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&ndash;/g, '–').replace(/&mdash;/g, '—')
    .replace(/&rsquo;/g, '’').replace(/&lsquo;/g, '‘')
    .replace(/&rdquo;/g, '”').replace(/&ldquo;/g, '“')
    .replace(/&hellip;/g, '…')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()

  const norm = title.toLowerCase().replace(/\s+/g, ' ').trim()
  if (decoded.includes(norm)) return true
  // Partial match for long titles
  if (norm.length > 25 && decoded.includes(norm.slice(0, 25))) return true
  return false
}

// Req #1: Fast string check for description presence.
function descriptionAppearsInHtml(description: string, html: string): boolean {
  const decoded = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').toLowerCase()
  const sample = description.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80)
  return sample.length > 0 && decoded.includes(sample)
}

// Req #5: Image URL validation — discards placeholders, logos, and relative URLs.
const IMAGE_DISCARD_RE = /placeholder|default[^/]*\.(jpe?g|png|webp|gif|svg)|\/logo[^/]*\.(jpe?g|png|webp|svg)|\/icon[^/]*\.(jpe?g|png|webp|svg)|avatar|blank|spacer/i

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

// Detects bot-protection walls that make the page useless for link extraction.
// Checks content signals in addition to size — MoMA returned 29K but was still blocked.
// Returns the signal name that fired, or null if no bot wall is detected.
function detectBotWall(html: string): string | null {
  // If the page has exhibition links, it rendered successfully — not a bot wall.
  // This prevents false positives on CF-protected sites that we successfully render
  // via Browserbase (CF injects ray IDs, scripts, etc. into legitimately-served pages).
  const hasExhibitLinks = /<a[^>]+href=["'][^"']*exhibit/i.test(html)
  if (hasExhibitLinks) return null

  // Hard signals: structural markers that only appear on challenge/block pages,
  // not in ordinary HTML that Cloudflare serves through successfully.
  // Note: /ray\s+id/ is intentionally excluded — it appears in normal CF-served HTML.
  const hardSignals: Array<[RegExp, string]> = [
    [/cf-browser-verification/i,   'cf-browser-verification'],
    [/challenge-form/i,            'challenge-form'],
    [/<title[^>]*>[^<]*just\s+a\s+moment[^<]*<\/title>/i, 'cf-just-a-moment'],
    [/<title[^>]*>[^<]*attention\s+required[^<]*<\/title>/i, 'attention-required'],
    [/verifying\s+you\s+are\s+human/i, 'verifying-human'],
    [/checking\s+your\s+browser/i,     'checking-browser'],
    [/ddos\s+protection\s+by/i,        'ddos-protection'],
    [/too\s+many\s+requests/i,         'too-many-requests'],
  ]

  for (const [re, label] of hardSignals) {
    if (re.test(html)) return label
  }

  return null
}

// Scans the FULL raw listing-page HTML for exhibition-like hrefs.
// FIX 3 CONFIRMED: this function receives `listingHtml` — the complete HTML string
// returned by fetchListingPage — NOT the 60K-sliced version used by extractExhibitionLinks.
// Slicing only happens inside extractExhibitionLinks (in claude.ts). This scan is
// therefore unaffected by the slice window and will find links anywhere in the page.
function scanExhibitionHrefs(html: string, venueUrl: string): string[] {
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

    // Skip terminal section segments
    const lastSegment = pathname.split('/').pop()?.toLowerCase() ?? ''
    if (SECTION_TERMINAL_SEGMENTS.has(lastSegment)) continue

    // Must be at least two path segments deep (not just the homepage)
    if (pathname.split('/').filter(Boolean).length < 2) continue

    // The URL must look like an individual show page — path contains an exhibition-like word
    if (!/(exhibition|show|display|on-view|exhibit)/.test(pathname.toLowerCase())) continue

    results.push(absolute)
  }

  return results
}

// Broader fallback scan: same as scanExhibitionHrefs but WITHOUT the exhibition-keyword
// pathname filter. Used when scanExhibitionHrefs returns 0 — passes all candidate URLs
// to classifyExhibitionUrls (Claude Haiku) for semantic classification.
function scanAllHrefs(html: string, venueUrl: string): string[] {
  const base = (() => { try { return new URL(venueUrl).origin } catch { return '' } })()
  const selfPathname = (() => { try { return new URL(venueUrl).pathname.replace(/\/$/, '') } catch { return '' } })()

  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])
  const seen = new Set<string>()
  const results: string[] = []

  for (const href of hrefs) {
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) continue
    let absolute: string
    try { absolute = href.startsWith('http') ? href : new URL(href, base).href } catch { continue }
    if (base && !absolute.startsWith(base)) continue
    if (seen.has(absolute)) continue
    seen.add(absolute)
    let pathname: string
    try { pathname = new URL(absolute).pathname.replace(/\/$/, '') } catch { continue }
    if (pathname === selfPathname) continue
    if (selfPathname && selfPathname.startsWith(pathname + '/') && pathname.length > 1) continue
    const lastSegment = pathname.split('/').pop()?.toLowerCase() ?? ''
    if (SECTION_TERMINAL_SEGMENTS.has(lastSegment)) continue
    if (pathname.split('/').filter(Boolean).length < 2) continue
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
      if (res.ok) {
        const html = await res.text()
        if (html.length > 3000) return { html, success: true, method: 'http_fallback' }
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

  // Fallback: Browserbase (JS-rendered sites)
  let browser: Awaited<ReturnType<typeof createBrowserSession>>['browser'] | null = null
  try {
    const session = await createBrowserSession()
    browser = session.browser
    const page = session.page

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })

    // Wait for network to go idle (no requests for 500ms) OR 8s max.
    // Gives React/Next.js/Wix sites time to populate the DOM after initial load.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (page as any).waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => {})

    // Expand hidden content panels (press releases, descriptions, etc.)
    await page.evaluate(() => {
      const re = /read more|full description|press release|view more|show more|expand/i
      document.querySelectorAll('button, a, [role="button"], details summary').forEach((el) => {
        if (re.test(el.textContent?.trim() ?? '')) (el as HTMLElement).click()
      })
    })

    let html = await page.content()

    // Sparsity check: measure visible text AFTER stripping scripts/styles so that
    // JS-bundle content doesn't mask an empty DOM (Next.js SSR pattern where
    // content lives in <script> until React hydrates into actual DOM elements).
    const strippedForCheck = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
    const visibleTextLen = strippedForCheck.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().length
    if (visibleTextLen < 500) {
      console.log(JSON.stringify({
        tag: 'AGENT1', url, event: 'SPARSE_CONTENT',
        html_length: html.length,
        visible_text_after_strip: visibleTextLen,
      }))
      // React hydration is CPU-bound — wait for h1 to appear (up to 8s), then re-capture.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (page as any).waitForSelector('h1, [class*="title"], [class*="heading"]', { timeout: 8000 }).catch(() => {})
      await new Promise((r) => setTimeout(r, 500))
      html = await page.content()
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

const DETAIL_SESSION_CAP = 15

export async function scrapeInstitution(venue: VenueRecord, skipPrereads = false): Promise<number> {
  const vn = venue.name
  console.log(`[${vn}] Starting scrape — ${venue.exhibitions_url}`)
  const db = getSupabaseAdmin()
  const isMuseum = venue.type === 'museum'

  // Diagnostic counters for SCRAPE_COMPLETE summary
  const diag = {
    shows_found_on_listing: 0,
    shows_after_classification: 0,
    shows_after_guards: 0,
    shows_fetched: 0,
    shows_extracted: 0,
    shows_passed_hallucination: 0,
    shows_passed_temporal: 0,
    discard_reasons: {
      guard_failed: 0,
      fetch_failed: 0,
      extraction_failed: 0,
      hallucination_rejected: 0,
      temporal_discarded: 0,
      upsert_failed: 0,
    },
  }

  await geocodeVenueIfNeeded(venue.id, venue.address ?? null, venue.latitude, venue.longitude)

  // ─── Step 1: listing page ─────────────────────────────────────────────────
  let { html: listingHtml, success: listingSuccess, method: listingMethod } =
    await fetchListingPage(venue.exhibitions_url)

  // Retry with a longer timeout when the first attempt fails or returns suspiciously small HTML
  // (< 10K on success = likely a bot-protection redirect page)
  const likelBotWall = listingSuccess && listingHtml.length < 10000
  if (!listingSuccess || likelBotWall) {
    console.warn(`[${vn}] First listing fetch ${likelBotWall ? 'returned tiny HTML' : 'failed'} — retrying with 60s timeout`)
    const retry = await fetchListingPage(venue.exhibitions_url, 60000)
    if (retry.success && (!likelBotWall || retry.html.length > listingHtml.length)) {
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

  if (!listingSuccess) {
    console.error(`[${vn}] Listing page fetch failed after retry — marking scrape_failed + manual_entry_required`)
    await db.from('venues').update({
      scrape_failed: true,
      manual_entry_required: true,
      scrape_failure_reason: 'fetch_failed',
    }).eq('id', venue.id)
    return 0
  }

  // Bot-wall detection: check for known bot-protection signals regardless of HTML size.
  // Size alone is insufficient — MoMA returned 29K but was still bot-blocked.
  const botWallSignal = detectBotWall(listingHtml)
  if (botWallSignal) {
    console.log(JSON.stringify({
      tag: 'AGENT1', venue: vn, event: 'BOT_WALL_DETECTED',
      html_size: listingHtml.length, signal: botWallSignal,
    }))
    await db.from('venues').update({
      scrape_failed: true,
      manual_entry_required: true,
      scrape_failure_reason: 'bot_protected',
    }).eq('id', venue.id)
    return 0
  }

  // Still too small after retry and no specific bot signal → flag anyway
  if (listingHtml.length < 10000) {
    console.warn(`[${vn}] Listing HTML too small after retry (${listingHtml.length}B) — likely bot protection`)
    await db.from('venues').update({
      scrape_failed: true,
      manual_entry_required: true,
      scrape_failure_reason: 'bot_protected',
    }).eq('id', venue.id)
    return 0
  }

  let allLinks = await extractExhibitionLinks(listingHtml, vn, venue.exhibitions_url)

  // Fallback tier 1: if extractExhibitionLinks found nothing, scan full HTML for exhibition hrefs.
  // Recovers venues where content is past the 60K slice window.
  if (allLinks.length === 0) {
    console.warn(`[${vn}] extractExhibitionLinks returned 0 — trying exhibition href scan`)
    const candidateUrls = scanExhibitionHrefs(listingHtml, venue.exhibitions_url)
    console.log(JSON.stringify({
      tag: 'AGENT1', venue: vn, event: 'HREF_SCAN_FALLBACK',
      candidates_found: candidateUrls.length,
      candidates: candidateUrls.slice(0, 20),
    }))
    if (candidateUrls.length > 0) {
      allLinks = await classifyExhibitionUrls(candidateUrls.slice(0, 60), vn, venue.exhibitions_url)
    }
  }

  // Fallback tier 2: broader scan without exhibition-keyword URL filter + Haiku classification.
  // Covers SPAs (Wix, Squarespace) where show URLs don't contain "exhibition" in the path.
  if (allLinks.length === 0) {
    console.warn(`[${vn}] exhibition href scan returned 0 — trying broad href scan + Haiku classification`)
    const broadCandidates = scanAllHrefs(listingHtml, venue.exhibitions_url)
    console.log(JSON.stringify({
      tag: 'AGENT1', venue: vn, event: 'BROAD_HREF_SCAN',
      candidates_found: broadCandidates.length,
    }))
    if (broadCandidates.length > 0) {
      allLinks = await classifyExhibitionUrls(broadCandidates.slice(0, 80), vn, venue.exhibitions_url)
    }
  }

  // After all attempts: if still 0 links, flag for manual entry
  if (allLinks.length === 0) {
    console.warn(`[${vn}] No links after href scan — flagging manual_entry_required`)
    await db.from('venues').update({
      scrape_failed: true,
      manual_entry_required: true,
      scrape_failure_reason: 'zero_links_after_retry',
    }).eq('id', venue.id)
    return 0
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
  }))

  console.log(`[${vn}] Listing: ${allLinks.length} links → ${currentLinks.length} current/upcoming`)

  if (currentLinks.length === 0) {
    console.log(`[${vn}] No current shows — updating check_back_date`)
    await db.from('venues').update({ check_back_date: sevenDaysFromNow(), scrape_failed: false }).eq('id', venue.id)
    console.log(JSON.stringify({
      tag: 'AGENT1', venue: vn, event: 'SCRAPE_COMPLETE',
      shows_found_on_listing: diag.shows_found_on_listing,
      shows_after_classification: diag.shows_after_classification,
      shows_after_guards: 0, shows_fetched: 0, shows_extracted: 0,
      shows_passed_hallucination: 0, shows_passed_temporal: 0, shows_upserted: 0,
      shows_discarded: diag.shows_found_on_listing,
      discard_reasons: diag.discard_reasons,
    }))
    return 0
  }

  // Req #2: Location filter — remove shows at fairs, partner venues, other cities
  const nycLinks = await filterLinksByLocation(currentLinks, vn)
  console.log(`[${vn}] After location filter: ${nycLinks.length}/${currentLinks.length} links`)

  // Log each link dropped by the location filter
  for (const link of currentLinks) {
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
  const guardedLinks = selfPathname
    ? nycLinks.filter((link) => {
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
    : nycLinks

  diag.shows_after_guards = guardedLinks.length

  console.log(JSON.stringify({
    tag: 'AGENT1', venue: vn, event: 'AFTER_GUARDS',
    links_remaining: guardedLinks.length,
    links: guardedLinks.map((l) => l.url),
  }))

  if (guardedLinks.length === 0) {
    console.warn(`[${vn}] No current links remain after location + self-referential filtering`)
    await db.from('venues').update({ check_back_date: sevenDaysFromNow(), scrape_failed: false }).eq('id', venue.id)
    const totalDiscarded = diag.shows_found_on_listing
    console.log(JSON.stringify({
      tag: 'AGENT1', venue: vn, event: 'SCRAPE_COMPLETE',
      shows_found_on_listing: diag.shows_found_on_listing,
      shows_after_classification: diag.shows_after_classification,
      shows_after_guards: 0, shows_fetched: 0, shows_extracted: 0,
      shows_passed_hallucination: 0, shows_passed_temporal: 0, shows_upserted: 0,
      shows_discarded: totalDiscarded,
      discard_reasons: diag.discard_reasons,
    }))
    return 0
  }

  if (guardedLinks.length > DETAIL_SESSION_CAP) {
    console.warn(`[${vn}] Capping at ${DETAIL_SESSION_CAP} (found ${guardedLinks.length})`)
  }
  const linksToProcess = guardedLinks.slice(0, DETAIL_SESSION_CAP)

  // Wipe stale pending entries for this venue before inserting fresh ones.
  // Published and upcoming exhibitions are intentionally left untouched.
  await db.from('exhibitions').delete().eq('venue_id', venue.id).eq('status', 'pending')

  // ─── Step 2: detail pages ─────────────────────────────────────────────────
  let upsertedCount = 0

  for (const link of linksToProcess) {
    // Req #3: URL-level section page check (free — no Browserbase session needed)
    if (isSectionPageUrl(link.url)) {
      console.log(`[${vn}] Skipping section page URL: ${link.url}`)
      console.log(JSON.stringify({
        tag: 'AGENT1', venue: vn, url: link.url, event: 'GUARD_FAILED',
        guard: 'isSectionPageUrl',
        reason: 'URL last segment matches section terminal list',
      }))
      diag.discard_reasons.guard_failed++
      continue
    }

    console.log(`[${vn}] Detail: "${link.title}" — ${link.url}`)

    const { html: detailHtml, success: detailSuccess, method: detailMethod } = await fetchDetailPage(link.url)

    console.log(JSON.stringify({
      tag: 'AGENT1', venue: vn, url: link.url, event: 'DETAIL_FETCH',
      method: detailMethod,
      status: detailSuccess ? 'success' : 'failed',
      html_length: detailHtml.length,
    }))

    if (!detailSuccess) {
      console.error(`[${vn}] Detail fetch failed for "${link.title}"`)
      diag.discard_reasons.fetch_failed++
      continue
    }

    diag.shows_fetched++

    // Req #3: HTML-level section page check
    if (isSectionPageHtml(detailHtml, vn)) {
      console.log(`[${vn}] section_page_skipped: ${link.url}`)
      console.log(JSON.stringify({
        tag: 'AGENT1', venue: vn, url: link.url, event: 'GUARD_FAILED',
        guard: 'isSectionPageUrl',
        reason: 'HTML-level section page detected',
      }))
      diag.discard_reasons.guard_failed++
      continue
    }

    const detail = await extractExhibitionDetail(detailHtml, link.url)

    console.log(JSON.stringify({
      tag: 'AGENT1', venue: vn, url: link.url, event: 'EXTRACTION',
      status: detail.title?.trim() ? 'success' : 'failed',
      title_extracted: detail.title ?? null,
      dates_extracted: { start_date: detail.start_date, end_date: detail.end_date, date_notes: detail.date_notes },
      image_url: detail.image_url ?? null,
      description_length: detail.description ? detail.description.length : null,
    }))

    if (!detail.title?.trim()) {
      console.warn(`[${vn}] No title extracted for "${link.title}" — skipping`)
      diag.discard_reasons.extraction_failed++
      try {
        appendFileSync('/tmp/scrape-diag.jsonl', JSON.stringify({
          tag: 'AGENT1', venue: vn, url: link.url, event: 'EXTRACTION_FAILED',
          link_title: link.title,
          detail_html_length: detailHtml.length,
          detail_snippet: detailHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300),
        }) + '\n')
      } catch {}
      continue
    }

    diag.shows_extracted++
    const cleanTitle = detail.title.trim()

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
      continue
    }

    diag.shows_passed_hallucination++

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
      result: dateClass === 'past' ? 'discarded_past' : (!detail.start_date && !detail.end_date ? 'missing_dates' : 'kept'),
      reason: `classified as ${dateClass}${dateClass === 'past' ? ` (end: ${detail.end_date})` : ''}`,
    }))

    if (dateClass === 'past') {
      console.log(`[${vn}] Skipping past show: "${cleanTitle}" (end: ${detail.end_date})`)
      diag.discard_reasons.temporal_discarded++
      continue
    }

    diag.shows_passed_temporal++

    // Req #5: Image URL validation — discard placeholders, logos, relative URLs
    const validatedImage = validateImageUrl(detail.image_url, link.url)

    const prCleaned = cleanPressRelease(verifiedDescription)

    const missingFields: string[] = []
    if (dateClass === 'upcoming') missingFields.push('upcoming')
    if (!detail.start_date) missingFields.push('start_date')
    if (!detail.end_date) missingFields.push('end_date')
    if (!prCleaned) missingFields.push('press_release')
    if (!validatedImage) missingFields.push('image_url')

    // DB constraint only allows 'pending' | 'published'.
    // Upcoming shows go to pending with 'upcoming' in missingFields so the admin
    // can distinguish them. Only fully-complete current shows auto-publish.
    const isUpcoming = dateClass === 'upcoming'
    const status = (!isUpcoming && missingFields.length === 0) ? 'published' : 'pending'

    console.log(`[${vn}] "${cleanTitle}" — ${status}, missing: [${missingFields.join(', ')}]`)

    // ─── Step 3: upsert to Supabase ─────────────────────────────────────────
    const { data: existing } = await db
      .from('exhibitions')
      .select('id, status')
      .eq('venue_id', venue.id)
      .ilike('show_title', cleanTitle)
      .maybeSingle()

    const payload = {
      venue_id: venue.id,
      show_title: cleanTitle,
      start_date: detail.start_date,
      end_date: detail.end_date,
      date_notes: detail.date_notes,
      press_release: prCleaned,
      image_url: upgradeImageUrl(validatedImage),
      status,
      missing_fields: missingFields,
      preread_type: isMuseum ? 'coverage_only' : 'full',
    }

    let exhibitionId: string

    if (existing) {
      // Never overwrite admin-approved content — leave published exhibitions intact.
      if ((existing as { id: string; status: string }).status !== 'published') {
        await db.from('exhibitions').update(payload).eq('id', existing.id)
      }
      exhibitionId = existing.id
    } else {
      const { data: inserted, error } = await db
        .from('exhibitions')
        .insert(payload)
        .select('id')
        .single()

      if (error || !inserted) {
        console.log(JSON.stringify({
          tag: 'AGENT1', venue: vn, url: link.url, event: 'UPSERT_FAILED',
          error_code:    error?.code    ?? null,
          error_message: error?.message ?? 'no data returned',
          error_details: error?.details ?? null,
          title: cleanTitle,
        }))
        diag.discard_reasons.upsert_failed++
        continue
      }
      exhibitionId = inserted.id
    }

    // Sync artists
    for (const artistName of detail.artists.slice(0, 20)) {
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
    }

    // Generate prereads / coverage only if not already present
    if (!skipPrereads) {
      const exhibitionRaw: ExhibitionRaw = {
        show_title: cleanTitle,
        artists: detail.artists,
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
          const { prereads, hasShowCoverage } = await generatePrereads({
            ...exhibitionRaw,
            venue_name: venue.name,
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

    upsertedCount++
  }

  await db
    .from('venues')
    .update({ check_back_date: sevenDaysFromNow(), scrape_failed: false })
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
  }

  console.log(JSON.stringify(completeEntry))
  try { appendFileSync('/tmp/scrape-diag.jsonl', JSON.stringify(completeEntry) + '\n') } catch {}

  console.log(`[${vn}] Done: ${upsertedCount}/${linksToProcess.length} processed`)
  return upsertedCount
}

function sevenDaysFromNow(): string {
  const d = new Date()
  d.setDate(d.getDate() + 7)
  return d.toISOString().split('T')[0]
}

// ─── Institution queries ──────────────────────────────────────────────────────

const VENUE_SELECT =
  'id, name, exhibitions_url, active, address, latitude, longitude, check_back_date, scrape_failed, manual_entry_required, scrape_failure_reason, institutions!inner(id, type)'

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
    latitude: (v.latitude as number | null) ?? null,
    longitude: (v.longitude as number | null) ?? null,
    check_back_date: (v.check_back_date as string | null) ?? null,
    scrape_failed: (v.scrape_failed as boolean | null) ?? false,
    manual_entry_required: (v.manual_entry_required as boolean | null) ?? false,
    scrape_failure_reason: (v.scrape_failure_reason as string | null) ?? null,
  }
}

// Venues flagged manual_entry_required are excluded from automated scrape runs
export async function getActiveInstitutions(): Promise<VenueRecord[]> {
  const { data } = await getSupabaseAdmin()
    .from('venues')
    .select(VENUE_SELECT)
    .eq('active', true)
    .eq('manual_entry_required', false)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data ?? []).map((v: any) => normalizeVenueRow(v))
}

export async function getInstitutionsDueForRefresh(): Promise<VenueRecord[]> {
  const today = new Date().toISOString().split('T')[0]

  const { data } = await getSupabaseAdmin()
    .from('venues')
    .select(VENUE_SELECT)
    .eq('active', true)
    .eq('manual_entry_required', false)
    .or(`check_back_date.is.null,check_back_date.lte.${today}`)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data ?? []).map((v: any) => normalizeVenueRow(v))
}

export async function getScrapeIssueVenues(): Promise<VenueRecord[]> {
  const { data } = await getSupabaseAdmin()
    .from('venues')
    .select(VENUE_SELECT)
    .eq('active', true)
    .or('scrape_failed.eq.true,manual_entry_required.eq.true')
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
