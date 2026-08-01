import { NextResponse } from 'next/server'
import { runAgent2 } from '@/lib/audit'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'

// POST /api/admin/audit-prereads — Agent 2's only trigger (no cron entry; the
// dashboard's Run Now button and manual curl are the callers). Regeneration
// spends Exa searches and Anthropic completions per exhibition, so it takes the
// same gate as the other agent routes.

// Agent 2 already awaited its work, so it was never at risk from the frozen
// instance — but it still needs a ceiling above the 60s default, since a repair
// pass is an Exa search plus a Claude call per uncovered exhibition.
export const maxDuration = 800

export async function POST(request: Request) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()

  try {
    const result = await runAgent2()
    return NextResponse.json({ ok: true, ...result })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
