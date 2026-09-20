-- migration_v62: the exhibition log
--
-- HOW TO APPLY: paste into the Supabase SQL editor as role `postgres`
-- (dashboard/project/sgkycnecmdxvujybsuev/sql/new). There is no psql, no
-- Supabase CLI and no DATABASE_URL in this project. Safe to re-run.
--
-- ---------------------------------------------------------------------------
-- WHY THIS COULD NOT BE BUILT UNTIL NOW
--
-- A log row points at an exhibition by id and means nothing if that id moves.
-- Until migration_v60 and the detail_url backfill in 147d8ff, an id COULD move:
-- Agent 1 matched a scraped show to its row by (venue_id, detail_url) and fell
-- back to a case-insensitive title match for rows saved before detail_url
-- existed. When the extracted title drifted between scrapes the fallback
-- missed, and the same real show was inserted again under a second id. Every
-- log written against the first id would have been orphaned by a rescrape,
-- silently, with nothing in the product to show it had happened.
--
-- That is fixed for exhibitions and verified: published rows keep their id
-- across rescrapes, matched by page address. So the FK below is worth having.
-- Prereads and readings have their own stability fixes, and their logs are
-- Phase 2 — nothing here touches them.
--
-- ---------------------------------------------------------------------------
-- THE GATING RULE, AND WHY IT IS A CONSTRAINT RATHER THAN A TRIGGER
--
-- A rating, a like and a comment are all claims about having SEEN a show.
-- 'want_to_see' means the opposite, so the three are only valid alongside
-- status = 'seen'. The brief asked for this to REJECT the write rather than
-- quietly tidy it, and that rules out the obvious-looking implementation: a
-- BEFORE trigger that nulls the extras out when status is 'want_to_see' would
-- accept `{status: 'want_to_see', rating: 5}` and silently drop the 5. A
-- caller that believed it had saved a rating would be wrong and never told.
--
-- So it is a CHECK, which fails loudly (23514), and the clearing behaviour
-- lives at the point of write instead: lib/exhibition-log-writes.ts upserts a
-- COMPLETE row every time, so moving back to 'want_to_see' carries explicit
-- NULLs and the extras are genuinely gone from the table — not preserved and
-- hidden. That is the default the brief asked for, arrived at honestly.
--
-- A CONSEQUENCE WORTH KNOWING: a PARTIAL update that sets only status to
-- 'want_to_see' on a row that already has a rating will FAIL rather than
-- clear it. That is deliberate. A partial update that quietly succeeded by
-- discarding data is the failure mode this whole section exists to avoid, and
-- a loud 23514 is how a future caller finds out it must send the nulls.
--
-- ---------------------------------------------------------------------------
-- COMMENT VISIBILITY IS NESTED INSIDE PROFILE PRIVACY, NOT PARALLEL TO IT
--
-- Two gates, in this order:
--
--   1. public.can_view_profile(user_id) — may this visitor see this person at
--      all? Public profile: yes. Private profile: only its owner and approved
--      followers. Either side of a block: no. This is the SAME function the
--      follower lists and the events feed ask (v44, widened by v48), not a
--      second copy of the privacy model.
--   2. comment_visibility — 'private' means the logger alone, always.
--
-- The rule that falls out, and the one the brief names explicitly: a 'public'
-- comment on a PRIVATE profile is NOT visible to a stranger. It is public
-- only within the audience gate 1 already decided. comment_visibility can
-- narrow that audience and can never widen it.
--
-- WHY THE READ GOES THROUGH A FUNCTION. RLS is row-level, and this rule is
-- column-level: on someone else's log entry the status, rating and like are
-- visible while the comment may not be. A policy cannot express that, so the
-- table's own policies are strictly first-person — you read YOUR rows, full
-- stop, exactly as public.follows does — and everything anyone sees of
-- somebody else's log comes from profile_exhibition_logs() below, which nulls
-- the comment itself. There is no policy anywhere that lets one account read
-- another's row from this table directly.
--
-- ---------------------------------------------------------------------------
-- WHAT IS NOT HERE
--
-- No reading logs (prereads, Top Stories, River) — Phase 2. No Top Four lists
-- — Phase 3. No feed event type: v47's log is deliberately empty and a
-- "logged an exhibition" event is now POSSIBLE, but writing it is a separate
-- decision about what a feed should carry, not a side effect of this table
-- existing. Nothing in Agent 1, 2, 3 or 4 changes; this reads exhibition ids
-- and never writes exhibition, preread or reading data.
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The table.
--
-- PRIMARY KEY (user_id, exhibition_id) IS the "one row per user per show"
-- constraint the brief asked for — the same shape public.follows uses for its
-- pair, and for the same reason: logging twice is then a conflict the database
-- resolves, not a second row somebody has to de-duplicate later. It is also
-- what makes the client's upsert an upsert.
--
-- user_id points at profiles rather than auth.users: a log belongs to the
-- profile that shows it, profiles already cascades from auth.users, and
-- deleting an account therefore removes its logs in one step.
--
-- exhibition_id CASCADEs too. A published exhibition is not deleted today —
-- that is what makes ids stable — but if one ever is, a log pointing at
-- nothing is worse than no log.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.exhibition_logs (
  user_id            uuid NOT NULL REFERENCES public.profiles(id)   ON DELETE CASCADE,
  exhibition_id      uuid NOT NULL REFERENCES public.exhibitions(id) ON DELETE CASCADE,
  status             text NOT NULL,
  rating             smallint,
  liked              boolean NOT NULL DEFAULT false,
  comment            text,
  comment_visibility text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (user_id, exhibition_id),

  CONSTRAINT exhibition_logs_status_values CHECK (status IN ('want_to_see', 'seen')),
  CONSTRAINT exhibition_logs_rating_range  CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  CONSTRAINT exhibition_logs_visibility_values
    CHECK (comment_visibility IS NULL OR comment_visibility IN ('public', 'private')),

  -- THE GATING RULE. See the header: this rejects, it does not tidy.
  CONSTRAINT exhibition_logs_seen_gates_opinions CHECK (
    status = 'seen'
    OR (rating IS NULL AND liked = false AND comment IS NULL AND comment_visibility IS NULL)
  ),

  -- A comment and its visibility travel together. Without this, a row can hold
  -- a comment with no visibility — and then every reader has to invent a
  -- default, which is exactly how a private comment becomes a public one.
  -- Writing one without the other is a mistake worth refusing.
  CONSTRAINT exhibition_logs_visibility_needs_comment CHECK (
    (comment IS NULL) = (comment_visibility IS NULL)
  )
);

