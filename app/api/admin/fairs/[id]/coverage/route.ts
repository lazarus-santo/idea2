import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'
import { generateFairCoverage, crossLinkCoverageToReadings, coverageItemToPrereadRow } from '@/lib/museum-coverage'
import { recomputePrereadStatus } from '@/lib/agent2'
import { loggedPrereadIds } from '@/lib/preread-logs'
import { planFairCoverageWrites } from '@/lib/preread-writes'

// POST /api/admin/fairs/[id]/coverage — run the fair coverage search for one fair.
// [id] is the institution id. Spends Exa searches, so it is an explicit action
// rather than something the create path always does.
//
// No gate of any kind, by design — unlike the museum trigger in scraper.ts,
// this route is meant to be re-run on demand.
//
// It used to overwrite by deleting every preread for the fair and inserting the
// fresh set, which handed all of them new ids on every click — the same
// delete-and-recreate shape Agent 1 had before 147d8ff, and the same hazard:
// anything referencing a preread id (a person's log, once logging ships) would
// be silently orphaned by an admin pressing a button.
//
// Now each regenerated item is matched to its existing row by article address
// and updated in place, so an article that is still there keeps its id. Only
// rows the regeneration no longer finds are removed, and a row someone has
// logged is never removed — it is blanked, so the log still resolves to what
// they read. See lib/preread-writes.ts for the matching rules.

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

  // Frozen rows (migration_v61) are archived copies, not live coverage: they take
  // no part in matching, and are neither refreshed nor removed.
  const { data: existingRows, error: readError } = await db
    .from('prereads')
    .select('id, article_url')
    .eq('exhibition_id', exhibitionId)
    .is('superseded_by', null)
  if (readError) return NextResponse.json({ error: readError.message }, { status: 500 })

  const existing = (existingRows ?? []) as { id: string; article_url: string | null }[]
  const logged = await loggedPrereadIds(existing.map((r) => r.id))
  const plan = planFairCoverageWrites(exhibitionId, existing, coverage, logged, coverageItemToPrereadRow)

  for (const { id: rowId, row } of plan.updates) {
    const { error: updateError } = await db.from('prereads').update(row).eq('id', rowId)
    if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 })
  }

  if (plan.inserts.length > 0) {
    const { error: insertError } = await db.from('prereads').insert(plan.inserts)
    if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 })
  }

  if (plan.blanks.length > 0) {
    const { error: blankError } = await db.from('prereads').update({ row_status: 'blanked' }).in('id', plan.blanks)
    if (blankError) return NextResponse.json({ error: blankError.message }, { status: 500 })
  }

  // The one delete left in this path, and it only ever touches rows nobody has
  // logged. migration_v54's trigger copies each one into preread_deletions first.
  if (plan.deletes.length > 0) {
    const { error: deleteError } = await db.from('prereads').delete().in('id', plan.deletes)
    if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 500 })
  }

  await crossLinkCoverageToReadings(exhibitionId, coverage).catch((err) =>
    console.error(`Fair coverage cross-link failed for ${inst.name}:`, err)
  )

  // Keep Agent 2's status in step (migration_v53), or Run Now would treat this
  // show as never attempted.
  await recomputePrereadStatus(exhibitionId)

  return NextResponse.json({
    ok: true,
    fair: inst.name,
    exhibition_id: exhibitionId,
    coverage_count: coverage.length,
    // What the regeneration actually did, so "ids are preserved" is verifiable
    // from the response rather than taken on trust.
    rows: {
      kept: plan.updates.length,
      added: plan.inserts.length,
      blanked_because_logged: plan.blanks.length,
      deleted: plan.deletes.length,
    },
    coverage,
  })
}
