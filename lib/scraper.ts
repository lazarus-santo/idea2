import Browserbase from '@browserbasehq/sdk'
import { getSupabaseAdmin } from './supabase'
import { extractExhibitionsFromPage, generatePrereads } from './claude'
import { geocodeVenueIfNeeded } from './geocoding'
import type { VenueRecord } from './types'

// Wix: strip /v1/fill/... or /v1/crop/.../fill/... suffix — returns the original master file.
// CloudFront auto_image: bump resize width to 2000 so we always request the highest available res.
function upgradeImageUrl(url: string | null): string | null {
  if (!url) return null

  // Wix static CDN — remove transform path, keep only the media hash segment
  const wixMatch = url.match(/^(https:\/\/static\.wixstatic\.com\/media\/[^/]+)/)
  if (wixMatch) return wixMatch[1]

  // CloudFront auto_image resize — bump width to 2000
  if (url.includes('cloudfront.net/auto_image/')) {
    return url.replace(/resize=width:\d+/, 'resize=width:2000')
  }

  return url
}

const CONTACT_BOILERPLATE = /inquir|please\s+(reach\s+out|contact)|for\s+more\s+information|press\s+(office|contact|release\s+contact)|media\s+contact|rsvp|@[a-z0-9.-]+\.[a-z]{2,}/i

function cleanPressRelease(text: string | null): string | null {
  if (!text) return null
  // Split into paragraphs (blank-line separated) and strip trailing contact blocks
  const paragraphs = text.split(/\n{2,}/)
  while (paragraphs.length > 0 && CONTACT_BOILERPLATE.test(paragraphs[paragraphs.length - 1])) {
    paragraphs.pop()
  }
  const cleaned = paragraphs.join('\n\n').trim()
  return cleaned || null
}

function computeCheckBackDate(endDate: string | null): string | null {
  if (!endDate) return null
  const d = new Date(endDate)
  d.setDate(d.getDate() - 5)
  return d.toISOString().split('T')[0]
}

async function fetchWithBrowserbase(url: string): Promise<string> {
  const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY! })
  const session = await bb.sessions.create({ projectId: process.env.BROWSERBASE_PROJECT_ID! })

  const puppeteer = await import('puppeteer')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const browser = await (puppeteer as any).connect({ browserWSEndpoint: session.connectUrl })
  try {
    const pages = await browser.pages()
    const page = pages[0] ?? await browser.newPage()
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 })
    await new Promise((r) => setTimeout(r, 2000))
    return await page.content()
  } finally {
    await browser.close()
  }
}

async function upsertArtist(name: string): Promise<string | null> {
  const db = getSupabaseAdmin()

  const { data: existing } = await db
    .from('artists')
    .select('id')
    .eq('name', name)
    .maybeSingle()

  if (existing) return existing.id

  const { data: inserted, error } = await db
    .from('artists')
    .insert({ name })
    .select('id')
    .single()

  if (error || !inserted) {
    console.error(`Failed to upsert artist "${name}":`, error?.message)
    return null
  }
  return inserted.id
}