COMMENT ON TABLE public.exhibition_logs IS
  'One row per person per exhibition. status want_to_see = intend to go; seen = went. rating, liked and comment are valid ONLY at seen and are rejected otherwise by exhibition_logs_seen_gates_opinions. Readable through RLS by its owner alone; other people see it only via profile_exhibition_logs(), which applies profile privacy and comment visibility.';
COMMENT ON COLUMN public.exhibition_logs.comment_visibility IS
  'public | private, NULL when there is no comment. A SECOND, NARROWER gate inside profile privacy — never a wider one. private = the logger only. public = whoever can already see the profile, which on a private account means approved followers, not everyone.';
COMMENT ON COLUMN public.exhibition_logs.liked IS
  'A like, not a rating — kept separate so "loved it" and "four stars" stay different statements. false is the absence of a like, which is why the gating CHECK reads liked = false rather than IS NULL.';

-- The PK indexes (user_id, exhibition_id), which serves "this person's log"
-- and "this person's entry for this show". Nothing yet reads the other
-- direction — the exhibition page shows the visitor their OWN entry only, and
-- other people's opinions on a show are not part of this phase — so no index
-- on exhibition_id is created here. Add one with the feature that needs it.

-- ---------------------------------------------------------------------------
-- 2. updated_at, and only from the database.
--
-- public.set_updated_at() is migration_v40's, already used by profiles. The
-- column is withheld from the write grants in section 5 for the usual reason:
-- a client-supplied timestamp can be backdated, and "recently logged" is an
-- ordering people will eventually see.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS exhibition_logs_updated_at ON public.exhibition_logs;
CREATE TRIGGER exhibition_logs_updated_at
  BEFORE UPDATE ON public.exhibition_logs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. You may only log a PUBLISHED exhibition.
--
-- The foreign key proves the id exists; it says nothing about whether the row
-- is one the public was ever shown. Pending rows are unreviewed scraper output
-- (migration_v26), and a signed-in caller writing straight to PostgREST can
-- name any uuid it likes — so without this, guessing a pending id and logging
-- it would confirm that the id exists and that the show is real, ahead of any
-- editorial decision to publish it.
--
-- SECURITY DEFINER because `authenticated` has NO read policy on exhibitions
-- at all: v26 granted published rows to `anon` only. This trigger has to read
-- status with the owner's privileges or it would find no row for anybody and
-- refuse every legitimate log.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.exhibition_logs_require_published()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  show_status text;
BEGIN
  SELECT status INTO show_status
    FROM public.exhibitions
   WHERE id = NEW.exhibition_id;

  -- Both cases answer identically on purpose. "No such show" and "not
  -- published yet" are different facts, and telling them apart is precisely
  -- the disclosure this trigger exists to prevent.
  IF show_status IS DISTINCT FROM 'published' THEN
    RAISE EXCEPTION 'no_such_exhibition'
      USING HINT = 'That exhibition is not available to log.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS exhibition_logs_published_only ON public.exhibition_logs;
