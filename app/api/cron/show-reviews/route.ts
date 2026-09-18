import { NextRequest, NextResponse } from 'next/server'
import { runShowReviewsDue } from '@/lib/agent2'
import type { AgentRunError } from '@/lib/agent-runs'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'

// GET /api/cron/show-reviews — gallery solo S4, once a day.
//
// A show review can't exist the day a show opens, so the solo ladder waits 14 days
// (exhibitions.show_review_pending_until, migration_v55). This finds every published
// solo show whose wait is over and that hasn't had its show-review search yet (or
// whose search has errored fewer than 3 times), and runs it. An empty result is
// final. Rules: lib/agent2.ts runShowReviewsDue.
//
// Each show costs one or two Exa searches and a Haiku check. Called by Vercel Cron
// via Authorization: Bearer CRON_SECRET; also accepts x-admin-secret.

export const maxDuration = 800

// Shows may start only within this; the last 60s are held back for the final write.
const BUDGET_MS = maxDuration * 1000 - 60_000

export async function GET(request: NextRequest) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()

  const errors: AgentRunError[] = []
  try {
    const { eligible, outcomes, deferred } = await runShowReviewsDue(errors, BUDGET_MS)
    return NextResponse.json({
      eligible,
      ran: outcomes.length,
      found: outcomes.filter((o) => o.status === 'found').length,
      empty: outcomes.filter((o) => o.status === 'empty').length,
      error: outcomes.filter((o) => o.status.startsWith('error')).length,
      gave_up: outcomes.filter((o) => o.status === 'error3').length,
      deferred,
      outcomes,
      errors,
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err), errors }, { status: 500 })
  }
}
