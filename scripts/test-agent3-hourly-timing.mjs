/**
 * One Agent 3 run over every feed, with a big backlog, ends inside 300s — 2026-09-22.
 *
 *   node --import ./scripts/ts-resolve.mjs scripts/test-agent3-hourly-timing.mjs
 *   node --env-file=.env.local --import ./scripts/ts-resolve.mjs scripts/test-agent3-hourly-timing.mjs --live
 *
 * Runs the REAL curateReadings() — feed pass, relevance, classification, image
 * fetches, inserts and Top Stories grouping — against an in-memory database,
 * and times it. Nothing is ever written to Supabase: every request to the
 * Supabase host is answered by the fake below, in both modes.
 *
 * Default (offline, ~4–5 minutes, free): every outside service is faked, with
 * latencies set WORSE than anything measured, to show the stopping points hold
 * even when everything is slow at once:
 *   - 30 feeds (+ Mousse pages 2–3), 4 of them hanging until the 15s timeout
 *   - 15 new art articles per feed: ~420 reach sorting (the real backlog after the
 *     three-week pause was ~170)
 *   - every article approved, so every one also needs classifying
 *   - Haiku: 8s per relevance call, 20s per classification call, 5s per
 *     Top Stories confirmation; Voyage: 5s per embedding call
 *   - article pages: 1 in 3 hangs until the 5s image timeout
 *   - one Haiku relevance call never answers at all, and one classification
 *     call is rate-limited with "retry-after: 120"
 *   - 500 readings waiting for Top Stories grouping, every one close enough
 *     to the others to need a Haiku confirmation
 *   - 80ms for every database request
 *
 * --live (needs .env.local; costs well under $1): the REAL feeds, Haiku, Voyage
 * and article pages, against a copy of production's readings, embeddings,
 * story groups and publications read once at the start — so the backlog is the
 * real one. Writes still go only to the in-memory copy. Database requests get
 * the same 80ms.
 *
 * What it proves:
 *   1. the whole run ends inside 300s, with room to spare
 *   2. no chunk of sorting starts after 150s, no image fetch after 230s, no
 *      Top Stories comparison after 240s
 *   3. the run still saves articles (the backlog shrinks), and says how many
 *      it left for the next run
 *   4. a Haiku call that never answers, or that is rate-limited with a long
 *      retry-after, costs one batch, not the run
 */

import { createClient } from '@supabase/supabase-js'

const LIVE = process.argv.includes('--live')
const realFetch = globalThis.fetch

