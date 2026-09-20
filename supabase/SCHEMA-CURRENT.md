# Current database schema

**Generated from the live database on 2026-09-20** by `scripts/dump-schema.mjs`.
Do not edit by hand — re-run the script instead.

## Read this before you trust it

This is a **shape reference**, not a definition of the database and not
something to run. It is derived from what PostgREST serves, which is the live
catalog, so the columns and types below are true. But it **cannot see**:

- **CHECK constraints** — including the gating rule on `exhibition_logs`
- **RLS policies and grants** — i.e. the entire privacy model
- **Triggers and function bodies** — only a function's name appears, under RPCs
- **Indexes**

For anything that decides **access**, read the migration. `supabase/migration_v*.sql`
is the source of truth and each one explains its own reasoning at the top.

`supabase/schema.sql` is the **v1** schema and is long out of date — it
declares three tables and columns that do not exist. Do not read it as current.

---

## Tables (29)

### `agent_runs`

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | `"gen_random_uuid()"` | PK |
| `agent` | text | NOT NULL |  |  |
| `started_at` | timestamp with time zone | NOT NULL | `"now()"` |  |
| `completed_at` | timestamp with time zone |  |  |  |
| `status` | text |  |  |  |
| `items_processed` | integer |  | `0` |  |
| `items_succeeded` | integer |  | `0` |  |
| `items_failed` | integer |  | `0` |  |
| `errors` | jsonb |  |  |  |
| `summary` | jsonb |  |  |  |
| `duration_ms` | integer |  |  |  |

### `agent1_discarded_items`

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | `"gen_random_uuid()"` | PK |
| `institution_id` | uuid |  |  | FK → institutions.id |
| `title` | text |  |  |  |
| `url` | text |  |  |  |
| `content_type` | text |  |  |  |
| `discarded_at` | timestamp with time zone |  | `"now()"` |  |

### `agent1_fetch_logs`

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | `"gen_random_uuid()"` | PK |
| `venue_id` | uuid |  |  | FK → venues.id |
| `institution_id` | uuid |  |  | FK → institutions.id |
| `exhibition_id` | uuid |  |  | FK → exhibitions.id |
| `url` | text | NOT NULL |  |  |
| `title` | text |  |  |  |
| `method` | text |  |  |  |
| `html_length` | integer |  |  |  |
| `outcome` | text | NOT NULL |  |  |
| `created_at` | timestamp with time zone | NOT NULL | `"now()"` |  |

### `agent1_missing_show_reports`

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | `"gen_random_uuid()"` | PK |
| `institution_id` | uuid |  |  | FK → institutions.id |
| `exhibition_name` | text |  |  |  |
| `notes` | text |  |  |  |
| `reported_at` | timestamp with time zone |  | `"now()"` |  |
| `resolved` | boolean |  | `false` |  |

### `artists`

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | `"gen_random_uuid()"` | PK |
| `name` | text | NOT NULL |  |  |
| `bio` | text |  |  |  |
| `instagram` | text |  |  |  |
| `created_at` | timestamp with time zone |  | `"now()"` |  |

### `blocks`

> One row per block, stored one direction but ENFORCED both ways: while this row exists the two accounts cannot see each other in search or on profile pages and cannot follow each other. Inserting it severs any existing follow in both directions (trigger blocks_sever_follows). Deleting it restores visibility only — never the follows. Readable only by the blocker.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| `blocker_id` | uuid | NOT NULL |  | PK, FK → profiles.id |
| `blocked_id` | uuid | NOT NULL |  | PK, FK → profiles.id |
| `created_at` | timestamp with time zone | NOT NULL | `"now()"` |  |

### `editor_picks`

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | `"gen_random_uuid()"` | PK |
| `pick_type` | text | NOT NULL |  |  |
| `reference_id` | uuid | NOT NULL |  |  |
| `status` | text |  | `"pending"` |  |
| `approved_at` | timestamp with time zone |  |  |  |
| `created_at` | timestamp with time zone |  | `"now()"` |  |

### `events`

> Append-only activity log behind the feed. One row per thing somebody did. Generic on purpose: type names the kind, payload carries that kind's data, and no column here is specific to any one event type. As of migration_v47 there are NO event types and nothing writes here — see the header.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | `"gen_random_uuid()"` | PK |
| `actor_id` | uuid | NOT NULL |  | FK → profiles.id |
| `type` | text | NOT NULL |  |  |
| `payload` | jsonb | NOT NULL |  |  |
| `created_at` | timestamp with time zone | NOT NULL | `"now()"` |  |

