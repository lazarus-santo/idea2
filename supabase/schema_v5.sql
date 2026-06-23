-- Lazarus Idea 2 — Schema v5
-- Part 1: readings_tags table for institution + artist press tagging
-- Part 2: rss_url column on publications for Agent 3
-- Run in Supabase SQL Editor.

-- ─── Part 1: readings_tags ────────────────────────────────────────────────────

CREATE TABLE readings_tags (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  reading_id uuid        NOT NULL REFERENCES readings(id) ON DELETE CASCADE,
  gallery_id uuid        REFERENCES galleries(id) ON DELETE CASCADE,
  artist_id  uuid        REFERENCES artists(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT readings_tags_must_have_one CHECK (
    (gallery_id IS NOT NULL)::int + (artist_id IS NOT NULL)::int = 1
  )
);

ALTER TABLE readings_tags ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all" ON readings_tags FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX idx_readings_tags_reading_id ON readings_tags(reading_id);
CREATE INDEX idx_readings_tags_gallery_id ON readings_tags(gallery_id);
CREATE INDEX idx_readings_tags_artist_id  ON readings_tags(artist_id);

-- ─── Part 2: rss_url on publications ─────────────────────────────────────────

ALTER TABLE publications ADD COLUMN IF NOT EXISTS rss_url text;

-- Seed RSS URLs for known art publications.
-- Add more as publications are approved in the admin UI.
UPDATE publications SET rss_url = 'https://hyperallergic.com/feed/'
WHERE domain = 'hyperallergic.com';

UPDATE publications SET rss_url = 'https://www.theartnewspaper.com/rss.xml'
WHERE domain = 'theartnewspaper.com';

UPDATE publications SET rss_url = 'https://artnews.com/feed/'
WHERE domain = 'artnews.com';

UPDATE publications SET rss_url = 'https://brooklynrail.org/rss'
WHERE domain = 'brooklynrail.org';

UPDATE publications SET rss_url = 'https://rss.nytimes.com/services/xml/rss/nyt/Arts.xml'
WHERE domain = 'nytimes.com';

UPDATE publications SET rss_url = 'https://www.theguardian.com/artanddesign/rss'
WHERE domain = 'theguardian.com';
