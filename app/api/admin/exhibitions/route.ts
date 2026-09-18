import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'
import { resolveExhibitionLocation } from '@/lib/exhibition-location'

// GET /api/admin/exhibitions — all exhibitions (pending + published) for admin UI
export async function GET(request: Request) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()

  const db = getSupabaseAdmin()

  const { data, error } = await db
    .from('exhibitions')
    .select(`
      id, show_title, start_date, end_date, is_ongoing, description, press_release, image_url,
      status, missing_fields, hide_artist_names, address_override, address_override_neighborhood,
      show_location, show_location_2, show_location_3, show_location_neighborhood, show_location_source,
      admin_notes, created_at, updated_at,
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
    // Same order as the public site (lib/exhibition-location.ts), so "on the site"
    // in the admin means exactly what visitors see.
    const location = resolveExhibitionLocation(rest, venueData)

    return {
      ...rest,
      institution_name: institution?.name ?? venueData.name,
      venue_name: venueData.name,
      venue_type: institution?.type ?? 'gallery',
      venue_url: venueData.exhibitions_url,
      venue_address: venueData.address ?? null,
      venue_neighborhood: venueData.neighborhood ?? null,
      resolved_address: location.address,
      resolved_addresses: location.addresses,
      resolved_neighborhood: location.neighborhood,
      resolved_location_source: location.source,
      artists: (exhibition_artists ?? [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((ea: any) => ea.artists?.name)
        .filter(Boolean) as string[],
    }
  })

  return NextResponse.json(normalized)
}
