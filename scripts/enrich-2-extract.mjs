#!/usr/bin/env node
/**
 * Enrichment phase 2 — read every gallery's own site for locations and status.
 *
 * Input : seed-data/artforum-nyc-galleries-seed.csv  (664 Artguide rows)
 *         seed-data/enrich-majors-resolved.json      (95 majors Artguide omits)
 * Output: seed-data/enriched-nyc-galleries.csv       (for review — no DB writes)
 *         seed-data/enriched-nyc-galleries.raw.json  (per-gallery evidence)
 *
 *     node scripts/enrich-2-extract.mjs
 *
 * FETCH LADDER, cheapest first
 *   1. homepage over plain HTTP                                    free
 *   2. /contact, /locations, /visit, /about, /info if that is thin  free
 *   3. Browserbase, 25 concurrent, only if both are still thin      ~1 min each
 * Measured on a 30-gallery sample: step 2 rescues roughly 40% of thin homepages,
 * which is what keeps the browser count near 195 rather than 320.
 *
 * Progress is checkpointed after every gallery. A crash or an expired session
 * costs the remaining galleries, not the completed ones — the Artguide scrape
 * lost six minutes of work that way.
 *
 * STATUS is deliberately conservative. "closed" requires the page to say the
 * gallery has permanently closed. A site that is merely unreachable is
 * "unclear", never "closed": in the earlier probe a naive reading of HTTP status
 * would have marked Hauser & Wirth closed on a 429 from my own concurrency, and
 * Lisson closed on a bot-block 403.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import Anthropic from '@anthropic-ai/sdk'
import Browserbase from '@browserbasehq/sdk'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CSV_IN = resolve(ROOT, 'seed-data/artforum-nyc-galleries-seed.csv')
const MAJORS_IN = resolve(ROOT, 'seed-data/enrich-majors-resolved.json')
const CKPT = resolve(ROOT, 'seed-data/.enrich-checkpoint.json')
const OUT_CSV = resolve(ROOT, 'seed-data/enriched-nyc-galleries.csv')
const OUT_RAW = resolve(ROOT, 'seed-data/enriched-nyc-galleries.raw.json')
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

const env = Object.fromEntries(
  readFileSync(resolve(ROOT, '.env.local'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
)
const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })

const THIN = 1500
const SUBPAGES = ['/contact', '/contact-us', '/locations', '/visit', '/about', '/info']
const HTTP_CONC = 20
const BB_CONC = 12

function parseCsv(t) {
  const rows = []; let f = '', row = [], q = false
  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++ } else q = false } else f += c }
    else if (c === '"') q = true
    else if (c === ',') { row.push(f); f = '' }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = '' }
    else if (c !== '\r') f += c
  }
  if (f || row.length) { row.push(f); rows.push(row) }
  return rows
}
const csvEscape = (v) => {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim()

// ─── Build the work list ──────────────────────────────────────────────────────
const artguide = parseCsv(readFileSync(CSV_IN, 'utf8')).slice(1).filter((r) => r.length > 1)
  .map((r) => ({ name: r[0], artguide_address: r[1], website: r[2], source: 'artguide' }))
const majors = JSON.parse(readFileSync(MAJORS_IN, 'utf8')).filter((m) => m.verified)
  .map((m) => ({ name: m.name, artguide_address: '', website: m.website, source: 'major-added' }))

// Artguide lists one row per location using a "Name | Location" convention, so
// several rows share a website. Fetch each site once and fan the result back out.
const work = [...artguide, ...majors]
const byWebsite = new Map()
for (const w of work) {
  const key = (w.website || `~${w.name}`).replace(/\/$/, '').toLowerCase()
  if (!byWebsite.has(key)) byWebsite.set(key, [])
  byWebsite.get(key).push(w)
}
const sites = [...byWebsite.entries()].map(([key, members]) => ({ key, website: members[0].website, members }))
console.log(`${work.length} rows (${artguide.length} Artguide + ${majors.length} majors) across ${sites.length} distinct sites`)

const checkpoint = existsSync(CKPT) ? JSON.parse(readFileSync(CKPT, 'utf8')) : {}
console.log(`checkpoint holds ${Object.keys(checkpoint).length} already-processed sites`)

// ─── Step 1+2: plain HTTP, homepage then subpages ─────────────────────────────
async function httpText(url, timeout = 15000) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(timeout) })
    if (!res.ok) return { text: '', http: res.status, finalUrl: res.url }
    return { text: strip(await res.text()), http: res.status, finalUrl: res.url }
  } catch (e) {
    return { text: '', http: 0, err: String(e?.name === 'TimeoutError' ? 'timeout' : e?.message ?? e).slice(0, 80) }
  }
}

async function fetchPlain(site) {
  if (!site.website) return { text: '', method: 'no-website', http: null }
  const home = await httpText(site.website)
  let best = home.text, via = 'homepage'
  if (best.length < THIN) {
    for (const p of SUBPAGES) {
      let url
      try { url = new URL(p, site.website).href } catch { continue }
      const r = await httpText(url, 10000)
      if (r.text.length > best.length) { best = r.text; via = p }
      if (best.length >= THIN) break
    }
  }
  return { text: best, method: best.length >= THIN ? `http:${via}` : 'thin', http: home.http, err: home.err }
}

// ─── Step 3: Browserbase for what plain HTTP could not render ────────────────
async function fetchBrowser(sites) {
  if (sites.length === 0) return
  console.log(`\nBrowserbase pass: ${sites.length} sites, ${BB_CONC} concurrent`)
  const bb = new Browserbase({ apiKey: env.BROWSERBASE_API_KEY })
  let idx = 0, done = 0
  await Promise.all(Array.from({ length: BB_CONC }, async () => {
    while (idx < sites.length) {
      const site = sites[idx++]
      let browser
      try {
        const session = await bb.sessions.create({ projectId: env.BROWSERBASE_PROJECT_ID, timeout: 300 })
        browser = await puppeteerConnect(session.connectUrl)
        const page = (await browser.pages())[0] ?? (await browser.newPage())
        await page.goto(site.website, { waitUntil: 'domcontentloaded', timeout: 30000 })
        await page.waitForNetworkIdle({ idleTime: 900, timeout: 8000 }).catch(() => {})
        let text = strip(await page.content())
        if (text.length < THIN) {
          for (const p of ['/contact', '/locations', '/visit']) {
            try {
              await page.goto(new URL(p, site.website).href, { waitUntil: 'domcontentloaded', timeout: 20000 })
              await page.waitForNetworkIdle({ idleTime: 700, timeout: 6000 }).catch(() => {})
              const t = strip(await page.content())
              if (t.length > text.length) text = t
              if (text.length >= THIN) break
            } catch { /* next subpage */ }
          }
        }
        site.text = text
        site.method = 'browserbase'
      } catch (e) {
        site.text = site.text ?? ''
        site.method = 'browserbase-failed'
        site.err = String(e?.message ?? e).slice(0, 80)
      } finally {
        await browser?.close().catch(() => {})
      }
      done++
      if (done % 20 === 0) console.log(`  browser ${done}/${sites.length}`)
    }
  }))
}
let _pptr
async function puppeteerConnect(ws) {
  _pptr ??= (await import('puppeteer')).default
  return _pptr.connect({ browserWSEndpoint: ws })
}

