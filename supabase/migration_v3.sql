-- Lazarus Idea 2 — Schema v3
-- Part 1: galleries table + venues restructure
-- Part 2: address_override columns on exhibitions
-- Run in Supabase SQL Editor.

-- ─── Part 1a: galleries ───────────────────────────────────────────────────────

CREATE TABLE galleries (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL,
  website    text,
  type       text        CHECK (type IN ('museum', 'gallery', 'fair')),
  active     boolean     DEFAULT true,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE galleries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all" ON galleries FOR ALL USING (true) WITH CHECK (true);

-- ─── Part 1b: add gallery_id to venues ───────────────────────────────────────

ALTER TABLE venues ADD COLUMN gallery_id uuid REFERENCES galleries(id);

-- ─── Part 1c: seed galleries ─────────────────────────────────────────────────

INSERT INTO galleries (name, website, type) VALUES
  ('56 Henry',              'https://56henry.nyc',                  'gallery'),
  ('Salon 94',              'https://salon94.com',                  'gallery'),
  ('Kravets Wehby Gallery', 'https://www.kravetswehbygallery.com',  'gallery'),
  ('Amant',                 'https://www.amant.org',                'gallery'),
  ('Hannah Traore Gallery', 'https://hannahtraoregallery.com',      'gallery');

-- ─── Part 1d: link venues → galleries ────────────────────────────────────────

UPDATE venues v
SET gallery_id = g.id
FROM galleries g
WHERE v.name = g.name;

-- ─── Part 1e: seed venue addresses ───────────────────────────────────────────

UPDATE venues SET
  address      = '56 Henry Street, New York NY 10013',
  neighborhood = 'Tribeca'
WHERE name = '56 Henry';

UPDATE venues SET
  address      = '3 East 89th Street, New York NY 10128',
  neighborhood = 'Upper East Side'
WHERE name = 'Salon 94';

UPDATE venues SET
  address      = '521 West 23rd Street, New York NY 10011',
  neighborhood = 'Chelsea'
WHERE name = 'Kravets Wehby Gallery';

UPDATE venues SET
  address      = '315 Maujer Street, Brooklyn NY 11206',
  neighborhood = 'Bushwick'
WHERE name = 'Amant';

UPDATE venues SET
  address      = '35 West 13th Street, New York NY 10011',
  neighborhood = 'West Village'
WHERE name = 'Hannah Traore Gallery';

-- ─── Part 1f: drop type from venues (moved to galleries) ─────────────────────

ALTER TABLE venues DROP COLUMN type;

-- ─── Part 2: address_override columns on exhibitions ─────────────────────────

ALTER TABLE exhibitions
  ADD COLUMN address_override              text,
  ADD COLUMN address_override_neighborhood text;
