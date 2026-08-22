-- migration_v34: let exhibition deletes proceed past fetch-log references
--
-- agent1_fetch_logs.exhibition_id was declared as a plain REFERENCES with no
-- ON DELETE action (migration_v20), so it defaults to NO ACTION. That silently
-- broke the scraper's stale-pending wipe: every run calls
--   delete from exhibitions where venue_id = ? and status = 'pending'
-- and every pending row that had ever been fetch-logged rejected the delete with
-- 23503. The scraper never checked the result, so the failure was invisible and
-- stale pending rows accumulated on most venues, every run.
--
-- SET NULL rather than CASCADE on purpose: the fetch log is diagnostic history
-- and still carries url/title/method/outcome, which stay useful after the
-- exhibition row is gone. Only the link is dropped.
ALTER TABLE agent1_fetch_logs
  DROP CONSTRAINT IF EXISTS agent1_fetch_logs_exhibition_id_fkey;

ALTER TABLE agent1_fetch_logs
  ADD CONSTRAINT agent1_fetch_logs_exhibition_id_fkey
  FOREIGN KEY (exhibition_id) REFERENCES exhibitions(id) ON DELETE SET NULL;
