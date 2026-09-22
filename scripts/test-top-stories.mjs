/**
 * Dry run of Top Stories grouping over every existing reading — migration_v68.
 *
 *   node --env-file=.env.local --import ./scripts/ts-resolve.mjs scripts/test-top-stories.mjs [outDir]
 *
 * Needs VOYAGE_API_KEY and ANTHROPIC_API_KEY. Does NOT need migration_v68
 * applied, and WRITES NOTHING TO THE DATABASE: readings are read once, and
 * lib/story-groups.ts assignStoryGroups() — the same function Agent 3 calls —
 * runs against an in-memory StoryStore instead of Supabase.
 *
 * Readings are fed through in published order, as if each arrived when it was
 * published. It uses the live threshold unless TEST_THRESHOLD is set; a lower
 * one makes Haiku rule on a wider band of pairs, to see where its yeses fall.
 *
 * Writes to outDir (default: <os tmpdir>/idea2-top-stories-test — outside the
 * repo, so nothing it writes can be committed by accident):
 *   embeddings.json   cached vectors, so a re-run does not re-embed
 *   result.json       groups, members, every logged comparison, split checks
 *   report.md         the human-readable report
 *   preview.html      the Top Stories tab as it would have looked on the day
 *                     of the newest reading, using app/top-stories.css
 *
 * Costs (estimate): ~46k Voyage tokens (free allowance) and roughly one Haiku
 * call per reading that has a candidate above TEST_THRESHOLD — well under $1.
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  assignStoryGroups, buildTopStories, haikuConfirm, toStoryReading, cosine,
  MATCH_THRESHOLD, WINDOW_DAYS, MIN_OUTLETS,
} from '../lib/story-groups.ts'

// The live threshold by default, so the report shows what would ship.
// TEST_THRESHOLD=0.45 widens the band Haiku rules on, for tuning.
const TEST_THRESHOLD = Number(process.env.TEST_THRESHOLD ?? MATCH_THRESHOLD)
const outDir = process.argv[2] ?? join(tmpdir(), 'idea2-top-stories-test')
mkdirSync(outDir, { recursive: true })

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// ── Read every reading once ─────────────────────────────────────────────────

const COLUMNS = 'id, headline, rss_summary, article_url, thumbnail_url, author, publication_id, tier, ' +
  'category, published_at, created_at, publications(name, tier)'
const rows = []
for (let from = 0; ; from += 1000) {
  const { data, error } = await db.from('readings').select(COLUMNS).range(from, from + 999)
  if (error) throw error
  rows.push(...data)
  if (data.length < 1000) break
}
const readings = new Map(rows.map((r) => [r.id, toStoryReading({ ...r, story_group_id: null, story_is_digest: null })]))
console.log(`${readings.size} readings`)

// ── In-memory StoryStore ────────────────────────────────────────────────────

const embPath = join(outDir, 'embeddings.json')
const vectors = new Map(existsSync(embPath) ? Object.entries(JSON.parse(readFileSync(embPath, 'utf8'))) : [])
const checked = new Set()
const groups = new Map()
const log = []
let nextGroup = 1

const store = {
  async pending(limit) {
    return [...readings.values()].filter((r) => !checked.has(r.id))
      .sort((a, b) => a.published.localeCompare(b.published) || a.id.localeCompare(b.id))
      .slice(0, limit)
  },
  async window(from, to) {
    return [...readings.values()].filter((r) => checked.has(r.id) && r.published >= from && r.published <= to)
      .map((r) => ({ ...r }))
  },
  async embeddings(ids) {
    return new Map(ids.filter((id) => vectors.has(id)).map((id) => [id, vectors.get(id)]))
  },
  async saveEmbeddings(rs) {
    for (const r of rs) vectors.set(r.reading_id, r.embedding)
    writeFileSync(embPath, JSON.stringify(Object.fromEntries(vectors)))
  },
  async group(id) { return groups.has(id) ? { ...groups.get(id) } : null },
  async members(groupId) { return [...readings.values()].filter((r) => r.story_group_id === groupId) },
  async createGroup(g) {
    const id = `g${nextGroup++}`
    groups.set(id, { id, ...g })
    return id
  },
  async updateGroup(id, patch) {
    const g = groups.get(id)
    if (g.lead_reading_id && patch.lead_reading_id && patch.lead_reading_id !== g.lead_reading_id) {
      throw new Error(`lead of ${id} changed — migration_v68's trigger would reject this`)
    }
    Object.assign(g, patch)
  },
  async assign(ids, groupId) { for (const id of ids) readings.get(id).story_group_id = groupId },
  async markChecked(id, isDigest) { checked.add(id); readings.get(id).is_digest = isDigest },
  async log(rs) { log.push(...rs) },
}

// ── Run the real grouping pass ──────────────────────────────────────────────

const prompts = []
const confirm = async (reading, targets) => {
  const result = await haikuConfirm(reading, targets)
  prompts.push({
    reading: reading.id, isDigest: result.isDigest, verdicts: result.verdicts,
    targets: targets.map((t) => ({ key: t.key, ids: t.readings.map((r) => r.id) })),
  })
  return result
}

const summary = await assignStoryGroups(store, { threshold: TEST_THRESHOLD, confirm, limit: 5000 })
console.log(summary)

// ── Split check: are two groups really one event? ───────────────────────────
// Groups never merge, so a story can split if its second group formed before
// anything linked it to the first. For every pair of groups whose members fall
// within WINDOW_DAYS of each other and whose closest cross pair is at or above
// the live threshold, ask Haiku the same question the pipeline asks.

const members = (gid) => [...readings.values()].filter((r) => r.story_group_id === gid)
  .sort((a, b) => a.published.localeCompare(b.published))
const nonDigest = (gid) => members(gid).filter((r) => !r.is_digest)
const groupList = [...groups.values()]
const splitChecks = []
for (let i = 0; i < groupList.length; i++) {
  for (let j = i + 1; j < groupList.length; j++) {
    const a = groupList[i], b = groupList[j]
    const ma = nonDigest(a.id), mb = nonDigest(b.id)
    const gap = Math.max(
      new Date(a.first_published_at) - new Date(b.last_published_at),
      new Date(b.first_published_at) - new Date(a.last_published_at)
    ) / 86_400_000
    if (gap > WINDOW_DAYS) continue
    let best = 0
    for (const x of ma) for (const y of mb) best = Math.max(best, cosine(vectors.get(x.id), vectors.get(y.id)))
    if (best < MATCH_THRESHOLD) continue
    const { verdicts: [verdict] } = await haikuConfirm(ma[0], [{ key: b.id, groupId: b.id, readings: mb.slice(0, 4) }])
    splitChecks.push({ a: a.id, b: b.id, best_similarity: Number(best.toFixed(4)), same_event: verdict.same_event, reason: verdict.reason })
  }
}

// ── Page as of the newest reading ───────────────────────────────────────────

const newest = [...readings.values()].reduce((m, r) => (r.published > m ? r.published : m), '')
const asOf = new Date(new Date(newest).getTime() + 60_000)
const membersByGroup = new Map(groupList.map((g) => [g.id, members(g.id)]))
const page = buildTopStories(groupList, membersByGroup, asOf)
// Every 3+ outlet group, each as it looked the moment it became visible.
const everyThreePlus = groupList.filter((g) => g.lead_reading_id)
  .map((g) => buildTopStories([g], membersByGroup, new Date(new Date(g.first_published_at).getTime() + 1000))[0])
  .filter(Boolean)

writeFileSync(join(outDir, 'result.json'), JSON.stringify({
  summary, asOf: asOf.toISOString(), threshold: TEST_THRESHOLD, liveThreshold: MATCH_THRESHOLD,
  groups: groupList.map((g) => ({ ...g, members: members(g.id).map((r) => r.id) })),
  readings: Object.fromEntries([...readings].map(([id, r]) => [id, {
    headline: r.headline, publication_name: r.publication_name, tier: r.tier, category: r.category,
    published: r.published, article_url: r.article_url, is_digest: r.is_digest,
  }])),
  log, prompts, splitChecks, page, everyThreePlus,
}, null, 1))

// ── Preview HTML ────────────────────────────────────────────────────────────

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const css = readFileSync('app/top-stories.css', 'utf8')
const logPill = '<span class="rl-pill">Log</span>'
const storyHtml = (s) => `
<article class="ts-story">
  ${s.lead.thumbnail_url ? `<a class="ts-image-link" href="${esc(s.lead.article_url)}"><img class="ts-image" src="${esc(s.lead.thumbnail_url)}" alt=""></a>` : ''}
  <div class="ts-body">
    <p class="ts-source">${esc([s.lead.author, s.lead.publication_name].filter(Boolean).join(' / '))}</p>
    <div class="ts-headline-row"><a class="ts-headline" href="${esc(s.lead.article_url)}">${esc(s.lead.headline)}</a><span class="ts-lead-log">${logPill}</span></div>
    <p class="ts-more"><span class="ts-more-label">More:</span>${s.more.map((m) =>
      `<span class="ts-more-item"><a class="ts-more-link" href="${esc(m.article_url)}" title="${esc(m.headline)}">${esc(m.publication_name)}</a>${logPill}</span>`).join('')}</p>
    <p class="ts-debug">${esc(s.category)} · ${s.outlet_count} outlets · first published ${esc(s.first_published_at.slice(0, 10))}</p>
  </div>
</article>`
writeFileSync(join(outDir, 'preview.html'), `<!doctype html><meta charset="utf-8"><title>Top Stories preview</title>
<style>
body{margin:0;background:#FFFCEC;color:#000;--font-inter-tight:'Inter Tight',system-ui}
main{max-width:1440px;margin:0 auto;padding:32px 44px 120px}
h1{font:700 13px/17px system-ui;margin:0 0 4px} .note{font:13px/17px system-ui;color:#0008;margin:0 0 32px}
.rl-pill{font:12px/1 system-ui;padding:5px 9px;border:1px solid #CFC9B8;border-radius:999px;color:#4A4640;white-space:nowrap}
.ts-debug{font-size:11px;color:#0007;margin:0}
${css}
</style>
<main>
<h1>Top Stories — dry run as of ${esc(asOf.toISOString().slice(0, 16).replace('T', ' '))} UTC</h1>
<p class="note">Page order and seven-day cutoff exactly as /api/top-stories applies them. The grey line under each story is test-only. Log pills are shown as a signed-in visitor sees them.</p>
<div class="ts-list">${page.map(storyHtml).join('') || '<p>No top stories.</p>'}</div>
</main>`)

// ── Report ──────────────────────────────────────────────────────────────────

const R = (id) => readings.get(id)
const line = (r) => `${r.publication_name} (${r.tier ?? '—'}) · ${r.published.slice(0, 10)} · ${r.category ?? '—'} — ${r.headline}`
const out = []
out.push(`# Top Stories dry run\n`)
out.push(`${readings.size} readings · test threshold ${TEST_THRESHOLD} (live ${MATCH_THRESHOLD}) · ${summary.llmCalls} Haiku calls · ${summary.embeddingTokens} Voyage tokens\n`)
out.push(`${groupList.length} groups formed · ${everyThreePlus.length} reached ${MIN_OUTLETS}+ outlets (not counting digests) · ${summary.splitSignals.length} split signals at join time · ${summary.digestsFlagged} readings flagged as digests\n`)

out.push(`\n## Every group\n`)
for (const g of [...groupList].sort((a, b) => b.outlet_count - a.outlet_count || a.first_published_at.localeCompare(b.first_published_at))) {
  out.push(`\n### ${g.id} — ${g.outlet_count} outlet(s)${g.lead_reading_id ? ' · TOP STORY' : ''}${g.lead_reading_id ? ` · lead: ${R(g.lead_reading_id).publication_name}` : ''}`)
  for (const r of members(g.id)) out.push(`- ${r.id === g.lead_reading_id ? '**LEAD** ' : ''}${r.is_digest ? '[digest — not counted] ' : ''}${line(r)}`)
}

const asked = log.filter((l) => l.sent_to_llm)
const yes = asked.filter((l) => l.llm_same_event)
const no = asked.filter((l) => l.llm_same_event === false)
out.push(`\n## Readings Haiku flagged as digests\n`)
for (const r of [...readings.values()].filter((r) => r.is_digest).sort((a, b) => a.published.localeCompare(b.published))) {
  out.push(`- ${line(r)}${r.story_group_id ? ` (in ${r.story_group_id})` : ''}`)
}

out.push(`\n## Where Haiku's answers fell\n`)
const bands = [[0.45, 0.5], [0.5, 0.55], [0.55, 0.6], [0.6, 0.65], [0.65, 0.7], [0.7, 0.8], [0.8, 1.01]]
out.push(`| similarity | asked | yes | no |\n|---|---|---|---|`)
for (const [lo, hi] of bands) {
  const inBand = asked.filter((l) => l.similarity >= lo && l.similarity < hi)
  out.push(`| ${lo.toFixed(2)}–${Math.min(hi, 1).toFixed(2)} | ${inBand.length} | ${inBand.filter((l) => l.llm_same_event).length} | ${inBand.filter((l) => l.llm_same_event === false).length} |`)
}

out.push(`\n## Near misses (highest similarity Haiku said no to)\n`)
for (const l of [...no].sort((a, b) => b.similarity - a.similarity).slice(0, 10)) {
  out.push(`- **${l.similarity.toFixed(3)}** — ${l.llm_reason}\n  - new: ${line(R(l.reading_id))}\n  - vs:  ${line(R(l.candidate_reading_id))}`)
}

out.push(`\n## Lowest-similarity yeses\n`)
for (const l of [...yes].sort((a, b) => a.similarity - b.similarity).slice(0, 8)) {
  out.push(`- **${l.similarity.toFixed(3)}** — ${l.llm_reason}\n  - new: ${line(R(l.reading_id))}\n  - vs:  ${line(R(l.candidate_reading_id))}`)
}

out.push(`\n## Split check\n`)
out.push(`Join-time signals (a reading confirmed against 2+ groups): ${summary.splitSignals.length}`)
for (const s of summary.splitSignals) out.push(`- ${line(R(s.readingId))} → ${s.groupIds.join(', ')}`)
out.push(`\nGroup pairs within ${WINDOW_DAYS} days whose closest pair is ≥ ${MATCH_THRESHOLD}: ${splitChecks.length}`)
for (const s of splitChecks) out.push(`- ${s.a} vs ${s.b} · ${s.best_similarity} · Haiku: ${s.same_event ? '**SAME EVENT**' : 'different'} — ${s.reason}`)

out.push(`\n## Page as of ${asOf.toISOString().slice(0, 16)} UTC\n`)
for (const s of page) {
  out.push(`- [${s.category}] ${s.outlet_count} outlets — **${s.lead.headline}** (${s.lead.publication_name})\n  More: ${s.more.map((m) => m.publication_name).join(', ')}`)
}

writeFileSync(join(outDir, 'report.md'), out.join('\n') + '\n')
console.log(`\nWrote ${outDir}/report.md, result.json, preview.html`)
console.log(`Groups: ${groupList.length} · Top Stories (3+): ${everyThreePlus.length} · on the page as of ${asOf.toISOString()}: ${page.length} · failed checks: ${summary.errors.length}`)
