// Agent 2 — preread / coverage generation, driven by exhibitions.preread_status.
//
// Source: the "Revamped Agent 2 Triggers + Schema Changes" Miro board. Every
// trigger goes through runAgent2ForExhibition, so the run / skip / block /
// repair rules live here once:
//
//   Trigger 1  Agent 1 adds or re-scrapes a show     → mode 'auto'
//   Trigger 2  POST /api/admin/audit-prereads (Run Now) → mode 'auto', per show
//   Trigger 3A admin Retrigger                        → mode 'retrigger'
//   Trigger 3B admin Replace                          → replacePreread
//   Trigger 3C admin Blank / Activate                 → setPrereadRowStatus
//
// preread_status, as each mode reads it:
//
//                          auto                    retrigger
//   NULL, error            block check → generate  block check → generate
//   pending_*              skip (admin unblocks)   block check → generate
//   empty                  skip                    block check → generate
//   success                skip                    skip (use Replace per row)
//   needs_review           repair flagged rows     block check → repair
//
// A Retrigger never runs past a block: the missing field is checked again every
// time, so "unblocking" a show means filling the field in, then Retriggering.
//
// The quality_flag → row_status = 'blanked' rule is enforced by a database
// trigger (migration_v53), not here, so no write path can forget it.

import { getSupabaseAdmin } from './supabase'
import {
  generatePrereads,
  recheckPreread,
  findReplacementPreread,
  prereadSubject,
  searchGalleryShowReview,
  searchMuseumGroupShowReview,
  showReviewPendingUntil,
  isShowReviewDue,
  nextShowReviewStatus,
  type PrereadRepairContext,
  type MuseumRepairKind,
  type ShowReviewResult,
  type ShowReviewStatus,
} from './claude'
import {
  generateMuseumCoverage,
  searchMuseumSoloShowReview,
  museumRepairContext,
  generateFairCoverage,
  crossLinkCoverageToReadings,
  coverageItemToPrereadRow,
} from './museum-coverage'
import type { AgentRunError } from './agent-runs'
import type { PrereadStatus, QualityFlag, RowStatus } from './types'

export type Agent2Mode = 'auto' | 'retrigger'

/** Which generator a show goes through — by institution type, per the spec. */
export type Agent2Path = 'gallery' | 'museum' | 'fair'

export type Agent2Action = 'generated' | 'repaired' | 'skipped' | 'blocked' | 'failed'

export interface Agent2Outcome {
  exhibitionId: string
  showTitle: string
  path: Agent2Path
  action: Agent2Action
  statusBefore: PrereadStatus | null
  statusAfter: PrereadStatus | null
  rowsAdded: number
  rowsRepaired: number
  /** Flagged rows a repair pass could not fix. */
  rowsStillFlagged: number
  /** Plain-language line for the admin UI and run logs. */
  message: string
  /** The show's missing_fields at the time of the run — shown as warnings in admin. */
  missingFields: string[]
}

// ─── Loading ──────────────────────────────────────────────────────────────────

const EXHIBITION_SELECT = `
  id, show_title, press_release, preread_status, missing_fields, start_date,
  show_review_pending_until, show_review_attempted_at, show_review_status,
  preread_retry_artists,
  venues!inner(name, exhibitions_url, institutions(name, type)),
  exhibition_artists(artists!inner(name))
`

