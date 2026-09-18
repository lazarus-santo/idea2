import { runAgent2AcrossExhibitions } from './agent2'
import { startAgentRun, finishAgentRun, failAgentRun, type AgentRunError, type AgentRunResult } from './agent-runs'

// ─── Agent 2 run wrapper (Trigger 2: the dashboard's Run Now) ────────────────
//
// Replaces the old audit pass, which only covered gallery shows, deleted any
// preread on the venue's own domain, and regenerated when fewer than two were left.
// Now every published show on both paths ('full' and 'coverage_only') goes through
// the same status rules as an Agent 1 run — see lib/agent2.ts. Self-sourced
// articles are filtered out at generation time, so there is no delete step.
//
// "Items" are shows auto mode actually acted on (never attempted, errored, or
// needing review). Shows already at success / empty / blocked aren't loaded.

// Leaves ~100s of the route's 800s ceiling for the run-record write and response.
const RUN_BUDGET_MS = 700_000

export async function runAgent2(): Promise<AgentRunResult> {
  const runId = await startAgentRun('agent2')
  const errors: AgentRunError[] = []

  try {
    const { eligible, outcomes, deferred } = await runAgent2AcrossExhibitions(errors, RUN_BUDGET_MS)

    const count = (action: string) => outcomes.filter((o) => o.action === action).length
    const statusCounts: Record<string, number> = {}
    for (const o of outcomes) {
      const key = o.statusAfter ?? 'null'
      statusCounts[key] = (statusCounts[key] ?? 0) + 1
    }

    const itemsFailed = count('failed') + errors.filter((e) => e.step === 'agent2').length
    const result: AgentRunResult = {
      itemsProcessed: outcomes.length + errors.filter((e) => e.step === 'agent2').length,
      itemsSucceeded: outcomes.length - count('failed'),
      itemsFailed,
      errors,
      summary: {
        eligible,
        deferred_to_next_run: deferred,
        generated: count('generated'),
        repaired: count('repaired'),
        blocked: count('blocked'),
        failed: count('failed'),
        status_after: statusCounts,
      },
    }
    await finishAgentRun(runId, result)
    return result
  } catch (err) {
    await failAgentRun(runId, err instanceof Error ? err.message : String(err))
    throw err
  }
}