CREATE TRIGGER exhibition_logs_published_only
  BEFORE INSERT OR UPDATE OF exhibition_id ON public.exhibition_logs
  FOR EACH ROW EXECUTE FUNCTION public.exhibition_logs_require_published();

-- ---------------------------------------------------------------------------
-- 4. RLS: strictly first-person, on every verb.
--
-- There is no policy here that returns somebody else's row, and that is the
-- design rather than an omission — see the header. Other people's logs are
-- reachable only through section 6, which nulls the comment where it must.
--
-- No anon policy at all: a signed-out visitor has no logs and cannot make any.
-- ---------------------------------------------------------------------------
ALTER TABLE public.exhibition_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS exhibition_logs_read_own   ON public.exhibition_logs;
DROP POLICY IF EXISTS exhibition_logs_insert_own ON public.exhibition_logs;
DROP POLICY IF EXISTS exhibition_logs_update_own ON public.exhibition_logs;
DROP POLICY IF EXISTS exhibition_logs_delete_own ON public.exhibition_logs;

CREATE POLICY exhibition_logs_read_own ON public.exhibition_logs
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY exhibition_logs_insert_own ON public.exhibition_logs
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

-- USING and WITH CHECK both, and they are not the same question: USING picks
-- which rows may be updated, WITH CHECK decides what they may become. Without
-- the second, a person could update their own row and hand it to somebody else
-- by rewriting user_id.
CREATE POLICY exhibition_logs_update_own ON public.exhibition_logs
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY exhibition_logs_delete_own ON public.exhibition_logs
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- ---------------------------------------------------------------------------
-- 5. Grants, column by column.
--
-- v26 left this database deny-by-default, so a new table arrives with no
-- privileges and has to be handed back explicitly even where a policy above
-- already does the filtering.
--
-- created_at and updated_at are readable but NOT writable: both are the
-- database's account of when something happened, and a caller that can set
-- them can lie about it.
-- ---------------------------------------------------------------------------
GRANT SELECT (user_id, exhibition_id, status, rating, liked, comment,
              comment_visibility, created_at, updated_at)
  ON public.exhibition_logs TO authenticated;

GRANT INSERT (user_id, exhibition_id, status, rating, liked, comment,
              comment_visibility)
  ON public.exhibition_logs TO authenticated;

-- THE UPDATE LIST INCLUDES user_id AND exhibition_id, AND THAT IS DELIBERATE.
--
-- The instinct from public.follows — grant UPDATE on the one column that may
-- change and withhold the key columns — breaks here, because this table is
-- written by an UPSERT rather than by an insert and a separate update.
-- PostgREST compiles an upsert to
--
--     INSERT INTO ... ON CONFLICT (user_id, exhibition_id)
--     DO UPDATE SET user_id = excluded.user_id, exhibition_id = ..., status = ...
--
-- naming every column of the payload, key columns included. Withhold either
-- and the FIRST save of a log succeeds while every later one fails on a
-- permission error — the worst possible split, because the feature looks like
-- it works until somebody changes their mind.
--
-- Granting them costs nothing, because the grant was never what protected
-- them:
--   user_id        the UPDATE policy's WITH CHECK requires the row to still be
--                  the caller's afterwards, so it cannot be handed to anybody
--                  else. USING already limited the caller to their own rows.
--   exhibition_id  the published-only trigger in section 3 fires on UPDATE OF
--                  exhibition_id, so a row cannot be repointed at an
--                  unpublished show. Repointing it at another PUBLISHED show
--                  is just moving your own log, and the primary key refuses a
--                  move onto one you have already logged.
GRANT UPDATE (user_id, exhibition_id, status, rating, liked, comment,
              comment_visibility)
  ON public.exhibition_logs TO authenticated;

GRANT DELETE ON public.exhibition_logs TO authenticated;
GRANT ALL    ON public.exhibition_logs TO service_role;

