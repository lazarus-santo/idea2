import { NextRequest, NextResponse } from 'next/server'
import { runAgent2ForExhibition } from '@/lib/agent2'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'
import type { AgentRunError } from '@/lib/agent-runs'

// POST /api/admin/exhibitions/[id]/retrigger-prereads — the admin Retrigger button
// (Trigger 3A). Runs Agent 2 for one show in 'retrigger' mode: a show that is
// blocked, empty or errored is run again, a show needing review is repaired, and a
// show already at success is left alone. The missing-field block is re-checked
// every time and never bypassed — the response carries the show's missing fields
// so the admin UI can show them as warnings.
//
// A full generation is several Exa searches plus Claude calls, so this waits for
// the result instead of firing in the background: the admin sees the outcome.
export const maxDuration = 300

export async function POST(request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()

  const { id } = await params
  const errors: AgentRunError[] = []
  try {
    const outcome = await runAgent2ForExhibition(id, { mode: 'retrigger', errors })
    return NextResponse.json({ ok: true, ...outcome, errors })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