- `type` — Dot-namespaced event kind, e.g. a future log.created. The legal set lives in the app beside the renderers (lib/feed-types.ts), not in a database enum, so adding a kind is not a migration.
- `payload` — Per-type jsonb. Each type owns its own shape; the feed query never looks inside it.

### `exa_search_log`

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | `"gen_random_uuid()"` | PK |
| `exhibition_id` | uuid |  |  | FK → exhibitions.id |
| `function_name` | text | NOT NULL |  |  |
| `query_text` | text | NOT NULL |  |  |
| `result_count` | integer |  |  |  |
| `cost_dollars` | numeric |  |  |  |
| `request_id` | text |  |  |  |
| `error` | text |  |  |  |
| `created_at` | timestamp with time zone |  | `"now()"` |  |

### `exhibition_artists`

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | `"gen_random_uuid()"` | PK |
| `exhibition_id` | uuid | NOT NULL |  | FK → exhibitions.id |
| `artist_id` | uuid | NOT NULL |  | FK → artists.id |

### `exhibition_coverage`

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | `"gen_random_uuid()"` | PK |
| `exhibition_id` | uuid | NOT NULL |  | FK → exhibitions.id |
| `reading_id` | uuid | NOT NULL |  | FK → readings.id |
| `source` | text | NOT NULL |  |  |
| `created_at` | timestamp with time zone | NOT NULL | `"now()"` |  |

### `exhibition_logs`

> One row per person per exhibition. status want_to_see = intend to go; seen = went. rating, liked and comment are valid ONLY at seen and are rejected otherwise by exhibition_logs_seen_gates_opinions. Readable through RLS by its owner alone; other people see it only via profile_exhibition_logs(), which applies profile privacy and comment visibility.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| `user_id` | uuid | NOT NULL |  | PK, FK → profiles.id |
| `exhibition_id` | uuid | NOT NULL |  | PK, FK → exhibitions.id |
| `status` | text | NOT NULL |  |  |
| `rating` | smallint |  |  |  |
| `liked` | boolean | NOT NULL | `false` |  |
| `comment` | text |  |  |  |
| `comment_visibility` | text |  |  |  |
| `created_at` | timestamp with time zone | NOT NULL | `"now()"` |  |
| `updated_at` | timestamp with time zone | NOT NULL | `"now()"` |  |

- `liked` — A like, not a rating — kept separate so "loved it" and "four stars" stay different statements. false is the absence of a like, which is why the gating CHECK reads liked = false rather than IS NULL.
- `comment_visibility` — public | private, NULL when there is no comment. A SECOND, NARROWER gate inside profile privacy — never a wider one. private = the logger only. public = whoever can already see the profile, which on a private account means approved followers, not everyone.

### `exhibitions`

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | `"gen_random_uuid()"` | PK |
| `venue_id` | uuid | NOT NULL |  | FK → venues.id |
| `show_title` | text | NOT NULL |  |  |
| `start_date` | date |  |  |  |
| `end_date` | date |  |  |  |
| `check_back_date` | date |  |  |  |
| `description` | text |  |  |  |
| `press_release` | text |  |  |  |
| `image_url` | text |  |  |  |
| `status` | text |  | `"pending"` |  |
| `missing_fields` | text[] |  |  |  |
| `created_at` | timestamp with time zone |  | `"now()"` |  |
| `updated_at` | timestamp with time zone |  | `"now()"` |  |
| `address_override` | text |  |  |  |
| `address_override_neighborhood` | text |  |  |  |
| `override_latitude` | numeric |  |  |  |
| `override_longitude` | numeric |  |  |  |
| `coverage` | jsonb |  |  |  |
| `preread_type` | text | NOT NULL | `"full"` |  |
| `date_notes` | text |  |  |  |
| `admin_notes` | text |  |  |  |
| `is_ongoing` | boolean |  | `false` |  |
| `detail_url` | text |  |  |  |
| `show_type` | text | NOT NULL | `"exhibition"` |  |
| `coverage_type` | text |  |  |  |
| `show_location` | text |  |  |  |
| `show_location_latitude` | numeric |  |  |  |
| `show_location_longitude` | numeric |  |  |  |
| `show_location_neighborhood` | text |  |  |  |
| `show_location_2` | text |  |  |  |
| `show_location_2_latitude` | numeric |  |  |  |
| `show_location_2_longitude` | numeric |  |  |  |
| `show_location_2_neighborhood` | text |  |  |  |
| `show_location_3` | text |  |  |  |
| `show_location_3_latitude` | numeric |  |  |  |
| `show_location_3_longitude` | numeric |  |  |  |
| `show_location_3_neighborhood` | text |  |  |  |
| `show_location_source` | text |  |  |  |
| `hide_artist_names` | boolean | NOT NULL | `false` |  |
| `preread_status` | text |  |  |  |
| `show_review_pending_until` | date |  |  |  |
| `show_review_attempted_at` | timestamp with time zone |  |  |  |
| `show_review_status` | text |  |  |  |
| `preread_retry_artists` | text[] |  |  |  |