let failures = 0
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `\n        ${detail}` : ''}`)
  if (!ok) failures++
}

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// Waits ms, or rejects the way fetch does if the caller's timeout fires first.
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason) }, { once: true })
  })
}

// ── Timeline: when each kind of outside call STARTED, in seconds from run start ─

let runStart = 0
const started = { feed: [], relevance: [], classify: [], image: [], confirm: [], embed: [], db: [] }
const mark = (kind) => started[kind].push((Date.now() - runStart) / 1000)

// ── In-memory Supabase (PostgREST) ──────────────────────────────────────────

const DB_LATENCY_MS = 80
let tables = {}
let nextId = 1

function parseIn(value) {
  const out = []
  for (const m of value.slice(4, -1).matchAll(/"((?:[^"\\]|\\.)*)"|([^,]+)/g)) out.push(m[1] ?? m[2])
  return out
}

// Only the filters Agent 3 and the story store use. `or` (the window query's
// date range) is ignored, which returns MORE readings than the real query —
// more to compare, so if anything slower, never faster.
function applyFilters(rows, params) {
  let out = rows
  for (const [key, value] of params) {
    if (['select', 'order', 'limit', 'or', 'on_conflict', 'columns'].includes(key)) continue
    if (value.startsWith('in.')) {
      const wanted = new Set(parseIn(value))
      out = out.filter((r) => wanted.has(String(r[key])))
    } else if (value === 'is.null') out = out.filter((r) => r[key] == null)
    else if (value === 'not.is.null') out = out.filter((r) => r[key] != null)
    else if (value.startsWith('eq.')) out = out.filter((r) => String(r[key]) === value.slice(3))
    else if (value.startsWith('neq.')) out = out.filter((r) => String(r[key]) !== value.slice(4))
  }
  return out
}

function conflictKey(table) {
  return { readings: 'article_url', readings_rejected: 'article_url', reading_embeddings: 'reading_id' }[table]
}

async function fakePostgrest(url, init) {
  mark('db')
  await delay(DB_LATENCY_MS)
  const table = url.pathname.replace('/rest/v1/', '')
  const rows = (tables[table] ??= [])
  const method = init?.method ?? 'GET'
  const headers = new Headers(init?.headers)
  const wantsObject = (headers.get('accept') ?? '').includes('vnd.pgrst.object')

  if (method === 'GET' || method === 'HEAD') {
    let out = applyFilters(rows, url.searchParams)
    const limit = Number(url.searchParams.get('limit') ?? 1000)
    out = out.slice(0, Math.min(limit, 1000))
    if (wantsObject) {
      if (out.length === 1) return json(200, out[0])
      return json(406, { code: 'PGRST116', details: `The result contains ${out.length} rows`, message: 'JSON object requested, multiple (or no) rows returned' })
    }
    return json(200, out)
  }
  if (method === 'POST') {
    const list = [JSON.parse(init.body)].flat()
    const key = conflictKey(table)
    const upsert = (headers.get('prefer') ?? '').includes('resolution=')
    const inserted = []
    for (const row of list) {
      const existing = key && rows.find((r) => r[key] === row[key])
      if (existing) {
        if (upsert) { Object.assign(existing, row); continue }
        return json(409, { code: '23505', message: 'duplicate key value violates unique constraint' })
      }
      const saved = { id: `mem-${nextId++}`, created_at: new Date().toISOString(), ...row }
      if (table === 'readings') {
        const pub = tables.publications.find((p) => p.id === row.publication_id)
        saved.publications = pub ? { name: pub.name, tier: pub.tier } : null
        saved.story_checked_at = null
        saved.story_group_id = null
        saved.story_is_digest = false
      }
      rows.push(saved)
      inserted.push(saved)
    }
    return json(201, wantsObject ? inserted[0] : inserted)
  }
  if (method === 'PATCH') {
    const patch = JSON.parse(init.body)
    for (const r of applyFilters(rows, url.searchParams)) Object.assign(r, patch)
    return new Response(null, { status: 204 })
  }
  return json(405, { message: `unhandled ${method}` })
}

// ── Offline fakes: feeds, article pages, Haiku, Voyage ──────────────────────

const FEEDS = 30
const HUNG_FEEDS = 4
const PER_FEED = 15
const PENDING_GROUPING = 500
const LATENCY = { relevance: 8000, classify: 20000, confirm: 5000, embed: 5000 }
// One batch's relevance call never answers; one classification call comes back
// rate-limited, asking for a 120s wait (see fakeAnthropic). Both are answers a
// run has to survive without overrunning.
const HANGING_ARTICLE = 'Gallery exhibition 7-1-0 opens'
const RATE_LIMITED_CLASSIFY_CALL = 2

function offlineSetup() {
  const now = Date.now()
  const publications = Array.from({ length: FEEDS }, (_, f) => ({
    id: `pub-${f}`, name: `Outlet ${f}`, tier: f < 5 ? 't1' : 't2', status: 'approved', active: true,
    rss_url: f === 0 ? 'https://www.moussemagazine.it/feed/' : `https://outlet${f}.test/rss`,
  }))
  const feedXml = (f, page) => `<?xml version="1.0"?><rss><channel>${Array.from({ length: PER_FEED }, (_, i) => {
    const link = `https://outlet${f}.test/p${page}/article-${i}`
    const date = new Date(now - (i * 3 + f) * 3600_000).toUTCString()
    return `<item><title>Gallery exhibition ${f}-${page}-${i} opens</title><link>${link}</link><pubDate>${date}</pubDate><description>A painting show.</description></item>`
  }).join('')}</channel></rss>`

  const readings = Array.from({ length: PENDING_GROUPING }, (_, i) => ({
    id: `pending-${i}`, headline: `Museum names new director ${i}`, rss_summary: 'The museum announced.',
    article_url: `https://old.test/${i}`, thumbnail_url: null, author: null,
    publication_id: `pub-${i % FEEDS}`, tier: 't2', category: 'institutional_news',
    published_at: new Date(now - i * 600_000).toISOString(), created_at: new Date(now - i * 600_000).toISOString(),
    story_checked_at: null, story_group_id: null, story_is_digest: false,
    publications: { name: `Outlet ${i % FEEDS}`, tier: 't2' },
  }))
  tables = { publications, readings, readings_rejected: [], institutions: [], reading_embeddings: [], story_groups: [], story_match_log: [] }

  const anthropicReply = (body, text) => json(200, {
    id: 'msg_fake', type: 'message', role: 'assistant', model: body.model,
    content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  })

  return async (url, init) => {
    const signal = init?.signal
    const feed = url.href.match(/^https:\/\/outlet(\d+)\.test\/rss$/)
    const mousse = url.hostname === 'www.moussemagazine.it'
    if (feed || mousse) {
      mark('feed')
      const f = feed ? Number(feed[1]) : 0
      const page = Number(url.searchParams.get('paged') ?? 1)
      if (f > 0 && f <= HUNG_FEEDS) { await delay(60_000, signal); return new Response('') }
      await delay(1000 + (f % 5) * 1000, signal)
      return new Response(feedXml(f, page), { status: 200 })
    }
    if (url.hostname.endsWith('.test')) { // an article page, for its og:image
      mark('image')
      const n = Number(url.pathname.match(/(\d+)$/)?.[1] ?? 0)
      if (n % 3 === 0) { await delay(60_000, signal); return new Response('') }
      await delay(1500, signal)
      return new Response(`<meta property="og:image" content="https://img.test${url.pathname}.jpg">`, { status: 200 })
    }
    if (url.hostname === 'api.anthropic.com') {
      const body = JSON.parse(init.body)
      const content = body.messages[0].content
      if (body.system?.includes('same specific EVENT')) {
        mark('confirm')
        await delay(LATENCY.confirm)
        const stories = [...content.matchAll(/^\[(\d+)\]$/gm)].map((m) => Number(m[1]))
        return anthropicReply(body, JSON.stringify({
          new_article_event: 'a director appointment', new_article_is_digest: false,
          verdicts: stories.map((story) => ({ story, story_event: 'a director appointment', same_event: story === 1 })),
        }))
      }
      const lines = content.split('\n').filter((l) => /^\[\d+\] /.test(l))
      if (body.system) {
        mark('classify')
        if (started.classify.length === RATE_LIMITED_CLASSIFY_CALL) {
          return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } }), {
            status: 429, headers: { 'content-type': 'application/json', 'retry-after': '120' },
          })
        }
        await delay(LATENCY.classify)
        return anthropicReply(body, JSON.stringify(lines.map((_, index) => ({
          index, category: 'show_review', art_relevance_score: 0.9, nyc_relevance_score: 0.9,
          major_artist: false, significant_announcement: false,
        }))))
      }
      mark('relevance')
      // One batch's Haiku call never answers, on every attempt: the per-call
      // limit has to end it, or it outlasts the run.
      if (content.includes(HANGING_ARTICLE)) { await delay(600_000, signal); return new Response('') }
      await delay(LATENCY.relevance)
      return anthropicReply(body, JSON.stringify(lines.map((_, i) => i)))
    }
    if (url.hostname === 'api.voyageai.com') {
      mark('embed')
      await delay(LATENCY.embed)
      const { input } = JSON.parse(init.body)
      // Nearly the same vector for everything: every reading is a candidate
      // match for every other, so each one needs a Haiku confirmation.
      return json(200, {
        data: input.map((_, index) => ({ index, embedding: Array.from({ length: 8 }, (_, d) => 1 + (d === index % 8 ? 0.01 : 0)) })),
        usage: { total_tokens: input.length * 40 },
      })
    }
    return new Response('not found', { status: 404 })
  }
}

