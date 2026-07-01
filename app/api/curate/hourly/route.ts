import { NextResponse } from 'next/server'
import { curateReadings } from '@/lib/readings-curator'

function isAuthorized(request: Request): boolean {
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret) {
    const auth = request.headers.get('authorization')
    if (auth === `Bearer ${cronSecret}`) return true
  }
  const adminSecret = request.headers.get('x-admin-secret')
  if (adminSecret && adminSecret === process.env.ADMIN_PASSWORD) return true
  return false
}

function runInBackground() {
  Promise.resolve().then(async () => {
    try {
      const result = await curateReadings('t1')
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