- `show_location` — Where the show is: "<street>, [<floor/suite>, ]<borough>, New York <zip>". Venue address only as fallback — see show_location_source.
- `show_location_source` — show = address found for this show; venue = no address found, venue address used.
- `hide_artist_names` — Do not display this show's artist names publicly. The names are still stored in exhibition_artists and are still read by Agent 2 coverage and preread matching — this hides them on screen only. Set by Agent 1 for a credited group of 6+, and by the admin from Pending review.

### `follows`

> One row per follow, per direction. status pending = requested and not yet answered (private targets only); approved = the follow is live. A denial DELETES the row rather than storing a third state, so the person may ask again later.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| `follower_id` | uuid | NOT NULL |  | PK, FK → profiles.id |
| `followed_id` | uuid | NOT NULL |  | PK, FK → profiles.id |
| `status` | text | NOT NULL | `"pending"` |  |
| `created_at` | timestamp with time zone | NOT NULL | `"now()"` |  |

- `status` — pending | approved. Set by the follows_status_from_privacy trigger from the TARGET profile privacy, never by the client — the INSERT grant does not include this column.

### `institutions`

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | `"gen_random_uuid()"` | PK |
| `name` | text | NOT NULL |  |  |
| `website` | text |  |  |  |
| `type` | text |  |  |  |
| `active` | boolean |  | `true` |  |
| `created_at` | timestamp with time zone |  | `"now()"` |  |
| `exhibitors` | jsonb |  |  |  |
| `fair_location` | text |  |  |  |
| `status` | text | NOT NULL | `"active"` |  |
| `status_note` | text |  |  |  |
| `is_multi_city` | boolean | NOT NULL | `false` |  |

- `type` — gallery | museum | fair | nonprofit | experimental. nonprofit and experimental group under the "Other Spaces" tab on the public site, and are treated like galleries by Agent 1 (full prereads, not museum coverage_only).
- `exhibitors` — Fairs only. jsonb array of exhibiting gallery names as printed on the fair's exhibitor page. Plain strings, intentionally not FKs to institutions.
- `fair_location` — Fairs only. Free text — fairs run at piers, armories and temporary structures that do not fit the venues address shape.
- `status` — Editorial state. Non-active should also set active=false; active remains the field queries filter on.
- `is_multi_city` — True when the institution operates physical exhibition space outside NYC. Gates the Tier 1 location_hint retry ladder.

### `mutes`

> One row per mute, one direction. Hides the muted account's events from the muter's feed and does NOTHING else — no access change, no effect on follows, and no way for the muted person to observe it. Readable only by the muter.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| `muter_id` | uuid | NOT NULL |  | PK, FK → profiles.id |
| `muted_id` | uuid | NOT NULL |  | PK, FK → profiles.id |
| `created_at` | timestamp with time zone | NOT NULL | `"now()"` |  |

### `preread_deletions`

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | `"gen_random_uuid()"` | PK |
| `preread_id` | uuid | NOT NULL |  |  |
| `exhibition_id` | uuid |  |  |  |
| `article_url` | text |  |  |  |
| `article_title` | text |  |  |  |
| `publication` | text |  |  |  |
| `row_data` | jsonb | NOT NULL |  |  |
| `deleted_at` | timestamp with time zone | NOT NULL | `"now()"` |  |
| `db_role` | text |  |  |  |

### `prereads`

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | `"gen_random_uuid()"` | PK |
| `exhibition_id` | uuid | NOT NULL |  | FK → exhibitions.id |
| `article_title` | text |  |  |  |
| `publication` | text |  |  |  |
| `article_url` | text |  |  |  |
| `thumbnail_url` | text |  |  |  |
| `summary` | text |  |  |  |
| `created_at` | timestamp with time zone |  | `"now()"` |  |
| `artist_name` | text |  |  |  |
| `item_coverage_type` | text |  |  |  |
| `author` | text |  |  |  |
| `published_date` | timestamp with time zone |  |  |  |
| `quality_flag` | text |  |  |  |
| `row_status` | text | NOT NULL | `"active"` |  |
| `repair_hold` | boolean | NOT NULL | `false` |  |
| `superseded_by` | uuid |  |  | FK → prereads.id |

