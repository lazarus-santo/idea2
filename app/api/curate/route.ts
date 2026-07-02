import { NextResponse } from 'next/server'
import { runAgent3 } from '@/lib/readings-curator'

function isAuthorized(request: Request): boolean {
  // Vercel Cron: GET with Authorization: Bearer <CRON_SECRET>
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret) {
    const auth = request.headers.get('authorization')
    if (auth === `Bearer ${cronSecret}`) return true
  }
  // Manual trigger: any method with x-admin-secret
  const adminSecret = request.headers.get('x-admin-secret')
  if (adminSecret && adminSecret === process.env.ADMIN_PASSWORD) return true
  return false
}

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