interface LoadedExhibition {
  ctx: PrereadRepairContext
  path: Agent2Path
  status: PrereadStatus | null
  missingFields: string[]
  institutionName: string
  startDate: string | null
  /** migration_v55/v56 — the 14-day show-review gate (gallery solo + small group). */
  showReview: { pendingUntil: string | null; attemptedAt: string | null; status: ShowReviewStatus | null }
  /** migration_v58 — group-show artists whose search failed last run; the retry searches only them. */
  retryArtists: string[]
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toLoaded(raw: any): LoadedExhibition {
  const type = raw.venues?.institutions?.type as string | undefined
  const path: Agent2Path = type === 'museum' ? 'museum' : type === 'fair' ? 'fair' : 'gallery'
  return {
    ctx: {
      exhibition_id: raw.id,
      show_title: raw.show_title,
      artists: (raw.exhibition_artists ?? [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((ea: any) => ea.artists?.name)
        .filter(Boolean) as string[],
      press_release: raw.press_release ?? null,
      venue_name: raw.venues.name,
      venue_url: raw.venues.exhibitions_url ?? null,
    },
    path,
    status: (raw.preread_status ?? null) as PrereadStatus | null,
    missingFields: (raw.missing_fields ?? []) as string[],
    institutionName: raw.venues.institutions?.name ?? raw.venues.name,
    startDate: raw.start_date ?? null,
    showReview: {
      pendingUntil: raw.show_review_pending_until ?? null,
      attemptedAt: raw.show_review_attempted_at ?? null,
      status: (raw.show_review_status ?? null) as ShowReviewStatus | null,
    },
    retryArtists: (raw.preread_retry_artists ?? []) as string[],
  }
}

/**
 * Thrown by generate() AFTER it has stored what it found, when some group-show artist
 * searches never got an answer. The caller marks the show 'error'; the next run
 * searches only those artists (preread_retry_artists).
 */
class ArtistRetryPending extends Error {
  constructor(public rowsAdded: number, public artists: string[], searchErrors: string[]) {
    super(`${artists.length} artist search(es) failed and will be retried (${artists.join(', ')}): ${searchErrors.join(' | ')}`)
  }
}

const GROUP_ARTIST_CAP = 5

/**
 * On the 14-day show-review gate: every gallery-path show with artists (solo, small
 * and large group) and every museum show — a group show or historical solo show,
 * whose only coverage IS the show review, and a contemporary solo show (gallery's S4).
 */
function isOnShowReviewGate(ex: LoadedExhibition): boolean {
  if (ex.path === 'gallery') return ex.ctx.artists.length >= 1
  return ex.path === 'museum'
}

/** The show's review date: stored, or its opening + 14 days. */
function gatePendingUntil(ex: LoadedExhibition): string {
  return ex.showReview.pendingUntil ?? showReviewPendingUntil(ex.startDate)
}

// Records the gate after a main run: the date always, the attempt only if it ran.
async function recordShowReviewGate(ex: LoadedExhibition, pendingUntil: string, showReview: { ran: boolean; result: ShowReviewResult | null } | undefined): Promise<void> {
  const { error } = await getSupabaseAdmin().from('exhibitions').update({
    show_review_pending_until: pendingUntil,
    ...(showReview?.ran && showReview.result ? {
      show_review_attempted_at: new Date().toISOString(),
      show_review_status: nextShowReviewStatus(ex.showReview.status, showReview.result),
    } : {}),
  }).eq('id', ex.ctx.exhibition_id)
  if (error) throw new Error(`Failed to record show-review gate: ${error.message}`)
}

// Which review search a museum show's gate runs: gallery's S4 for a contemporary solo
// show, the group show's for a group or historical solo show. The era isn't stored,
// so a solo show's is decided again here (museumRepairContext, the same three tiers).
async function museumReviewSearchKind(ex: LoadedExhibition): Promise<MuseumRepairKind> {
  return (await museumRepairContext(ex.ctx, ex.institutionName)).museum!.kind
}

function museumReviewContext(ex: LoadedExhibition) {
  return { ...ex.ctx, institution_name: ex.institutionName }
}

async function loadExhibition(exhibitionId: string): Promise<LoadedExhibition> {
  const { data, error } = await getSupabaseAdmin()
    .from('exhibitions')
    .select(EXHIBITION_SELECT)
    .eq('id', exhibitionId)
    .single()
  if (error || !data) throw new Error(`Exhibition ${exhibitionId} not found: ${error?.message ?? 'no row'}`)
  return toLoaded(data)
}

// ─── Blocking ─────────────────────────────────────────────────────────────────

// A press release can arrive as HTML from the rich-text editor; "<p></p>" is empty.
function hasText(html: string | null): boolean {
  return !!html && html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').trim().length > 0
}

// Gallery-path shows (galleries, nonprofits, experimental spaces) need both artists
// and a press release — the search is built on artist names and the press release
// is what the quality check verifies the show against. Museums and fairs are never
// blocked: a museum show with no artists is a group show (searched by title + venue) and fairs have no
// artists at all. Artists are checked first, so a show missing both reads as
// pending_artists; the admin warnings list both missing fields regardless.
function blockingStatus(ex: LoadedExhibition): PrereadStatus | null {
  if (ex.path !== 'gallery') return null
  if (ex.ctx.artists.length === 0) return 'pending_artists'
  if (!hasText(ex.ctx.press_release)) return 'pending_press_release'
  return null
}

function blockWarnings(ex: LoadedExhibition): string[] {
  if (ex.path !== 'gallery') return ex.missingFields
  const extra: string[] = []
  if (ex.ctx.artists.length === 0 && !ex.missingFields.includes('artists')) extra.push('artists')
  if (!hasText(ex.ctx.press_release) && !ex.missingFields.includes('press_release')) extra.push('press_release')
  return [...ex.missingFields, ...extra]
}

// ─── Status ───────────────────────────────────────────────────────────────────

/** Exported for the fair admin routes, which run fair coverage outside runAgent2ForExhibition. */
export async function setPrereadStatus(exhibitionId: string, status: PrereadStatus): Promise<void> {
  return setStatus(exhibitionId, status)
}

async function setStatus(exhibitionId: string, status: PrereadStatus): Promise<void> {
  const { error } = await getSupabaseAdmin().from('exhibitions').update({ preread_status: status }).eq('id', exhibitionId)
  if (error) throw new Error(`Failed to set preread_status: ${error.message}`)
}

/**
 * Derives the exhibition-level status from its rows: any row with a quality_flag →
 * needs_review; otherwise any row → success; no rows → empty. row_status plays no
 * part — an admin blanking a clean row is an editorial choice, not a failure, and
 * reactivating a flagged row does not make its flag go away.
 */
export async function recomputePrereadStatus(exhibitionId: string): Promise<PrereadStatus> {
  const { data, error } = await getSupabaseAdmin()
    .from('prereads')
    .select('quality_flag')
    .eq('exhibition_id', exhibitionId)
  if (error) throw new Error(`Failed to read prereads: ${error.message}`)
  const rows = data ?? []
  const status: PrereadStatus =
    rows.some((r) => r.quality_flag !== null) ? 'needs_review'
      : rows.length > 0 ? 'success'
        : 'empty'
  await setStatus(exhibitionId, status)
  return status
}

// ─── Generation ───────────────────────────────────────────────────────────────

// Artist pieces already stored, counted cautiously: every stored row, minus one only
// when the show review is known to be among them. artist_name can't be used — rows
// from before it was recorded have it NULL (all 3 of Fiber Thinks!' on 2026-09-18),
// which would make a retry think every slot was open. Over-counting only ever leaves a
// slot unused; under-counting could push a show past 1 + 5.
async function storedArtistRowCount(ex: LoadedExhibition): Promise<number> {
  const { count, error } = await getSupabaseAdmin().from('prereads').select('id', { count: 'exact', head: true })
    .eq('exhibition_id', ex.ctx.exhibition_id)
  if (error) throw new Error(`Failed to count stored pieces: ${error.message}`)
  return Math.max(0, (count ?? 0) - (ex.showReview.status === 'found' ? 1 : 0))
}

async function existingUrls(exhibitionId: string): Promise<Set<string>> {
  const { data, error } = await getSupabaseAdmin().from('prereads').select('article_url').eq('exhibition_id', exhibitionId)
  if (error) throw new Error(`Failed to read prereads: ${error.message}`)
  return new Set((data ?? []).map((r) => r.article_url as string | null).filter((u): u is string => !!u))
}

// Runs the generator for the show's path and inserts what it found. Rows already
// stored for the show (an admin's manual additions, or a partial earlier run) are
// kept and never duplicated. Throws on generator or insert failure; the caller turns
// that into preread_status = 'error'. Returns the generator's block instead of a
// count when it refused to search (blockingStatus should have caught it first).
async function generate(ex: LoadedExhibition): Promise<number | 'pending_artists'> {
  const db = getSupabaseAdmin()
  const id = ex.ctx.exhibition_id
  const have = await existingUrls(id)

  if (ex.path === 'gallery') {
    const gated = isOnShowReviewGate(ex)
    const pendingUntil = gated ? gatePendingUntil(ex) : null
    // A group show left in 'error' by failed artist searches: search only those artists,
    // for only the artist slots still open (large group's 5).
    const retryArtists = ex.status === 'error' && ex.ctx.artists.length >= 2
      ? ex.retryArtists.filter((a) => ex.ctx.artists.includes(a))
      : []
    const retry = retryArtists.length > 0
      ? { artists: retryArtists, artistSlots: Math.max(0, GROUP_ARTIST_CAP - await storedArtistRowCount(ex)) }
      : undefined
    const { prereads, hasShowCoverage, blocked, showReview, retryArtists: stillFailing, searchErrors } = await generatePrereads({
      show_title: ex.ctx.show_title,
      artists: ex.ctx.artists,
      start_date: ex.startDate,
      end_date: null,
      description: null,
      press_release: ex.ctx.press_release,
      image_url: null,
      venue_name: ex.ctx.venue_name,
      venue_url: ex.ctx.venue_url,
      exhibition_id: id,
      show_review_due: gated && isShowReviewDue(pendingUntil, ex.showReview.attemptedAt, ex.showReview.status),
      retry,
    })
    if (blocked) return blocked
    const fresh = prereads.filter((p) => !p.article_url || !have.has(p.article_url))
    if (fresh.length > 0) {
      const { error } = await db.from('prereads').insert(fresh.map((p) => ({ ...p, exhibition_id: id })))
      if (error) throw new Error(`Failed to insert prereads: ${error.message}`)
    }
    if (gated) await recordShowReviewGate(ex, pendingUntil!, showReview)
    // Carried over from Agent 1's old inline block: a gallery show with no show-level
    // review gets 'show_coverage' in missing_fields. A gated show whose review hasn't run
    // yet isn't missing it — it's waiting for it.
    const showReviewPending = gated && !showReview?.ran
    if (!hasShowCoverage && !showReviewPending && !ex.missingFields.includes('show_coverage')) {
      await db.from('exhibitions').update({ missing_fields: [...ex.missingFields, 'show_coverage'] }).eq('id', id)
    }
    // Everything found is stored above. Artists whose search never got an answer are
    // recorded for the retry (cleared when none are left), and the show goes to 'error'.
    const pendingRetry = stillFailing ?? []
    if (pendingRetry.length > 0 || ex.retryArtists.length > 0) {
      const { error } = await db.from('exhibitions').update({ preread_retry_artists: pendingRetry.length > 0 ? pendingRetry : null }).eq('id', id)
      if (error) throw new Error(`Failed to record artists to retry: ${error.message}`)
    }
    if (pendingRetry.length > 0) throw new ArtistRetryPending(fresh.length, pendingRetry, searchErrors ?? [])
    return fresh.length
  }

  if (ex.path === 'museum') {
    // Solo: contemporary/historical (3 tiers), then the gallery solo ladder
    // (contemporary) or the show review only (historical). Group show: the show review
    // only. Every museum show is gated at 14 days.
    const pendingUntil = gatePendingUntil(ex)
    const r = await generateMuseumCoverage({
      exhibitionId: id,
      showTitle: ex.ctx.show_title,
      venueName: ex.ctx.venue_name,
      institutionName: ex.institutionName,
      venueUrl: ex.ctx.venue_url,
      artists: ex.ctx.artists,
      pressRelease: ex.ctx.press_release,
      showReviewDue: isShowReviewDue(pendingUntil, ex.showReview.attemptedAt, ex.showReview.status),
    })
    // Needs migration_v59: the old CHECK only allows the Type A-D values.
    const { error: typeError } = await db.from('exhibitions').update({ coverage_type: r.coverageType }).eq('id', id)
    if (typeError) throw new Error(`Failed to record coverage_type: ${typeError.message}`)
    const fresh = r.prereads.filter((p) => !p.article_url || !have.has(p.article_url))
    if (fresh.length > 0) {
      const { error } = await db.from('prereads').insert(fresh.map((p) => ({ ...p, exhibition_id: id })))
      if (error) throw new Error(`Failed to insert coverage: ${error.message}`)
      await crossLinkCoverageToReadings(id, fresh.map((p) => ({ url: p.article_url })))
    }
    if (r.showReview) await recordShowReviewGate(ex, pendingUntil, r.showReview)
    return fresh.length
  }

  const coverage = await generateFairCoverage(ex.institutionName, id)

  const fresh = coverage.filter((c) => !have.has(c.url))
  if (fresh.length > 0) {
    const { error } = await db.from('prereads').insert(fresh.map((c) => coverageItemToPrereadRow(id, c)))
    if (error) throw new Error(`Failed to insert coverage: ${error.message}`)
    await crossLinkCoverageToReadings(id, fresh)
  }
  return fresh.length
}

// ─── Repair ───────────────────────────────────────────────────────────────────

interface StoredPreread {
  id: string
  exhibition_id: string
  article_url: string | null
  article_title: string | null
  summary: string | null
  artist_name: string | null
  item_coverage_type: string | null
  quality_flag: QualityFlag | null
  row_status: RowStatus
  /** migration_v60 — a flagged row only a person may repair (Replace); automatic repair skips it. */
  repair_hold: boolean
}

const PREREAD_SELECT = 'id, exhibition_id, article_url, article_title, summary, artist_name, item_coverage_type, quality_flag, row_status, repair_hold'

type RowRepairResult =
  | { repaired: true; how: 'rechecked' | 'replaced' }
  | { repaired: false; flag: QualityFlag | null; note: string }

// One row: re-check the article already there first (no search needed if the only
// problem was a check that failed to run), then look for a replacement. A repaired
// row gets quality_flag NULL and row_status 'active' in one write — the replacement
// article is new, so a blank that existed only because of the old flag goes with it.
async function repairRow(
  ex: LoadedExhibition,
  row: StoredPreread,
  opts: { recheckFirst: boolean; customQuery?: string | null; excludeUrls: Set<string> }
): Promise<RowRepairResult> {
  const db = getSupabaseAdmin()

  let recheckFlag: QualityFlag | null = null
  if (opts.recheckFirst) {
    const verdict = await recheckPreread(ex.ctx, row)
    if (verdict === 'pass') {
      const { error } = await db.from('prereads').update({ quality_flag: null, row_status: 'active', repair_hold: false }).eq('id', row.id)
      if (error) throw new Error(`Failed to update preread: ${error.message}`)
      return { repaired: true, how: 'rechecked' }
    }
    recheckFlag = verdict
  }

  const subject = prereadSubject(ex.ctx, row.artist_name, row.item_coverage_type)
  const found = await findReplacementPreread(ex.ctx, subject, opts.excludeUrls, opts.customQuery)
  if (found.ok) {
    const { error } = await db.from('prereads').update({
      ...found.row,
      // A per-artist row stays bound to its artist even if the replacement came from
      // a custom query that didn't name them.
      artist_name: row.artist_name ?? found.row.artist_name ?? null,
      quality_flag: null,
      row_status: 'active',
      repair_hold: false,
    }).eq('id', row.id)
    if (error) throw new Error(`Failed to update preread: ${error.message}`)
    // Two flagged rows repaired in one pass must not both land on this article.
    if (found.row.article_url) opts.excludeUrls.add(found.row.article_url)
    return { repaired: true, how: 'replaced' }
  }

  // Why the repair failed: the replacement search's own reason if it judged
  // something, else the re-check's verdict on the existing article.
  const flag = found.flag ?? recheckFlag
  const note = found.flag
    ? `best replacement for "${found.query}" was ${found.flag}`
    : `no usable replacement found for "${found.query}"`
  return { repaired: false, flag, note }
}

// A museum show is repaired with its own search and check (museumRepairContext
// decides which — for a solo show that means running the era check again). Gallery
// shows need nothing added.
async function withRepairContext(ex: LoadedExhibition): Promise<LoadedExhibition> {
  if (ex.path !== 'museum') return ex
  return { ...ex, ctx: await museumRepairContext(ex.ctx, ex.institutionName) }
}

// Flagged rows automatic repair may touch — held rows (repair_hold) are left for a
// person to Replace.
async function flaggedRows(exhibitionId: string): Promise<StoredPreread[]> {
  const { data, error } = await getSupabaseAdmin()
    .from('prereads')
    .select(PREREAD_SELECT)
    .eq('exhibition_id', exhibitionId)
    .not('quality_flag', 'is', null)
    .eq('repair_hold', false)
  if (error) throw new Error(`Failed to read flagged prereads: ${error.message}`)
  return (data ?? []) as StoredPreread[]
}

async function repairFlagged(ex: LoadedExhibition, errors: AgentRunError[]): Promise<{ repaired: number; stillFlagged: number }> {
  const db = getSupabaseAdmin()
  const rows = await flaggedRows(ex.ctx.exhibition_id)
  const exclude = await existingUrls(ex.ctx.exhibition_id)
  let repaired = 0
  let stillFlagged = 0

  for (const row of rows) {
    try {
      const result = await repairRow(ex, row, { recheckFirst: true, excludeUrls: exclude })
      if (result.repaired) {
        repaired++
        continue
      }
      stillFlagged++
      // Spec: an unrepaired row gets a new flag. If nothing judged anything (the
      // search came back empty), the old flag still describes the row best.
      if (result.flag && result.flag !== row.quality_flag) {
        await db.from('prereads').update({ quality_flag: result.flag }).eq('id', row.id)
      }
    } catch (err) {
      stillFlagged++
      errors.push({ item: ex.ctx.show_title, step: 'preread_repair', message: err instanceof Error ? err.message : String(err) })
    }
  }
  return { repaired, stillFlagged }
}

// ─── Entry point for every exhibition-level trigger ───────────────────────────

/**
 * Runs Agent 2 for one exhibition according to its preread_status and the mode.
 * Never throws for a generation failure — that becomes preread_status 'error' and an
 * entry in `errors`. Throws only if the exhibition can't be loaded or a status write
 * fails, since then the outcome can't be recorded at all.
 */
export async function runAgent2ForExhibition(
  exhibitionId: string,
  opts: { mode: Agent2Mode; errors?: AgentRunError[] }
): Promise<Agent2Outcome> {
  const errors = opts.errors ?? []
  const ex = await loadExhibition(exhibitionId)
  const base = {
    exhibitionId,
    showTitle: ex.ctx.show_title,
    path: ex.path,
    statusBefore: ex.status,
    rowsAdded: 0,
    rowsRepaired: 0,
    rowsStillFlagged: 0,
    missingFields: blockWarnings(ex),
  }
  const skip = (message: string): Agent2Outcome => ({ ...base, action: 'skipped', statusAfter: ex.status, message })

  if (opts.mode === 'auto') {
    if (ex.status === 'pending_artists' || ex.status === 'pending_press_release') {
      return skip('Blocked — waiting on missing information. Fill it in, then Retrigger.')
    }
    if (ex.status === 'empty') return skip('Already ran and found nothing. Only an admin Retrigger reruns it.')
    if (ex.status === 'success') return skip('Already complete.')
  } else if (ex.status === 'success') {
    return skip('Already complete — every row passed. Use Replace on a single row to change it.')
  }

  // needs_review in auto mode repairs without a block check: the show already ran,
  // and the spec routes it straight to repair. Everywhere else, and always in
  // retrigger mode, the block is checked first and never bypassed.
  const repairWithoutBlockCheck = opts.mode === 'auto' && ex.status === 'needs_review'
  if (!repairWithoutBlockCheck) {
    const block = blockingStatus(ex)
    if (block) {
      await setStatus(exhibitionId, block)
      const message = block === 'pending_artists'
        ? 'Blocked — this show has no artists. Add them, then Retrigger.'
        : 'Blocked — this show has no press release. Add it, then Retrigger.'
      return { ...base, action: 'blocked', statusAfter: block, message }
    }
  }

  if (ex.status === 'needs_review') {
    if (ex.path === 'fair') {
      // Unreachable today: nothing flags fair rows (they have no quality check yet).
      // Left explicit so a future flag doesn't send them into a repair search by accident.
      return skip('Fair coverage has no repair path yet.')
    }
    // Checked before withRepairContext, which runs the era check for a museum solo show.
    if ((await flaggedRows(exhibitionId)).length === 0) {
      return skip('Every flagged row is held for a person to Replace.')
    }
    const { repaired, stillFlagged } = await repairFlagged(await withRepairContext(ex), errors)
    const statusAfter = await recomputePrereadStatus(exhibitionId)
    return {
      ...base,
      action: 'repaired',
      statusAfter,
      rowsRepaired: repaired,
      rowsStillFlagged: stillFlagged,
      message: `Repaired ${repaired} of ${repaired + stillFlagged} flagged row(s).`,
    }
  }

  // NULL, error, or (retrigger only) pending_* / empty — run the generator.
  try {
    const added = await generate(ex)
    if (added === 'pending_artists') {
      await setStatus(exhibitionId, added)
      return { ...base, action: 'blocked', statusAfter: added, message: 'Blocked — this show has no artists. Add them, then Retrigger.' }
    }
    const statusAfter = await recomputePrereadStatus(exhibitionId)
    const waitingForReview = ex.path === 'museum' && isOnShowReviewGate(ex)
      && !isShowReviewDue(gatePendingUntil(ex), ex.showReview.attemptedAt, ex.showReview.status)
    const message = statusAfter === 'empty' && waitingForReview ? `Nothing yet — the show review is searched from ${gatePendingUntil(ex)}.`
      : statusAfter === 'empty' ? 'Ran and found nothing.'
      : statusAfter === 'needs_review' ? `Added ${added} row(s); at least one is flagged and hidden.`
        : `Added ${added} row(s).`
    return { ...base, action: 'generated', statusAfter, rowsAdded: added, message }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[Agent 2] Generation failed for "${ex.ctx.show_title}":`, err)
    errors.push({ item: ex.ctx.show_title, step: ex.path === 'gallery' ? 'preread' : 'coverage', message })
    await setStatus(exhibitionId, 'error')
    if (err instanceof ArtistRetryPending) {
      return {
        ...base, action: 'failed', statusAfter: 'error', rowsAdded: err.rowsAdded,
        message: `Added ${err.rowsAdded} row(s); search failed for ${err.artists.join(', ')} — only they will be retried on the next run.`,
      }
    }
    return { ...base, action: 'failed', statusAfter: 'error', message: `Failed: ${message}` }
  }
}

// ─── Trigger 3B: Replace one row ──────────────────────────────────────────────

export interface ReplaceOutcome {
  prereadId: string
  replaced: boolean
  qualityFlag: QualityFlag | null
  statusAfter: PrereadStatus | null
  message: string
}

/**
 * Reruns generation for one row, whatever its current state.
 *
 * - Regular retry (no customQuery): the same steps as the automatic repair — a
 *   flagged row is re-checked first, then a replacement is searched for.
 * - Custom search: the admin's query is used for the replacement search as-is.
 *
 * On success the row gets the new article, quality_flag NULL and row_status
 * 'active'. On failure a FLAGGED row gets the new flag; a CLEAN row is left exactly
 * as it was — failing to find something better is no reason to hide an article
 * that passed. Museum rows use their show type's search and check; fair rows are
 * refused, since fair coverage has no quality check yet.
 */
export async function replacePreread(prereadId: string, customQuery?: string | null): Promise<ReplaceOutcome> {
  const db = getSupabaseAdmin()
  const { data: row, error } = await db.from('prereads').select(PREREAD_SELECT).eq('id', prereadId).single()
  if (error || !row) throw new Agent2UserError(`Preread ${prereadId} not found`, 404)
  const stored = row as StoredPreread

  const loaded = await loadExhibition(stored.exhibition_id)
  if (loaded.path === 'fair') {
    throw new Agent2UserError('Replace is not available for fair coverage: it has no quality check yet.', 400)
  }
  const ex = await withRepairContext(loaded)

  const exclude = await existingUrls(ex.ctx.exhibition_id)
  const result = await repairRow(ex, stored, {
    // A clean row passed already; re-checking it would just "repair" it to itself.
    recheckFirst: stored.quality_flag !== null && !customQuery?.trim(),
    customQuery,
    excludeUrls: exclude,
  })

  let qualityFlag: QualityFlag | null = null
  let message: string
  if (result.repaired) {
    message = result.how === 'rechecked' ? 'Re-checked the existing article: it passes now.' : 'Replaced with a new article that passed the check.'
  } else if (stored.quality_flag !== null) {
    qualityFlag = result.flag ?? stored.quality_flag
    if (qualityFlag !== stored.quality_flag) {
      await db.from('prereads').update({ quality_flag: qualityFlag }).eq('id', prereadId)
    }
    message = `Not repaired — ${result.note}. Row stays flagged (${qualityFlag}) and hidden.`
  } else {
    message = `No better article found — ${result.note}. The current article is unchanged.`
  }

  // A blocked show keeps its block: a row replaced by hand doesn't supply the
  // missing artists or press release.
  const statusAfter = ex.status === 'pending_artists' || ex.status === 'pending_press_release'
    ? ex.status
    : await recomputePrereadStatus(ex.ctx.exhibition_id)

  return { prereadId, replaced: result.repaired, qualityFlag, statusAfter, message }
}

// ─── Trigger 3C: Blank / Activate ─────────────────────────────────────────────

/**
 * Manual override of whether a row shows publicly. Independent of quality_flag and
 * of the exhibition's status: blanking a clean row doesn't make the show need
 * review, and activating a flagged row doesn't clear its flag.
 */
export async function setPrereadRowStatus(prereadId: string, rowStatus: RowStatus): Promise<void> {
  const { data, error } = await getSupabaseAdmin()
    .from('prereads')
    .update({ row_status: rowStatus })
    .eq('id', prereadId)
    .select('id')
  if (error) throw new Error(error.message)
  if (!data || data.length === 0) throw new Agent2UserError(`Preread ${prereadId} not found`, 404)
}

/** An error the admin caused (bad id, unsupported row) — routes return it with its status. */
export class Agent2UserError extends Error {
  constructor(message: string, public status: number) {
    super(message)
  }
}

// ─── Trigger 2: Run Now over every show ───────────────────────────────────────

/**
 * Every published show on either path whose status means auto mode would do
 * something: never attempted, errored, or needs review. success / empty / pending_*
 * are skipped by the rules anyway, so they're filtered out in the query rather than
 * loaded one by one just to be skipped.
 *
 * Stops starting new shows once `budgetMs` has elapsed, so a long pass ends inside
 * the route's time limit instead of being killed mid-write; the rest are picked up
 * by the next run.
 */
export async function runAgent2AcrossExhibitions(
  errors: AgentRunError[],
  budgetMs: number
): Promise<{ eligible: number; outcomes: Agent2Outcome[]; deferred: number }> {
  const started = Date.now()
  const { data, error } = await getSupabaseAdmin()
    .from('exhibitions')
    .select('id')
    .eq('status', 'published')
    .in('preread_type', ['full', 'coverage_only'])
    .or('preread_status.is.null,preread_status.in.(error,needs_review)')
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)

  const ids = (data ?? []).map((r) => r.id as string)
  const outcomes: Agent2Outcome[] = []
  let attempted = 0
  for (const id of ids) {
    if (Date.now() - started > budgetMs) break
    attempted++
    try {
      outcomes.push(await runAgent2ForExhibition(id, { mode: 'auto', errors }))
    } catch (err) {
      errors.push({ item: id, step: 'agent2', message: err instanceof Error ? err.message : String(err) })
    }
  }
  return { eligible: ids.length, outcomes, deferred: ids.length - attempted }
}

// ─── Show review (gallery solo S4 + small group): the daily cron ──────────────

export interface ShowReviewOutcome {
  exhibitionId: string
  showTitle: string
  status: ShowReviewStatus | 'skipped'
  rowsAdded: number
  message: string
}

/**
 * Runs the show review for one gallery show (any tier) whose 14 days are up. Stores what
 * it finds alongside the show's existing rows, records the attempt, and recomputes
 * preread_status (a stored row may be flagged 'unverified'). Never throws for a
 * search failure — that climbs show_review_status error1 → error2 → error3; the
 * first two are retried by the next run, error3 never is. A clean empty result is
 * 'empty' and is never retried.
 */
export async function runSoloShowReview(exhibitionId: string, errors: AgentRunError[] = []): Promise<ShowReviewOutcome> {
  const db = getSupabaseAdmin()
  const ex = await loadExhibition(exhibitionId)
  const base = { exhibitionId, showTitle: ex.ctx.show_title, rowsAdded: 0 }

  if (!isOnShowReviewGate(ex)) return { ...base, status: 'skipped', message: 'Not a gallery show with artists, or a museum show.' }
  if (!isShowReviewDue(ex.showReview.pendingUntil, ex.showReview.attemptedAt, ex.showReview.status)) {
    return { ...base, status: 'skipped', message: `Not due (pending until ${ex.showReview.pendingUntil ?? 'unset'}).` }
  }
  // The same block Agent 2 applies: the check is grounded in the press release.
  const block = blockingStatus(ex)
  if (block) return { ...base, status: 'skipped', message: `Blocked (${block}).` }

  let result: ShowReviewResult
  let rowsAdded = 0
  try {
    const have = await existingUrls(exhibitionId)
    const s4 = ex.path !== 'museum' ? await searchGalleryShowReview(ex.ctx)
      : await museumReviewSearchKind(ex) === 'solo_contemporary' ? await searchMuseumSoloShowReview(ex.ctx)
        : await searchMuseumGroupShowReview(museumReviewContext(ex))
    const fresh = s4.rows.filter((p) => !p.article_url || !have.has(p.article_url))
    if (fresh.length > 0) {
      const { error } = await db.from('prereads').insert(fresh.map((p) => ({ ...p, exhibition_id: exhibitionId })))
      if (error) throw new Error(`Failed to insert show review: ${error.message}`)
    }
    rowsAdded = fresh.length
    // A review the show already has (same URL) still counts as found.
    result = s4.result
    if (result === 'error') errors.push({ item: ex.ctx.show_title, step: 'show_review', message: 'An Exa search call failed' })
  } catch (err) {
    result = 'error'
    errors.push({ item: ex.ctx.show_title, step: 'show_review', message: err instanceof Error ? err.message : String(err) })
  }
  const status = nextShowReviewStatus(ex.showReview.status, result)

  // show_coverage in missing_fields is a gallery-only signal; museums never carried it.
  const missing = ex.path !== 'gallery' ? ex.missingFields
    : status === 'found'
    ? ex.missingFields.filter((f) => f !== 'show_coverage')
    : status === 'empty' && !ex.missingFields.includes('show_coverage') ? [...ex.missingFields, 'show_coverage'] : ex.missingFields
  const { error } = await db.from('exhibitions').update({
    show_review_attempted_at: new Date().toISOString(),
    show_review_status: status,
    missing_fields: missing,
  }).eq('id', exhibitionId)
  if (error) throw new Error(`Failed to record show-review attempt: ${error.message}`)

  // Only a show that already ran keeps a derived status; a never-attempted or blocked
  // show's status belongs to the main Agent 2 run.
  if (rowsAdded > 0 && ex.status !== null && ex.status !== 'error') await recomputePrereadStatus(exhibitionId)

  const message = status === 'found' ? `Added ${rowsAdded} show review.`
    : status === 'empty' ? 'Searched; no review passed. Not retried.'
      : status === 'error3' ? 'Search failed a third time; no more automatic retries.'
        : `Search failed (${status}); will retry next run.`
  return { ...base, status, rowsAdded, message }
}

/**
 * Every published gallery show (any tier) whose show review is due. Shows Agent 2 hasn't run yet
 * (preread_status NULL / error) are left to it — its own run does S4 inline once due.
 * Stops starting new shows once `budgetMs` has elapsed.
 */
export async function runShowReviewsDue(
  errors: AgentRunError[],
  budgetMs: number
): Promise<{ eligible: number; outcomes: ShowReviewOutcome[]; deferred: number }> {
  const started = Date.now()
  const today = new Date().toISOString().slice(0, 10)
  const { data, error } = await getSupabaseAdmin()
    .from('exhibitions')
    .select('id')
    .eq('status', 'published')
    .lte('show_review_pending_until', today)
    .or('show_review_attempted_at.is.null,show_review_status.in.(error1,error2)')
    .or(`end_date.is.null,end_date.gte.${today}`)
    .in('preread_status', ['success', 'needs_review', 'empty'])
    .order('show_review_pending_until', { ascending: true })
  if (error) throw new Error(error.message)

  const ids = (data ?? []).map((r) => r.id as string)
  const outcomes: ShowReviewOutcome[] = []
  let attempted = 0
  for (const id of ids) {
    if (Date.now() - started > budgetMs) break
    attempted++
    try {
      outcomes.push(await runSoloShowReview(id, errors))
    } catch (err) {
      errors.push({ item: id, step: 'show_review', message: err instanceof Error ? err.message : String(err) })
    }
  }
  return { eligible: ids.length, outcomes, deferred: ids.length - attempted }
}
