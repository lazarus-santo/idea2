-- migration_v8.sql
-- Track whether a reading has been checked for top story status.
-- Prevents re-running Exa searches on articles that already went through
-- detectTopStories and didn't qualify. Checked once; cost stays O(new articles).

ALTER TABLE readings
  ADD COLUMN IF NOT EXISTS top_story_checked boolean NOT NULL DEFAULT false;