// ── Live: production copied in once, read-only ──────────────────────────────

async function readAll(db, table, select, filter = (q) => q) {
  const out = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await filter(db.from(table).select(select)).range(from, from + 999)
    if (error) throw new Error(`${table}: ${error.message}`)
    out.push(...data)
    if (data.length < 1000) return out
  }
}

async function liveSetup() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!supabaseUrl || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('--live needs .env.local')
  // Its own client on the real fetch, used only here, only to read.
  const prod = createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY, { global: { fetch: realFetch } })
  console.log('Copying production data into memory (read-only)…')
  const readings = await readAll(prod, 'readings',
    'id, headline, rss_summary, article_url, thumbnail_url, author, publication_id, tier, category, published_at, created_at, story_checked_at, story_group_id, story_is_digest, publications(name, tier)')
  const ids = new Set(readings.filter((r) => r.story_checked_at == null || Date.now() - Date.parse(r.published_at ?? r.created_at) < 5 * 864e5).map((r) => r.id))
  const reading_embeddings = (await readAll(prod, 'reading_embeddings', 'reading_id, embedding, model'))
    .filter((e) => ids.has(e.reading_id))
    .map((e) => ({ ...e, embedding: typeof e.embedding === 'string' ? JSON.parse(e.embedding) : e.embedding }))
  tables = {
    publications: await readAll(prod, 'publications', 'id, name, rss_url, tier, status, active'),
    readings,
    readings_rejected: await readAll(prod, 'readings_rejected', 'article_url, publication_id, headline, reason'),
    institutions: await readAll(prod, 'institutions', 'name'),
    reading_embeddings,
    story_groups: await readAll(prod, 'story_groups', '*'),
    story_match_log: [],
  }
  console.log(`  ${tables.readings.length} readings (${readings.filter((r) => r.story_checked_at == null).length} awaiting grouping), ` +
    `${tables.readings_rejected.length} rejected, ${reading_embeddings.length} embeddings, ${tables.publications.length} publications`)

  return (url, init) => {
    if (url.hostname === 'api.anthropic.com') {
      const body = JSON.parse(init.body)
      mark(body.system?.includes('same specific EVENT') ? 'confirm' : body.system ? 'classify' : 'relevance')
    } else if (url.hostname === 'api.voyageai.com') mark('embed')
    else if (tables.publications.some((p) => p.rss_url && url.href.startsWith(p.rss_url.split('?')[0]))) mark('feed')
    else mark('image')
    return realFetch(url, init)
  }
}

