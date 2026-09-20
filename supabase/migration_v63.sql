-- migration_v63: the reading log (prereads + Top Stories/River articles)
--
-- HOW TO APPLY: paste into the Supabase SQL editor as role `postgres`
-- (dashboard/project/sgkycnecmdxvujybsuev/sql/new). There is no psql, no
-- Supabase CLI and no DATABASE_URL in this project. Safe to re-run.
--
-- Phase 2 of 3. migration_v62 did exhibitions; this does the things people
-- read. Phase 3 (Top Four lists) is not here and nothing below anticipates it.
--
-- ---------------------------------------------------------------------------
-- WHY THIS COULD NOT BE BUILT UNTIL NOW, AND WHAT MADE IT SAFE
--
-- The same question v62 had to answer for exhibitions: does the id a log
-- points at still mean the same thing tomorrow? For readings there were two
-- separate ways it did not, and both were fixed before this table was written:
--
--   River articles used to be pruned on a retention window, so a log would
--   have outlived the row it pointed at. e1d0e9b ended that: readings are
--   never deleted, and RETENTION_DAYS is now only a spend limit on Agent 3.
--   Top Stories were already stable.
--
--   Prereads were worse, because the row survived while its CONTENTS changed.
--   Repair and the admin Replace button wrote a different article onto the
--   same id. e10444b/migration_v61 ended that: a row someone has logged is
--   FROZEN — the fresh article goes into a new row, and the logged row is
--   blanked with its content untouched, pointing at its replacement through
--   superseded_by.
--
-- That freeze has been dead code until this moment. lib/preread-logs.ts, the
-- function the repair paths ask "has anyone logged this?", was a stub that
-- always answered no, because there was no log table to ask. This migration is
-- what makes that question answerable, and the same change wires the stub to
-- this table. Until both halves landed, prereads had the mechanism and none of
-- the protection.
--
-- ---------------------------------------------------------------------------
-- WHY THE KEY IS (content_type, content_id) AND NOT A FOREIGN KEY
--
-- Prereads and readings are different tables with independent id spaces. A
-- bare content_id would be ambiguous — two rows could collide across the two
-- tables, and no reader could tell which one a log meant. So the pair
-- identifies the item, and the primary key is (user_id, content_type,
-- content_id).
--
-- The cost of that is real and worth stating: a polymorphic column CANNOT have
-- a foreign key. v62 could lean on `REFERENCES exhibitions(id) ON DELETE
-- CASCADE` to guarantee a log never points at nothing. Here the database
-- cannot enforce it, so two things stand in its place:
--
--   ON WRITE   the trigger in section 3 checks the row exists and is something
--              this person was ever shown — the same job
--              exhibition_logs_require_published() does, doing more work
--              because it has two tables to look in.
--   ON READ    profile_reading_logs() JOINs, so a log pointing at a vanished
--              row returns no entry rather than a blank one.
--
-- Neither can stop a DELETE elsewhere from orphaning a row, which is why both
-- underlying tables having a never-delete rule is a precondition of this
-- table, not a nice-to-have. Readings are never deleted (e1d0e9b). Prereads
-- are: migration_v54 logs each deletion, and planFairCoverageWrites() already
-- BLANKS a logged row where it would delete an unlogged one — which is the
-- same protection, arrived at from the other direction.
--
-- ---------------------------------------------------------------------------
-- THE GATING RULE — IDENTICAL TO v62, INCLUDING WHY IT IS A CHECK
--
-- rating, liked and comment are claims about having READ the piece.
-- 'reading_list' says the opposite, so the three are valid only at 'read'. The
-- brief asked for the write to be REJECTED rather than quietly tidied, which
-- rules out a BEFORE trigger that nulls them: that would accept
-- `{status: 'reading_list', rating: 5}` and silently drop the 5, leaving a
-- caller believing it had saved a rating.
--
-- So it is a CHECK, which fails loudly (23514), and the clearing lives at the
-- point of write: lib/reading-log-writes.ts upserts a COMPLETE row every time,
-- so moving back to 'reading_list' carries explicit NULLs and the extras are
-- genuinely gone. Downgrading warns first, in the component, exactly as
-- ExhibitionLog does.
--
-- The same consequence as v62 applies: a PARTIAL update that sets only status
-- to 'reading_list' on a row that has a rating FAILS rather than clears it.
-- Deliberate. A loud 23514 is how a future caller learns it must send nulls.
--
-- ---------------------------------------------------------------------------
-- COMMENT VISIBILITY — THE SAME MODEL, NOT A SECOND COPY OF IT
--
-- The brief was explicit that this must not be reimplemented, and it is not:
-- section 6 calls public.can_view_profile(), the SAME function v44 wrote, v48
-- widened for blocks, and v62's profile_exhibition_logs() asks. There is no
-- privacy logic in this file that exists anywhere else.
--
-- Two gates, in order:
--   1. can_view_profile(user_id) — may this visitor see this person at all?
--   2. comment_visibility — 'private' means the logger alone, always.
--
-- A 'public' comment on a PRIVATE profile is therefore NOT visible to a
-- stranger. comment_visibility narrows the audience gate 1 decided; it can
-- never widen it. As in v62 the read goes through a function because the rule
-- is column-level (status, rating and like are visible while the comment may
-- not be) and RLS is row-level. The table's own policies are strictly
-- first-person: no policy anywhere lets one account read another's row.
--
-- ---------------------------------------------------------------------------
-- A FROZEN PREREAD IS STILL YOUR LOG — SEE SECTION 6
--
-- The one rule here with no counterpart in v62. When a logged preread is
-- frozen, its row is blanked and disappears from the public exhibition page.
-- The log must still render, with THAT row's content — the article the person
-- actually read — so profile_reading_logs() deliberately does NOT filter
-- row_status or superseded_by. Section 3 has the matching subtlety on write.
--
-- ---------------------------------------------------------------------------
-- WHAT IS NOT HERE
--
-- No Top Four lists — Phase 3. No feed event type: v47's log is deliberately
-- empty and "logged an article" is now POSSIBLE, but writing it is a separate
-- decision. No notifications. Nothing in Agent 1, 2, 3 or 4 changes except the
-- freeze stub being given a real query to run, which is a read.
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The table.
--
-- PRIMARY KEY (user_id, content_type, content_id) IS the "one row per user per
-- item" constraint the brief asked for, and it is what makes the client's
-- upsert an upsert. content_type is part of it for the reason in the header:
-- the two id spaces are independent, so only the pair identifies an item.
--
-- user_id points at profiles rather than auth.users, as in v62: a log belongs
-- to the profile that shows it, and deleting an account removes its logs in
-- one step through the cascade profiles already has.
--
-- content_id has NO foreign key and cannot have one. See the header.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reading_logs (
  user_id            uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content_type       text NOT NULL,
  content_id         uuid NOT NULL,
  status             text NOT NULL,
  rating             smallint,
  liked              boolean NOT NULL DEFAULT false,
  comment            text,
  comment_visibility text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (user_id, content_type, content_id),

  CONSTRAINT reading_logs_content_type_values CHECK (content_type IN ('preread', 'reading')),
  CONSTRAINT reading_logs_status_values       CHECK (status IN ('reading_list', 'read')),
  CONSTRAINT reading_logs_rating_range        CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  CONSTRAINT reading_logs_visibility_values
    CHECK (comment_visibility IS NULL OR comment_visibility IN ('public', 'private')),

  -- THE GATING RULE. See the header: this rejects, it does not tidy.
  CONSTRAINT reading_logs_read_gates_opinions CHECK (
    status = 'read'
    OR (rating IS NULL AND liked = false AND comment IS NULL AND comment_visibility IS NULL)
  ),

  -- A comment and its visibility travel together, as in v62. Without this a
  -- row can hold a comment with no visibility, and then every reader has to
  -- invent a default — which is how a private comment becomes a public one.
  CONSTRAINT reading_logs_visibility_needs_comment CHECK (
    (comment IS NULL) = (comment_visibility IS NULL)
  )
);