- `superseded_by` — Set when this row was frozen because someone had logged it: points at the row that replaced it. Frozen rows are blanked, never repaired again, and excluded from the exhibition's status.

### `profiles`

> One row per personal account, created automatically by handle_new_user() on auth.users insert. Gallery/org accounts will be a separate table, not a flag here.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| `id` | uuid | NOT NULL |  | PK |
| `username` | text |  |  |  |
| `display_name` | text |  |  |  |
| `avatar_url` | text |  |  |  |
| `bio` | text |  |  |  |
| `privacy` | text | NOT NULL | `"public"` |  |
| `created_at` | timestamp with time zone | NOT NULL | `"now()"` |  |
| `updated_at` | timestamp with time zone | NOT NULL | `"now()"` |  |

- `username` — Lower-case handle, unique. NULL means onboarding is not finished yet.
- `privacy` — public | private. Private gates what the profile page SHOWS, not whether the profile can be found: see public.profile_cards. When follows ship, an approved follower sees a private profile in full.

### `publications`

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | `"gen_random_uuid()"` | PK |
| `name` | text | NOT NULL |  |  |
| `domain` | text | NOT NULL |  |  |
| `status` | text |  | `"pending"` |  |
| `created_at` | timestamp with time zone |  | `"now()"` |  |
| `rss_url` | text |  |  |  |
| `tier` | text |  |  |  |
| `scrape_frequency` | text | NOT NULL | `"daily"` |  |
| `active` | boolean | NOT NULL | `true` |  |

### `reading_logs`

> One row per person per item read, across two tables: content_type preread = prereads.id, reading = readings.id (Top Stories and River). status reading_list = mean to read; read = read it. rating, liked and comment are valid ONLY at read and are rejected otherwise by reading_logs_read_gates_opinions. Readable through RLS by its owner alone; other people see it only via profile_reading_logs(), which applies profile privacy and comment visibility.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| `user_id` | uuid | NOT NULL |  | PK, FK → profiles.id |
| `content_type` | text | NOT NULL |  | PK |
| `content_id` | uuid | NOT NULL |  | PK |
| `status` | text | NOT NULL |  |  |
| `rating` | smallint |  |  |  |
| `liked` | boolean | NOT NULL | `false` |  |
| `comment` | text |  |  |  |
| `comment_visibility` | text |  |  |  |
| `created_at` | timestamp with time zone | NOT NULL | `"now()"` |  |
| `updated_at` | timestamp with time zone | NOT NULL | `"now()"` |  |

- `content_id` — The prereads.id or readings.id this log is about. NO foreign key is possible on a polymorphic column — reading_logs_loggable() checks it on write and profile_reading_logs() JOINs on read. Both underlying tables have a never-delete rule, which is what keeps this honest.
- `comment_visibility` — public | private, NULL when there is no comment. A SECOND, NARROWER gate inside profile privacy — never a wider one. private = the logger only. public = whoever can already see the profile, which on a private account means approved followers, not everyone.

### `readings`

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | `"gen_random_uuid()"` | PK |
| `publication_id` | uuid |  |  | FK → publications.id |
| `author` | text |  |  |  |
| `headline` | text | NOT NULL |  |  |
| `article_url` | text | NOT NULL |  |  |
| `rss_summary` | text |  |  |  |
| `top_story` | boolean |  | `false` |  |
| `published_at` | timestamp with time zone |  |  |  |
| `created_at` | timestamp with time zone |  | `"now()"` |  |
| `thumbnail_url` | text |  |  |  |
| `category` | text |  |  |  |
| `art_relevance_score` | numeric |  |  |  |
| `nyc_relevance_score` | numeric |  |  |  |
| `top_story_candidate` | boolean | NOT NULL | `false` |  |
| `tier` | text |  |  |  |
| `top_story_checked` | boolean | NOT NULL | `false` |  |
| `river_group` | text |  |  |  |
| `major_artist` | boolean |  | `false` |  |
| `significant_announcement` | boolean |  | `false` |  |

### `readings_tags`

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | `"gen_random_uuid()"` | PK |
| `reading_id` | uuid | NOT NULL |  | FK → readings.id |
| `entity_type` | text |  |  |  |
| `entity_id` | uuid | NOT NULL |  |  |
| `created_at` | timestamp with time zone |  | `"now()"` |  |
| `exhibition_id` | uuid |  |  | FK → exhibitions.id |

### `reserved_usernames`

