-- Migration v24: museum coverage_only classification type
-- coverage jsonb, preread_type, and exhibition_coverage already exist (migration_v14) —
-- guards below are no-ops for those. coverage_type is the only genuinely new column.

ALTER TABLE exhibitions
  ADD COLUMN IF NOT EXISTS coverage      jsonb DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS coverage_type text  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS preread_type  text  DEFAULT 'full';

ALTER TABLE exhibitions
  DROP CONSTRAINT IF EXISTS chk_coverage_type;

ALTER TABLE exhibitions
  ADD CONSTRAINT chk_coverage_type
  CHECK (coverage_type IN ('type_a', 'type_b', 'type_c_small', 'type_c_large', 'type_d') OR coverage_type IS NULL);

CREATE TABLE IF NOT EXISTS exhibition_coverage (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  exhibition_id uuid        NOT NULL REFERENCES exhibitions(id) ON DELETE CASCADE,
  reading_id    uuid        NOT NULL REFERENCES readings(id)    ON DELETE CASCADE,
  source        text        NOT NULL CHECK (source IN ('agent2', 'agent3')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (exhibition_id, reading_id)
);
