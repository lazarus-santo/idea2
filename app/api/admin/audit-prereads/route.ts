import { NextResponse } from 'next/server'
import { runAgent2 } from '@/lib/audit'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'

// POST /api/admin/audit-prereads — Agent 2's only trigger (no cron entry; the
// dashboard's Run Now button and manual curl are the callers). Regeneration
// spends Exa searches and Anthropic completions per exhibition, so it takes the
// same gate as the other agent routes.
export async function POST(request: Request) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()

  try {
    const result = await runAgent2()
    return NextResponse.json({ ok: true, ...result })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