// ─── Extraction ───────────────────────────────────────────────────────────────
const PROMPT = `You are reading an art gallery's website to build a directory of its physical spaces.

Return ONLY JSON:
{ "status": "open" | "closed" | "unclear",
  "closed_evidence": string | null,
  "locations": [ { "label": string | null, "address": string, "city": string } ] }

Rules:
- locations: every physical gallery space listed on this page, worldwide. Copy each address EXACTLY as printed and give its city. Include every branch, not just the first.
- Only addresses actually printed in the text below. Never recall or infer a location you expect this gallery to have.
- status "closed" ONLY if the text states the gallery has permanently closed or ceased operations, and quote that sentence in closed_evidence. An exhibition closing, applications closing, seasonal hours, or "by appointment" are NOT closure.
- If the page carries no address and no closure statement, status is "unclear" and locations is [].

Page content:
`

async function extract(text) {
  const r = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 900,
    messages: [{ role: 'user', content: PROMPT + text.slice(0, 24000) }],
  })
  const body = r.content.find((b) => b.type === 'text')?.text ?? ''
  const m = body.match(/\{[\s\S]*\}/)
  if (!m) return { status: 'unclear', closed_evidence: null, locations: [], tokens: r.usage }
  try {
    const p = JSON.parse(m[0])
    return {
      status: ['open', 'closed', 'unclear'].includes(p.status) ? p.status : 'unclear',
      closed_evidence: typeof p.closed_evidence === 'string' ? p.closed_evidence.slice(0, 300) : null,
      locations: Array.isArray(p.locations) ? p.locations.filter((l) => l && typeof l.address === 'string') : [],
      tokens: r.usage,
    }
  } catch {
    return { status: 'unclear', closed_evidence: null, locations: [], tokens: r.usage }
  }
}