> Usernames nobody may claim: app routes and impersonation risks. Enforced by the profiles_username_not_reserved trigger. Add a row here whenever a new top-level route is added.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| `username` | text | NOT NULL |  | PK |

### `seed_books`

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | `"gen_random_uuid()"` | PK |
| `title` | text | NOT NULL |  |  |
| `author` | text |  |  |  |
| `source` | text |  |  |  |
| `goodreads_rating` | numeric |  |  |  |
| `picked` | boolean |  | `false` |  |
| `created_at` | timestamp with time zone |  | `"now()"` |  |
| `image_url` | text |  |  |  |

### `seed_exclusions`

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | `"gen_random_uuid()"` | PK |
| `dedup_key` | text | NOT NULL |  |  |
| `name` | text | NOT NULL |  |  |
| `reason` | text |  |  |  |
| `created_at` | timestamp with time zone |  | `"now()"` |  |

### `venue_artist_warnings`

> A venue + warning_type pair the admin has said not to prompt about again. Currently one type: non_inferred_group_6_plus — a credited group show of 6 or more artists, whose names publish with hide_artist_names set. Keyed to the venue and the type, deliberately not to the artist count.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | `"gen_random_uuid()"` | PK |
| `venue_id` | uuid | NOT NULL |  | FK → venues.id |
| `warning_type` | text | NOT NULL |  |  |
| `exhibition_id` | uuid |  |  |  |
| `muted_at` | timestamp with time zone | NOT NULL | `"now()"` |  |

### `venue_scrape_attempts`

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | `"gen_random_uuid()"` | PK |
| `venue_id` | uuid | NOT NULL |  | FK → venues.id |
| `agent_run_id` | uuid |  |  | FK → agent_runs.id |
| `trigger` | text | NOT NULL |  |  |
| `started_at` | timestamp with time zone | NOT NULL | `"now()"` |  |
| `completed_at` | timestamp with time zone |  |  |  |
| `duration_ms` | integer |  |  |  |
| `outcome` | text | NOT NULL | `"running"` |  |
| `failure_reason` | text |  |  |  |
| `exhibitions_upserted` | integer |  |  |  |

### `venues`

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | `"gen_random_uuid()"` | PK |
| `name` | text | NOT NULL |  |  |
| `exhibitions_url` | text | NOT NULL |  |  |
| `address` | text |  |  |  |
| `neighborhood` | text |  |  |  |
| `latitude` | numeric |  |  |  |
| `longitude` | numeric |  |  |  |
| `active` | boolean |  | `true` |  |
| `created_at` | timestamp with time zone |  | `"now()"` |  |
| `institution_id` | uuid |  |  | FK → institutions.id |
| `hours` | jsonb |  |  |  |
| `check_back_date` | date |  |  |  |
| `scrape_failed` | boolean | NOT NULL | `false` |  |
| `manual_entry_required` | boolean | NOT NULL | `false` |  |
| `scrape_failure_reason` | text |  |  |  |
| `scrape_notes` | text |  |  |  |
| `scrapable` | boolean | NOT NULL | `true` |  |
| `location_window_size` | integer |  |  |  |
| `scrape_day_of_week` | smallint |  |  |  |
| `scrape_status` | text | NOT NULL | `"not_started"` |  |
| `scrape_status_changed_at` | timestamp with time zone |  |  |  |
| `scrape_failures` | smallint | NOT NULL | `0` |  |
| `scrape_status_version` | integer | NOT NULL | `0` |  |

- `scrape_notes` — Free-text hint passed to Agent 1's link-extraction prompt as context.
- `scrapable` — Human decision: do not attempt automated scraping. Distinct from manual_entry_required, which the scraper sets and clears.
- `location_window_size` — Anchor-context window (chars) that last produced location_hint values for this venue. NULL = use default.
- `scrape_day_of_week` — Permanent weekly scrape slot, 0=Sunday..6=Saturday in America/New_York. Never re-randomized.
- `scrape_status` — Agent 1 queue state. completed blocks only the NY day of scrape_status_changed_at.
- `scrape_status_version` — Compare-and-swap token; every scrape state write is conditional on it.

---

## Callable functions (13)

Names only. What each one does, who may execute it, and whether it is
SECURITY DEFINER are all in the migration that created it.

- `blocked_profiles()`
- `can_view_profile()`
- `feed_events()`
- `follow_counts()`
- `is_approved_follower()`
- `muted_profiles()`
- `pending_follow_requests()`
- `profile_card()`
- `profile_exhibition_logs()`
- `profile_followers()`
- `profile_following()`
- `profile_reading_logs()`
- `search_profile_cards()`
