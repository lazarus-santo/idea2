// Top Stories as story groups.
//
// A Top Story is three or more DIFFERENT outlets covering the same event,
// published within three days of each other. Different angles on one event
// (report, review, opinion, analysis) count; every category counts.
//
// HOW A READING FINDS ITS GROUP
//   1. Embed its headline + summary (lib/voyage.ts).
//   2. Compare it against every already-grouped-or-checked reading published
//      within WINDOW_DAYS either side of it.
//   3. The closest MAX_LLM_CANDIDATES at or above MATCH_THRESHOLD are sent to
//      Haiku in ONE call: "is the new article about the same event as this
//      story?" — once per candidate story, where a candidate already in a
//      group is represented by that group. The same call says whether the new
//      article is a DIGEST (see below).
//   4. It joins the closest story Haiku says yes to: a group, or a lone reading
//      it then starts a new group with. Groups never merge; a yes to two
//      different groups is counted (splitSignals) so it can be watched.
//   5. Every comparison is logged to story_match_log, above and below the
//      threshold, with Haiku's answer where one was asked.
//
// DIGESTS — round-ups of unrelated items ("Morning Links", "... and Other Art
// World Matters", "Industry Moves") — may join a group but never count as an
// outlet, never become the lead or a "More:" link, and never bring another
// article into a group: a digest cannot start a group, a lone digest is never
// offered as a match, and a group is described to Haiku by its non-digest
// members only. In the first dry run digests bridged unrelated stories and
// produced all three wrong Top Stories.
//
// Chaining is deliberate: a reading is compared with readings within three
// days of IT, not of the group's first article, so a story keeps growing for
// as long as coverage keeps arriving.
//
// THE LEAD is chosen the moment a group first reaches MIN_OUTLETS outlets —
// the tier-1 outlet's article, the earliest published if several are tier 1,
// otherwise the earliest published — and never changes after that
// (migration_v68 enforces it with a trigger). The group takes the lead's
// category.
//
// Everything that touches storage goes through StoryStore, so
// scripts/test-top-stories.mjs can run exactly this code against an in-memory
// store without writing to the database. This file only uses relative imports
// for the same reason.

import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { embedTexts, EMBEDDING_MODEL } from './voyage'
import { createAnthropic } from './ai-account'
import type { TopStory, TopStoryOutlet } from './types'

// Starting guess, to be tuned from story_match_log. Haiku confirms every
// match, so a low threshold only costs a few extra Haiku calls; a high one
// silently drops stories.
export const MATCH_THRESHOLD = 0.55
export const WINDOW_DAYS = 3
export const MIN_OUTLETS = 3
export const VISIBLE_DAYS = 7
export const MAX_LLM_CANDIDATES = 8
export const CONFIRM_MODEL = 'claude-haiku-4-5-20251001'

const DAY_MS = 86_400_000
// How many member headlines represent a group in the Haiku prompt.
const GROUP_CONTEXT_HEADLINES = 4

// ─── Types ───────────────────────────────────────────────────────────────────

export interface StoryReading {
  id: string
  headline: string
  summary: string | null
  article_url: string
  thumbnail_url: string | null
  author: string | null
  publication_id: string | null
  publication_name: string | null
  tier: string | null
  category: string | null
  // published_at, or created_at when the feed gave no date.
  published: string
  story_group_id: string | null
  // Set by Haiku when grouping runs for this reading; null when no Haiku call
  // was needed (nothing close enough), which is treated as not a digest.
  is_digest: boolean | null
}

export interface StoryGroup {
  id: string
  lead_reading_id: string | null
  lead_set_at: string | null
  first_published_at: string
  last_published_at: string
  outlet_count: number
}

export interface MatchLogRow {
  reading_id: string
  candidate_reading_id: string
  candidate_group_id: string | null
  similarity: number
  threshold_used: number
  sent_to_llm: boolean
  llm_same_event: boolean | null
  llm_reason: string | null
  embedding_model: string
  llm_model: string | null
}

