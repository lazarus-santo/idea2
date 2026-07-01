-- Migration v13: publication tiers + readings classification
-- Run in Supabase SQL Editor.

-- ─── publications: add tier, scrape_frequency, active ────────────────────────

ALTER TABLE publications
  ADD COLUMN IF NOT EXISTS tier             text,
  ADD COLUMN IF NOT EXISTS scrape_frequency text NOT NULL DEFAULT 'daily',
  ADD COLUMN IF NOT EXISTS active           boolean NOT NULL DEFAULT true;

ALTER TABLE publications
  DROP CONSTRAINT IF EXISTS chk_pub_tier,
  DROP CONSTRAINT IF EXISTS chk_pub_scrape_frequency;

ALTER TABLE publications
  ADD CONSTRAINT chk_pub_tier CHECK (tier IS NULL OR tier IN ('t1','t2','t3','art_adjacent')),
  ADD CONSTRAINT chk_pub_scrape_frequency CHECK (scrape_frequency IN ('hourly','daily'));

-- Unique constraint needed for ON CONFLICT below
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'publications_domain_unique' AND contype = 'u'
  ) THEN
    ALTER TABLE publications ADD CONSTRAINT publications_domain_unique UNIQUE (domain);
  END IF;
END $$;

-- ─── readings: add classification columns ────────────────────────────────────

ALTER TABLE readings
  ADD COLUMN IF NOT EXISTS category             text,
  ADD COLUMN IF NOT EXISTS art_relevance_score  numeric,
  ADD COLUMN IF NOT EXISTS nyc_relevance_score  numeric,
  ADD COLUMN IF NOT EXISTS top_story_candidate  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tier                 text;

ALTER TABLE readings
  DROP CONSTRAINT IF EXISTS chk_reading_category;

ALTER TABLE readings
  ADD CONSTRAINT chk_reading_category
    CHECK (category IS NULL OR category IN ('news','opinion','conversation'));

-- ─── Backfill existing publications with tier / frequency ────────────────────

UPDATE publications SET tier = 't1', scrape_frequency = 'hourly'
WHERE domain IN ('artforum.com','hyperallergic.com','theartnewspaper.com','artnews.com');

UPDATE publications SET tier = 't2', scrape_frequency = 'daily'
WHERE domain IN ('nytimes.com','frieze.com');

UPDATE publications SET tier = 'art_adjacent', scrape_frequency = 'daily'
WHERE domain = 'culturedmag.com';

-- Frieze has no RSS — deactivate
UPDATE publications SET active = false WHERE domain = 'frieze.com';

-- ─── T1 hourly ───────────────────────────────────────────────────────────────

INSERT INTO publications (name, domain, status, tier, scrape_frequency, rss_url, active) VALUES
  ('Artnet News',       'news.artnet.com',       'approved', 't1', 'hourly', 'https://news.artnet.com/feed',                 true),
  ('Ocula',             'ocula.com',             'approved', 't1', 'hourly', 'https://ocula.com/magazine/feed/',             true),
  -- already seeded but ensure tier/frequency are set
  ('Artforum',          'artforum.com',          'approved', 't1', 'hourly', 'https://www.artforum.com/feed/',               true),
  ('Hyperallergic',     'hyperallergic.com',     'approved', 't1', 'hourly', 'https://hyperallergic.com/rss/',              true),
  ('The Art Newspaper', 'theartnewspaper.com',   'approved', 't1', 'hourly', 'https://www.theartnewspaper.com/rss.xml',     true),
  ('ARTnews',           'artnews.com',           'approved', 't1', 'hourly', 'https://www.artnews.com/feed/',               true)
ON CONFLICT (domain) DO UPDATE SET
  tier             = EXCLUDED.tier,
  scrape_frequency = EXCLUDED.scrape_frequency,
  rss_url          = COALESCE(EXCLUDED.rss_url, publications.rss_url),
  active           = EXCLUDED.active;

-- ─── T2 daily ────────────────────────────────────────────────────────────────

INSERT INTO publications (name, domain, status, tier, scrape_frequency, rss_url, active) VALUES
  ('The New York Times Arts', 'nytimes.com',              'approved', 't2', 'daily', 'https://rss.nytimes.com/services/xml/rss/nyt/Arts.xml', true),
  ('The New Yorker',          'newyorker.com',            'approved', 't2', 'daily', 'https://www.newyorker.com/feed/everything',             true),
  ('The Nation',              'thenation.com',            'approved', 't2', 'daily', 'https://www.thenation.com/feed/?type=article',          true),
  ('Los Angeles Times Arts',  'latimes.com',              'approved', 't2', 'daily', 'https://www.latimes.com/entertainment-arts/rss2.0.xml', true),
  ('Artsy Editorial',         'artsy.net',                'approved', 't2', 'daily', 'https://www.artsy.net/rss/news',                        true),
  ('Galerie Magazine',        'galeriemagazine.com',      'approved', 't2', 'daily', 'https://galeriemagazine.com/feed/',                     true),
  ('Observer Arts',           'observer.com',             'approved', 't2', 'daily', 'https://observer.com/art/feed/',                        true),
  ('Mousse Magazine',         'moussemagazine.it',        'approved', 't2', 'daily', 'https://www.moussemagazine.it/feed/',                   true),
  ('Art in America',          'art-in-america.artnews.com','approved', 't2', 'daily', 'https://www.artnews.com/c/art-in-america/feed/',       true),
  ('Financial Times Arts',    'ft.com',                   'approved', 't2', 'daily', null,                                                    false),
  ('The Times',               'thetimes.co.uk',           'approved', 't2', 'daily', null,                                                    false),
  ('Boston Globe Arts',       'bostonglobe.com',          'approved', 't2', 'daily', null,                                                    false),
  ('Art Basel Magazine',      'artbasel.com',             'approved', 't2', 'daily', null,                                                    false),
  ('Brooklyn Rail',           'brooklynrail.org',         'approved', 't2', 'daily', null,                                                    false),
  ('e-flux',                  'e-flux.com',               'approved', 't2', 'daily', null,                                                    false)