COMMENT ON TABLE public.reading_logs IS
  'One row per person per item read, across two tables: content_type preread = prereads.id, reading = readings.id (Top Stories and River). status reading_list = mean to read; read = read it. rating, liked and comment are valid ONLY at read and are rejected otherwise by reading_logs_read_gates_opinions. Readable through RLS by its owner alone; other people see it only via profile_reading_logs(), which applies profile privacy and comment visibility.';
COMMENT ON COLUMN public.reading_logs.content_id IS
  'The prereads.id or readings.id this log is about. NO foreign key is possible on a polymorphic column — reading_logs_loggable() checks it on write and profile_reading_logs() JOINs on read. Both underlying tables have a never-delete rule, which is what keeps this honest.';
COMMENT ON COLUMN public.reading_logs.comment_visibility IS
  'public | private, NULL when there is no comment. A SECOND, NARROWER gate inside profile privacy — never a wider one. private = the logger only. public = whoever can already see the profile, which on a private account means approved followers, not everyone.';

-- The PK indexes (user_id, content_type, content_id), which serves "this
-- person's reading log" and "this person's entry for this item".
--
-- THIS ONE IS DIFFERENT FROM v62, WHICH ADDED NO SECOND INDEX. The freeze
-- check reads the OTHER direction — "has ANYONE logged these preread ids?" —
-- on every Agent 2 repair and every admin Replace, so that lookup gets an
-- index of its own. Partial, because it is only ever asked about prereads.
CREATE INDEX IF NOT EXISTS reading_logs_preread_idx
  ON public.reading_logs (content_id) WHERE content_type = 'preread';

