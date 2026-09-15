# Anatomy of Agent 1 (exhibition scraper)

A text version of the "Anatomy of Agent 1" diagram artifact, written for Claude to read as context.

- **Original:** traced from `lib/scraper.ts`, `lib/claude.ts`, `app/api/cron/scrape` and `vercel.json` on **2026-08-18**, at commit `02373f2` plus that session's location re-check. The counts in it are live production figures from that date.
- **Updated:** 2026-09-14, after the weekly-queue rebuild (commits `21939c7`, `a417490`). Anything the rebuild replaced is marked **[SUPERSEDED]**, with the current behavior right after it. Unmarked sections still match the code as of 2026-09-14.
- **Rule:** the code is the source of truth. Check it before relying on any detail here.

---

## Current state (2026-09-14): read this first

- **Trigger:** `GET /api/cron/scrape`, every 15 minutes at :05/:20/:35/:50 (`5-59/15`). **The cron is PAUSED** (`vercel.json` has `crons: []`, commit `a417490`). Don't re-enable it without the owner's go-ahead.
- **Which venues are due:** every venue has a permanent `scrape_day_of_week` (0 = Sunday … 6 = Saturday, New York time). A tick scrapes venues whose day is today and whose `check_back_date` ≤ today, plus venues retrying after a failure. It only considers `active = true`, `scrapable = true` and `manual_entry_required = false`.
- **Per-venue status:** `venues.scrape_status` is one of `not_started`, `in_progress`, `completed`, `error1`, `error2`, `error3`. Every write is a compare-and-swap on `scrape_status_version`, and that doubles as the Run Lock: a venue can never be scraped twice at once.
  - `completed` blocks the venue only until midnight New York time.
  - `error1`/`error2` retry 6 hours later, on any day.
  - `error3` sets `manual_entry_required` and stops automatic retries. The ways out are the admin "Clear Issue" button or a successful manual scrape.
  - An `in_progress` claim older than 860 seconds is treated as a killed run and counted as a failure.
- **Time budget:** each venue attempt is recorded in `venue_scrape_attempts`, with `duration_ms`. A venue starts only if the average of its last 5 completed durations × 1.25 fits in the 740 seconds left of the invocation. With no history, the estimate is 600 seconds. The first venue of every invocation always starts.
- **`check_back_date`:** after a scrape it's set to the venue's next scheduled day, not today + 7.
- **Manual trigger:** `POST /api/admin/venues/[id]/scrape` (the "Retry Scrape" button on the Scrape Issues and Pending tabs). It ignores the day, date and status gates but respects the Run Lock. `POST /api/scrape` and `.../retry-scrape` return 410, and the Dashboard's Agent 1 "Run Now" button has been removed.
- **Preread repair** no longer runs inside the scrape path.
- **Code:** rules in `lib/venue-scrape-schedule.ts`, database state in `lib/venue-scrape-queue.ts`, the queue run in `runAgent1()` / `runVenueScrapeAttempt()` in `lib/scraper.ts`.

---

## 1. What starts a run, and which venues it takes

**Original design (2026-08-18) [SUPERSEDED]:**
- **Triggers (3):**
  - A cron "drain" every 15 minutes.
  - A cron "force" run on Mondays at 08:00, which re-queued every venue.
  - The admin "Run Now" button (`POST /api/scrape`).
- **Run lock:** the triggers shared a run-level lock in `agent_runs`, so only one run happened at a time. A run killed by the platform left a stale lock, which was ignored after the function's ceiling plus 1 minute.
- **Queue filter:** `active = true`, `scrapable = true`, `manual_entry_required = false`, `check_back_date ≤ today`, oldest first.
- **Loop:** scrape one venue, then the next, until the queue was empty or 500 seconds had passed. Unfinished venues kept their old `check_back_date` and were picked up first next slice.
- **Afterwards:** preread repair ran, but only once the queue was empty.

**Still true:** the queue filter is how a venue can disappear from Agent 1 entirely. Setting `manual_entry_required` or `scrapable = false` removes it from selection, and nothing automatic puts it back.

