import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'

// GET /api/admin/publications — pending publications with a sample article
export async function GET() {
  const db = getSupabaseAdmin()

  const { data, error } = await db
    .from('publications')
    .select('id, name, status, readings(headline, article_url)')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const normalized = (data ?? []).map((pub: any) => ({
    id: pub.id,
    name: pub.name,
    sample_headline: pub.readings?.[0]?.headline ?? null,
    sample_url: pub.readings?.[0]?.article_url ?? null,
  }))

  return NextResponse.json(normalized)
}
