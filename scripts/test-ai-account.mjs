/**
 * AI account problems are loud, and nothing is lost to them — 2026-09-22.
 *
 *   node --import ./scripts/ts-resolve.mjs scripts/test-ai-account.mjs
 *
 * Fully offline, like scripts/test-agent3-dedup.mjs: runs the REAL
 * curateReadings(), assignStoryGroups() and lib/ai-account.ts with every network
 * call answered in memory. No database, no model, no .env.local.
 *
 * What it proves:
 *   1. Anthropic's "credit balance is too low", a rejected key, and Voyage's
 *      401/429 are recognised as account problems; a 500 or a bad request is not
 *   2. a credit outage stops Agent 3 after the FIRST refused call, saves and
 *      rejects nothing, and reports the error; the next run picks everything up
 *   3. an article is never saved without a category: if sorting fails (an API
 *      error, or Haiku leaving it out) it waits, and is saved sorted next run
 *   4. Mousse's feed is read to page 3, and an article only on page 2 is saved
 *   5. Top Stories grouping stops on an account problem and marks nothing
 *      checked, so every reading is retried
 *   6. the admin banner's rule: blocked until a run gets an answer — a quiet
 *      run never clears it, and August's old-format errors are recognised
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://fake-supabase.test'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role'
process.env.ANTHROPIC_API_KEY = 'fake-anthropic'
process.env.VOYAGE_API_KEY = 'fake-voyage'

let failures = 0
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `\n        ${detail}` : ''}`)
  if (!ok) failures++
}

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// The real wording Anthropic sent in August 2026 (agent_runs, 2026-08-26..31).
const CREDIT = { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } }

// ── Fixtures: feeds ─────────────────────────────────────────────────────────

const now = new Date().toUTCString()
const rss = (items) => `<?xml version="1.0"?><rss><channel>${items
  .map(([link, title]) => `<item><title>${title}</title><link>${link}</link><pubDate>${now}</pubDate></item>`)
  .join('')}</channel></rss>`

// 30 art articles on one feed: two relevance batches of 25 when all is well.
const MANY = Array.from({ length: 30 }, (_, i) => [`https://outlet.test/a${i}`, `Gallery exhibition number ${i} [art]`])
const MOUSSE = 'https://www.moussemagazine.it/feed/'
let feeds

// ── Fake Supabase ───────────────────────────────────────────────────────────

let tables
function resetDb(publications) {
  tables = { publications, readings: [], readings_rejected: [], institutions: [] }
}

function parseIn(value) {
  const out = []
  for (const m of value.slice(4, -1).matchAll(/"((?:[^"\\]|\\.)*)"|([^,]+)/g)) out.push(m[1] ?? m[2])
  return out
}

async function fakePostgrest(url, init) {
  const rows = tables[url.pathname.replace('/rest/v1/', '')]
  if (!rows) return json(404, { code: 'PGRST205', message: 'no such table' })
  const method = init?.method ?? 'GET'
  if (method === 'GET' || method === 'HEAD') {
    let out = rows
    for (const [key, value] of url.searchParams) {
      if (value.startsWith('in.')) {
        const wanted = new Set(parseIn(value))
        out = out.filter((r) => wanted.has(r[key]))
      }
    }
    return json(200, out)
  }
  if (method === 'POST') {
    const list = [JSON.parse(init.body)].flat()
    const inserted = []
    for (const row of list) {
      if (rows.some((r) => r.article_url === row.article_url)) continue
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
let anthropicMode = 'ok' // 'ok' | 'credit' | 'classify-500' | 'classify-omit'

function fakeAnthropic(init) {
  const body = JSON.parse(init.body)
  const titles = body.messages[0].content.split('\n').filter((l) => /^\[\d+\] /.test(l)).map((l) => l.replace(/^\[\d+\] /, ''))
  const reply = (text) => json(200, {
    id: 'msg_fake', type: 'message', role: 'assistant', model: body.model,
    content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  })
  if (anthropicMode === 'credit') {
    haiku.refused++
    return json(400, CREDIT)
  }
  if (body.system) { // classification
    haiku.classify.push(...titles)
    if (anthropicMode === 'classify-500') return json(500, { type: 'error', error: { type: 'api_error', message: 'fake outage' } })
    const answered = anthropicMode === 'classify-omit' ? titles.slice(1) : titles
    return reply(JSON.stringify(answered.map((t) => ({
      index: titles.indexOf(t), category: 'show_review', art_relevance_score: 0.9, nyc_relevance_score: 0.9,
      major_artist: false, significant_announcement: false,
    }))))
  }
  haiku.relevance.push(...titles)
  return reply(JSON.stringify(titles.flatMap((t, i) => (t.includes('[art]') ? [i] : []))))
}

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url)
  if (feeds[url.href]) return new Response(feeds[url.href], { status: 200 })
  if (url.host === 'fake-supabase.test') return fakePostgrest(url, init)
  if (url.host === 'api.anthropic.com') return fakeAnthropic(init)
  return new Response('not found', { status: 404 })
}

const { accountProblem, watchedFetch, aiActivitySince, currentAiBlock } = await import('../lib/ai-account.ts')
const { curateReadings } = await import('../lib/readings-curator.ts')
const { assignStoryGroups } = await import('../lib/story-groups.ts')

const quiet = console.log
async function run() {
  haiku = { relevance: [], classify: [], refused: 0 }
  console.log = () => {}; console.error = () => {}; console.warn = () => {}
  try {
    const result = await curateReadings([])
    return { result, errors: result.errors.filter((e) => e.item !== '(story grouping)') }
  } finally {
    console.log = quiet
  }
}
const saved = (url) => tables.readings.find((r) => r.article_url === url)
const rejected = (url) => tables.readings_rejected.some((r) => r.article_url === url)

// ── 1. Recognising account problems ─────────────────────────────────────────

console.log('\n1. Which errors are account problems')
check('Anthropic credit balance → billing', accountProblem('anthropic', 400, JSON.stringify(CREDIT)) === 'billing')
check('Anthropic 401 → access', accountProblem('anthropic', 401, '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}') === 'access')
check('Anthropic bad request → not an account problem', accountProblem('anthropic', 400, '{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: must be positive"}}') === null)
check('Anthropic 500 / 429 → not account problems', accountProblem('anthropic', 500, '{}') === null && accountProblem('anthropic', 429, '{}') === null)
check('Voyage 401 (its real body) → access', accountProblem('voyage', 401, '{"detail":"Provided API key is invalid."}') === 'access')
check('Voyage 429 → limit', accountProblem('voyage', 429, '{"detail":"rate limit"}') === 'limit')
check('Voyage 500 → not an account problem', accountProblem('voyage', 500, '{}') === null)

const before = Date.now()
const f = watchedFetch('anthropic')
feeds = {}
const saveFetch = globalThis.fetch
globalThis.fetch = async () => json(400, CREDIT)
await f('https://api.anthropic.com/v1/messages', {})
globalThis.fetch = saveFetch
const act = aiActivitySince(before)
check('watchedFetch records the error with Anthropic\'s own message',
  act.account_error?.problem === 'billing' && /credit balance is too low/.test(act.account_error.message), JSON.stringify(act))

// ── 2. A credit outage in Agent 3 ───────────────────────────────────────────

console.log('\n2. Agent 3 during a credit outage, then after')
await new Promise((r) => setTimeout(r, 5)) // leave section 1's error behind
resetDb([{ id: 'pub-1', name: 'Outlet', rss_url: 'https://feed.test/rss', tier: 't1' }])
feeds = { 'https://feed.test/rss': rss(MANY) }
anthropicMode = 'credit'
let r = await run()
check('stops after the first refused call (not one per batch)', haiku.refused === 1, `refused calls: ${haiku.refused}`)
check('nothing saved', tables.readings.length === 0)
check('nothing remembered as rejected', tables.readings_rejected.length === 0)
check('run reports the account error', r.result.accountError?.problem === 'billing', JSON.stringify(r.result.accountError))
check('run error says articles were left for the next run',
  r.errors.some((e) => /left for the next run/.test(e.item) && /credit balance/.test(e.message)), JSON.stringify(r.errors))

anthropicMode = 'ok'
await new Promise((r) => setTimeout(r, 5))
r = await run()
check('next run saves all 30', MANY.every(([u]) => saved(u)), `saved ${tables.readings.length}`)
check('every one has a category', tables.readings.every((x) => x.category))
check('no account error this time', r.result.accountError === null)

// ── 3. Never saved without a category ───────────────────────────────────────

console.log('\n3. Sorting fails — articles wait instead of being saved unsorted')
const B = 'https://outlet.test/b', C = 'https://outlet.test/c'
resetDb([{ id: 'pub-1', name: 'Outlet', rss_url: 'https://feed.test/rss', tier: 't1' }])
feeds = { 'https://feed.test/rss': rss([[B, 'Painting exhibition B [art]'], [C, 'Sculpture exhibition C [art]']]) }
anthropicMode = 'classify-500'
r = await run()
check('passed the art check but not saved', haiku.relevance.length === 2 && tables.readings.length === 0, `saved: ${tables.readings.length}`)
check('not rejected either', !rejected(B) && !rejected(C))
check('counted as awaiting classification', r.result.awaitingClassification === 2, `awaiting=${r.result.awaitingClassification}`)

anthropicMode = 'classify-omit'
r = await run()
check('an article Haiku leaves out is not saved', !saved(B) && saved(C)?.category === 'show_review',
  JSON.stringify(tables.readings.map((x) => [x.article_url, x.category])))
check('an unparseable/omitted answer is counted, not silent', r.result.awaitingClassification === 1)

anthropicMode = 'ok'
r = await run()
check('next run saves it, sorted', saved(B)?.category === 'show_review')
check('only that one went back to Haiku', haiku.relevance.length === 1, haiku.relevance.join(' | '))

// ── 4. Mousse, pages 2 and 3 ────────────────────────────────────────────────

console.log('\n4. Mousse is read to page 3')
const P1 = 'https://www.moussemagazine.it/magazine/p1', P2 = 'https://www.moussemagazine.it/magazine/p2', P3 = 'https://www.moussemagazine.it/magazine/p3'
resetDb([{ id: 'pub-m', name: 'Mousse Magazine', rss_url: MOUSSE, tier: 't2' }])
feeds = {
  [MOUSSE]: rss([[P1, 'Exhibition on page one [art]']]),
  [`${MOUSSE}?paged=2`]: rss([[P2, 'Exhibition only on page two [art]'], [P1, 'Exhibition on page one [art]']]),
  [`${MOUSSE}?paged=3`]: rss([[P3, 'Exhibition on page three [art]']]),
}
r = await run()
check('article only on page 2 is saved', Boolean(saved(P2)))
check('page 3 too', Boolean(saved(P3)))
check('the article on two pages is sent to Haiku once', haiku.relevance.filter((t) => t.includes('page one')).length === 1)
check('no fetch errors', r.errors.length === 0, JSON.stringify(r.errors))
r = await run()
check('second run: all three already saved, no Haiku calls', r.result.alreadySaved === 3 && haiku.relevance.length === 0)

// Other feeds are still read once.
resetDb([{ id: 'pub-1', name: 'Outlet', rss_url: 'https://feed.test/rss', tier: 't1' }])
const asked = []
const plain = globalThis.fetch
globalThis.fetch = async (input, init) => { asked.push(String(input)); return plain(input, init) }
feeds = { 'https://feed.test/rss': rss([]) }
await run()
globalThis.fetch = plain
check('any other feed is fetched once', asked.filter((u) => u.startsWith('https://feed.test')).length === 1, asked.join(' '))

// ── 5. Grouping stops and retries ───────────────────────────────────────────

console.log('\n5. Top Stories grouping on an account problem')
const marked = []
const pending = [1, 2, 3].map((i) => ({
  id: `r${i}`, headline: `Story ${i}`, summary: null, article_url: `https://x.test/${i}`, thumbnail_url: null,
  author: null, publication_id: `p${i}`, publication_name: `P${i}`, tier: 't1', category: 'breaking_news',
  published: new Date().toISOString(), story_group_id: null, is_digest: null,
}))
const store = {
  pending: async () => pending, window: async () => [], embeddings: async (ids) => new Map(ids.map((id) => [id, [1, 0]])),
  saveEmbeddings: async () => {}, group: async () => null, members: async () => [], createGroup: async () => 'g',
  updateGroup: async () => {}, assign: async () => {}, markChecked: async (id) => { marked.push(id) }, log: async () => {},
}
let g = await assignStoryGroups(store, { shouldStop: () => true })
check('stops before doing anything', g.stoppedForAccount && g.checked === 0 && marked.length === 0)
let calls = 0
g = await assignStoryGroups(store, { shouldStop: () => ++calls > 2 })
check('stops mid-pass, leaving the rest unchecked', g.stoppedForAccount && marked.length === 1 && g.checked === 1, `marked ${marked}`)

// ── 6. The banner's rule ────────────────────────────────────────────────────

console.log('\n6. When the admin banner shows')
const billing = { provider: 'anthropic', problem: 'billing', status: 400, message: 'Your credit balance is too low', at: '' }
const newRun = (t, ai, items = 0) => ({ started_at: t, items_succeeded: items, errors: [], summary: { ai } })
const legacy = (t, msg, items = 0) => ({ started_at: t, items_succeeded: items, errors: msg ? [{ message: msg }] : [], summary: {} })
const AUGUST = `400 ${JSON.stringify(CREDIT)}`

let block = currentAiBlock([
  legacy('2026-08-31T19:00Z', AUGUST), legacy('2026-08-31T18:00Z', null), legacy('2026-08-26T10:00Z', AUGUST),
  legacy('2026-08-25T09:00Z', null, 4),
])
check('August\'s old-format runs are recognised, with the real message',
  block?.since === '2026-08-26T10:00Z' && /credit balance is too low/.test(block.error.message), JSON.stringify(block))
check('September 1st (articles written after the top-up) clears it',
  currentAiBlock([legacy('2026-09-01T19:00Z', null, 12), legacy('2026-08-31T19:00Z', AUGUST)]) === null)
check('a quiet run with no AI calls does NOT clear it',
  currentAiBlock([newRun('t3', { calls_ok: 0, account_error: null }), newRun('t2', { calls_ok: 0, account_error: billing })])?.since === 't2')
check('a run whose AI calls succeeded clears it',
  currentAiBlock([newRun('t3', { calls_ok: 4, account_error: null }), newRun('t2', { calls_ok: 0, account_error: billing })]) === null)
check('never blocked → no banner', currentAiBlock([newRun('t1', { calls_ok: 2, account_error: null })]) === null)

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`)
process.exit(failures === 0 ? 0 : 1)
