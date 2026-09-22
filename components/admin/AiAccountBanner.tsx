'use client'

import { useEffect, useState } from 'react'
import { adminFetch } from '@/lib/admin-fetch'
import type { AiAgentProblem } from '@/app/api/admin/ai-status/route'

// Sits above the tabs on every admin screen while any agent's AI provider is
// refusing it for billing, a rejected key or a usage limit. It goes away on
// its own once a later run of that agent gets an answer again — see
// app/api/admin/ai-status for exactly what counts.

const F = 'var(--font-inter-tight), system-ui, sans-serif'

const AGENT_LABEL: Record<AiAgentProblem['agent'], string> = {
  agent1: 'Agent 1 (exhibitions)',
  agent2: 'Agent 2 (prereads)',
  agent3_daily: 'Agent 3 daily (readings)',
  agent3_hourly: 'Agent 3 hourly (readings)',
}

const PROVIDER_LABEL = { anthropic: 'Anthropic', voyage: 'Voyage' } as const

const PROBLEM_LABEL = {
  billing: 'billing — out of credit or over a spend limit',
  access: 'the API key or account was refused',
  limit: 'a usage or rate limit',
} as const

function when(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York',
  }) + ' ET'
}

export default function AiAccountBanner() {
  const [problems, setProblems] = useState<AiAgentProblem[]>([])

  useEffect(() => {
    let live = true
    adminFetch('/api/admin/ai-status')
      .then((res) => (res.ok ? res.json() : { problems: [] }))
      .then((body: { problems?: AiAgentProblem[] }) => { if (live) setProblems(body.problems ?? []) })
      .catch(() => {})
    return () => { live = false }
  }, [])

  if (problems.length === 0) return null

  return (
    <div role="alert" style={{
      fontFamily: F, background: '#B42318', color: '#fff',
      padding: '16px 20px', marginBottom: 28, fontSize: 13, lineHeight: 1.5,
    }}>
      <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>
        An AI provider is refusing the agents. Nothing is being curated until this is fixed.
      </div>
      {problems.map((p) => (
        <div key={p.agent} style={{ marginBottom: 6 }}>
          <strong>{AGENT_LABEL[p.agent]}</strong>: {PROVIDER_LABEL[p.error.provider]} refused it — {PROBLEM_LABEL[p.error.problem]}.
          {' '}Since {when(p.since)}; last seen {when(p.last_blocked_run)}.
          <span style={{ opacity: 0.8 }}> “{p.error.message}”</span>
        </div>
      ))}
      <div style={{ opacity: 0.85, marginTop: 8 }}>
        Articles wait and are retried, but anything that drops out of its feed or passes 7 days old before
        this is fixed is missed. This warning clears after the next run that gets an answer.
      </div>
    </div>
  )
}
