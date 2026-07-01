import { getSupabaseAdmin } from './supabase'
import { generatePrereads } from './claude'
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
export async function auditAndRepairPrereads(exhibitionIds?: string[]): Promise<{
  audited: number
  report: AuditReport[]
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

  return { audited: exhibitions?.length ?? 0, report }
}

// Finds all published gallery exhibitions with zero prereads and retries generation.
// Called at the end of the daily cron to catch approve-time failures.
export async function repairZeroPrereads(): Promise<{ attempted: number; report: AuditReport[] }> {
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

    const { prereads } = await generatePrereads(exhibitionRaw)

    if (prereads.length > 0) {
      await db.from('prereads').insert(prereads.map((p) => ({ ...p, exhibition_id: raw.id })))
      report.push({ exhibition: raw.show_title, deleted: [], regenerated: true, newCount: prereads.length })
    }
  }

  return { attempted: zeroPreread.length, report }
}
