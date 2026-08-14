import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { getSupabaseAdmin } from '@/lib/supabase'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

function normalizeForDedup(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(the|gallery|galleries|museum|museums|art|arts|foundation|institute|center|centre|studio|studios|project|projects|space|spaces|inc|llc|and|&)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '')
    .replace(/\s+/g, '')
}

// Pulls every complete top-level object out of a JSON array, and reports whether
// the array actually closed.
//
// Replaces a `\[[\s\S]*\]` match, which fails badly on a truncated response: the
// greedy match runs to the LAST ']' in the text, which after truncation is the
// close of some institution's "venues" array rather than the array itself. That
// yields a string that looks like JSON, fails to parse, and surfaced as "Invalid
// JSON in response" — accurate but useless, since the real cause was length.
//
// Scanning object by object means a truncated response still returns everything
// that did come through, instead of throwing away 19 good institutions because
// the 20th was cut in half.
function extractObjects(text: string): { items: unknown[]; closed: boolean } | null {
  const start = text.indexOf('[')
  if (start === -1) return null

  const items: unknown[] = []
  let depth = 0
  let inString = false
  let escaped = false
  let objStart = -1
  let closed = false

  for (let i = start + 1; i < text.length; i++) {
    const c = text[i]

    // String state has to be tracked or a '}' inside a gallery name — or an
    // escaped quote in an address — would be read as structure.
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') { inString = true; continue }

    if (c === '{') { if (depth === 0) objStart = i; depth++; continue }
    if (c === '}') {
      depth--
      if (depth === 0 && objStart !== -1) {
        try { items.push(JSON.parse(text.slice(objStart, i + 1))) } catch { /* skip malformed object */ }
        objStart = -1
      }
      continue
    }
    if (c === ']' && depth === 0) { closed = true; break }
  }

  return { items, closed }
}

export async function POST(req: NextRequest) {
  if (!isAuthorizedAgentRequest(req)) return unauthorized()

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

  const SYSTEM = `You are an expert on the New York City art world. Given a query, return ONLY a valid JSON array of NYC institutions matching the query, no markdown or commentary. Each object: { name: string, website: string, type: 'museum'|'gallery'|'nonprofit'|'experimental', venues: [{ name: string, exhibitions_url: string, address: string, neighborhood: string, latitude: number, longitude: number }] }. Most institutions have exactly one venue. Only include real currently-operating NYC institutions. Return 5-20 institutions.

address MUST be the full street address including city, state and ZIP — "531 West 24th Street, New York, NY 10011", never the bare street line. A street number and name alone is ambiguous across the country: "531 West 24th Street" also exists in Indianapolis, and "522 West 22nd Street" in Cedar Falls, Iowa.${exclusionLine}`

  let raw: string
  let stopReason: string | null = null
  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      // 20 institutions measured at ~4050 output tokens, so the old 4096 ceiling
      // sat directly on the requested maximum — runs returning 18 fit, runs
      // returning 20 were cut off mid-object. Roughly half of them failed.
      max_tokens: 16000,
      system: SYSTEM,
      messages: [{ role: 'user', content: query.trim() }],
    })
    stopReason = msg.stop_reason
    raw = (msg.content.find((b) => b.type === 'text') as { text: string } | undefined)?.text ?? ''
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Claude API error: ${msg}` }, { status: 502 })
  }

  const jsonStr = raw.replace(/```(?:json)?\n?/g, '').trim()
  const extracted = extractObjects(jsonStr)
  if (!extracted) {
    return NextResponse.json({ error: 'No JSON array found in response', raw }, { status: 502 })
  }

  const truncated = !extracted.closed || stopReason === 'max_tokens'
  if (extracted.items.length === 0) {
    return NextResponse.json(
      {
        error: truncated
          ? 'The response was cut off before any complete institution came through. Try a narrower query.'
          : 'Could not parse any institutions from the response',
        raw,
      },
      { status: 502 }
    )
  }

  const institutions: unknown[] = extracted.items

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

  // A truncated response is still worth returning — the complete institutions in
  // it are fine. Surfaced as a warning rather than swallowed, so a short list
  // reads as "cut off" rather than "that's all there is".
  return NextResponse.json({
    institutions: deduped,
    ...(truncated
      ? { warning: `The response was cut off — showing the ${deduped.length} institution${deduped.length === 1 ? '' : 's'} that came through complete.` }
      : {}),
  })
}