**Now:** see "Current state" above. The Monday force run was removed on 2026-09-01. Run Now and preread repair were removed on 2026-09-14. The flat 500-second budget is now the per-venue time estimate. The run-level lock still exists as an extra guard, but the per-venue claim is what prevents double scrapes.

---

## 2. Getting the show links off the listing page

There are two jobs: fetch the page, then find the links. Each has its own ladder of fallbacks.

### Fetch the page
1. **Browserbase (a real browser):** waits for the network to go quiet and clicks "load more" up to 3 times.
2. **Plain HTTP:** used only if step 1 fails.
3. **One more full attempt with a 60-second timeout**, if the result is empty or under 10 KB.
4. **Bot-wall and size checks:** a fixed list of challenge phrases, or HTML under 10 KB. A match marks the venue `bot_protected` or `fetch_failed` and ends the venue.

### Find the links
1. **Tier 1:** Claude reads the page. The venue's `scrape_notes` are passed in here.
2. **Tier 2**, if Tier 1 finds nothing: scan for exhibition-shaped links (up to 60) and sort them with a cheap model.
3. **Tier 3**, if still nothing: scan every link on the page (up to 80). This covers Wix and Squarespace sites.
4. **Nothing after all three:** `zero_links_after_retry`.

### Why the failure labels mislead
- The bot-wall check only knows its fixed phrase list. A challenge page it doesn't recognize passes, yields no links, and gets recorded as "zero links" instead of "blocked". On 2026-08-18 this mislabelled the Met, Brooklyn Museum and Hauser & Wirth.
- The 10 KB size check doesn't catch those pages either: their challenge page is about 31 KB.
- The listing fetch tries a real browser first and plain HTTP second. Detail pages (section 4) do the opposite, trying HTTP first to save browser sessions.

**[SUPERSEDED] Flagging:** originally, both failure exits also set `manual_entry_required` straight away, which removed the venue from the queue after a single failure.
**Now:** a failure only sets `scrape_failed` and `scrape_failure_reason`, and moves the venue through `error1` → `error2` → `error3`. `manual_entry_required` is set only at `error3`.

---

## 3. Filtering the links, and the two silent exits

A found link must pass these filters, in order, before any show page is downloaded:

1. **Deduplicate by URL.**
2. **Current or upcoming only:** past and permanent links are dropped. **This can empty the list.**
3. **Exhibitions only:** events and online-only items are dropped (logged to `agent1_discarded_items`). **This can empty the list.**
4. **Location filter:** looks only at the link's title and URL, and assumes NYC when neither names a city. A second check happens later, once the page is downloaded (section 4).
5. **Drop self-links and cap at 15.** Then all of this venue's `pending` exhibition rows are wiped, before re-scraping.

### The silent exit (still present as of 2026-09-14)
If filter 2 or 3, or the location/self-link filtering, leaves the list empty, the venue is treated as **healthy**. Its failure flags are cleared, its `check_back_date` moves forward, and nothing appears in Scrape Issues. It's retried next cycle, fails the same way, and clears its flags again. In the data this looks identical to a venue that genuinely has no shows on.

- **On 2026-08-18, 25 venues were stuck in this loop.** They included Chapter NY, Casey Kaplan, Bureau, Friedman Benda, 15 Orient, Aicon Art and 19 more, and they all shared the same next-check date. Scrape Issues counts venues that *errored*, not venues that *produced nothing*, so these were invisible in the admin.
- **Now:** these paths return `failureReason: null`, so the new queue records them as `completed`. They still don't count toward `error1`–`error3`. The flaw is unchanged; only the record-keeping moved.

---

## 4. The checks each show goes through

Up to 15 shows per venue reach this stage. Each is downloaded, then checked in this order:

