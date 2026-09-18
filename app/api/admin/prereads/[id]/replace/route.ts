import { NextRequest, NextResponse } from 'next/server'
import { replacePreread, Agent2UserError } from '@/lib/agent2'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'

// POST /api/admin/prereads/[id]/replace — the admin Replace button (Trigger 3B).
// Body: { query?: string }. No query = a regular Agent 2 retry for this one row;
// a query = the admin's own search terms, used as-is. Gallery prereads only —
// museum and fair coverage has no quality check yet and gets a 400.
export const maxDuration = 120

export async function POST(request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()

  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const query = typeof body?.query === 'string' ? body.query : null

  try {
    const outcome = await replacePreread(id, query)
    return NextResponse.json({ ok: true, ...outcome })
  } catch (err) {
    const status = err instanceof Agent2UserError ? err.status : 500
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status })
  }
}
