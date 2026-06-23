import { NextResponse } from 'next/server'

// going_counts was removed in schema v2 — this endpoint is no longer active
export async function POST() {
  return NextResponse.json({ error: 'Not implemented' }, { status: 410 })
}