-- ---------------------------------------------------------------------------
-- 2. updated_at, and only from the database.
--
-- public.set_updated_at() is migration_v40's. The column is withheld from the
-- write grants in section 5: a client-supplied timestamp can be backdated, and
-- "recently logged" is the order the profile list is shown in.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS reading_logs_updated_at ON public.reading_logs;
CREATE TRIGGER reading_logs_updated_at
  BEFORE UPDATE ON public.reading_logs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. You may only log something you were actually shown.
--
-- This is v62's exhibition_logs_require_published() with two tables to check
-- instead of one, and it exists for the same reason: a signed-in caller
-- writing straight to PostgREST can name any uuid it likes, and without this,
-- guessing an id and logging it would confirm the row exists.
--
-- SECURITY DEFINER because `authenticated` has NO read grant on prereads or
-- readings at all — migration_v26 granted both to `anon` only. Without the
-- owner's privileges this would find no row for any signed-in person and
-- refuse every legitimate log.
--
-- WHAT COUNTS AS LOGGABLE:
--   preread   the row exists, its exhibition is PUBLISHED, and the row is live
--             (row_status = 'active', not superseded). A blanked row is
--             admin-only and never appears on the public page, so it is not
--             something anyone could have decided to log.
--   reading   the row exists. readings has no status column and no row-level
--             gate — v26's policy is USING (true) — so existence is the whole
--             test. It is still worth making: it is what stops a log pointing
--             at nothing.
--
-- ── THE SUBTLE PART, AND THE ONE v62 NEVER HAD TO FACE ──────────────────────
--
-- A write that does not REPOINT the log is allowed through without checking,
-- and there are TWO early returns below because an upsert can arrive on either
-- branch. Both exist to protect the same thing:
--
--   FROZEN PREREADS. A logged preread gets blanked the moment it is repaired —
--   by design (migration_v61). Re-checking "is it still active?" on every
--   write would mean that from the instant the freeze fires, the person could
--   no longer edit their own rating or note on the piece they read. Their log
--   would be readable and frozen shut. The item was loggable when they logged
--   it, and that decision is not revisited.
--
-- WHY TWO BRANCHES AND NOT ONE. The obvious version guards only TG_OP =
-- 'UPDATE', on the reasoning that PostgREST compiles an upsert to
--
--     INSERT ... ON CONFLICT (user_id, content_type, content_id)
--     DO UPDATE SET content_type = excluded.content_type, content_id = ...
--
-- which names the key columns and so fires a trigger declared UPDATE OF
-- content_id. That much is true, and it is not enough, because of an ordering
-- rule that is easy to miss and was caught here by a failing test rather than
-- by reading:
--
--   POSTGRES FIRES BEFORE INSERT ROW TRIGGERS *BEFORE* IT LOOKS FOR THE
--   CONFLICT. An upsert is an INSERT until the conflict is found. So on the
--   second save of any log, this function runs first with TG_OP = 'INSERT',
--   and if it raises there, the ON CONFLICT ... DO UPDATE path is never
--   reached at all. Guarding only the UPDATE branch therefore produced
--   exactly the bug it was written to prevent: a frozen preread's log could be
--   read but never edited again.
--
-- So the INSERT branch asks a different question — "does this person already
-- have a row for this item?" — and lets an existing log through. It is not a
-- weaker check: a row can only exist because the full check passed when it was
-- first written, and RLS confines a caller to their own rows either way.
--
-- Repointing a log at a DIFFERENT item is still checked, which is the only
-- case where the question is real.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reading_logs_loggable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  ok boolean;
BEGIN
  -- Not repointing: the item was checked when it was first logged. See the
  -- header for why this is asked twice, once per branch.
  --
  -- NESTED rather than one AND-ed condition, which matters: on an INSERT the
  -- OLD record is unassigned, and PL/pgSQL raises rather than short-circuiting
  -- if a field of it is named in the same expression as the TG_OP test. The
  -- outer IF is what keeps OLD out of reach on the insert path.
  IF TG_OP = 'UPDATE' THEN
    IF NEW.content_type IS NOT DISTINCT FROM OLD.content_type
       AND NEW.content_id IS NOT DISTINCT FROM OLD.content_id THEN
      RETURN NEW;
    END IF;
  END IF;

  -- An upsert of a log that already exists arrives HERE, as an INSERT, because
  -- BEFORE INSERT triggers fire before the conflict is found. Letting it
  -- through is what keeps a frozen preread's log editable by the person who
  -- wrote it. Safe for the reason the header gives: the row can only exist
  -- because this check already passed once, and RLS keeps a caller to their
  -- own rows.
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (
      SELECT 1 FROM public.reading_logs l
       WHERE l.user_id      = NEW.user_id
         AND l.content_type = NEW.content_type
         AND l.content_id   = NEW.content_id
    ) THEN
      RETURN NEW;
    END IF;
  END IF;

  IF NEW.content_type = 'preread' THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.prereads p
        JOIN public.exhibitions e ON e.id = p.exhibition_id
       WHERE p.id = NEW.content_id
         AND e.status = 'published'
         AND p.row_status = 'active'
         AND p.superseded_by IS NULL
    ) INTO ok;
  ELSIF NEW.content_type = 'reading' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.readings r WHERE r.id = NEW.content_id
    ) INTO ok;
  ELSE
    -- Unreachable: the CHECK in section 1 refuses any other value first. Kept
    -- so that adding a content_type without teaching this function about it
    -- fails closed rather than silently accepting anything.
    ok := false;
  END IF;

  -- "No such row" and "not something you were shown" answer identically on
  -- purpose, as in v62. Telling them apart is the disclosure this prevents.
  IF NOT ok THEN
    RAISE EXCEPTION 'no_such_content'
      USING HINT = 'That article is not available to log.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reading_logs_loggable_only ON public.reading_logs;