// ─── Run ──────────────────────────────────────────────────────────────────────
const todo = sites.filter((s) => !checkpoint[s.key])
console.log(`fetching ${todo.length} sites over plain HTTP (${HTTP_CONC} concurrent)`)
let n = 0
await Promise.all(Array.from({ length: HTTP_CONC }, async () => {
  while (n < todo.length) {
    const s = todo[n++]
    const r = await fetchPlain(s)
    s.text = r.text; s.method = r.method; s.http = r.http; s.err = r.err
    if (n % 100 === 0) console.log(`  http ${n}/${todo.length}`)
  }
}))

const needBrowser = todo.filter((s) => s.website && (s.text?.length ?? 0) < THIN)
console.log(`plain HTTP resolved ${todo.length - needBrowser.length}/${todo.length}; ${needBrowser.length} need a browser`)
await fetchBrowser(needBrowser)

let inTok = 0, outTok = 0, extracted = 0
for (const s of todo) {
  if (!s.text || s.text.length < 200) {
    checkpoint[s.key] = { status: 'unclear', closed_evidence: null, locations: [], method: s.method ?? 'unreachable', http: s.http ?? null, err: s.err ?? null, chars: s.text?.length ?? 0 }
  } else {
    const e = await extract(s.text)
    inTok += e.tokens?.input_tokens ?? 0
    outTok += e.tokens?.output_tokens ?? 0
    checkpoint[s.key] = { status: e.status, closed_evidence: e.closed_evidence, locations: e.locations, method: s.method, http: s.http ?? null, err: null, chars: s.text.length }
    extracted++
  }
  if (extracted % 25 === 0) writeFileSync(CKPT, JSON.stringify(checkpoint))
}
writeFileSync(CKPT, JSON.stringify(checkpoint))
console.log(`\nextracted ${extracted} sites · tokens in ${inTok} out ${outTok}`)

// ─── Emit ─────────────────────────────────────────────────────────────────────
const NYC = /\b(new york|nyc|manhattan|brooklyn|queens|bronx|staten island|long island city|lic)\b/i
const today = new Date().toISOString().split('T')[0]
const rows = []
for (const site of sites) {
  const res = checkpoint[site.key] ?? { status: 'unclear', locations: [], method: 'skipped' }
  const nycLocs = (res.locations ?? []).filter((l) => NYC.test(`${l.city ?? ''} ${l.address ?? ''}`))
  const base = site.members[0]
  const instName = base.name.split('|')[0].trim()
  if (nycLocs.length > 0) {
    for (const l of nycLocs) {
      rows.push({
        name: instName, location_label: l.label ?? '', address: l.address, city: l.city ?? 'New York',
        website: site.website ?? '', status: res.status, closed_evidence: res.closed_evidence ?? '',
        source: base.source, artguide_address: base.artguide_address ?? '', method: res.method, extracted_date: today,
      })
    }
  } else {
    // No location found on the site — keep Artguide's address rather than losing
    // the row, and let status carry the uncertainty.
    for (const m of site.members) {
      rows.push({
        name: m.name.split('|')[0].trim(), location_label: (m.name.split('|')[1] ?? '').trim(),
        address: m.artguide_address ?? '', city: 'New York', website: site.website ?? '',
        status: res.status, closed_evidence: res.closed_evidence ?? '', source: m.source,
        artguide_address: m.artguide_address ?? '', method: res.method, extracted_date: today,
      })
    }
  }
}

// Same institution + same address twice adds nothing.
const seen = new Set()
const deduped = rows.filter((r) => {
  const k = `${r.name}|${r.address}`.toLowerCase().replace(/\s+/g, ' ')
  if (seen.has(k)) return false
  seen.add(k); return true
}).sort((a, b) => a.name.localeCompare(b.name) || a.address.localeCompare(b.address))

const header = ['name', 'location_label', 'address', 'city', 'website', 'status', 'closed_evidence', 'source', 'artguide_address', 'method', 'extracted_date']
writeFileSync(OUT_CSV, [header.join(','), ...deduped.map((r) => header.map((h) => csvEscape(r[h])).join(','))].join('\n') + '\n')
writeFileSync(OUT_RAW, JSON.stringify(deduped, null, 1))

const by = (k) => deduped.reduce((a, r) => ((a[r[k]] = (a[r[k]] ?? 0) + 1), a), {})
console.log(`\nwrote ${deduped.length} rows -> ${OUT_CSV}`)
console.log('status :', JSON.stringify(by('status')))
console.log('source :', JSON.stringify(by('source')))
console.log('closed with evidence:', deduped.filter((r) => r.status === 'closed').length)
console.log('institutions with 2+ NYC locations:',
  Object.values(deduped.reduce((a, r) => ((a[r.name] = (a[r.name] ?? 0) + 1), a), {})).filter((n) => n > 1).length)
