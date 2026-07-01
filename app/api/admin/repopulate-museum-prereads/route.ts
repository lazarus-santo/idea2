import { NextResponse } from 'next/server'

// Museum coverage has been removed. This route is no longer active.
export async function POST() {
  return NextResponse.json({ error: 'Museum coverage has been removed' }, { status: 410 })
}
