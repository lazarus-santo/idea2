import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import type { AgentName } from '@/lib/agent-runs'

const AGENTS: AgentName[] = ['agent1', 'agent2', 'agent3_daily', 'agent3_hourly']

// Last 5 runs per agent — powers the Section 2 run-history timeline and the
// "recent errors" list (errors of the most recent run, runs[0]).
export async function GET() {
  const db = getSupabaseAdmin()

  const results = await Promise.all(
    AGENTS.map((agent) =>
      db
        .from('agent_runs')
        .select('id, started_at, completed_at, status, items_processed, items_succeeded, items_failed, errors, duration_ms')
        .eq('agent', agent)
        .order('started_at', { ascending: false })
        .limit(5)
    )
  )

  const byAgent: Record<AgentName, unknown[]> = {} as Record<AgentName, unknown[]>
  AGENTS.forEach((agent, i) => {
    byAgent[agent] = results[i].data ?? []
  })

  return NextResponse.json(byAgent)
}
