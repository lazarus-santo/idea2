-- Migration v20: Agent 1 per-fetch logging
-- Persists method (http/browserbase) and html_length for every detail-page
-- fetch attempt, so pending/missing-field exhibitions can be traced back to
-- how they were scraped. Previously this only existed in console logs and
-- an ephemeral /tmp file that doesn't survive serverless invocations.
-- Run in Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS agent1_fetch_logs (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id       uuid        REFERENCES venues(id),
  institution_id uuid        REFERENCES institutions(id),
  exhibition_id  uuid        REFERENCES exhibitions(id),
  url            text        NOT NULL,
  title          text,
  method         text,
  html_length    integer,
  outcome        text        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent1_fetch_logs_venue ON agent1_fetch_logs(venue_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent1_fetch_logs_exhibition ON agent1_fetch_logs(exhibition_id);

ALTER TABLE agent1_fetch_logs ENABLE ROW LEVEL SECURITY;

-- Service-role only (written by the scraper via the server, never the browser directly)
CREATE POLICY "agent1_fetch_logs_service_all" ON agent1_fetch_logs FOR ALL USING (true) WITH CHECK (true);