CREATE TRIGGER reading_logs_loggable_only
  BEFORE INSERT OR UPDATE OF content_type, content_id ON public.reading_logs
  FOR EACH ROW EXECUTE FUNCTION public.reading_logs_loggable();

-- ---------------------------------------------------------------------------
-- 4. RLS: strictly first-person, on every verb. Same as v62.
--
-- There is no policy here that returns somebody else's row. Other people's
-- logs are reachable only through section 6, which nulls the comment where it
-- must. No anon policy: a signed-out visitor has no logs and cannot make any.
-- ---------------------------------------------------------------------------
ALTER TABLE public.reading_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reading_logs_read_own   ON public.reading_logs;
DROP POLICY IF EXISTS reading_logs_insert_own ON public.reading_logs;
DROP POLICY IF EXISTS reading_logs_update_own ON public.reading_logs;
DROP POLICY IF EXISTS reading_logs_delete_own ON public.reading_logs;

CREATE POLICY reading_logs_read_own ON public.reading_logs
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY reading_logs_insert_own ON public.reading_logs
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

-- USING and WITH CHECK both: USING picks which rows may be updated, WITH CHECK
-- decides what they may become. Without the second, a person could update
-- their own row and hand it to somebody else by rewriting user_id.
CREATE POLICY reading_logs_update_own ON public.reading_logs
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY reading_logs_delete_own ON public.reading_logs
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- ---------------------------------------------------------------------------
-- 5. Grants, column by column.
--
-- v26 left this database deny-by-default, so a new table arrives with no
-- privileges. created_at and updated_at are readable but NOT writable: both
-- are the database's account of when something happened.
--
-- The UPDATE list includes the key columns for the reason v62 spells out at
-- length: PostgREST's upsert names every column of the payload in its DO
-- UPDATE, key columns included, so withholding one would let the FIRST save of
-- a log succeed and every later one fail on a permission error. The grant was
-- never what protected them — the UPDATE policy's WITH CHECK keeps the row the
-- caller's, and the trigger in section 3 checks any repointing.
-- ---------------------------------------------------------------------------
GRANT SELECT (user_id, content_type, content_id, status, rating, liked,
              comment, comment_visibility, created_at, updated_at)
  ON public.reading_logs TO authenticated;

