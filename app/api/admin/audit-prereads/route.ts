import { NextResponse } from 'next/server'
import { auditAndRepairPrereads } from '@/lib/audit'

export async function POST() {
  try {
    const result = await auditAndRepairPrereads()
    return NextResponse.json({ ok: true, ...result })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
