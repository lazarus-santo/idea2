-- Lazarus Exhibitions Database Schema
-- Run this in the Supabase SQL editor

CREATE TABLE IF NOT EXISTS exhibitions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  venue_name TEXT NOT NULL,
  show_title TEXT NOT NULL,
  artists JSONB NOT NULL DEFAULT '[]',
  start_date DATE,
  end_date DATE,
  description TEXT,
  check_back_date DATE,
  last_fetched_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(venue_name, show_title)
);

CREATE TABLE IF NOT EXISTS prereads (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  exhibition_id UUID REFERENCES exhibitions(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  source_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS going_counts (
  exhibition_id UUID REFERENCES exhibitions(id) ON DELETE CASCADE PRIMARY KEY,
  count INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE exhibitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE prereads ENABLE ROW LEVEL SECURITY;
ALTER TABLE going_counts ENABLE ROW LEVEL SECURITY;

-- Public read access
CREATE POLICY "exhibitions_public_read" ON exhibitions FOR SELECT USING (true);
CREATE POLICY "prereads_public_read" ON prereads FOR SELECT USING (true);
CREATE POLICY "going_counts_public_read" ON going_counts FOR SELECT USING (true);

-- Service role can write (used by server-side API routes)
CREATE POLICY "exhibitions_service_write" ON exhibitions FOR ALL USING (true);
CREATE POLICY "prereads_service_write" ON prereads FOR ALL USING (true);
CREATE POLICY "going_counts_service_write" ON going_counts FOR ALL USING (true);

-- Index for check_back_date queries
CREATE INDEX IF NOT EXISTS idx_exhibitions_check_back_date ON exhibitions(check_back_date);
CREATE INDEX IF NOT EXISTS idx_exhibitions_end_date ON exhibitions(end_date);
CREATE INDEX IF NOT EXISTS idx_prereads_exhibition_id ON prereads(exhibition_id);

-- RPC: atomic increment for going counts
CREATE OR REPLACE FUNCTION increment_going_count(p_exhibition_id UUID)
RETURNS INTEGER AS $$
DECLARE
  new_count INTEGER;
BEGIN
  INSERT INTO going_counts (exhibition_id, count, updated_at)
  VALUES (p_exhibition_id, 1, NOW())
  ON CONFLICT (exhibition_id)
  DO UPDATE SET count = going_counts.count + 1, updated_at = NOW()
  RETURNING count INTO new_count;
  RETURN new_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
