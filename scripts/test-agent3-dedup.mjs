/**
 * Agent 3 skips what it has already seen — migration_v69.
 *
 *   node --import ./scripts/ts-resolve.mjs scripts/test-agent3-dedup.mjs [path/to/curator.ts]
 *
 * Runs the REAL curateReadings() from lib/readings-curator.ts, several times in
 * a row, with every network call it makes answered in memory: the RSS feeds,
 * Supabase's REST API, Anthropic, and anything else (og:image scrapes, Voyage).
 * It touches NO database, calls NO model and needs no .env.local — it counts
 * the Haiku calls instead of making them.
 *
 * The fake database behaves like Supabase where it matters here: a response
 * holds at most 1,000 rows. It is seeded with 1,500 readings, and the
 * already-saved article sits past row 1,000, which is exactly where the old
 * load-every-link check stopped seeing. Pass HEAD's curator as the argument to
 * watch the old code fail the same checks.
 *
 * What it proves:
 *   1. an already-saved article is skipped without calling Haiku, even past
 *      the 1,000-row mark
 *   2. an article Haiku turns down is remembered and skipped next run
 *   3. a show roundup excluded for having no NYC angle is remembered too
 *   4. a relevance call that FAILS remembers nothing — its article is tried
 *      again, never mistaken for a "no"
 *   5. with readings_rejected missing (migration not applied), the run still
 *      works as before and reports the lookup as a run error
 *   6. the same article in two feeds is only sent once
 */

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://fake-supabase.test'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role'
process.env.ANTHROPIC_API_KEY = 'fake-anthropic'
process.env.VOYAGE_API_KEY = 'fake-voyage'

// ── Fixtures ────────────────────────────────────────────────────────────────

const now = new Date().toUTCString()
const A = 'https://outlet.test/already-saved'
const B = 'https://outlet.test/good-review'
const C = 'https://outlet.test/kitchen-gallery'
const D = 'https://outlet.test/london-roundup'
const E = 'https://outlet.test/unlucky'

// Haiku's fake rule: an article is about art only if its title says [art].
const FEED_1 = [
  [A, 'Already saved: museum show [art]'],
  [B, 'A painting exhibition worth the trip [art]'],
  [C, 'Gallery of kitchen designs'],
  [D, 'London roundup: ten gallery shows [art]'],
]
// Feed 2 carries B again — the same article syndicated in a second feed.
const FEED_2 = [[B, 'A painting exhibition worth the trip [art]']]

const rss = (items) => `<?xml version="1.0"?><rss><channel>${items
  .map(([link, title]) => `<item><title>${title}</title><link>${link}</link><pubDate>${now}</pubDate></item>`)
  .join('')}</channel></rss>`

let feeds
const setFeeds = (one, two) => {
  feeds = { 'https://feed1.test/rss': rss(one), 'https://feed2.test/rss': rss(two) }
}

// ── Fake Supabase (PostgREST) ───────────────────────────────────────────────

const MAX_ROWS = 1000 // Supabase's per-request cap — the root of bug 1
let tables

function resetDb({ withRejectedTable = true } = {}) {
  const readings = []
  for (let i = 0; i < 1500; i++) readings.push({ id: `seed-${i}`, article_url: `https://old.test/${i}` })
  readings.splice(1400, 0, { id: 'saved-A', article_url: A }) // past row 1,000
  tables = {
    publications: [
      { id: 'pub-1', name: 'Feed One', rss_url: 'https://feed1.test/rss', tier: 't1' },
      { id: 'pub-2', name: 'Feed Two', rss_url: 'https://feed2.test/rss', tier: 't1' },
    ],
    readings,
    institutions: [],
  }
  if (withRejectedTable) tables.readings_rejected = []
}

// in.(a,"b,c") → ['a', 'b,c']
function parseIn(value) {
  const inner = value.slice(4, -1)
  const out = []
  for (const m of inner.matchAll(/"((?:[^"\\]|\\.)*)"|([^,]+)/g)) out.push(m[1] ?? m[2])
  return out
}

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

