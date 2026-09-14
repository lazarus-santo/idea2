#!/usr/bin/env node
/**
 * ONE-TIME cleanup — agent_runs rows stuck at status 'running' because the
 * platform killed the invocation before it could record completion.
 *
 *     node scripts/cleanup-stale-agent-runs.mjs            # dry run — prints only
 *     node scripts/cleanup-stale-agent-runs.mjs --execute  # marks them timed_out
 *
 * A row qualifies when status = 'running' and started_at is more than 860s ago:
 * the 800s function ceiling plus 60s, the same threshold as LOCK_STALE_MS in
 * app/api/cron/scrape. No invocation can still be alive past that.
 *
 * completed_at and duration_ms stay NULL. When the function actually died was
 * never recorded, and a made-up value would read as real in the dashboard's run
 * history.
 *
 * Requires migration_v38, which adds 'timed_out' to the agent_runs status CHECK.
 * Without it every update is rejected (23514) and nothing is written.
 */
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })

const EXECUTE = process.argv.includes('--execute')
const STALE_MS = 800_000 + 60_000

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

async function main() {
  const cutoff = new Date(Date.now() - STALE_MS).toISOString()
  const { data: rows, error } = await db
    .from('agent_runs')
    .select('id, agent, started_at, items_processed, items_succeeded')
    .eq('status', 'running')
    .lt('started_at', cutoff)
    .order('started_at', { ascending: true })

  if (error) {
    console.error('Failed to load agent_runs:', error.message)
    process.exit(1)
  }

  console.log(`${rows.length} run(s) stuck at 'running' with started_at before ${cutoff}:\n`)
  for (const r of rows) {
    console.log(`  ${r.started_at}  ${r.agent.padEnd(13)} processed=${r.items_processed}  ${r.id}`)
  }

  const byAgent = new Map()
  for (const r of rows) byAgent.set(r.agent, (byAgent.get(r.agent) ?? 0) + 1)
  console.log(`\nBy agent: ${[...byAgent].map(([a, n]) => `${a} ${n}`).join(', ') || 'none'}`)

  if (!EXECUTE) {
    console.log('\nDry run — nothing written. Re-run with --execute to mark these timed_out.')
    return
  }
  if (rows.length === 0) return

  // status = 'running' is re-checked in the update itself, so a row that
  // somehow completed after the read above is left alone.
  const { data: updated, error: updateError } = await db
    .from('agent_runs')
    .update({
      status: 'timed_out',
      errors: [{
        item: '(run)',
        step: 'timeout',
        message: 'No completion recorded — the invocation was killed by the platform. Marked by scripts/cleanup-stale-agent-runs.mjs.',
      }],
    })
    .in('id', rows.map((r) => r.id))
    .eq('status', 'running')
    .select('id')

  if (updateError) {
    const hint = updateError.code === '23514' ? ' — apply supabase/migration_v38.sql first' : ''
    console.error(`\nUpdate failed: ${updateError.message}${hint}`)
    process.exit(1)
  }
  console.log(`\nMarked ${updated.length} of ${rows.length} run(s) timed_out.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
