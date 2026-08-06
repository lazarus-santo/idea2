import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'
import { geocodeAddress } from '@/lib/geocode'
import { generateFairCoverage } from '@/lib/museum-coverage'

// GET  /api/admin/fairs — every fair with its exhibitor count, for the admin list
// POST /api/admin/fairs — create a fair
//
// A fair is stored as institution + venue + exactly one exhibitions row. That row
// is the fair itself: show_title is the fair name, start_date/end_date are its run
// dates, coverage holds Agent 2's results. Modelling it that way means the Fairs
// tab, the exhibition card, /exhibitions/[id], and the map all work unchanged.

export const maxDuration = 300

export async function GET(request: NextRequest) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()

  const db = getSupabaseAdmin()
  const { data, error } = await db
    .from('institutions')
    .select('id, name, website, exhibitors, fair_location, active, venues(id, exhibitions_url, address, latitude, longitude, exhibitions(id, show_title, start_date, end_date, status, coverage, preread_type))')
    .eq('type', 'fair')
    .order('name')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fairs = (data ?? []).map((f: any) => {
    const venue = f.venues?.[0] ?? null
    const ex = venue?.exhibitions?.[0] ?? null
    return {
      institution_id: f.id,
      name: f.name,
      website: f.website,
      fair_location: f.fair_location,
      exhibitor_count: Array.isArray(f.exhibitors) ? f.exhibitors.length : 0,
      exhibitors: f.exhibitors ?? [],
      active: f.active,
      exhibitions_url: venue?.exhibitions_url ?? null,
      exhibition_id: ex?.id ?? null,
      start_date: ex?.start_date ?? null,
      end_date: ex?.end_date ?? null,
      status: ex?.status ?? null,
      coverage_count: Array.isArray(ex?.coverage) ? ex.coverage.length : 0,
      preread_type: ex?.preread_type ?? null,
    }
  })

  return NextResponse.json(fairs)
}

interface FairInput {
  name: string
  exhibitions_url: string
  start_date: string | null
  end_date: string | null
  fair_location: string | null
  website?: string | null
  exhibitors?: { name: string; section: string | null }[]
  image_url?: string | null
  /** Run the Agent 2 coverage search inline. Costs Exa searches; off by default. */
  generate_coverage?: boolean
}

export async function POST(request: NextRequest) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()

  const body = (await request.json().catch(() => null)) as FairInput | null
  if (!body?.name || !body?.exhibitions_url) {
    return NextResponse.json({ error: 'name and exhibitions_url are required' }, { status: 400 })
  }

  const db = getSupabaseAdmin()
  const name = body.name.trim()

  const { data: existing } = await db.from('institutions').select('id').eq('name', name).maybeSingle()
  if (existing) {
    return NextResponse.json({ error: `An institution named "${name}" already exists` }, { status: 409 })
  }

  const { data: inst, error: instErr } = await db
    .from('institutions')
    .insert({
      name,
      type: 'fair',
      website: body.website ?? null,
      active: true,
      exhibitors: body.exhibitors ?? [],
      fair_location: body.fair_location ?? null,
    })
    .select('id')
    .single()
  if (instErr || !inst) return NextResponse.json({ error: instErr?.message ?? 'institution insert failed' }, { status: 500 })

  // Best-effort geocode. Fairs sit at piers, armories and temporary structures, so
  // fair_location is free text and often will not geocode — that is expected and
  // not an error. Coordinates only decide whether the fair gets a map pin.
  let lat: number | null = null
  let lng: number | null = null
  if (body.fair_location) {
    const geo = await geocodeAddress(`${body.fair_location}, New York, NY`)
    if (geo) { lat = geo.lat; lng = geo.lng }
  }

  // manual_entry_required = true is what keeps this fair out of Agent 1's recurring
  // queue: both getActiveInstitutions() and getInstitutionsDueForRefresh() filter on
  // manual_entry_required = false. Fairs are scraped once, on demand, from here.
  const { data: venue, error: venueErr } = await db
    .from('venues')
    .insert({
      institution_id: inst.id,
      name,
      exhibitions_url: body.exhibitions_url,
      address: body.fair_location ?? null,
      latitude: lat,
      longitude: lng,
      active: true,
      manual_entry_required: true,
    })
    .select('id')
    .single()
  if (venueErr || !venue) {
    await db.from('institutions').delete().eq('id', inst.id)
    return NextResponse.json({ error: venueErr?.message ?? 'venue insert failed' }, { status: 500 })
  }

  let coverage: unknown[] = []
  if (body.generate_coverage) {
    try {
      coverage = await generateFairCoverage(name)
    } catch (err) {
      console.error(`Fair coverage failed for ${name}:`, err)
    }
  }

  const { data: ex, error: exErr } = await db
    .from('exhibitions')
    .insert({
      venue_id: venue.id,
      show_title: name,
      start_date: body.start_date,
      end_date: body.end_date,
      image_url: body.image_url ?? null,
      detail_url: body.exhibitions_url,
      status: 'pending',
      // Same gate museums use — a fair gets searched coverage, never a generated
      // preread, and the prereads table is never written for it.
      preread_type: 'coverage_only',
      coverage,
    })
    .select('id')
    .single()
  if (exErr || !ex) {
    await db.from('venues').delete().eq('id', venue.id)
    await db.from('institutions').delete().eq('id', inst.id)
    return NextResponse.json({ error: exErr?.message ?? 'exhibition insert failed' }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    institution_id: inst.id,
    venue_id: venue.id,
    exhibition_id: ex.id,
    exhibitor_count: (body.exhibitors ?? []).length,
    coverage_count: coverage.length,
    geocoded: lat !== null,
  })
}
