-- Migration v14: museum coverage + exhibition_coverage cross-link table
-- Replaces the scholarly preread pipeline with a targeted press coverage approach for museums.
-- Run in Supabase SQL Editor.

-- ─── exhibitions: add coverage and preread_type ───────────────────────────────

ALTER TABLE exhibitions
  ADD COLUMN IF NOT EXISTS coverage     jsonb DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS preread_type text  NOT NULL DEFAULT 'full';

ALTER TABLE exhibitions
  DROP CONSTRAINT IF EXISTS chk_preread_type;

ALTER TABLE exhibitions
  ADD CONSTRAINT chk_preread_type CHECK (preread_type IN ('full', 'coverage_only'));

-- ─── exhibitions: drop scholarly columns ─────────────────────────────────────

ALTER TABLE exhibitions
  DROP CONSTRAINT IF EXISTS chk_preread_strategy,
  DROP CONSTRAINT IF EXISTS chk_preread_strategy_override;

ALTER TABLE exhibitions
  DROP COLUMN IF EXISTS preread_strategy,
  DROP COLUMN IF EXISTS preread_strategy_override,
  DROP COLUMN IF EXISTS scholarly_preread;

-- ─── exhibition_coverage: cross-link table ────────────────────────────────────

CREATE TABLE IF NOT EXISTS exhibition_coverage (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  exhibition_id uuid        NOT NULL REFERENCES exhibitions(id) ON DELETE CASCADE,
  reading_id    uuid        NOT NULL REFERENCES readings(id)    ON DELETE CASCADE,
  source        text        NOT NULL CHECK (source IN ('agent2', 'agent3')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (exhibition_id, reading_id)
);

-- ─── Backfill: mark existing museum exhibitions as coverage_only ──────────────

UPDATE exhibitions e
SET    preread_type = 'coverage_only'
FROM   venues v
JOIN   institutions i ON i.id = v.institution_id
WHERE  e.venue_id = v.id
AND    i.type = 'museum';
