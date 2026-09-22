import { NextResponse } from 'next/server'
import { runAgent3 } from '@/lib/readings-curator'
import { isAuthorizedAgentRequest as isAuthorized } from '@/lib/api-auth'

// Every active publication, every hour — this is Agent 3's only run. The daily
// run for non-T1 outlets (/api/curate) was merged into it; tier now only picks
// a Top Story's lead article.
//
// Each stage stops at a fixed point in the run (see "One run inside 300
// seconds" in lib/readings-curator.ts), so a run with a large backlog still
// ends inside the ceiling and leaves the rest for the next hour.
export const maxDuration = 300

async function curate() {
  // Awaited rather than backgrounded: on Vercel the instance is frozen as soon
  // as the response is sent, so a backgrounded promise would be killed within
  // milliseconds of the route returning.
  try {
    const result = await runAgent3()
    console.log('Hourly curation complete:', result)
    return NextResponse.json({ message: 'Hourly curation complete', ...result })
  } catch (err) {
    console.error('Hourly curation error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}

// GET — called by Vercel Cron (hourly, every active publication)
export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return curate()
}

// POST — manual trigger (admin UI, curl, testing)
export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return curate()
}
