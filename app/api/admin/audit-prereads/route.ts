import { NextResponse } from 'next/server'
import { runAgent2 } from '@/lib/audit'

export async function POST() {
  try {
    const result = await runAgent2()
    return NextResponse.json({ ok: true, ...result })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
