import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'

// GET /api/exhibitions — returns current published exhibitions with prereads
export async function GET() {
  const today = new Date().toISOString().split('T')[0]

  const { data: exhibitions, error } = await getSupabaseAdmin()
    .from('exhibitions')
    .select(`
      *,
      venues!inner(name, exhibitions_url, address, neighborhood, institution_id, institutions!inner(id, name, type)),
      exhibition_artists(artists(name)),
      prereads(id, exhibition_id, article_title, publication, article_url, thumbnail_url, created_at)
    `)
    .eq('status', 'published')
    .or(`end_date.gte.${today},end_date.is.null`)
    .order('start_date', { ascending: true })

  if (error) {
    console.error('Failed to fetch exhibitions:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const ninetyDaysAgo = new Date()
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)
  const cutoff = ninetyDaysAgo.toISOString().split('T')[0]

  const normalized = (exhibitions ?? [])
    .filter((ex) => !ex.start_date || ex.start_date <= today)
    .filter((ex) => ex.is_ongoing || ex.end_date || (ex.start_date && ex.start_date >= cutoff))
    .map((ex) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = ex as any
      const { venues: venueData, exhibition_artists, ...rest } = raw
      const institution = venueData.institutions ?? null

      return {
        ...rest,
        institution_name: institution?.name ?? venueData.name,
        institution_id: institution?.id ?? null,
        venue_name: venueData.name,
        venue_type: institution?.type ?? 'gallery',
        venue_url: venueData.exhibitions_url,
        venue_address: venueData.address ?? null,
        resolved_address: rest.address_override ?? venueData.address ?? null,
        resolved_neighborhood: rest.address_override_neighborhood ?? venueData.neighborhood ?? null,
        artists: (exhibition_artists ?? [])
          .map((ea: { artists: { name: string } | null }) => ea.artists?.name)
          .filter(Boolean) as string[],
      }
    })

  return NextResponse.json(normalized)
}
