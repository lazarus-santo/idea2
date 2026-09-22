import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import type { AgentName } from '@/lib/agent-runs'
import { currentAiBlock, type AiBlock, type AiRunRow } from '@/lib/ai-account'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'

// Whether any agent's AI provider is refusing it right now — for the warning
// at the top of the admin panel (components/admin/AiAccountBanner.tsx). What
// counts as blocked, and what clears it, is currentAiBlock in lib/ai-account.ts.

const AGENTS: AgentName[] = ['agent1', 'agent2', 'agent3_daily', 'agent3_hourly']
// Far more than a blocked streak needs: Agent 1 runs every 15 minutes, so 200
// runs is two days of quiet runs before the last one that said anything.
const RUNS_TO_READ = 200

export interface AiAgentProblem extends AiBlock {
  agent: AgentName
}

export async function GET(request: Request) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()
  const db = getSupabaseAdmin()

  const results = await Promise.all(AGENTS.map((agent) =>
    db.from('agent_runs')
      .select('started_at, items_succeeded, errors, summary')
      .eq('agent', agent)
      .neq('status', 'running')
      .order('started_at', { ascending: false })
      .limit(RUNS_TO_READ)
  ))

  const problems: AiAgentProblem[] = []
  for (let i = 0; i < AGENTS.length; i++) {
    const { data, error } = results[i]
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    const block = currentAiBlock((data ?? []) as AiRunRow[])
    if (block) problems.push({ agent: AGENTS[i], ...block })
  }

  return NextResponse.json({ problems })
}
