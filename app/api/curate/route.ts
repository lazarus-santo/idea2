import { NextResponse } from 'next/server'
import { runAgent3 } from '@/lib/readings-curator'
import { isAuthorizedAgentRequest as isAuthorized } from '@/lib/api-auth'

function runInBackground() {
  Promise.resolve().then(async () => {
    try {
      const result = await runAgent3('non-t1')
      console.log('Daily curation complete:', result)
    } catch (err) {
      console.error('Daily curation error:', err)
    }
  })
}

// GET — called by Vercel Cron (daily, non-T1 publications)
export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  runInBackground()
  return NextResponse.json({ message: 'Daily curation started (non-T1)' })
}

// POST — manual trigger (admin UI, curl, testing)
export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  runInBackground()
  return NextResponse.json({ message: 'Daily curation started (non-T1)' })
}