-- ---------------------------------------------------------------------------
-- 6. Somebody else's log — the only way to read one.
--
-- Returns the exhibition's display fields as well as the log, because
-- `authenticated` cannot read public.exhibitions at all (v26 granted published
-- rows to `anon` only). Without the join here the profile page would have to
-- fetch titles with the service key, which would mean a second, differently
-- privileged path to the same data — and a privacy rule is only as good as its
-- least careful caller. One function, one answer.
--
-- THE THREE GATES, IN ORDER:
--
--   can_view_profile(profile_id)  the whole result is empty if the visitor may
--                                 not see this person: private and not an
--                                 approved follower, or a block in either
--                                 direction. Asked ONCE for the query rather
--                                 than per row, because it is a fact about the
--                                 person, not about any one log entry.
--   e.status = 'published'        an unpublished show does not appear on
--                                 anybody's profile, the same rule section 3
--                                 enforces on write, applied again on read in
--                                 case a row is ever unpublished after the fact.
--   the comment CASE              'private' to its owner alone; 'public' to
--                                 everyone who got past gate one, which on a
--                                 private profile is approved followers only.
--
-- The comment is NULLED rather than the ROW being dropped: a visitor allowed
-- on the profile is allowed to know the show was logged, rated and liked. The
-- comment is the only part comment_visibility governs.
--
-- Ordered newest first by updated_at, which is when the person last said
-- something about the show rather than when they first marked it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.profile_exhibition_logs(
  profile_id uuid,
  max_rows   integer DEFAULT 200
)
RETURNS TABLE (
  exhibition_id uuid,
  status        text,
  rating        smallint,
  liked         boolean,
  comment       text,
  comment_visibility text,
  logged_at     timestamptz,
  show_title    text,
  start_date    date,
  end_date      date,
  image_url     text,
  venue_name    text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    l.exhibition_id,
    l.status,
    l.rating,
    l.liked,
    CASE
      WHEN l.comment_visibility = 'public' THEN l.comment
      WHEN l.user_id = (SELECT auth.uid()) THEN l.comment
      ELSE NULL
    END,
    -- MASKED IN LOCKSTEP WITH THE COMMENT, and that is the whole point of
    -- repeating the CASE rather than selecting the column. Handed back
    -- unmasked, 'private' would arrive next to a NULL comment and announce
    -- "there is a note here you are not allowed to read" — the one thing a
    -- private note must not do. Returned this way it is non-null only when the
    -- comment beside it is, so it can say "only you" on its author's own page
    -- and tells everyone else nothing.
    CASE
      WHEN l.comment_visibility = 'public' THEN l.comment_visibility
      WHEN l.user_id = (SELECT auth.uid()) THEN l.comment_visibility
      ELSE NULL
    END,
    l.updated_at,
    e.show_title,
    e.start_date,
    e.end_date,
    e.image_url,
    coalesce(i.name, v.name)
  FROM public.exhibition_logs l
  JOIN public.exhibitions e ON e.id = l.exhibition_id
  LEFT JOIN public.venues       v ON v.id = e.venue_id
  LEFT JOIN public.institutions i ON i.id = v.institution_id
  WHERE l.user_id = profile_id
    AND e.status = 'published'
    AND public.can_view_profile(profile_id)
  ORDER BY l.updated_at DESC
  LIMIT LEAST(GREATEST(coalesce(max_rows, 200), 1), 200);
$$;

COMMENT ON FUNCTION public.profile_exhibition_logs(uuid, integer) IS
  'A person''s exhibition log, as a given visitor is allowed to see it. Empty unless can_view_profile() says yes. A private comment comes back NULL to everyone but its author; a public comment comes back to everyone who got past that first gate — which on a private profile is approved followers, not the world. MUST be called with the visitor''s session: it reads auth.uid().';

-- anon is granted this deliberately: a public profile's log is public, exactly
-- as a public profile's follower list and events already are. With no session
-- auth.uid() is NULL, so can_view_profile() answers true only for public
-- profiles and the comment CASE hands back public comments only — a signed-out
-- visitor can never reach a private comment or a private person's log.
GRANT EXECUTE ON FUNCTION public.profile_exhibition_logs(uuid, integer) TO anon, authenticated;

COMMIT;

-- PostgREST caches the schema; new tables and functions are invisible over the
-- REST API until it reloads. Supabase normally fires this itself on DDL.
NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- VERIFY
--
-- scripts/test-exhibition-logs.mjs proves all of this against the live
-- database with real sessions. Run it after applying this file:
--
--   node --env-file=.env.local scripts/test-exhibition-logs.mjs
--
-- It must be a script and not a query in this editor, because the editor runs
-- as postgres and bypasses every policy above.
-- ---------------------------------------------------------------------------
