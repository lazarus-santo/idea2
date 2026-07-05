-- Migration v21: Agent 1 content-type classification + admin feedback loop
-- Two independent additions:
-- 1. agent1_discarded_items — log of listing-page links Step 1 classified as
--    'event'/'online_only' (or 'unclear' links that also failed to show any
--    exhibition-like signal at Step 2) and therefore never became a pending
--    exhibition record. Visibility only — not surfaced to admin action yet.
-- 2. agent1_missing_show_reports — the inverse: admin-reported shows that
--    should exist for an institution but never showed up in a scrape.
-- Run in Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS agent1_discarded_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid REFERENCES institutions(id),
  title text,
  url text,
  content_type text, -- 'event' | 'online_only' | 'unclear_no_signal'
  discarded_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent1_discarded_items_institution ON agent1_discarded_items(institution_id, discarded_at DESC);

ALTER TABLE agent1_discarded_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "agent1_discarded_items_service_all" ON agent1_discarded_items FOR ALL USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS agent1_missing_show_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid REFERENCES institutions(id),
  exhibition_name text,
  notes text,
  reported_at timestamptz DEFAULT now(),
  resolved boolean DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_agent1_missing_show_reports_unresolved ON agent1_missing_show_reports(resolved, reported_at DESC);

ALTER TABLE agent1_missing_show_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "agent1_missing_show_reports_service_all" ON agent1_missing_show_reports FOR ALL USING (true) WITH CHECK (true);
