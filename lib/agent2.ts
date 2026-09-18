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
  type PrereadRepairContext,
} from './claude'
import {
  generateMuseumCoverage,
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
  id, show_title, press_release, preread_status, missing_fields,
  venues!inner(name, exhibitions_url, institutions(name, type)),
  exhibition_artists(artists!inner(name))
`

interface LoadedExhibition {
  ctx: PrereadRepairContext
  path: Agent2Path
  status: PrereadStatus | null
  missingFields: string[]
  institutionName: string
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
  }
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
// blocked: museum coverage has its own no-artist tier (Type D) and fairs have no
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

async function existingUrls(exhibitionId: string): Promise<Set<string>> {
  const { data, error } = await getSupabaseAdmin().from('prereads').select('article_url').eq('exhibition_id', exhibitionId)
  if (error) throw new Error(`Failed to read prereads: ${error.message}`)
  return new Set((data ?? []).map((r) => r.article_url as string | null).filter((u): u is string => !!u))
}

// Runs the generator for the show's path and inserts what it found. Rows already
// stored for the show (an admin's manual additions, or a partial earlier run) are
// kept and never duplicated. Throws on generator or insert failure; the caller turns
// that into preread_status = 'error'.
async function generate(ex: LoadedExhibition): Promise<number> {
  const db = getSupabaseAdmin()
  const id = ex.ctx.exhibition_id
  const have = await existingUrls(id)

  if (ex.path === 'gallery') {
    const { prereads, hasShowCoverage } = await generatePrereads({
      show_title: ex.ctx.show_title,
      artists: ex.ctx.artists,
      start_date: null,
      end_date: null,
      description: null,
      press_release: ex.ctx.press_release,
      image_url: null,
      venue_name: ex.ctx.venue_name,
      venue_url: ex.ctx.venue_url,
      exhibition_id: id,
    })
    const fresh = prereads.filter((p) => !p.article_url || !have.has(p.article_url))
    if (fresh.length > 0) {
      const { error } = await db.from('prereads').insert(fresh.map((p) => ({ ...p, exhibition_id: id })))
      if (error) throw new Error(`Failed to insert prereads: ${error.message}`)
    }
    // Carried over unchanged from Agent 1's old inline block: a gallery show with no
    // show-level review gets 'show_coverage' in missing_fields.
    if (!hasShowCoverage && !ex.missingFields.includes('show_coverage')) {
      await db.from('exhibitions').update({ missing_fields: [...ex.missingFields, 'show_coverage'] }).eq('id', id)
    }
    return fresh.length
  }

  const coverage = ex.path === 'museum'
    ? await generateMuseumCoverage(ex.ctx.show_title, ex.ctx.venue_name, ex.ctx.artists, id).then(async (r) => {
      // The Type A-D tier still lives on the exhibition row.
      await db.from('exhibitions').update({ coverage_type: r.coverageType }).eq('id', id)
      return r.coverage
    })
    : await generateFairCoverage(ex.institutionName, id)

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
  quality_flag: QualityFlag | null
  row_status: RowStatus
}

const PREREAD_SELECT = 'id, exhibition_id, article_url, article_title, summary, artist_name, quality_flag, row_status'

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
      const { error } = await db.from('prereads').update({ quality_flag: null, row_status: 'active' }).eq('id', row.id)
      if (error) throw new Error(`Failed to update preread: ${error.message}`)
      return { repaired: true, how: 'rechecked' }
    }
    recheckFlag = verdict
  }

  const subject = prereadSubject(ex.ctx, row.artist_name)
  const found = await findReplacementPreread(ex.ctx, subject, opts.excludeUrls, opts.customQuery)
  if (found.ok) {
    const { error } = await db.from('prereads').update({
      ...found.row,
      // A per-artist row stays bound to its artist even if the replacement came from
      // a custom query that didn't name them.
      artist_name: row.artist_name ?? found.row.artist_name ?? null,
      quality_flag: null,
      row_status: 'active',
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

async function flaggedRows(exhibitionId: string): Promise<StoredPreread[]> {
  const { data, error } = await getSupabaseAdmin()
    .from('prereads')
    .select(PREREAD_SELECT)
    .eq('exhibition_id', exhibitionId)
    .not('quality_flag', 'is', null)
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
    if (ex.path !== 'gallery') {
      // Unreachable today: nothing flags museum or fair rows (they have no quality
      // check yet). Left explicit so a future flag doesn't send them into the
      // gallery repair search by accident.
      return skip('Museum/fair coverage has no repair path yet.')
    }
    const { repaired, stillFlagged } = await repairFlagged(ex, errors)
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
    const statusAfter = await recomputePrereadStatus(exhibitionId)
    const message = statusAfter === 'empty' ? 'Ran and found nothing.'
      : statusAfter === 'needs_review' ? `Added ${added} row(s); at least one is flagged and hidden.`
        : `Added ${added} row(s).`
    return { ...base, action: 'generated', statusAfter, rowsAdded: added, message }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[Agent 2] Generation failed for "${ex.ctx.show_title}":`, err)
    errors.push({ item: ex.ctx.show_title, step: ex.path === 'gallery' ? 'preread' : 'coverage', message })
    await setStatus(exhibitionId, 'error')
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
 * that passed. Museum and fair rows are refused: they have no quality check yet.
 */
export async function replacePreread(prereadId: string, customQuery?: string | null): Promise<ReplaceOutcome> {
  const db = getSupabaseAdmin()
  const { data: row, error } = await db.from('prereads').select(PREREAD_SELECT).eq('id', prereadId).single()
  if (error || !row) throw new Agent2UserError(`Preread ${prereadId} not found`, 404)
  const stored = row as StoredPreread

  const ex = await loadExhibition(stored.exhibition_id)
  if (ex.path !== 'gallery') {
    throw new Agent2UserError('Replace is only available for gallery prereads. Museum and fair coverage has no quality check yet.', 400)
  }

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
