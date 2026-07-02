import { getSupabaseAdmin } from './supabase'
import { generatePrereads } from './claude'
import { startAgentRun, finishAgentRun, failAgentRun, type AgentRunError, type AgentRunResult } from './agent-runs'
import type { ExhibitionRaw } from './types'

function extractDomain(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

export interface AuditReport {
  exhibition: string
  deleted: string[]
  regenerated: boolean
  newCount: number
}

// Deletes gallery-domain prereads and regenerates for any gallery exhibition with < 2.
// Scoped to published gallery exhibitions (preread_type = 'full') only.
// Optionally scoped to specific exhibition IDs (e.g. those just scraped).
export async function auditAndRepairPrereads(exhibitionIds?: string[], errors: AgentRunError[] = []): Promise<{
  audited: number
  report: AuditReport[]
  regenerationAttempts: number
}> {
  const db = getSupabaseAdmin()

  let query = db
    .from('exhibitions')
    .select(`
      id,
      show_title,
      start_date,
      end_date,
      description,
      press_release,
      image_url,
      venues!inner(name, exhibitions_url, institutions(type)),
      exhibition_artists(artists!inner(name)),
      prereads(id, article_url, article_title, publication, summary, thumbnail_url)
    `)
    .eq('status', 'published')
    .eq('preread_type', 'full')

  if (exhibitionIds && exhibitionIds.length > 0) {
    query = query.in('id', exhibitionIds)
  }

  const { data: exhibitions, error } = await query

  if (error) throw new Error(error.message)

  const report: AuditReport[] = []
  let regenerationAttempts = 0

  for (const ex of exhibitions ?? []) {
    const raw = ex as typeof ex & {
      venues: { name: string; exhibitions_url: string; institutions: { type: string } | null }
      exhibition_artists: { artists: { name: string } }[]
      prereads: { id: string; article_url: string | null; article_title: string | null; publication: string | null; summary: string | null; thumbnail_url: string | null }[]
    }

    const venueDomain = extractDomain(raw.venues.exhibitions_url)
    const prereads = raw.prereads ?? []

    const toDelete = prereads.filter((p) => {
      if (!p.article_url || !venueDomain) return false
      return extractDomain(p.article_url) === venueDomain
    })

    if (toDelete.length > 0) {
      await db.from('prereads').delete().in('id', toDelete.map((p) => p.id))
    }

    const remaining = prereads.length - toDelete.length
    let regenerated = false
    let newCount = remaining

    if (remaining < 2) {
      regenerationAttempts++
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const artists = (raw.exhibition_artists ?? []).map((ea: any) => ea.artists?.name).filter(Boolean) as string[]

        const { prereads: newPrereads } = await generatePrereads({
          show_title: raw.show_title,
          artists,
          start_date: raw.start_date,
          end_date: raw.end_date,
          description: raw.description ?? null,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          press_release: (raw as any).press_release ?? null,
          image_url: raw.image_url ?? null,
          venue_name: raw.venues.name,
        })

        if (newPrereads.length > 0) {
          await db.from('prereads').insert(newPrereads.map((p) => ({ ...p, exhibition_id: raw.id })))
          newCount = remaining + newPrereads.length
          regenerated = true
        }
      } catch (err) {
        console.error(`Preread regeneration failed for "${raw.show_title}":`, err)
        errors.push({
          item: raw.show_title,
          step: 'preread',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    }

    if (toDelete.length > 0 || regenerated) {
      report.push({
        exhibition: raw.show_title,
        deleted: toDelete.map((p) => p.article_url ?? '(no url)'),
        regenerated,
        newCount,
      })
    }
  }

  return { audited: exhibitions?.length ?? 0, report, regenerationAttempts }
}

// Finds all published gallery exhibitions with zero prereads and retries generation.
// Called at the end of the daily cron to catch approve-time failures.
export async function repairZeroPrereads(errors: AgentRunError[] = []): Promise<{ attempted: number; report: AuditReport[] }> {
  const db = getSupabaseAdmin()

  const [{ data: allExhibitions }, { data: withPrereads }] = await Promise.all([
    db
      .from('exhibitions')
      .select(`
        id, show_title, start_date, end_date, description, press_release, image_url,
        venues!inner(name, exhibitions_url),
        exhibition_artists(artists!inner(name))
      `)
      .eq('status', 'published')
      .eq('preread_type', 'full'),
    db.from('prereads').select('exhibition_id'),
  ])

  if (!allExhibitions?.length) return { attempted: 0, report: [] }

  const withPrereadIds = new Set((withPrereads ?? []).map((p) => p.exhibition_id))
  const zeroPreread = allExhibitions.filter((e) => !withPrereadIds.has(e.id))

  if (zeroPreread.length === 0) return { attempted: 0, report: [] }

  const report: AuditReport[] = []

  for (const ex of zeroPreread) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = ex as typeof ex & {
      venues: { name: string; exhibitions_url: string }
      exhibition_artists: { artists: { name: string } }[]
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const artists = (raw.exhibition_artists ?? []).map((ea: any) => ea.artists?.name).filter(Boolean) as string[]

    const exhibitionRaw: ExhibitionRaw & { venue_name: string } = {
      show_title: raw.show_title,
      artists,
      start_date: raw.start_date,
      end_date: raw.end_date,
      description: raw.description ?? null,
      press_release: raw.press_release ?? null,
      image_url: raw.image_url ?? null,
      venue_name: raw.venues.name,
    }

    try {
      const { prereads } = await generatePrereads(exhibitionRaw)

      if (prereads.length > 0) {
        await db.from('prereads').insert(prereads.map((p) => ({ ...p, exhibition_id: raw.id })))
        report.push({ exhibition: raw.show_title, deleted: [], regenerated: true, newCount: prereads.length })
      }
    } catch (err) {
      console.error(`Zero-preread repair failed for "${raw.show_title}":`, err)
      errors.push({
        item: raw.show_title,
        step: 'preread',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { attempted: zeroPreread.length, report }
}

// ─── Agent 2 run wrapper ────────────────────────────────────────────────────
// "Items" here are gallery exhibitions where a regeneration attempt was made
// (fewer than 2 non-venue-domain prereads remaining after cleanup). Exhibitions
// that already had healthy prereads and needed no action are excluded from the
// counts — they're audited but not "processed" in any meaningful sense.
export async function runAgent2(): Promise<AgentRunResult> {
  const runId = await startAgentRun('agent2')
  const errors: AgentRunError[] = []

  try {
    const { audited, report, regenerationAttempts } = await auditAndRepairPrereads(undefined, errors)

    const itemsFailed = errors.length
    const itemsSucceeded = regenerationAttempts - itemsFailed
    const result: AgentRunResult = {
      itemsProcessed: regenerationAttempts,
      itemsSucceeded,
      itemsFailed,
      errors,
      summary: { audited, domain_cleanups: report.filter((r) => r.deleted.length > 0).length },
    }
    await finishAgentRun(runId, result)
    return result
  } catch (err) {
    await failAgentRun(runId, err instanceof Error ? err.message : String(err))
    throw err
  }
}