async function fakePostgrest(url, init) {
  const table = url.pathname.replace('/rest/v1/', '')
  const rows = tables[table]
  if (!rows) {
    return json(404, { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` })
  }
  const method = init?.method ?? 'GET'
  if (method === 'GET' || method === 'HEAD') {
    let out = rows
    for (const [key, value] of url.searchParams) {
      if (value.startsWith('in.')) {
        const wanted = new Set(parseIn(value))
        out = out.filter((r) => wanted.has(r[key]))
      }
    }
    return json(200, out.slice(0, MAX_ROWS))
  }
  if (method === 'POST') {
    const body = JSON.parse(init.body)
    const list = Array.isArray(body) ? body : [body]
    const prefer = new Headers(init.headers).get('prefer') ?? ''
    const inserted = []
    for (const row of list) {
      if (rows.some((r) => r.article_url === row.article_url)) {
        if (prefer.includes('ignore-duplicates')) continue
        return json(409, { code: '23505', message: 'duplicate key value violates unique constraint' })
      }
      const saved = { id: `new-${rows.length}`, ...row }
      rows.push(saved)
      inserted.push(saved)
    }
    const accept = new Headers(init.headers).get('accept') ?? ''
    return json(201, accept.includes('vnd.pgrst.object') ? inserted[0] : inserted)
  }
  return json(405, { message: `unhandled ${method}` })
}

// ── Fake Haiku ──────────────────────────────────────────────────────────────

let haiku
// The SDK retries a 500 twice on its own, so an outage has to last the run.
let relevanceDown = false

function fakeAnthropic(init) {
  const body = JSON.parse(init.body)
  const lines = body.messages[0].content.split('\n').filter((l) => /^\[\d+\] /.test(l))
  const titles = lines.map((l) => l.replace(/^\[\d+\] /, ''))
  const reply = (text) => json(200, {
    id: 'msg_fake', type: 'message', role: 'assistant', model: body.model,
    content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  })

  if (body.system) { // Stage 3 — classification
    haiku.classify.push(...titles)
    return reply(JSON.stringify(titles.map((t, index) => t.startsWith('London roundup')
      ? { index, category: 'show_roundup', art_relevance_score: 0.9, nyc_relevance_score: 0.05, major_artist: false, significant_announcement: false }
      : { index, category: 'show_review', art_relevance_score: 0.9, nyc_relevance_score: 0.9, major_artist: false, significant_announcement: false })))
  }
  // Stage 2 — relevance
  haiku.relevance.push(...titles)
  if (relevanceDown) {
    return json(500, { type: 'error', error: { type: 'api_error', message: 'fake outage' } })
  }
  return reply(JSON.stringify(titles.flatMap((t, i) => (t.includes('[art]') ? [i] : []))))
}

// ── Route every request ─────────────────────────────────────────────────────

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url)
  if (feeds[url.href]) return new Response(feeds[url.href], { status: 200 })
  if (url.host === 'fake-supabase.test') return fakePostgrest(url, init)
  if (url.host === 'api.anthropic.com') return fakeAnthropic(init)
  return new Response('not found', { status: 404 }) // og:image scrapes, Voyage
}

// ── Load the real curator only now, so it picks up the fake fetch ──────────

const curatorPath = resolve(process.argv[2] ?? 'lib/readings-curator.ts')
const { curateReadings } = await import(pathToFileURL(curatorPath).href)

async function run() {
  haiku = { relevance: [], classify: [] }
  const errors = []
  const result = await curateReadings('t1', errors)
  // Story grouping (lib/story-groups.ts, migration_v68) is another piece of work
  // and its tables are not faked here, so its errors are set aside.
  const all = result.errors ?? errors
  return { result, haiku, errors: all.filter((e) => e.item !== '(story grouping)') }
}

let failures = 0
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `\n        ${detail}` : ''}`)
  if (!ok) failures++
}
const titleOf = (url) => FEED_1.find(([u]) => u === url)?.[1]
const saw = (list, url) => list.includes(titleOf(url))
const quiet = console.log
const silence = (fn) => async () => { console.log = () => {}; console.error = () => {}; console.warn = () => {}; try { return await fn() } finally { console.log = quiet } }
const runQuiet = silence(run)

// ── Scenario 1 & 2: first run, then the same feeds an hour later ────────────

console.log(`\nCurator: ${curatorPath}`)
console.log('\nRun 1 — fresh feeds, 1,501 readings already saved (the saved one is past row 1,000)')
resetDb(); setFeeds(FEED_1, FEED_2)
let r = await runQuiet()
check('already-saved article is NOT sent to Haiku', !saw(r.haiku.relevance, A), `relevance call saw: ${r.haiku.relevance.join(' | ')}`)
check('new art article is saved', tables.readings.some((x) => x.article_url === B))
check('article in two feeds is sent to Haiku once', r.haiku.relevance.filter((t) => t === titleOf(B)).length === 1,
  `sent ${r.haiku.relevance.filter((t) => t === titleOf(B)).length} times`)
check('turned-down article is remembered', tables.readings_rejected.some((x) => x.article_url === C && x.reason === 'not_relevant'))
check('no-NYC roundup is remembered', tables.readings_rejected.some((x) => x.article_url === D && x.reason === 'nyc_roundup'))
check('no run errors', r.errors.length === 0, JSON.stringify(r.errors))

console.log('\nRun 2 — same feeds again')
r = await runQuiet()
check('no Haiku calls at all', r.haiku.relevance.length === 0 && r.haiku.classify.length === 0,
  `relevance: ${r.haiku.relevance.join(' | ')}; classify: ${r.haiku.classify.join(' | ')}`)
check('nothing saved twice', tables.readings.filter((x) => x.article_url === B).length === 1)
check('run reports 2 already saved, 2 already turned down',
  r.result.alreadySaved === 2 && r.result.rejectedSkipped === 2,
  `alreadySaved=${r.result.alreadySaved} rejectedSkipped=${r.result.rejectedSkipped}`)

// ── Scenario 4: a failed relevance call must not count as a "no" ────────────

console.log('\nRun 3 — a new article arrives, and the relevance call fails')
setFeeds([...FEED_1, [E, 'Unlucky gallery item']], FEED_2)
relevanceDown = true
r = await runQuiet()
relevanceDown = false
check('article was sent', saw(r.haiku.relevance, E) || r.haiku.relevance.includes('Unlucky gallery item'))
check('failure recorded as a run error', r.errors.some((e) => e.message.includes('fake outage') || e.message.includes('500')), JSON.stringify(r.errors))
check('article is NOT remembered as rejected', !tables.readings_rejected.some((x) => x.article_url === E))

console.log('\nRun 4 — the call works this time')
r = await runQuiet()
check('article is tried again', r.haiku.relevance.includes('Unlucky gallery item'), `relevance: ${r.haiku.relevance.join(' | ')}`)
check('and only that article', r.haiku.relevance.length === 1, `relevance: ${r.haiku.relevance.join(' | ')}`)
check('now remembered as rejected', tables.readings_rejected.some((x) => x.article_url === E))

// ── Scenario 5: migration not applied yet ───────────────────────────────────

console.log('\nRun 5 — readings_rejected does not exist (migration_v69 not applied)')
resetDb({ withRejectedTable: false }); setFeeds(FEED_1, FEED_2)
r = await runQuiet()
check('run still completes and saves the new article', tables.readings.some((x) => x.article_url === B))
check('already-saved article still skipped', !saw(r.haiku.relevance, A))
check('missing table reported as a run error', r.errors.some((e) => /readings_rejected/.test(e.message)), JSON.stringify(r.errors))

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`)
process.exit(failures === 0 ? 0 : 1)
