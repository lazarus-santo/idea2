import { getSupabaseAdmin } from './supabase'

export type AgentName = 'agent1' | 'agent2' | 'agent3_daily' | 'agent3_hourly'
export type RunStatus = 'running' | 'success' | 'partial' | 'failed'

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

// Inserts a 'running' row at the start of an agent run. Returns the row id
// (or null if the insert failed — callers should not let bookkeeping
// failures block the underlying agent work).
export async function startAgentRun(agent: AgentName): Promise<string | null> {
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

  const { error } = await db
    .from('agent_runs')
    .update({
      completed_at: completedAt.toISOString(),
      status,
      items_processed: result.itemsProcessed,
      items_succeeded: result.itemsSucceeded,
      items_failed: result.itemsFailed,
      errors: result.errors,
      summary: result.summary ?? {},
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
