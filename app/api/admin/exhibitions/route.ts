import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'

// GET /api/admin/exhibitions — all exhibitions (pending + published) for admin UI
export async function GET() {
  const db = getSupabaseAdmin()

  const { data, error } = await db
    .from('exhibitions')
    .select(`
      id, show_title, start_date, end_date, description, press_release, image_url,
      status, missing_fields, address_override, address_override_neighborhood,
      created_at, updated_at,
      venues!inner(name, exhibitions_url, address, neighborhood, institutions!inner(name, type)),
      exhibition_artists(artists(name)),
      prereads(id, article_title, publication, article_url, summary, thumbnail_url)
    `)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const normalized = (data ?? []).map((ex) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = ex as any
    const { venues: venueData, exhibition_artists, ...rest } = raw
    const institution = venueData.institutions ?? null

    return {
      ...rest,
      institution_name: institution?.name ?? venueData.name,
      venue_name: venueData.name,
      venue_type: institution?.type ?? 'gallery',
      venue_url: venueData.exhibitions_url,
      venue_address: venueData.address ?? null,
      venue_neighborhood: venueData.neighborhood ?? null,
      resolved_address: rest.address_override ?? venueData.address ?? null,
      resolved_neighborhood: rest.address_override_neighborhood ?? venueData.neighborhood ?? null,
      artists: (exhibition_artists ?? [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((ea: any) => ea.artists?.name)
        .filter(Boolean) as string[],
    }
  })

  return NextResponse.json(normalized)
}
