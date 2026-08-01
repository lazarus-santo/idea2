import { NextResponse } from 'next/server'
import { runAgent3 } from '@/lib/readings-curator'
import { isAuthorizedAgentRequest as isAuthorized } from '@/lib/api-auth'

// Observed durations for the T1 pass (agent_runs, last five runs): 9s, 17s,
// 32s, 75s, 80s. Past the 60s default, so the ceiling is set explicitly.
export const maxDuration = 300

async function curate() {
  // Awaited, not backgrounded — see the note in ../route.ts.
  try {
    const result = await runAgent3('t1')
    console.log('Hourly curation complete:', result)
    return NextResponse.json({ message: 'Hourly curation complete (T1 only)', ...result })
  } catch (err) {
    console.error('Hourly curation error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}

// GET — called by Vercel Cron (hourly, T1 publications only)
export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return curate()
}

// POST — manual trigger
export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return curate()
}
