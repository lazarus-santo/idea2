import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'

// Remembered rejections from the CSV import review table.
//
// GET    — list every exclusion, newest first
// POST   { name, reason? }  — hide a gallery from future import batches
// DELETE { name } or { dedup_key } — restore it
//
// This is a hide, not a delete. The CSV is unchanged and any exclusion can be
// undone, because the alternative — rejecting the same galleries on every visit
// to a 430-row list — is what made the review table impractical.

// Same normalization the insert route and the import preview use, so an
// exclusion holds across spelling variants: "Andrew Kreps" and "Andrew Kreps
// Gallery" share a key and are hidden together.
export function normalizeForDedup(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(the|gallery|galleries|museum|museums|art|arts|foundation|institute|center|centre|studio|studios|project|projects|space|spaces|inc|llc|and|&)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '')
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()
  const { data, error } = await getSupabaseAdmin()
    .from('seed_exclusions')
    .select('id, dedup_key, name, reason, created_at')
    .order('created_at', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ exclusions: data ?? [], count: (data ?? []).length })
}

export async function POST(request: NextRequest) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()
  const body = await request.json().catch(() => ({}))
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })

  const dedup_key = normalizeForDedup(name) || name.toLowerCase()
  const { error } = await getSupabaseAdmin()
    .from('seed_exclusions')
    // Re-excluding something already hidden is not an error worth surfacing to
    // someone clicking through a long list.
    .upsert({ dedup_key, name, reason: typeof body.reason === 'string' ? body.reason : null }, { onConflict: 'dedup_key' })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, dedup_key, name })
}

export async function DELETE(request: NextRequest) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()
  const body = await request.json().catch(() => ({}))
  const key = typeof body.dedup_key === 'string' && body.dedup_key
    ? body.dedup_key
    : typeof body.name === 'string' ? normalizeForDedup(body.name) : ''
  if (!key) return NextResponse.json({ error: 'name or dedup_key is required' }, { status: 400 })

  const { error } = await getSupabaseAdmin().from('seed_exclusions').delete().eq('dedup_key', key)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, restored: key })
}
