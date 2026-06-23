import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { getSupabaseAdmin } from '@/lib/supabase'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

function normalizeForDedup(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(the|gallery|galleries|museum|museums|art|arts|foundation|institute|center|centre|studio|studios|project|projects|space|spaces|inc|llc|and|&)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '')
    .replace(/\s+/g, '')
}

export async function POST(req: NextRequest) {
  const { query } = await req.json()
  if (!query?.trim()) {
    return NextResponse.json({ error: 'query is required' }, { status: 400 })
  }

  const db = getSupabaseAdmin()
  const { data: existing } = await db.from('institutions').select('name')
  const existingNames: string[] = (existing ?? []).map((r: { name: string }) => r.name)

  const exclusionLine = existingNames.length > 0
    ? `\n\nThe following institutions already exist in the database — do NOT suggest them again: ${existingNames.join(', ')}.`
    : ''

  const SYSTEM = `You are an expert on the New York City art world. Given a query, return ONLY a valid JSON array of NYC institutions matching the query, no markdown or commentary. Each object: { name: string, website: string, type: 'museum'|'gallery'|'nonprofit'|'experimental', venues: [{ name: string, exhibitions_url: string, address: string, neighborhood: string, latitude: number, longitude: number }] }. Most institutions have exactly one venue. Only include real currently-operating NYC institutions. Return 5-20 institutions.${exclusionLine}`

  let raw: string
  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: SYSTEM,
      messages: [{ role: 'user', content: query.trim() }],
    })
    raw = (msg.content[0] as { type: string; text: string }).text
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Claude API error: ${msg}` }, { status: 502 })
  }

  let jsonStr = raw.replace(/```(?:json)?\n?/g, '').trim()
  const match = jsonStr.match(/\[[\s\S]*\]/)
  if (!match) {
    return NextResponse.json({ error: 'Could not parse JSON from response', raw }, { status: 502 })
  }
  jsonStr = match[0]

  let institutions: unknown[]
  try {
    institutions = JSON.parse(jsonStr)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON in response', raw }, { status: 502 })
  }

  if (!Array.isArray(institutions)) {
    return NextResponse.json({ error: 'Response was not a JSON array', raw }, { status: 502 })
  }

  const normalizedExisting = existingNames.map(n => ({ name: n, norm: normalizeForDedup(n) }))

  // Filter exact duplicates; flag near-matches
  const deduped = institutions
    .filter((item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null &&
      typeof (item as Record<string, unknown>).name === 'string' &&
      Array.isArray((item as Record<string, unknown>).venues)
    )
    .map(inst => {
      const instName = String(inst.name)
      const normInst = normalizeForDedup(instName)

      const exactMatch = normalizedExisting.find(e => e.norm === normInst && e.norm.length > 2)
      if (exactMatch) return null  // already in DB, silently drop

      const nearMatch = normalizedExisting.find(e =>
        e.norm.length > 3 && normInst.length > 3 &&
        (e.norm.includes(normInst) || normInst.includes(e.norm))
      )
      if (nearMatch) {
        return { ...inst, _dupWarning: `Possible duplicate of existing: "${nearMatch.name}"` }
      }

      return inst
    })
    .filter(Boolean)

  return NextResponse.json({ institutions: deduped })
}