export interface StoryStore {
  /** Readings grouping has not run for yet, oldest published first. */
  pending(limit: number): Promise<StoryReading[]>
  /** Already-checked readings published between from and to (inclusive). */
  window(from: string, to: string): Promise<StoryReading[]>
  embeddings(ids: string[]): Promise<Map<string, number[]>>
  saveEmbeddings(rows: Array<{ reading_id: string; embedding: number[] }>): Promise<void>
  group(id: string): Promise<StoryGroup | null>
  members(groupId: string): Promise<StoryReading[]>
  createGroup(g: Omit<StoryGroup, 'id'>): Promise<string>
  updateGroup(id: string, patch: Partial<Omit<StoryGroup, 'id'>>): Promise<void>
  assign(readingIds: string[], groupId: string): Promise<void>
  markChecked(readingId: string, isDigest: boolean | null): Promise<void>
  log(rows: MatchLogRow[]): Promise<void>
}

/** One candidate story shown to Haiku: a group, or a lone reading. */
export interface ConfirmTarget {
  key: string
  groupId: string | null
  readings: StoryReading[]
}

export interface ConfirmVerdict {
  key: string
  same_event: boolean
  reason: string
}

export interface ConfirmResult {
  isDigest: boolean
  verdicts: ConfirmVerdict[]
}

export type ConfirmFn = (reading: StoryReading, targets: ConfirmTarget[]) => Promise<ConfirmResult>

export interface GroupingSummary {
  checked: number
  embedded: number
  embeddingTokens: number
  llmCalls: number
  joinedGroup: number
  startedGroup: number
  leadsSet: number
  digestsFlagged: number
  // A reading Haiku matched to two or more DIFFERENT existing groups — the
  // shape a split story takes, since groups never merge.
  splitSignals: Array<{ readingId: string; groupIds: string[] }>
  stoppedForTime: boolean
  // The caller's shouldStop said so — an AI account problem (lib/ai-account.ts).
  // Whatever was not reached stays unchecked and is retried next run.
  stoppedForAccount: boolean
  errors: string[]
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb)
}

export function embeddingText(r: Pick<StoryReading, 'headline' | 'summary'>): string {
  return r.summary ? `${r.headline}\n${r.summary}` : r.headline
}

function byPublished(a: StoryReading, b: StoryReading): number {
  return a.published.localeCompare(b.published) || a.id.localeCompare(b.id)
}

/** A reading without a publication counts as its own outlet. */
export function outletKey(r: StoryReading): string {
  return r.publication_id ?? `reading:${r.id}`
}

/** The members that count: everything except digests. */
export function countable(members: StoryReading[]): StoryReading[] {
  return members.filter((r) => !r.is_digest)
}

export function countOutlets(members: StoryReading[]): number {
  return new Set(countable(members).map(outletKey)).size
}

/** Tier-1 article if any (earliest of those), otherwise the earliest. Never a digest. */
export function chooseLead(members: StoryReading[]): StoryReading {
  const sorted = countable(members).sort(byPublished)
  return sorted.find((r) => r.tier === 't1') ?? sorted[0]
}

// ─── Haiku confirmation ──────────────────────────────────────────────────────

