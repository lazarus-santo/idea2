import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'

interface VenueInput {
  name: string
  exhibitions_url: string
  address: string
  neighborhood: string
  latitude: number | string
  longitude: number | string
  hours?: Record<string, [string, string] | null> | null
}

interface InstitutionInput {
  name: string
  website: string
  type: string
  venues: VenueInput[]
}

function normalizeForDedup(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(the|gallery|galleries|museum|museums|art|arts|foundation|institute|center|centre|studio|studios|project|projects|space|spaces|inc|llc|and|&)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '')
    .replace(/\s+/g, '')
}

export async function POST(req: NextRequest) {
  const { institutions }: { institutions: InstitutionInput[] } = await req.json()

  if (!Array.isArray(institutions) || institutions.length === 0) {
    return NextResponse.json({ error: 'institutions array is required' }, { status: 400 })
  }

  const db = getSupabaseAdmin()

  // Fetch existing data for dedup checks before any inserts
  const [{ data: allInstitutions }, { data: allVenues }] = await Promise.all([
    db.from('institutions').select('name'),
    db.from('venues').select('exhibitions_url'),
  ])

  const existingInstNorms = new Set(
    (allInstitutions ?? []).map((r: { name: string }) => normalizeForDedup(r.name))
  )
  // Track existing URLs and accumulate within-batch URLs to prevent intra-batch duplicates
  const existingVenueUrls = new Set(
    (allVenues ?? [])
      .map((r: { exhibitions_url: string | null }) => r.exhibitions_url)
      .filter(Boolean) as string[]
  )

  let institutionsInserted = 0
  let venuesInserted = 0
  const errors: string[] = []

  for (const inst of institutions) {
    // Institution name dedup
    const normInst = normalizeForDedup(inst.name.trim())
    if (normInst.length > 2 && existingInstNorms.has(normInst)) {
      errors.push(`Institution "${inst.name}" already exists — skipping`)
      continue
    }

    const { data: instRow, error: instErr } = await db
      .from('institutions')
      .insert({
        name: inst.name,
        website: inst.website || null,
        type: inst.type || 'gallery',
        active: true,
      })
      .select('id')
      .single()

    if (instErr || !instRow) {
      errors.push(`Institution "${inst.name}": ${instErr?.message ?? 'unknown error'}`)
      continue
    }

    institutionsInserted++
    existingInstNorms.add(normInst)
    const institutionId = instRow.id

    for (const venue of inst.venues ?? []) {
      // Venue exhibitions_url dedup (globally unique)
      if (venue.exhibitions_url && existingVenueUrls.has(venue.exhibitions_url)) {
        errors.push(`Venue "${venue.name}": exhibitions URL already exists — skipping`)
        continue
      }

      const { error: venueErr } = await db.from('venues').insert({
        institution_id: institutionId,
        name: venue.name,
        exhibitions_url: venue.exhibitions_url || null,
        address: venue.address || null,
        neighborhood: venue.neighborhood || null,
        latitude: venue.latitude !== '' ? Number(venue.latitude) : null,
        longitude: venue.longitude !== '' ? Number(venue.longitude) : null,
        hours: venue.hours ?? null,
        active: true,
      })

      if (venueErr) {
        errors.push(`Venue "${venue.name}" (under "${inst.name}"): ${venueErr.message}`)
      } else {
        venuesInserted++
        if (venue.exhibitions_url) existingVenueUrls.add(venue.exhibitions_url)
      }
    }
  }

  if (errors.length > 0 && institutionsInserted === 0) {
    return NextResponse.json({ error: errors.join('; ') }, { status: 409 })
  }

  return NextResponse.json({
    success: true,
    institutionsInserted,
    venuesInserted,
    ...(errors.length > 0 ? { warnings: errors } : {}),
  })
}
