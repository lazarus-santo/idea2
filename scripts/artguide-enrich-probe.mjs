#!/usr/bin/env node
/**
 * ONE-TIME enrichment probe for the Artguide seed list.
 *
 * Fetches every gallery's own website once and derives three things from that
 * single request, so the list is enriched and pruned from one pass rather than
 * three:
 *
 *   liveness  — dead, parked or erroring domains, the strongest cheap signal
 *               that a gallery has shut down
 *   closure   — explicit "permanently closed" / "has closed" language on the page
 *   addresses — every NYC-looking street address on the page, which surfaces the
 *               locations Artguide lists only one of
 *
 * Plain HTTP only, heavily parallel. No Browserbase: at 600+ sites a browser
 * session each would be absurd, and this pass is a triage step whose job is to
 * decide which handful of galleries deserve closer inspection.
 *
 *     node scripts/artguide-enrich-probe.mjs
 *
 * Writes seed-data/artguide-enrichment-probe.json. Changes nothing else.
 */
import { readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IN_PATH = resolve(ROOT, 'seed-data/artforum-nyc-galleries-seed.csv')
const OUT_PATH = resolve(ROOT, 'seed-data/artguide-enrichment-probe.json')
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const CONCURRENCY = 24

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

const CLOSURE_RE = /\b(permanently closed|has permanently closed|gallery (?:has )?closed|now closed|ceased operations|closed its doors|final exhibition|we have closed|no longer (?:in )?operat)/i
// Street addresses as galleries write them, plus the borough/state tail that
// distinguishes an NYC address from a London or LA one on the same page.
const ADDR_RE = /\b\d{1,4}\s+(?:[A-Z][A-Za-z.'-]+\s+){0,4}(?:East |West |E\.? |W\.? )?\d{0,3}(?:st|nd|rd|th)?\s*(?:Street|St\.?|Avenue|Ave\.?|Broadway|Place|Pl\.?|Road|Rd\.?|Lane|Boulevard|Blvd\.?|Parkway|Drive)\b[^,\n]{0,30}/g
const NYC_HINT = /\b(New York|NY|NYC|Manhattan|Brooklyn|Queens|Bronx|Chelsea|Tribeca|SoHo|Lower East Side|Upper East Side|Harlem|Bushwick|Greenpoint|Williamsburg)\b/i

function stripHtml(h) {
  return h.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ').trim()
}

async function probe(row) {
  const [name, address, website] = row
  const out = { name, artguide_address: address, website, status: null, http: null, closure_hint: null, addresses: [], note: null }
  if (!website) { out.status = 'no-website'; return out }
  try {
    const res = await fetch(website, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(15000) })
    out.http = res.status
    out.final_url = res.url
    const html = await res.text()
    const text = stripHtml(html)

    if (!res.ok) { out.status = 'http-error'; return out }
    if (text.length < 200) { out.status = 'empty-page'; return out }

    // Parked / for-sale domains are the clearest sign a gallery is gone.
    if (/this domain (is|may be) for sale|buy this domain|domain (?:name )?parked|GoDaddy|Sedo|Namecheap parking/i.test(text) && text.length < 3000) {
      out.status = 'parked'; return out
    }

    const closure = text.match(CLOSURE_RE)
    if (closure) out.closure_hint = text.slice(Math.max(0, text.indexOf(closure[0]) - 90), text.indexOf(closure[0]) + 130)

    // Only keep addresses whose surrounding text looks like New York, so a
    // gallery's London or Paris space is not mistaken for another NYC location.
    const seen = new Set()
    for (const m of text.matchAll(ADDR_RE)) {
      const at = m.index ?? 0
      const ctx = text.slice(Math.max(0, at - 60), at + m[0].length + 90)
      if (!NYC_HINT.test(ctx)) continue
      const a = m[0].replace(/\s+/g, ' ').trim()
      const k = a.toLowerCase()
      if (seen.has(k) || a.length < 8) continue
      seen.add(k); out.addresses.push(a)
      if (out.addresses.length >= 8) break
    }
    out.status = closure ? 'closure-language' : 'ok'
  } catch (err) {
    out.status = 'unreachable'
    out.note = String(err?.name === 'TimeoutError' ? 'timeout' : err?.message ?? err).slice(0, 90)
  }
  return out
}

const rows = parseCsv(readFileSync(IN_PATH, 'utf8')).slice(1).filter((r) => r.length > 1)
console.log(`probing ${rows.length} gallery websites, concurrency ${CONCURRENCY}`)

const results = []
let i = 0
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (i < rows.length) {
    const idx = i++
    results[idx] = await probe(rows[idx])
    if (results.filter(Boolean).length % 100 === 0) console.log(`  ${results.filter(Boolean).length}/${rows.length}`)
  }
}))

writeFileSync(OUT_PATH, JSON.stringify(results, null, 1))

const by = {}
for (const r of results) by[r.status] = (by[r.status] ?? 0) + 1
console.log('\nstatus counts:', JSON.stringify(by, null, 1))
console.log('with closure language :', results.filter((r) => r.closure_hint).length)
console.log('with 2+ NYC addresses :', results.filter((r) => r.addresses.length > 1).length)
console.log(`\nwrote ${OUT_PATH}`)
