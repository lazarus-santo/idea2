import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import type { AgentName } from '@/lib/agent-runs'

const AGENTS: AgentName[] = ['agent1', 'agent2', 'agent3_daily', 'agent3_hourly']

interface AgentStatus {
  last_run: string | null
  status: string | null
  items_processed: number
  items_succeeded: number
  items_failed: number
}

export async function GET() {
  const db = getSupabaseAdmin()
  const today = new Date().toISOString().split('T')[0]

  const [
    { count: publishedCount },
    { count: totalPendingCount },
    { count: upcomingCount },
    { count: manualRequiredCount },
    { data: fullPublishedIds },
    { data: prereadExhibitionIds },
    { count: readingsToday },
    { count: topStories },
    { count: unclassified },
    ...agentRows
  ] = await Promise.all([
    db.from('exhibitions').select('id', { count: 'exact', head: true }).eq('status', 'published'),
    db.from('exhibitions').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    db.from('exhibitions').select('id', { count: 'exact', head: true }).eq('status', 'pending').contains('missing_fields', ['upcoming']),
    db.from('venues').select('id', { count: 'exact', head: true }).eq('manual_entry_required', true),
    db.from('exhibitions').select('id').eq('status', 'published').eq('preread_type', 'full'),
    db.from('prereads').select('exhibition_id'),
    db.from('readings').select('id', { count: 'exact', head: true }).gte('created_at', today),
    db.from('readings').select('id', { count: 'exact', head: true }).eq('top_story', true),
    db.from('readings').select('id', { count: 'exact', head: true }).is('category', null),
    ...AGENTS.map((agent) =>
      db
        .from('agent_runs')
        .select('started_at, status, items_processed, items_succeeded, items_failed')
        .eq('agent', agent)
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle()
    ),
  ])

  // needs_preread: published gallery ('full') exhibitions with zero rows in prereads.
  // No single-query NOT EXISTS via supabase-js — diff two id sets in JS instead.
  const fullIds = new Set((fullPublishedIds ?? []).map((e) => e.id as string))
  const idsWithPrereads = new Set((prereadExhibitionIds ?? []).map((p) => p.exhibition_id as string))
  let needsPreread = 0
  for (const id of fullIds) {
    if (!idsWithPrereads.has(id)) needsPreread++
  }

  const agents: Record<AgentName, AgentStatus> = {} as Record<AgentName, AgentStatus>
  AGENTS.forEach((agent, i) => {
    const row = agentRows[i].data as {
      started_at: string
      status: string | null
      items_processed: number | null
      items_succeeded: number | null
      items_failed: number | null
    } | null
    agents[agent] = {
      last_run: row?.started_at ?? null,
      status: row?.status ?? null,
      items_processed: row?.items_processed ?? 0,
      items_succeeded: row?.items_succeeded ?? 0,
      items_failed: row?.items_failed ?? 0,
    }
  })

  return NextResponse.json({
    exhibitions: {
      pending: (totalPendingCount ?? 0) - (upcomingCount ?? 0),
      published: publishedCount ?? 0,
      upcoming: upcomingCount ?? 0,
      manual_required: manualRequiredCount ?? 0,
      needs_preread: needsPreread,
    },
    readings: {
      total_today: readingsToday ?? 0,
      top_stories: topStories ?? 0,
      unclassified: unclassified ?? 0,
    },
    agents,
  })
}
