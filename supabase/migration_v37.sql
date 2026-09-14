-- migration_v37: exa_search_log — one row per real Exa API call
--
-- Backs loggedExaSearch() (lib/exa-log.ts), the shared wrapper every exa.search()
-- call site in the codebase now routes through, replacing direct exa.search()
-- calls everywhere (searchShowReview, searchArtistProfile, solo's S1-S5,
-- museum-coverage.ts's museumSearch, generateFairCoverage).
--
-- exhibition_id is nullable, not a FK forcing a fake value: some calls have no
-- exhibition cleanly available at call time (solo's per-artist disambiguator
-- lookups happen before the exhibition-specific context is threaded in every
-- code path). ON DELETE SET NULL rather than CASCADE — this is a log, and
-- nothing in this codebase currently deletes an exhibition row, but a log
-- entry describing a real API call that already happened and was already
-- billed should outlive the exhibition record if that ever changes, not
-- vanish with it.
CREATE TABLE exa_search_log (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  exhibition_id  uuid        REFERENCES exhibitions(id) ON DELETE SET NULL,
  function_name  text        NOT NULL,
  query_text     text        NOT NULL,
  result_count   int,
  cost_dollars   numeric,
  request_id     text,
  error          text,
  created_at     timestamptz DEFAULT now()
);

-- Both are real query patterns for this table: "everything logged for this
-- show" (debugging one exhibition's preread generation) and "everything from
-- this call site" (auditing one search strategy's real cost/failure rate
-- across all exhibitions, the way this session's own investigations already
-- did by hand against production data).
CREATE INDEX idx_exa_search_log_exhibition_id ON exa_search_log(exhibition_id);
CREATE INDEX idx_exa_search_log_function_name ON exa_search_log(function_name);
CREATE INDEX idx_exa_search_log_created_at    ON exa_search_log(created_at);

-- ─── Verify ──────────────────────────────────────────────────────────────────
--   SELECT column_name, data_type, is_nullable FROM information_schema.columns
--   WHERE table_name = 'exa_search_log' ORDER BY ordinal_position;
--     -> id (uuid, NO), exhibition_id (uuid, YES), function_name (text, NO),
--        query_text (text, NO), result_count (integer, YES),
--        cost_dollars (numeric, YES), request_id (text, YES), error (text, YES),
--        created_at (timestamp with time zone, YES)
--
--   SELECT indexname FROM pg_indexes WHERE tablename = 'exa_search_log';
--     -> exa_search_log_pkey, idx_exa_search_log_exhibition_id,
--        idx_exa_search_log_function_name, idx_exa_search_log_created_at
