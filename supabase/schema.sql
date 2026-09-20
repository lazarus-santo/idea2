-- ############################################################################
-- ##  STALE. THIS IS THE v1 SCHEMA. DO NOT READ IT AS CURRENT, DO NOT RUN IT.
-- ############################################################################
--
-- Kept for history only. It stopped describing this database somewhere around
-- migration_v2 and has been wrong for sixty migrations since.
--
-- WHAT IS WRONG WITH IT, concretely, so nobody has to find out the hard way:
--
--   · It declares THREE tables. The database serves twenty-eight.
--   · exhibitions.venue_name and exhibitions.artists do not exist. Venues are
--     a table (exhibitions.venue_id -> venues.id) and artists are a join table
--     (exhibition_artists), both since migration_v2.
--   · exhibitions.last_fetched_at does not exist. A test in this repo was
--     written against it because of this file, and failed against production.
--     The column a scrape actually moves is exhibitions.updated_at.
--   · going_counts was DROPPED in schema v2. This file still creates it, and
--     app/api/going is a 410 stub explaining where it went.
--   · The RLS policies at the bottom are not the policies that are live. The
--     real ones are deny-by-default with per-column grants (migration_v26) and
--     a privacy model built across v40-v62. The "USING (true)" below would be
--     a serious misreading of how this database is protected.
--
-- WHERE THE TRUTH IS:
--
--   supabase/SCHEMA-CURRENT.md   what every table and column IS, today.
--                                Generated from the live database; regenerate
--                                with `node --env-file=.env.local
--                                scripts/dump-schema.mjs`. Shape only.
--   supabase/migration_v*.sql    the source of truth, and the ONLY source for
--                                constraints, RLS, grants, triggers, functions
--                                and indexes. Each explains its reasoning.
--
-- Read the migrations for anything that decides ACCESS. A shape reference
-- cannot tell you who is allowed to see a row.
--
-- ############################################################################

-- Lazarus Exhibitions Database Schema  [v1 — superseded, see the banner above]
-- Run this in the Supabase SQL editor  [NO. Running this would be destructive.]

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