ON CONFLICT (domain) DO UPDATE SET
  tier             = EXCLUDED.tier,
  scrape_frequency = EXCLUDED.scrape_frequency,
  rss_url          = COALESCE(EXCLUDED.rss_url, publications.rss_url),
  active           = CASE WHEN EXCLUDED.rss_url IS NULL THEN false ELSE EXCLUDED.active END;

-- ─── T3 daily ────────────────────────────────────────────────────────────────

INSERT INTO publications (name, domain, status, tier, scrape_frequency, rss_url, active) VALUES
  ('Joana',              'joana.world',                  'approved', 't3', 'daily', 'https://joana.world/feed/',                     true),
  ('Flash Art',          'flash---art.com',              'approved', 't3', 'daily', 'https://flash---art.com/feed/',                 true),
  ('CARLA',              'contemporaryartreview.la',     'approved', 't3', 'daily', 'https://contemporaryartreview.la/feed/',       true),
  ('Burnaway',           'burnaway.org',                 'approved', 't3', 'daily', 'https://burnaway.org/feed/',                   true),
  ('Two Coats of Paint', 'twocoatsofpaint.com',          'approved', 't3', 'daily', 'https://twocoatsofpaint.com/feed',             true),
  ('Elephant Magazine',  'elephant.art',                 'approved', 't3', 'daily', 'https://elephant.art/feed/',                   true),
  ('BOMB Magazine',      'bombmagazine.org',             'approved', 't3', 'daily', null,                                           false),
  ('Spike Art Magazine', 'spikeartmagazine.com',         'approved', 't3', 'daily', null,                                           false),
  ('NERO Magazine',      'neromagazine.it',              'approved', 't3', 'daily', null,                                           false),
  ('Kaleidoscope',       'kaleidoscope.media',           'approved', 't3', 'daily', null,                                           false),
  ('Autre Magazine',     'autre.love',                   'approved', 't3', 'daily', null,                                           false)
ON CONFLICT (domain) DO UPDATE SET
  tier             = EXCLUDED.tier,
  scrape_frequency = EXCLUDED.scrape_frequency,
  rss_url          = COALESCE(EXCLUDED.rss_url, publications.rss_url),
  active           = CASE WHEN EXCLUDED.rss_url IS NULL THEN false ELSE EXCLUDED.active END;

-- ─── Art-Adjacent daily ───────────────────────────────────────────────────────

INSERT INTO publications (name, domain, status, tier, scrape_frequency, rss_url, active) VALUES
  ('Vogue',                         'vogue.com',                 'approved', 'art_adjacent', 'daily', 'https://www.vogue.com/feed/rss',                                          true),
  ('AnOther Magazine',              'anothermag.com',            'approved', 'art_adjacent', 'daily', 'https://www.anothermag.com/feed/rss',                                    true),
  ('Dazed',                         'dazeddigital.com',          'approved', 'art_adjacent', 'daily', 'https://www.dazeddigital.com/rss',                                       true),
  ('Cultured Magazine',             'culturedmag.com',           'approved', 'art_adjacent', 'daily', 'https://www.culturedmag.com/feed/',                                      true),
  ('T: The New York Times Style',   't-magazine.nytimes.com',   'approved', 'art_adjacent', 'daily', 'https://rss.nytimes.com/services/xml/rss/nyt/FashionandStyle.xml',       true),
  ('WSJ Magazine',                  'wsj.com',                   'approved', 'art_adjacent', 'daily', 'https://feeds.a.dj.com/rss/RSSLifestyle.xml',                           true),
  ('Architectural Digest',          'architecturaldigest.com',   'approved', 'art_adjacent', 'daily', 'https://www.architecturaldigest.com/feed/rss',                           true),
  ('Wallpaper*',                    'wallpaper.com',             'approved', 'art_adjacent', 'daily', 'https://www.wallpaper.com/feeds.xml',                                    true),
  ('Surface Magazine',              'surfacemag.com',            'approved', 'art_adjacent', 'daily', 'https://www.surfacemag.com/feed/',                                       true),
  ('PIN–UP Magazine',               'pinupmagazine.org',         'approved', 'art_adjacent', 'daily', 'https://www.pinupmagazine.org/feed/',                                    true),
  ('Numéro',                        'numero.com',                'approved', 'art_adjacent', 'daily', 'https://numero.com/feed/',                                               true),
  ('SSENSE Editorial',              'ssense.com',                'approved', 'art_adjacent', 'daily', null,                                                                      false),
  ('i-D',                           'i-d.vice.com',              'approved', 'art_adjacent', 'daily', null,                                                                      false),
  ('032c',                          '032c.com',                  'approved', 'art_adjacent', 'daily', null,                                                                      false),
  ('Interview Magazine',            'interviewmagazine.com',     'approved', 'art_adjacent', 'daily', null,                                                                      false)
ON CONFLICT (domain) DO UPDATE SET
  tier             = EXCLUDED.tier,
  scrape_frequency = EXCLUDED.scrape_frequency,
  rss_url          = COALESCE(EXCLUDED.rss_url, publications.rss_url),
  active           = CASE WHEN EXCLUDED.rss_url IS NULL THEN false ELSE EXCLUDED.active END;

-- ─── Safety net: deactivate any row still missing rss_url ────────────────────

UPDATE publications SET active = false WHERE rss_url IS NULL AND active = true;