| # | Check | If it fails |
|---|---|---|
| 1 | Is this a section page, judging by the URL? (e.g. `…/exhibitions/past`) | discarded |
| 2 | Download the page: plain HTTP first, then a real browser up to 3 times | `fetch_failed` |
| 3 | Is this a section page, judging by the content? (looks like a listing, not one show) | discarded |
| 4 | Claude extracts the details: title, artists, dates, image, press release | if dates and description come back empty, one retry in a real browser |
| 5 | Was a title extracted at all? | `extraction_failed` |
| 6 | Does that title really appear on the page? (text match, then a model double-check) | treated as invented, discarded |
| 7 | The link was "unclear" and there are no artists and no dates? | discarded |
| 8 | Does the press release really appear on the page? | field emptied, show kept |
| 9 | Are the dates current? (anything starting within 90 days counts as current) | already closed: discarded. Far future: flagged `upcoming` |
| 10 | Is it actually in New York? (reads the downloaded page) | wrong city: discarded. Can't tell, and the gallery has spaces elsewhere: flagged `location_unverified` |
| 11 | Is the image real? (logos, placeholders, icons rejected) | field emptied, show kept |
| 12 | Is anything still missing? | goes to `pending` for review |
| — | Nothing missing | **published automatically**, then artists are linked and prereads (galleries) or coverage (museums/fairs) are generated |

### Publish rule (`lib/scraper.ts`)
- `missing_fields` can contain `location_unverified`, `upcoming`, `start_date`, `end_date` (skipped for ongoing installations), `press_release`, `image_url`.
- The show gets `status = 'published'` only if it isn't upcoming and `missing_fields` is empty. Otherwise it's `'pending'`.
- `show_coverage` is added *after* the status is decided, so it never blocks publishing.

### Writing is protective
- **Duplicates:** a show is matched to an existing record by `(venue_id, detail_url)` first, then by title, so a re-scrape updates the record instead of creating a second one.
- **Published shows:** once a show is published, a re-scrape doesn't overwrite it. The one exception is `end_date`, which also clears `is_ongoing`.

Only a show that passes every check with nothing missing is published without human review. Everything else is either dropped or waits in the Pending tab.

---

## 5. How a venue ends up, and what the admin sees

| How the venue finished | Venue record afterwards | Visible in admin? | Count on 2026-08-18 |
|---|---|---|---|
| Fetch or link extraction failed | failure flags set, `check_back_date` unchanged | **Yes**, in Scrape Issues | 20 |
| Page loaded, but no links survived filtering | flags cleared, next check moved forward | **No**, looks healthy | 25 |
| Shows written | flags cleared, next check moved forward | Yes, as published/pending shows | 37 venues produced published shows |

The second and third rows leave identical traces on the venue record. The failing venues can only be told apart from healthy ones by counting what they actually produced.

**Now:** row 1 goes `error1` → `error2` → `error3`, and only `error3` venues stop retrying. Venues at `error1` and `error2` appear in Scrape Issues with a "retrying" note. Rows 2 and 3 both end as `completed`.

**One-line summary:** Agent 1 is careful about what it lets through and careless about what it drops. Its checks protect the published set, but a venue that yields nothing looks the same as a venue with nothing on.

---

## 6. Where the money and time go

| Step | Cost | Notes |
|---|---|---|
| Listing fetch | Browser session | Always tries a real browser first, even for simple sites. The most expensive single step. |
| Link extraction | Claude | Up to two more model calls if Tier 1 finds nothing. |
| Link location filter | Haiku | One batched call per venue. |
| Detail fetch ×15 | HTTP first | Falls back to a browser only when plain HTTP returns too little. |
| Detail extraction ×15 | Claude | The bulk of the cost per show. |
| Show location re-check ×15 | Haiku | Free when the page title names a city (no call at all). |
| Prereads / coverage | Exa + Claude | Only for shows that have none yet, so re-scrapes are cheap. |

- **Cost controls:** the 15-show cap per venue is still in place. [SUPERSEDED] The 500-second run budget has been replaced by the per-venue time estimate.
- **Timings:** the original assumption of 85–260 seconds per venue was disproven. On 2026-09-01, single venues took up to about 581 seconds. On 2026-09-14, venues in production took 49–642 seconds.
