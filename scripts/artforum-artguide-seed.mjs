#!/usr/bin/env node
/**
 * ONE-TIME seed extraction — Artforum Artguide, New York galleries.
 *
 * Renders the Artguide listing through Browserbase and writes a CSV for manual
 * review. It is not wired into any cron, not exposed as an admin action, and
 * writes nothing to the database. Re-run it by hand if the list needs
 * refreshing:
 *
 *     node scripts/artforum-artguide-seed.mjs
 *
 * WHY BROWSERBASE
 * A plain fetch of this URL returns site chrome only — the listing is entirely
 * client-rendered.
 *
 * WHY CONTINUOUS HARVESTING
 * The list is virtualized: nodes are recycled as you scroll, so the number of
 * .guide-venue elements present at any moment is a window, not a total. Counting
 * at the end returns ~10 for a list of hundreds. Entries are therefore collected
 * after every scroll step and accumulated in a Map keyed by the venue's own
 * detail URL, which is stable across re-renders.
 *
 * ANTI-HALLUCINATION
 * There is none to apply, because no model is involved. Every field is read
 * directly from a DOM text node, so each value is literally present on the page
 * by construction — a stronger guarantee than asking a model and checking after.
 * The raw innerText of each entry is captured alongside the parsed fields so any
 * row can be audited against what the page actually said.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import Browserbase from '@browserbasehq/sdk'
import puppeteer from 'puppeteer'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_URL = 'https://artguide.artforum.com/artguide/place/new-york?category=galleries&show=all'
const OUT_PATH = resolve(ROOT, process.env.OUT ?? 'seed-data/artforum-nyc-galleries-seed.csv')
// A virtualized list can drop entries that mount and unmount between harvests.
// Lowering SCROLL_FACTOR narrows each jump and re-runs as a completeness check.
const SCROLL_FACTOR = Number(process.env.SCROLL_FACTOR ?? 2)
const SCROLL_WAIT = Number(process.env.SCROLL_WAIT ?? 250)

const env = Object.fromEntries(
  readFileSync(resolve(ROOT, '.env.local'), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
)

function csvEscape(v) {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

async function main() {
  const bb = new Browserbase({ apiKey: env.BROWSERBASE_API_KEY })
  // A full pass takes several minutes; the default session timeout expired
  // mid-run at 220 galleries on the first attempt.
  const session = await bb.sessions.create({
    projectId: env.BROWSERBASE_PROJECT_ID,
    timeout: 3600,
  })
  console.log('Browserbase session:', session.id)
  const browser = await puppeteer.connect({ browserWSEndpoint: session.connectUrl })
  const pages = await browser.pages()
  const page = pages[0] ?? (await browser.newPage())

  const found = new Map()
  let partial = false

  // Reads whatever entries are currently mounted. Called after every scroll step.
  const harvest = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('article.guide-venue')).map((el) => {
        const link = el.querySelector('.guide-venue__location h2 a')
        const addrEl = el.querySelector('.guide-venue__location__data__address')
        // The website sits beside the address as an external link. Mail links and
        // the venue's own Artguide page are excluded so they cannot be mistaken
        // for one.
        const site = Array.from(el.querySelectorAll('.guide-venue__location__data a[target="_blank"]')).find((a) => {
          const h = a.getAttribute('href') ?? ''
          return h.startsWith('http') && !h.includes('artguide.artforum.com') && !h.startsWith('mailto:')
        })
        const clean = (t) => (t ?? '').replace(/\s+/g, ' ').trim()
        return {
          key: link?.getAttribute('href') ?? clean(el.querySelector('h2')?.textContent) ?? '',
          name: clean(link?.textContent) || clean(el.querySelector('h2')?.textContent),
          address: clean(addrEl?.textContent),
          website: clean(site?.getAttribute('href')),
          raw: (el.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
        }
      })
    )

  // Harvest and scroll position in one round-trip — at ~1500 rounds the second
  // evaluate per round costs minutes.
  const harvestAndPosition = () =>
    page.evaluate(() => {
      const clean = (t) => (t ?? '').replace(/\s+/g, ' ').trim()
      const entries = Array.from(document.querySelectorAll('article.guide-venue')).map((el) => {
        const link = el.querySelector('.guide-venue__location h2 a')
        const addrEl = el.querySelector('.guide-venue__location__data__address')
        const site = Array.from(el.querySelectorAll('.guide-venue__location__data a[target="_blank"]')).find((a) => {
          const h = a.getAttribute('href') ?? ''
          return h.startsWith('http') && !h.includes('artguide.artforum.com') && !h.startsWith('mailto:')
        })
        return {
          key: link?.getAttribute('href') ?? clean(el.querySelector('h2')?.textContent),
          name: clean(link?.textContent) || clean(el.querySelector('h2')?.textContent),
          address: clean(addrEl?.textContent),
          website: clean(site?.getAttribute('href')),
          raw: clean(el.innerText).slice(0, 300),
        }
      })
      return {
        entries,
        atBottom: window.innerHeight + window.scrollY >= document.body.scrollHeight - 200,
      }
    })

  try {
    console.log('Loading', SOURCE_URL)
    await page.goto(SOURCE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForNetworkIdle({ idleTime: 2500, timeout: 30000 }).catch(() => {})
    await new Promise((r) => setTimeout(r, 3000))

    // No "load more" control exists on this page — confirmed by inspection — so
    // scrolling is the only way to advance. Kept as a check in case that changes.
    const loadMore = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('button, a, [role="button"]')).find((e) =>
        /load more|show more|view all/i.test(e.textContent?.trim() ?? '')
      )
      return el ? el.textContent.trim() : null
    })
    console.log('load-more control:', loadMore ?? 'none (scroll-driven)')

    for (const e of await harvest()) if (e.key) found.set(e.key, e)

    // The cap is a runaway guard, not an expected exit. Hitting it means the
    // list was still growing, so the result is incomplete — the first run stopped
    // at 400 rounds with 502 galleries and climbing, and reported success.
    const MAX_ROUNDS = 2500
    let stableRounds = 0
    let round = 0
    let atBottom = false
    while (stableRounds < 6 && round < MAX_ROUNDS) {
      const before = found.size
      await page.evaluate((f) => window.scrollBy(0, window.innerHeight * f), SCROLL_FACTOR)
      await new Promise((r) => setTimeout(r, SCROLL_WAIT))
      const step = await harvestAndPosition()
      for (const e of step.entries) if (e.key) found.set(e.key, e)
      atBottom = step.atBottom

      // Stability only counts once the page cannot scroll further — otherwise a
      // slow-loading stretch reads as the end of the list.
      if (found.size === before && atBottom) stableRounds++
      else stableRounds = 0

      round++
      if (round % 40 === 0) console.log(`  round ${round}: ${found.size} galleries, atBottom=${atBottom}`)
    }
    if (round >= MAX_ROUNDS) {
      console.error(`\nHit the ${MAX_ROUNDS}-round cap with the list still growing — result is INCOMPLETE.`)
      partial = true
    }
    console.log(`Finished after ${round} scroll rounds — ${found.size} galleries${partial ? ' (INCOMPLETE)' : ''}`)
  } catch (err) {
    console.error(`\nScroll loop ended early (${err.message?.slice(0, 80)}) — writing what was collected.`)
    partial = true
  } finally {
    await browser.close().catch(() => {})
  }

  const today = new Date().toISOString().split('T')[0]
  const rows = [...found.values()].sort((a, b) => a.name.localeCompare(b.name))

  const header = ['name', 'address', 'website', 'source_url', 'extracted_date']
  const csv = [
    header.join(','),
    ...rows.map((r) => [r.name, r.address, r.website, SOURCE_URL, today].map(csvEscape).join(',')),
  ].join('\n')

  mkdirSync(dirname(OUT_PATH), { recursive: true })
  writeFileSync(OUT_PATH, csv + '\n')
  writeFileSync(OUT_PATH.replace(/\.csv$/, '.raw.json'), JSON.stringify(rows, null, 1))

  // Rows worth a second look before onboarding.
  const noAddress = rows.filter((r) => !r.address)
  const noWebsite = rows.filter((r) => !r.website)
  const oddName = rows.filter((r) => r.name.length < 3 || /[…]|\.\.\.$/.test(r.name))

  console.log(`\nWrote ${rows.length} rows -> ${OUT_PATH}${partial ? '  (PARTIAL — session ended early, re-run to complete)' : ''}`)
  console.log(`  missing address : ${noAddress.length}`)
  console.log(`  missing website : ${noWebsite.length}`)
  console.log(`  suspicious name : ${oddName.length}`)
  for (const r of noAddress.slice(0, 20)) console.log(`    [no address] ${r.name}`)
  for (const r of oddName.slice(0, 20)) console.log(`    [odd name]   "${r.name}"`)
}

main().catch((err) => {
  console.error('Extraction failed:', err)
  process.exit(1)
})
