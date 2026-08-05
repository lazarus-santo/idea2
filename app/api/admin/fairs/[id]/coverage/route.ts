import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'
import { generateFairCoverage, crossLinkCoverageToReadings } from '@/lib/museum-coverage'

// POST /api/admin/fairs/[id]/coverage — run the fair coverage search for one fair.
// [id] is the institution id. Spends Exa searches, so it is an explicit action
// rather than something the create path always does.

export const maxDuration = 300

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()

  const { id } = await params
  const db = getSupabaseAdmin()

  const { data: inst, error: instErr } = await db
    .from('institutions')
    .select('id, name, type, venues(id, exhibitions(id))')
    .eq('id', id)
    .single()

  if (instErr || !inst) return NextResponse.json({ error: 'Fair not found' }, { status: 404 })
  if (inst.type !== 'fair') return NextResponse.json({ error: `Institution is type '${inst.type}', not 'fair'` }, { status: 400 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exhibitionId = (inst as any).venues?.[0]?.exhibitions?.[0]?.id
  if (!exhibitionId) return NextResponse.json({ error: 'Fair has no exhibition row to attach coverage to' }, { status: 409 })

  const coverage = await generateFairCoverage(inst.name as string)

  // preread_type is re-asserted rather than assumed: it is the gate that keeps
  // Agent 2's gallery preread path away from this row.
  const { error } = await db
    .from('exhibitions')
    .update({ coverage, preread_type: 'coverage_only' })
    .eq('id', exhibitionId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await crossLinkCoverageToReadings(exhibitionId, coverage).catch((err) =>
    console.error(`Fair coverage cross-link failed for ${inst.name}:`, err)
  )

  return NextResponse.json({ ok: true, fair: inst.name, exhibition_id: exhibitionId, coverage_count: coverage.length, coverage })
}
