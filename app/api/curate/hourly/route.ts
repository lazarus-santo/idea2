import { NextResponse } from 'next/server'
import { runAgent3 } from '@/lib/readings-curator'
import { isAuthorizedAgentRequest as isAuthorized } from '@/lib/api-auth'

function runInBackground() {
  Promise.resolve().then(async () => {
    try {
      const result = await runAgent3('t1')
      console.log('Hourly curation complete:', result)
    } catch (err) {
      console.error('Hourly curation error:', err)
    }
  })
}

// GET — called by Vercel Cron (hourly, T1 publications only)
export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  runInBackground()
  return NextResponse.json({ message: 'Hourly curation started (T1 only)' })
}

// POST — manual trigger
export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  runInBackground()
  return NextResponse.json({ message: 'Hourly curation started (T1 only)' })
}
