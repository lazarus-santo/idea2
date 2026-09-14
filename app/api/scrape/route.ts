import { NextResponse } from 'next/server'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'

// POST /api/scrape — retired. It ran a batch of Agent 1 on its own 240s budget
// (the dashboard's Agent 1 "Run Now" button), outside the scheduled queue.
// Scheduled scraping is now the 15-minute queue in app/api/cron/scrape, and one
// venue on demand is POST /api/admin/venues/[id]/scrape. Kept as an explicit
// 410 rather than deleted so a leftover caller gets a reason, not a bare 404.
export async function POST(request: Request) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()

  return NextResponse.json(
    {
      error: 'POST /api/scrape is retired. Venues are scraped by the 15-minute queue; to scrape one venue now, use POST /api/admin/venues/[id]/scrape.',
    },
    { status: 410 }
  )
}
