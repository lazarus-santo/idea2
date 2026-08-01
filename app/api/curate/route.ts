import { NextResponse } from 'next/server'
import { runAgent3 } from '@/lib/readings-curator'
import { isAuthorizedAgentRequest as isAuthorized } from '@/lib/api-auth'

// Observed durations for the daily pass (agent_runs, last five runs): 14s, 32s,
// 40s, 166s, 170s. Comfortably inside 300s, but well past the 60s a Vercel
// function gets by default — hence the explicit ceiling.
export const maxDuration = 300

async function curate() {
  // Awaited rather than backgrounded: on Vercel the instance is frozen as soon
  // as the response is sent, so the old Promise.resolve().then(...) would have
  // been killed within milliseconds of the route returning.
  try {
    const result = await runAgent3('non-t1')
    console.log('Daily curation complete:', result)
    return NextResponse.json({ message: 'Daily curation complete (non-T1)', ...result })
  } catch (err) {
    console.error('Daily curation error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}

// GET — called by Vercel Cron (daily, non-T1 publications)
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
