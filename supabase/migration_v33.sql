-- migration_v33: multi-city gating + per-venue anchor-window persistence
--
-- is_multi_city gates the location_hint retry ladder: only institutions that
-- actually operate space outside NYC are worth re-running Tier 1 for at a wider
-- anchor window. Default false is deliberate — the detail-stage location verifier
-- remains the real safety net, so a missed flag costs an extra detail fetch, not
-- a wrong-city publication.
ALTER TABLE institutions
  ADD COLUMN IF NOT EXISTS is_multi_city boolean NOT NULL DEFAULT false;

-- Records the anchor-window size at which this venue last yielded location hints,
-- so future scrapes start there instead of climbing the ladder from 600 again.
-- NULL means "never established" — start at the default.
ALTER TABLE venues
  ADD COLUMN IF NOT EXISTS location_window_size integer;

COMMENT ON COLUMN institutions.is_multi_city IS
  'True when the institution operates physical exhibition space outside NYC. Gates the Tier 1 location_hint retry ladder.';
COMMENT ON COLUMN venues.location_window_size IS
  'Anchor-context window (chars) that last produced location_hint values for this venue. NULL = use default.';
