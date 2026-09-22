import { getSupabaseAdmin } from './supabase'
import { aiActivitySince } from './ai-account'

export type AgentName = 'agent1' | 'agent2' | 'agent3_daily' | 'agent3_hourly'
// 'timed_out' is never derived: it marks runs the platform killed before they
// could finish (migration_v38, scripts/cleanup-stale-agent-runs.mjs).
export type RunStatus = 'running' | 'success' | 'partial' | 'failed' | 'timed_out'

export interface AgentRunError {
  item: string
  step: string
  message: string
}

export interface AgentRunResult {
  itemsProcessed: number
  itemsSucceeded: number
  itemsFailed: number
  errors: AgentRunError[]
  summary?: Record<string, unknown>
}

// When each run started, by this instance's clock, so finishAgentRun can ask
// lib/ai-account.ts what the AI clients saw during the run.
const runStarts = new Map<string, number>()

// Inserts a 'running' row at the start of an agent run. Returns the row id
// (or null if the insert failed — callers should not let bookkeeping
// failures block the underlying agent work).
export async function startAgentRun(agent: AgentName): Promise<string | null> {
  const startedAt = Date.now()
  const db = getSupabaseAdmin()
  const { data, error } = await db
    .from('agent_runs')
    .insert({ agent, status: 'running' })
    .select('id, started_at')
    .single()

  if (error || !data) {
    console.error(`Failed to start agent_runs row for ${agent}:`, error?.message)
    return null
  }
  runStarts.set(data.id as string, startedAt)
  return data.id as string
}

function deriveStatus(itemsProcessed: number, itemsFailed: number): RunStatus {
  if (itemsProcessed === 0) return itemsFailed > 0 ? 'failed' : 'success'
  if (itemsFailed === 0) return 'success'
  if (itemsFailed === itemsProcessed) return 'failed'
  return 'partial'
}

// Updates the row with final counts/errors/duration. Computes duration_ms
// from the row's own started_at so callers don't need to track timing.
export async function finishAgentRun(
  runId: string | null,
  result: AgentRunResult,
  overrideStatus?: RunStatus
): Promise<void> {
  if (!runId) return
  const db = getSupabaseAdmin()

  const { data: existing } = await db
    .from('agent_runs')
    .select('started_at')
    .eq('id', runId)
    .single()

  const startedAt = existing?.started_at ? new Date(existing.started_at as string).getTime() : Date.now()
  const completedAt = new Date()
  const durationMs = completedAt.getTime() - startedAt

  const status = overrideStatus ?? deriveStatus(result.itemsProcessed, result.itemsFailed)

  // summary.ai: successful Anthropic/Voyage calls during the run, and any
  // billing/key/limit error they hit. The admin banner reads it
  // (app/api/admin/ai-status). Recorded for every agent, whatever the agent's
  // own code did with the error.
  const runStart = runStarts.get(runId) ?? startedAt
  runStarts.delete(runId)
  const summary = { ...(result.summary ?? {}), ai: aiActivitySince(runStart) }

  const { error } = await db
    .from('agent_runs')
    .update({
      completed_at: completedAt.toISOString(),
      status,
      items_processed: result.itemsProcessed,
      items_succeeded: result.itemsSucceeded,
      items_failed: result.itemsFailed,
      errors: result.errors,
      summary,
      duration_ms: durationMs,
    })
    .eq('id', runId)

  if (error) console.error(`Failed to finish agent_runs row ${runId}:`, error.message)
}

// Marks a run as failed when the agent throws before producing any result
// (e.g. a network error before the main loop starts).
export async function failAgentRun(runId: string | null, message: string): Promise<void> {
  if (!runId) return
  await finishAgentRun(
    runId,
    { itemsProcessed: 0, itemsSucceeded: 0, itemsFailed: 0, errors: [{ item: '(run)', step: 'startup', message }] },
    'failed'
  )
}
