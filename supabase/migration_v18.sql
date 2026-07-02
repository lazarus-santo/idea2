-- Migration v18: agent_runs table for the Agent Dashboard
-- Persists run history for Agent 1 (scraper), Agent 2 (preread audit),
-- and Agent 3 daily/hourly (readings curator).
-- Run in Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS agent_runs (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent            text        NOT NULL CHECK (agent IN ('agent1', 'agent2', 'agent3_daily', 'agent3_hourly')),
  started_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  status           text        CHECK (status IN ('running', 'success', 'partial', 'failed')),
  items_processed  integer     DEFAULT 0,
  items_succeeded  integer     DEFAULT 0,
  items_failed     integer     DEFAULT 0,
  errors           jsonb       DEFAULT '[]',
  summary          jsonb       DEFAULT '{}',
  duration_ms      integer
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_started ON agent_runs(agent, started_at DESC);

ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;

-- Service-role only (admin dashboard reads/writes via the server, never the browser directly)
CREATE POLICY "agent_runs_service_all" ON agent_runs FOR ALL USING (true) WITH CHECK (true);