// ── Route every request ─────────────────────────────────────────────────────

if (!LIVE) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://fake-supabase.test'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role'
  process.env.ANTHROPIC_API_KEY = 'fake-anthropic'
  process.env.VOYAGE_API_KEY = 'fake-voyage'
}
const supabaseHost = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host
const outside = LIVE ? await liveSetup() : offlineSetup()

let reachedRealSupabase = 0
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url)
  if (url.host === supabaseHost) return fakePostgrest(url, init)
  if (url.hostname.endsWith('supabase.co')) { reachedRealSupabase++; throw new Error('blocked: real Supabase') }
  return outside(url, init)
}

const { curateReadings } = await import('../lib/readings-curator.ts')

// ── Run ─────────────────────────────────────────────────────────────────────

console.log(`\n${LIVE ? 'LIVE: real feeds, Haiku, Voyage and article pages' : 'OFFLINE worst case: everything slow at once'} — this takes up to 5 minutes\n`)
const quiet = { log: console.log, warn: console.warn, error: console.error }
console.log = console.warn = console.error = () => {}
runStart = Date.now()
let result
try {
  result = await curateReadings([])
} finally {
  Object.assign(console, quiet)
}
const total = (Date.now() - runStart) / 1000

const last = (kind) => (started[kind].length ? Math.max(...started[kind]) : null)
const span = (kind) => started[kind].length
  ? `${started[kind].length} call(s), first at ${Math.min(...started[kind]).toFixed(1)}s, last started at ${last(kind).toFixed(1)}s`
  : 'none'
