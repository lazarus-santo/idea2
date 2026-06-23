-- Lazarus Idea 2 — Schema v2 Migration
-- Run this in the Supabase SQL Editor.
-- WARNING: drops the old exhibitions, prereads, and going_counts tables.

-- ─── Drop old schema ──────────────────────────────────────────────────────────

DROP TABLE IF EXISTS going_counts CASCADE;
DROP TABLE IF EXISTS prereads CASCADE;
DROP TABLE IF EXISTS exhibitions CASCADE;

DROP FUNCTION IF EXISTS increment_going_count(UUID);

-- ─── venues ──────────────────────────────────────────────────────────────────

CREATE TABLE venues (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text        NOT NULL,
  exhibitions_url  text        NOT NULL,
  address          text,
  neighborhood     text,
  latitude         numeric,
  longitude        numeric,
  type             text        CHECK (type IN ('museum', 'gallery', 'fair')),
  active           boolean     DEFAULT true,
  created_at       timestamptz DEFAULT now()
);

-- ─── artists ─────────────────────────────────────────────────────────────────

CREATE TABLE artists (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL,
  bio        text,
  website    text,
  instagram  text,
  created_at timestamptz DEFAULT now()
);

-- ─── exhibitions ─────────────────────────────────────────────────────────────

CREATE TABLE exhibitions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id        uuid        NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  show_title      text        NOT NULL,
  start_date      date,
  end_date        date,
  check_back_date date,
  description     text,
  press_release   text,
  image_url       text,
  status          text        DEFAULT 'pending' CHECK (status IN ('pending', 'published')),
  missing_fields  text[],
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

-- ─── exhibition_artists ───────────────────────────────────────────────────────

CREATE TABLE exhibition_artists (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exhibition_id  uuid NOT NULL REFERENCES exhibitions(id) ON DELETE CASCADE,
  artist_id      uuid NOT NULL REFERENCES artists(id) ON DELETE CASCADE
);

-- ─── prereads ────────────────────────────────────────────────────────────────

CREATE TABLE prereads (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  exhibition_id  uuid        NOT NULL REFERENCES exhibitions(id) ON DELETE CASCADE,
  article_title  text,
  publication    text,
  article_url    text,
  thumbnail_url  text,
  summary        text,
  created_at     timestamptz DEFAULT now()
);

-- ─── publications ────────────────────────────────────────────────────────────

CREATE TABLE publications (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL,
  domain     text        NOT NULL UNIQUE,
  status     text        DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at timestamptz DEFAULT now()
);

-- ─── readings ────────────────────────────────────────────────────────────────

CREATE TABLE readings (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_id  uuid        REFERENCES publications(id) ON DELETE SET NULL,
  author          text,
  headline        text        NOT NULL,
  article_url     text        NOT NULL UNIQUE,
  rss_summary     text,
  thumbnail_url   text,
  top_story       boolean     DEFAULT false,
  published_at    timestamptz,
  created_at      timestamptz DEFAULT now()
);

-- ─── seed_books ──────────────────────────────────────────────────────────────

CREATE TABLE seed_books (
  id               uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  title            text    NOT NULL,
  author           text,
  source           text    CHECK (source IN ('goodreads', 'web_search')),
  goodreads_rating numeric,
  picked           boolean DEFAULT false,
  created_at       timestamptz DEFAULT now()
);

-- ─── editor_picks ────────────────────────────────────────────────────────────

CREATE TABLE editor_picks (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  pick_type    text        NOT NULL CHECK (pick_type IN ('exhibition', 'article', 'book')),
  reference_id uuid        NOT NULL,
  status       text        DEFAULT 'pending' CHECK (status IN ('pending', 'live')),
  approved_at  timestamptz,
  goes_live_at timestamptz,
  created_at   timestamptz DEFAULT now()
);

-- ─── updated_at trigger ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER exhibitions_updated_at
  BEFORE UPDATE ON exhibitions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── indexes ─────────────────────────────────────────────────────────────────

CREATE INDEX idx_exhibitions_venue_id         ON exhibitions(venue_id);
CREATE INDEX idx_exhibitions_status           ON exhibitions(status);
CREATE INDEX idx_exhibitions_end_date         ON exhibitions(end_date);
CREATE INDEX idx_exhibition_artists_exhibition ON exhibition_artists(exhibition_id);
CREATE INDEX idx_exhibition_artists_artist    ON exhibition_artists(artist_id);
CREATE INDEX idx_readings_published_at        ON readings(published_at);
CREATE INDEX idx_readings_top_story           ON readings(top_story);
CREATE INDEX idx_publications_domain          ON publications(domain);

-- ─── Row Level Security ───────────────────────────────────────────────────────

ALTER TABLE venues            ENABLE ROW LEVEL SECURITY;
ALTER TABLE artists           ENABLE ROW LEVEL SECURITY;
ALTER TABLE exhibitions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE exhibition_artists ENABLE ROW LEVEL SECURITY;
ALTER TABLE prereads          ENABLE ROW LEVEL SECURITY;
ALTER TABLE publications      ENABLE ROW LEVEL SECURITY;
ALTER TABLE readings          ENABLE ROW LEVEL SECURITY;
ALTER TABLE seed_books        ENABLE ROW LEVEL SECURITY;
ALTER TABLE editor_picks      ENABLE ROW LEVEL SECURITY;

-- Permissive: allow all operations (lock down before public launch)
CREATE POLICY "allow_all" ON venues             FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON artists            FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON exhibitions        FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON exhibition_artists FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON prereads           FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON publications       FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON readings           FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON seed_books         FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON editor_picks       FOR ALL USING (true) WITH CHECK (true);

-- ─── Seed: venues ─────────────────────────────────────────────────────────────

INSERT INTO venues (name, exhibitions_url, type) VALUES
  ('56 Henry',              'https://56henry.nyc/exhibitions',                      'gallery'),
  ('Salon 94',              'https://salon94.com/exhibitions',                      'gallery'),
  ('Kravets Wehby Gallery', 'https://www.kravetswehbygallery.com/exhibitions',      'gallery'),
  ('Amant',                 'https://www.amant.org/programs',                       'gallery'),
  ('Hannah Traore Gallery', 'https://hannahtraoregallery.com/exhibitions/',         'gallery');
