-- Migration v12: scholarly preread strategy + content columns
-- Adds three columns to exhibitions to support the historical artist scholarly pipeline.
-- 'contemporary' is the default (existing behaviour unchanged).
-- 'both' means the scholarly pipeline also ran for this exhibition.
-- preread_strategy_override lets admins force a strategy regardless of auto-detection.

ALTER TABLE exhibitions
  ADD COLUMN IF NOT EXISTS preread_strategy          text NOT NULL DEFAULT 'contemporary',
  ADD COLUMN IF NOT EXISTS preread_strategy_override text,
  ADD COLUMN IF NOT EXISTS scholarly_preread         text;

ALTER TABLE exhibitions
  DROP CONSTRAINT IF EXISTS chk_preread_strategy,
  DROP CONSTRAINT IF EXISTS chk_preread_strategy_override;

ALTER TABLE exhibitions
  ADD CONSTRAINT chk_preread_strategy         CHECK (preread_strategy IN ('contemporary', 'both')),
  ADD CONSTRAINT chk_preread_strategy_override CHECK (preread_strategy_override IS NULL OR preread_strategy_override IN ('contemporary', 'both'));