const CONFIRM_SYSTEM = `You decide whether art-world news articles are about the same specific EVENT.

The same event means one specific occurrence: the same death, the same appointment or resignation, the same auction or sale, the same exhibition, the same lawsuit, theft, closure or controversy. Different angles on that one event count as the same event — a news report, a review, an opinion piece, an interview and an analysis about it all match.

A tribute, obituary, profile, retrospective look, reactions piece or analysis published BECAUSE OF an event covers that event, even if it is mostly about the person's life or career. So describe every article by its TRIGGERING EVENT — the occurrence that prompted it — never by its subject. A career profile of an artist published the week the artist dies is described as "the artist's death", not "the artist's career"; a piece on a museum's history published because its director resigned is "the director's resignation". Compare triggering events, not subjects.

NOT the same event: the same person, institution or topic in a different occurrence (two different auctions, two different shows by one artist, a museum's hiring and the same museum's later budget cut), or a broad trend piece that mentions the event in passing.

You get one NEW ARTICLE and a numbered list of CANDIDATE STORIES. Each candidate story is one or more headlines already known to cover a single event — do NOT judge whether a candidate's own headlines match each other; they always do. For each candidate, judge only whether the NEW ARTICLE is about that candidate's event.

A DIGEST bundles unrelated items in one post. It is a digest when its headline names two or more unrelated items ("Morning Links", "Industry Moves", "... and Other Art World Matters", "X, Y, and More"), or when its summary adds unrelated items with "Plus:", "Also:" or a similar hand-off to other news. It is NOT a digest when it is one story that mentions a related detail: an auction report that names a second lot from the same sales, a reactions piece about one death, a news story with background. A digest matches a story only if that story's event is named in the digest's own headline, not merely somewhere in its summary.

Also say whether the NEW ARTICLE itself is a digest, by that definition.

First name the new article's triggering event, then, for every candidate, name the candidate's triggering event and compare the two. Return ONLY this JSON object, no commentary:
{"new_article_event": "<triggering event, under 12 words>", "new_article_is_digest": true | false, "verdicts": [{"story": <number>, "story_event": "<triggering event, under 12 words>", "same_event": true | false}]}`

function describe(r: StoryReading): string {
  const summary = r.summary ? ` — ${r.summary.slice(0, 280)}` : ''
  return `${r.publication_name ?? 'Unknown outlet'}: ${r.headline}${summary}`
}

let _anthropic: Anthropic | null = null

export const haikuConfirm: ConfirmFn = async (reading, targets) => {
  _anthropic ??= createAnthropic()
  const stories = targets
    .map((t, i) => `[${i + 1}]\n${t.readings.map((r) => `  - ${describe(r)}`).join('\n')}`)
    .join('\n\n')

  const response = await _anthropic.messages.create({
    model: CONFIRM_MODEL,
    max_tokens: 800,
    system: CONFIRM_SYSTEM,
    messages: [{
      role: 'user',
      content: `NEW ARTICLE:\n  ${describe(reading)}\n\nCANDIDATE STORIES:\n${stories}`,
    }],
  })

  const text = response.content[0]?.type === 'text' ? response.content[0].text : ''
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error(`Unparseable confirmation (stop_reason: ${response.stop_reason})`)
  const parsed = JSON.parse(match[0]) as {
    new_article_event?: string
    new_article_is_digest?: boolean
    verdicts?: Array<{ story: number; story_event?: string; same_event: boolean }>
  }

  // Both descriptions go into the logged reason, so a wrong answer can be
  // traced to which side Haiku misread.
  const newEvent = String(parsed.new_article_event ?? '')
  const verdicts: ConfirmVerdict[] = []
  for (const p of parsed.verdicts ?? []) {
    const t = targets[p.story - 1]
    if (t) {
      verdicts.push({
        key: t.key,
        same_event: p.same_event === true,
        reason: `new: ${newEvent} | story: ${String(p.story_event ?? '')}`,
      })
    }
  }
  // A story Haiku skipped is a no, not a crash: logged with an empty reason.
  for (const t of targets) {
    if (!verdicts.some((v) => v.key === t.key)) verdicts.push({ key: t.key, same_event: false, reason: '' })
  }
  return { isDigest: parsed.new_article_is_digest === true, verdicts }
}

// ─── The grouping pass ───────────────────────────────────────────────────────

export interface GroupingOptions {
  threshold?: number
  confirm?: ConfirmFn
  limit?: number
  /** Stop starting new readings after this long; the rest wait for the next run. */
  timeBudgetMs?: number
  /** Checked before embedding and before each reading; true stops the pass, leaving the rest unchecked. */
  shouldStop?: () => boolean
}

