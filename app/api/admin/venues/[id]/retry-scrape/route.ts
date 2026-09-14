import { NextResponse } from 'next/server'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'

// POST /api/admin/venues/[id]/retry-scrape — retired. It started a scrape in the
// background and returned immediately, which on Vercel froze the scrape almost
// as soon as it began, and it bypassed the queue's per-venue lock. Replaced by
// POST /api/admin/venues/[id]/scrape, which waits for the result and shares
// the lock. Kept as an explicit 410 so a leftover caller gets a reason.
export async function POST(request: Request) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()

  return NextResponse.json(
    { error: 'retry-scrape is retired — use POST /api/admin/venues/[id]/scrape.' },
    { status: 410 }
  )
}