export async function scrapeGallery(venue: VenueRecord, skipPrereads = false): Promise<number> {
  console.log(`Scraping ${venue.name}...`)
  const db = getSupabaseAdmin()

  // Geocode if coordinates are missing — fire-and-forget into the venues table
  await geocodeVenueIfNeeded(venue.id, venue.address ?? null, venue.latitude, venue.longitude)

  const html = await fetchWithBrowserbase(venue.exhibitions_url)
  const exhibitions = await extractExhibitionsFromPage(html, venue.name, venue.exhibitions_url)

  console.log(`Found ${exhibitions.length} exhibitions at ${venue.name}`)

  // Zero result means extraction failed — preserve existing data unchanged.
  if (exhibitions.length === 0) return 0

  // Cache existing prereads keyed by show_title before wiping.
  // The exhibition_id changes on every clean-slate cycle, so we key by title.
  type CachedPreread = { article_title: string | null; publication: string | null; article_url: string | null; thumbnail_url: string | null; summary: string | null }
  const prereadCache = new Map<string, CachedPreread[]>()

  const { data: existingExhibitions } = await db
    .from('exhibitions')
    .select('show_title, prereads(article_title, publication, article_url, thumbnail_url, summary)')
    .eq('venue_id', venue.id)

  for (const ex of existingExhibitions ?? []) {
    const prereads = (ex.prereads ?? []) as CachedPreread[]
    if (prereads.length > 0) {
      prereadCache.set(ex.show_title, prereads)
    }
  }

  // Clean slate: wipe all exhibitions for this venue (CASCADE removes prereads + exhibition_artists).
  await db.from('exhibitions').delete().eq('venue_id', venue.id)

  let upsertedCount = 0

  for (const raw of exhibitions) {
    const checkBackDate = computeCheckBackDate(raw.end_date)

    const cleanedPr = cleanPressRelease(raw.press_release)
    const prTruncated = !!cleanedPr && !/[.!?'””']$/.test(cleanedPr.trim())

    const requiredFields = ['show_title', 'start_date', 'end_date', 'image_url'] as const
    const missingFields: string[] = requiredFields.filter((f) => !raw[f])
    if (prTruncated) missingFields.push('press_release_truncated')
    const status = missingFields.length === 0 ? 'published' : 'pending'

    const { data: inserted, error } = await db
      .from('exhibitions')
      .insert({
        venue_id: venue.id,
        show_title: raw.show_title,
        start_date: raw.start_date,
        end_date: raw.end_date,
        description: raw.description,
        press_release: cleanedPr,
        image_url: upgradeImageUrl(raw.image_url),
        check_back_date: checkBackDate,
        status,
        missing_fields: missingFields,
      })
      .select('id')
      .single()

    if (error || !inserted) {
      console.error(`Failed to insert “${raw.show_title}”:`, error?.message)
      continue
    }

    const exhibitionId = inserted.id

    // Sync artists — cap at 20 so group shows don't flood the search index
    for (const artistName of raw.artists.slice(0, 20)) {
      const artistId = await upsertArtist(artistName)
      if (artistId) {
        await db.from('exhibition_artists').insert({
          exhibition_id: exhibitionId,
          artist_id: artistId,
        })
      }
    }

    // Re-attach cached prereads if they exist; generate only for new shows.
    if (!skipPrereads) {
      const cached = prereadCache.get(raw.show_title)
      if (cached && cached.length > 0) {
        await db.from('prereads').insert(
          cached.map((p) => ({ ...p, exhibition_id: exhibitionId }))
        )
      } else {
        const { prereads, hasShowCoverage } = await generatePrereads({ ...raw, venue_name: venue.name })
        if (prereads.length > 0) {
          await db.from('prereads').insert(
            prereads.map((p) => ({ ...p, exhibition_id: exhibitionId }))
          )
        }
        // Flag exhibitions with no show-specific press coverage for manual addition via admin
        if (!hasShowCoverage) {
          const currentMissing: string[] = missingFields as unknown as string[]
          if (!currentMissing.includes('show_coverage')) {
            await db.from('exhibitions').update({
              missing_fields: [...currentMissing, 'show_coverage'],
            }).eq('id', exhibitionId)
          }
        }
      }
    }

    upsertedCount++
  }

  return upsertedCount
}

function normalizeVenueRow(v: Record<string, unknown>): VenueRecord {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const institution = (v.institutions as any) ?? null
  return {
    id: v.id as string,
    name: v.name as string,
    exhibitions_url: v.exhibitions_url as string,
    type: (institution?.type ?? 'gallery') as VenueRecord['type'],
    active: v.active as boolean,
    institution_id: institution?.id ?? undefined,
    address: (v.address as string | null) ?? null,
    latitude: (v.latitude as number | null) ?? null,
    longitude: (v.longitude as number | null) ?? null,
  }
}

export async function getActiveInstitutions(): Promise<VenueRecord[]> {
  const { data } = await getSupabaseAdmin()
    .from('venues')
    .select('id, name, exhibitions_url, active, address, latitude, longitude, institutions!inner(id, type)')
    .eq('active', true)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data ?? []).map((v: any) => normalizeVenueRow(v))
}

export async function getInstitutionsDueForRefresh(): Promise<VenueRecord[]> {
  const today = new Date().toISOString().split('T')[0]

  const { data: dueRows } = await getSupabaseAdmin()
    .from('exhibitions')
    .select('venue_id')
    .lte('check_back_date', today)
    .not('check_back_date', 'is', null)

  if (!dueRows || dueRows.length === 0) return []

  const venueIds = [...new Set(dueRows.map((r) => r.venue_id))]

  const { data: venues } = await getSupabaseAdmin()
    .from('venues')
    .select('id, name, exhibitions_url, active, address, latitude, longitude, institutions!inner(id, type)')
    .in('id', venueIds)
    .eq('active', true)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (venues ?? []).map((v: any) => normalizeVenueRow(v))
}