console.log('Timeline (when each kind of call started):')
for (const kind of ['feed', 'relevance', 'classify', 'image', 'embed', 'confirm']) console.log(`  ${kind.padEnd(10)} ${span(kind)}`)
const g = result.storyGrouping
console.log(`\nSorted ${result.candidatesConsidered - result.leftForNextRun} of ${result.candidatesConsidered} candidates; saved ${result.written}; ` +
  `${result.leftForNextRun} left for the next run; ${result.rejectionsRecorded} rejections remembered`)
console.log(`Top Stories: checked ${g?.checked ?? 0} reading(s), ${g?.llmCalls ?? 0} Haiku confirmation(s), stopped for time: ${g?.stoppedForTime ?? false}`)
console.log(`Stopped for time — sorting: ${result.stoppedForTime.sorting}, images: ${result.stoppedForTime.images}`)
const otherErrors = result.errors.filter((e) => e.step !== 'fetch')
console.log(`Run errors: ${result.errors.length} (${result.errors.length - otherErrors.length} feed fetches)`)
for (const e of result.errors.slice(0, 8)) console.log(`  - ${e.item}: ${e.message.slice(0, 120)}`)
console.log(`\nTotal: ${total.toFixed(1)}s\n`)

check('whole run under 300s', total < 300, `${total.toFixed(1)}s`)
check('with at least 30s to spare', total <= 270, `${total.toFixed(1)}s`)
// A chunk starts with its relevance call; 150s is when the last may start.
check('no sorting chunk started after 150s', (last('relevance') ?? 0) < 150.5, `last relevance call at ${last('relevance')}s`)
check('no image fetch started after 230s', (last('image') ?? 0) < 230.5, `last image fetch at ${last('image')}s`)
check('no Top Stories comparison started after 240s', (last('confirm') ?? 0) < 245, `last confirmation at ${last('confirm')}s`)
check('articles were saved — the backlog shrinks', result.written > 0, `written=${result.written}`)
check('nothing reached the real database', reachedRealSupabase === 0)
if (!LIVE) {
  // One at a time, 4 hung feeds alone would be 60s and the rest ~90s more.
  check('every feed started within 25s despite 4 hung feeds', (last('feed') ?? 0) < 25, `last feed started at ${last('feed')}s`)
  check('Top Stories embedding stopped at 240s too', (last('embed') ?? 0) < 240.5, `last Voyage call at ${last('embed')}s`)
  check('sorting stopped for time and said how many it left', result.stoppedForTime.sorting && result.leftForNextRun > 0)
  check('grouping stopped for time', g?.stoppedForTime === true)
  const timedOut = otherErrors.filter((e) => /timed out|timeout|aborted/i.test(e.message))
  const rateLimited = otherErrors.filter((e) => /429|rate/i.test(e.message))
  check('the hanging Haiku call was cut off and recorded', timedOut.length === 1, JSON.stringify(otherErrors.slice(0, 3)))
  check('the rate-limited call did not wait 120s', rateLimited.length === 1 && total < 300, JSON.stringify(otherErrors.slice(0, 3)))
  check('no other run errors', otherErrors.length === timedOut.length + rateLimited.length, JSON.stringify(otherErrors.slice(0, 3)))
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`)
process.exit(failures === 0 ? 0 : 1)