GRANT INSERT (user_id, content_type, content_id, status, rating, liked,
              comment, comment_visibility)
  ON public.reading_logs TO authenticated;

GRANT UPDATE (user_id, content_type, content_id, status, rating, liked,
              comment, comment_visibility)
  ON public.reading_logs TO authenticated;

GRANT DELETE ON public.reading_logs TO authenticated;
GRANT ALL    ON public.reading_logs TO service_role;

-- ---------------------------------------------------------------------------
-- 6. Somebody else's reading log — the only way to read one.
--
-- The counterpart of profile_exhibition_logs(), and the same three gates in
-- the same order:
--
--   can_view_profile(profile_id)  the whole result is empty if the visitor may
--                                 not see this person: private and not an
--                                 approved follower, or a block in either
--                                 direction. THE SAME FUNCTION v62 asks — the
--                                 privacy model is not restated here.
--   the item's own visibility     an unpublished exhibition's preread does not
--                                 appear on anybody's profile.
--   the comment CASE              'private' to its owner alone; 'public' to
--                                 everyone who got past gate one.
--
-- The comment is NULLED rather than the ROW being dropped, and the visibility
-- is masked in LOCKSTEP with it — handed back unmasked, 'private' would arrive
-- next to a NULL comment and announce "there is a note here you may not read",
-- which is the one thing a private note must not do.
--
-- ── WHY THE PREREAD BRANCH FILTERS LESS THAN THE PUBLIC PAGE DOES ───────────
--
-- The exhibition page shows only row_status = 'active' rows. This deliberately
-- does NOT, and that is requirement 4 of the brief rather than an oversight.
--
-- A frozen preread (row_status 'blanked', superseded_by set) is precisely the
-- content the person logged: v61 keeps it byte-for-byte so the log resolves to
-- the article they actually read. Filtering it here would make their entry
-- vanish from their own profile the moment Agent 2 repaired the show — the
-- exact silent loss the freeze was built to prevent, moved one table along.
--
-- What is still filtered is the EXHIBITION's status, because that is a privacy
-- rule rather than a content-lifecycle one: an unpublished show is not
-- something a profile may disclose. `superseded` is returned so the UI can say
-- the piece has since been replaced, which is honest without being alarming.
--
-- Ordered newest first by updated_at — when the person last said something
-- about the piece, rather than when they first marked it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.profile_reading_logs(
  profile_id uuid,
  max_rows   integer DEFAULT 200
)
RETURNS TABLE (
  content_type       text,
  content_id         uuid,
  status             text,
  rating             smallint,
  liked              boolean,
  comment            text,
  comment_visibility text,
  logged_at          timestamptz,
  title              text,
  publication        text,
  article_url        text,
  thumbnail_url      text,
  author             text,
  published_at       timestamptz,
  exhibition_id      uuid,
  show_title         text,
  superseded         boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- Prereads. No row_status or superseded_by filter — see the note above.
  SELECT
    l.content_type,
    l.content_id,
    l.status,
    l.rating,
    l.liked,
    CASE
      WHEN l.comment_visibility = 'public' THEN l.comment
      WHEN l.user_id = (SELECT auth.uid()) THEN l.comment
      ELSE NULL
    END,
    CASE
      WHEN l.comment_visibility = 'public' THEN l.comment_visibility
      WHEN l.user_id = (SELECT auth.uid()) THEN l.comment_visibility
      ELSE NULL
    END,
    l.updated_at,
    p.article_title,
    p.publication,
    p.article_url,
    p.thumbnail_url,
    p.author,
    p.published_date,
    e.id,
    e.show_title,
    (p.superseded_by IS NOT NULL)
  FROM public.reading_logs l
  JOIN public.prereads    p ON p.id = l.content_id
  JOIN public.exhibitions e ON e.id = p.exhibition_id
  WHERE l.user_id = profile_id
    AND l.content_type = 'preread'
    AND e.status = 'published'
    AND public.can_view_profile(profile_id)

  UNION ALL

  -- Readings. Every row is public (v26), so there is no second gate to apply;
  -- the publications join is only for the name shown as attribution.
  SELECT
    l.content_type,
    l.content_id,
    l.status,
    l.rating,
    l.liked,
    CASE
      WHEN l.comment_visibility = 'public' THEN l.comment
      WHEN l.user_id = (SELECT auth.uid()) THEN l.comment
      ELSE NULL
    END,
    CASE
      WHEN l.comment_visibility = 'public' THEN l.comment_visibility
      WHEN l.user_id = (SELECT auth.uid()) THEN l.comment_visibility
      ELSE NULL
    END,
    l.updated_at,
    r.headline,
    pub.name,
    r.article_url,
    r.thumbnail_url,
    r.author,
    r.published_at,
    NULL::uuid,
    NULL::text,
    false
  FROM public.reading_logs l
  JOIN public.readings r ON r.id = l.content_id
  LEFT JOIN public.publications pub ON pub.id = r.publication_id
  WHERE l.user_id = profile_id
    AND l.content_type = 'reading'
    AND public.can_view_profile(profile_id)

  ORDER BY 8 DESC
  LIMIT LEAST(GREATEST(coalesce(max_rows, 200), 1), 200);
$$;

COMMENT ON FUNCTION public.profile_reading_logs(uuid, integer) IS
  'A person''s reading log — prereads and readings together — as a given visitor is allowed to see it. Empty unless can_view_profile() says yes. A private note comes back NULL to everyone but its author; a public note comes back to everyone who got past that first gate, which on a private profile is approved followers. A FROZEN preread is included and renders with the content the person logged (superseded = true): hiding it would undo migration_v61. MUST be called with the visitor''s session: it reads auth.uid().';

-- anon is granted this deliberately, as in v62: a public profile's log is
-- public, exactly as its follower list and events already are. With no session
-- auth.uid() is NULL, so can_view_profile() answers true only for public
-- profiles and the comment CASE hands back public comments only.
GRANT EXECUTE ON FUNCTION public.profile_reading_logs(uuid, integer) TO anon, authenticated;

COMMIT;

-- PostgREST caches the schema; new tables and functions are invisible over the
-- REST API until it reloads. Supabase normally fires this itself on DDL.
NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- DID IT LAND? Read what this prints.
--
-- Every column should say true. `insert_guard_present` is the one worth
-- looking at on a RE-RUN: it is the fix for the BEFORE-INSERT ordering trap
-- described above section 3, and a false there means the editor ran an older
-- copy of this file — the symptom is that a frozen preread's log can be read
-- and removed but never edited.
-- ---------------------------------------------------------------------------
SELECT
  to_regclass('public.reading_logs') IS NOT NULL                AS table_exists,
  to_regproc('public.reading_logs_loggable') IS NOT NULL        AS trigger_fn_exists,
  to_regproc('public.profile_reading_logs') IS NOT NULL         AS read_fn_exists,
  (SELECT prosrc LIKE '%TG_OP = ''INSERT''%'
     FROM pg_proc WHERE oid = to_regproc('public.reading_logs_loggable'))
                                                                AS insert_guard_present;

-- ---------------------------------------------------------------------------
-- VERIFY
--
-- scripts/test-reading-logs.mjs proves all of this against the live database
-- with real sessions, INCLUDING the freeze firing end to end. Run it after
-- applying this file:
--
--   node --env-file=.env.local --import ./scripts/ts-resolve.mjs \
--     scripts/test-reading-logs.mjs
--
-- It must be a script and not a query in this editor, because the editor runs
-- as postgres and bypasses every policy and grant above. The --import flag
-- lets it call the app's real lib/preread-logs.ts rather than a copy of its
-- query, which is the only way to prove the FREEZE itself is wired up.
-- ---------------------------------------------------------------------------
