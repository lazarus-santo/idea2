import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'
import { generateFairCoverage, crossLinkCoverageToReadings, coverageItemToPrereadRow } from '@/lib/museum-coverage'
import { recomputePrereadStatus } from '@/lib/agent2'

// POST /api/admin/fairs/[id]/coverage — run the fair coverage search for one fair.
// [id] is the institution id. Spends Exa searches, so it is an explicit action
// rather than something the create path always does.
//
// No gate of any kind, by design — unlike the museum trigger in scraper.ts,
// this route is meant to be re-run on demand and always overwrites. Coverage
// now lives as prereads rows rather than one overwritable jsonb value
// (migration_v35), so "overwrite" here means delete this fair's existing
// prereads rows first, then insert the fresh set — the same delete-then-
// regenerate shape /api/debug-prereads already uses for galleries.

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

  const coverage = await generateFairCoverage(inst.name as string, exhibitionId)

  // preread_type is re-asserted rather than assumed: it is the gate that keeps
  // Agent 2's gallery preread path away from this row.
  const { error } = await db
    .from('exhibitions')
    .update({ preread_type: 'coverage_only' })
    .eq('id', exhibitionId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const { error: deleteError } = await db.from('prereads').delete().eq('exhibition_id', exhibitionId)
  if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 500 })

  if (coverage.length > 0) {
    const { error: insertError } = await db
      .from('prereads')
      .insert(coverage.map((c) => coverageItemToPrereadRow(exhibitionId, c)))
    if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 })
  }

  await crossLinkCoverageToReadings(exhibitionId, coverage).catch((err) =>
    console.error(`Fair coverage cross-link failed for ${inst.name}:`, err)
  )

  // Keep Agent 2's status in step (migration_v53), or Run Now would treat this
  // show as never attempted.
  await recomputePrereadStatus(exhibitionId)

  return NextResponse.json({ ok: true, fair: inst.name, exhibition_id: exhibitionId, coverage_count: coverage.length, coverage })
}