export async function assignStoryGroups(store: StoryStore, opts: GroupingOptions = {}): Promise<GroupingSummary> {
  const threshold = opts.threshold ?? MATCH_THRESHOLD
  const confirm = opts.confirm ?? haikuConfirm
  const started = Date.now()
  const summary: GroupingSummary = {
    checked: 0, embedded: 0, embeddingTokens: 0, llmCalls: 0,
    joinedGroup: 0, startedGroup: 0, leadsSet: 0, digestsFlagged: 0,
    splitSignals: [], stoppedForTime: false, stoppedForAccount: false, errors: [],
  }

  const pending = await store.pending(opts.limit ?? 500)
  if (pending.length === 0) return summary
  if (opts.shouldStop?.()) {
    summary.stoppedForAccount = true
    return summary
  }

  // Embed everything pending up front, in batches. If Voyage is down nothing
  // is marked checked, so the whole batch is retried next run.
  const vectors = await store.embeddings(pending.map((r) => r.id))
  const missing = pending.filter((r) => !vectors.has(r.id))
  if (missing.length > 0) {
    try {
      const { embeddings, tokens } = await embedTexts(missing.map(embeddingText))
      const rows = missing.map((r, i) => ({ reading_id: r.id, embedding: embeddings[i] }))
      await store.saveEmbeddings(rows)
      for (const row of rows) vectors.set(row.reading_id, row.embedding)
      summary.embedded = rows.length
      summary.embeddingTokens = tokens
    } catch (err) {
      summary.errors.push(`embedding: ${err instanceof Error ? err.message : String(err)}`)
      return summary
    }
  }

  for (const reading of pending) {
    if (opts.timeBudgetMs && Date.now() - started > opts.timeBudgetMs) {
      summary.stoppedForTime = true
      break
    }
    if (opts.shouldStop?.()) {
      summary.stoppedForAccount = true
      break
    }
    try {
      await groupOne(reading, store, vectors, threshold, confirm, summary)
      summary.checked++
    } catch (err) {
      // Left unchecked: retried on the next run.
      summary.errors.push(`${reading.headline}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return summary
}

async function groupOne(
  reading: StoryReading,
  store: StoryStore,
  vectors: Map<string, number[]>,
  threshold: number,
  confirm: ConfirmFn,
  summary: GroupingSummary
): Promise<void> {
  const at = new Date(reading.published).getTime()
  const window = (await store.window(
    new Date(at - WINDOW_DAYS * DAY_MS).toISOString(),
    new Date(at + WINDOW_DAYS * DAY_MS).toISOString()
  )).filter((c) => c.id !== reading.id)

  const unseen = window.filter((c) => !vectors.has(c.id)).map((c) => c.id)
  if (unseen.length > 0) {
    for (const [id, v] of await store.embeddings(unseen)) vectors.set(id, v)
  }

  const own = vectors.get(reading.id)
  if (!own) throw new Error('no embedding')

  const scored = window
    .filter((c) => vectors.has(c.id))
    .map((c) => ({ c, similarity: cosine(own, vectors.get(c.id)!) }))
    .sort((a, b) => b.similarity - a.similarity)

  // The closest candidates above the threshold, collapsed into the stories
  // they belong to. Several close readings in one group are one question. A
  // lone digest is never offered: matching it would start a group on it.
  const close = scored
    .filter((s) => s.similarity >= threshold && (s.c.story_group_id || !s.c.is_digest))
    .slice(0, MAX_LLM_CANDIDATES)
  const targets: ConfirmTarget[] = []
  const bestSim = new Map<string, number>()
  for (const { c, similarity } of close) {
    const key = c.story_group_id ? `group:${c.story_group_id}` : `reading:${c.id}`
    if (!bestSim.has(key)) {
      bestSim.set(key, similarity)
      targets.push({
        key,
        groupId: c.story_group_id,
        readings: c.story_group_id ? await groupContext(store, c.story_group_id) : [c],
      })
    }
  }

  let verdicts: ConfirmVerdict[] = []
  let isDigest: boolean | null = null
  if (targets.length > 0) {
    const result = await confirm(reading, targets)
    verdicts = result.verdicts
    isDigest = result.isDigest
    summary.llmCalls++
    if (isDigest) summary.digestsFlagged++
  }
  const verdictFor = new Map(verdicts.map((v) => [v.key, v]))

  await store.log(scored.map(({ c, similarity }) => {
    const key = c.story_group_id ? `group:${c.story_group_id}` : `reading:${c.id}`
    const asked = close.some((s) => s.c.id === c.id)
    const v = asked ? verdictFor.get(key) : undefined
    return {
      reading_id: reading.id,
      candidate_reading_id: c.id,
      candidate_group_id: c.story_group_id,
      similarity: Number(similarity.toFixed(4)),
      threshold_used: threshold,
      sent_to_llm: asked,
      llm_same_event: v ? v.same_event : null,
      llm_reason: v ? v.reason : null,
      embedding_model: EMBEDDING_MODEL,
      llm_model: asked ? CONFIRM_MODEL : null,
    }
  }))

  const yes = targets.filter((t) => verdictFor.get(t.key)?.same_event)
  const yesGroups = [...new Set(yes.map((t) => t.groupId).filter((g): g is string => g !== null))]
  if (yesGroups.length >= 2) summary.splitSignals.push({ readingId: reading.id, groupIds: yesGroups })

  // targets are already in closest-first order. A digest may only join an
  // existing group — it never starts one — so it skips confirmed lone readings.
  const chosen = isDigest ? yes.find((t) => t.groupId) : yes[0]
  if (chosen) {
    const self = { ...reading, is_digest: isDigest }
    let groupId: string
    if (chosen.groupId) {
      groupId = chosen.groupId
      await store.assign([reading.id], groupId)
      summary.joinedGroup++
    } else {
      const pair = [chosen.readings[0], self].sort(byPublished)
      groupId = await store.createGroup({
        lead_reading_id: null,
        lead_set_at: null,
        first_published_at: pair[0].published,
        last_published_at: pair[1].published,
        outlet_count: countOutlets(pair),
      })
      await store.assign(pair.map((r) => r.id), groupId)
      summary.startedGroup++
    }
    // Recorded before the group is recomputed, so this reading's digest flag
    // is already in place when outlets and the lead are worked out.
    await store.markChecked(reading.id, isDigest)
    if (await refreshGroup(store, groupId)) summary.leadsSet++
    return
  }

  await store.markChecked(reading.id, isDigest)
}

/** The lead (if set) first, then the earliest members. Digests are left out. */
async function groupContext(store: StoryStore, groupId: string): Promise<StoryReading[]> {
  const [group, members] = await Promise.all([store.group(groupId), store.members(groupId)])
  const sorted = countable(members).sort(byPublished)
  const lead = sorted.find((r) => r.id === group?.lead_reading_id)
  const ordered = lead ? [lead, ...sorted.filter((r) => r.id !== lead.id)] : sorted
  return ordered.slice(0, GROUP_CONTEXT_HEADLINES)
}

/** Recompute dates and outlet count; set the lead once. Returns true if the lead was set now. */
async function refreshGroup(store: StoryStore, groupId: string): Promise<boolean> {
  const [group, members] = await Promise.all([store.group(groupId), store.members(groupId)])
  // Dates, outlets and the lead come from the members that count. A group is
  // only ever started from two non-digest readings, so there is always one.
  const sorted = countable(members).sort(byPublished)
  if (!group || sorted.length === 0) return false
  const outlets = countOutlets(members)
  const patch: Partial<Omit<StoryGroup, 'id'>> = {
    first_published_at: sorted[0].published,
    last_published_at: sorted[sorted.length - 1].published,
    outlet_count: outlets,
  }
  let leadSet = false
  if (!group.lead_reading_id && outlets >= MIN_OUTLETS) {
    patch.lead_reading_id = chooseLead(members).id
    patch.lead_set_at = new Date().toISOString()
    leadSet = true
  }
  await store.updateGroup(groupId, patch)
  return leadSet
}

// ─── What the page shows ─────────────────────────────────────────────────────

const CATEGORY_RANK: Record<string, number> = {
  breaking_news: 0,
  art_market: 1,
  institutional_news: 2,
}

function toOutlet(r: StoryReading): TopStoryOutlet {
  return {
    reading_id: r.id,
    publication_name: r.publication_name,
    headline: r.headline,
    article_url: r.article_url,
  }
}

/**
 * Visible Top Stories, in page order: groups with a lead (so 3+ outlets)
 * whose first article is under VISIBLE_DAYS old. breaking_news, then
 * art_market, then institutional_news, then everything else; within a
 * category more outlets first; then the newer story first.
 */
export function buildTopStories(
  groups: StoryGroup[],
  membersByGroup: Map<string, StoryReading[]>,
  now: Date = new Date()
): TopStory[] {
  const cutoff = now.getTime() - VISIBLE_DAYS * DAY_MS
  const stories: TopStory[] = []

  for (const g of groups) {
    if (!g.lead_reading_id || g.outlet_count < MIN_OUTLETS) continue
    if (new Date(g.first_published_at).getTime() <= cutoff) continue
    const members = countable(membersByGroup.get(g.id) ?? []).sort(byPublished)
    const lead = members.find((r) => r.id === g.lead_reading_id)
    if (!lead) continue

    // One link per other outlet: its earliest article on the story.
    const seen = new Set([outletKey(lead)])
    const more: TopStoryOutlet[] = []
    for (const r of members) {
      if (seen.has(outletKey(r))) continue
      seen.add(outletKey(r))
      more.push(toOutlet(r))
    }

    stories.push({
      id: g.id,
      category: lead.category,
      outlet_count: g.outlet_count,
      first_published_at: g.first_published_at,
      // No summary: nothing on the page is text the outlet's feed or a model
      // wrote — only the headline, outlet, author and image.
      lead: {
        ...toOutlet(lead),
        author: lead.author,
        thumbnail_url: lead.thumbnail_url,
      },
      more,
    })
  }

  return stories.sort((a, b) =>
    (CATEGORY_RANK[a.category ?? ''] ?? 3) - (CATEGORY_RANK[b.category ?? ''] ?? 3) ||
    b.outlet_count - a.outlet_count ||
    b.first_published_at.localeCompare(a.first_published_at)
  )
}

// ─── Supabase-backed store ───────────────────────────────────────────────────

const READING_COLUMNS =
  'id, headline, rss_summary, article_url, thumbnail_url, author, publication_id, tier, category, ' +
  'published_at, created_at, story_group_id, story_is_digest, publications(name, tier)'

interface ReadingRow {
  id: string
  headline: string
  rss_summary: string | null
  article_url: string
  thumbnail_url: string | null
  author: string | null
  publication_id: string | null
  tier: string | null
  category: string | null
  published_at: string | null
  created_at: string
  story_group_id: string | null
  story_is_digest: boolean | null
  publications: { name: string | null; tier: string | null } | null
}

export function toStoryReading(row: ReadingRow): StoryReading {
  return {
    id: row.id,
    headline: row.headline,
    summary: row.rss_summary,
    article_url: row.article_url,
    thumbnail_url: row.thumbnail_url,
    author: row.author,
    publication_id: row.publication_id,
    publication_name: row.publications?.name ?? null,
    // The outlet's current tier; the reading's own snapshot if it has none.
    tier: row.publications?.tier ?? row.tier,
    category: row.category,
    published: new Date(row.published_at ?? row.created_at).toISOString(),
    story_group_id: row.story_group_id,
    is_digest: row.story_is_digest,
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function check<T>(result: { data: T; error: { message: string } | null }, what: string): T {
  if (result.error) throw new Error(`${what}: ${result.error.message}`)
  return result.data
}

export function supabaseStoryStore(db: SupabaseClient): StoryStore {
  return {
    async pending(limit) {
      const rows = check(await db.from('readings').select(READING_COLUMNS)
        .is('story_checked_at', null)
        .order('published_at', { ascending: true, nullsFirst: true })
        .limit(limit), 'pending readings') as unknown as ReadingRow[]
      return rows.map(toStoryReading).sort(byPublished)
    },

    async window(from, to) {
      const f = `"${from}"`, t = `"${to}"`
      const rows = check(await db.from('readings').select(READING_COLUMNS)
        .not('story_checked_at', 'is', null)
        .or(`and(published_at.gte.${f},published_at.lte.${t}),and(published_at.is.null,created_at.gte.${f},created_at.lte.${t})`)
        .limit(1000), 'window readings') as unknown as ReadingRow[]
      return rows.map(toStoryReading)
    },

    async embeddings(ids) {
      const map = new Map<string, number[]>()
      for (const part of chunk(ids, 100)) {
        const rows = check(await db.from('reading_embeddings').select('reading_id, embedding')
          .eq('model', EMBEDDING_MODEL).in('reading_id', part), 'embeddings') as Array<{ reading_id: string; embedding: number[] }>
        for (const r of rows) map.set(r.reading_id, r.embedding)
      }
      return map
    },

    async saveEmbeddings(rows) {
      for (const part of chunk(rows, 50)) {
        check(await db.from('reading_embeddings')
          .upsert(part.map((r) => ({ ...r, model: EMBEDDING_MODEL })), { onConflict: 'reading_id' }), 'save embeddings')
      }
    },

    async group(id) {
      return check(await db.from('story_groups').select('*').eq('id', id).maybeSingle(), 'group') as StoryGroup | null
    },

    async members(groupId) {
      const rows = check(await db.from('readings').select(READING_COLUMNS)
        .eq('story_group_id', groupId), 'group members') as unknown as ReadingRow[]
      return rows.map(toStoryReading)
    },

    async createGroup(g) {
      const row = check(await db.from('story_groups').insert(g).select('id').single(), 'create group') as { id: string }
      return row.id
    },

    async updateGroup(id, patch) {
      check(await db.from('story_groups').update(patch).eq('id', id), 'update group')
    },

    async assign(readingIds, groupId) {
      check(await db.from('readings').update({ story_group_id: groupId }).in('id', readingIds), 'assign group')
    },

    async markChecked(readingId, isDigest) {
      check(await db.from('readings').update({
        story_checked_at: new Date().toISOString(),
        story_is_digest: isDigest,
      }).eq('id', readingId), 'mark checked')
    },

    async log(rows) {
      for (const part of chunk(rows, 200)) {
        check(await db.from('story_match_log').insert(part), 'match log')
      }
    },
  }
}

/** Visible Top Stories straight from the database, in page order. */
export async function loadTopStories(db: SupabaseClient, now: Date = new Date()): Promise<TopStory[]> {
  const cutoff = new Date(now.getTime() - VISIBLE_DAYS * DAY_MS).toISOString()
  const groups = check(await db.from('story_groups').select('*')
    .not('lead_reading_id', 'is', null)
    .gte('outlet_count', MIN_OUTLETS)
    .gt('first_published_at', cutoff), 'top story groups') as StoryGroup[]
  if (groups.length === 0) return []

  const membersByGroup = new Map<string, StoryReading[]>()
  for (const part of chunk(groups.map((g) => g.id), 100)) {
    const rows = check(await db.from('readings').select(READING_COLUMNS)
      .in('story_group_id', part), 'top story members') as unknown as ReadingRow[]
    for (const r of rows.map(toStoryReading)) {
      const list = membersByGroup.get(r.story_group_id!) ?? []
      list.push(r)
      membersByGroup.set(r.story_group_id!, list)
    }
  }
  return buildTopStories(groups, membersByGroup, now)
}
