# Idea 2 — NYC Art Exhibition Aggregator

A free web app that aggregates NYC exhibitions from galleries and museums, pairs each show with editorial prereads from top art publications, and surfaces a curated readings feed and weekly Editor's Picks.

Built with Next.js + TypeScript + Tailwind CSS + Supabase.

## Getting Started

```bash
npm run dev      # start dev server at localhost:3000
npm run build    # production build
npm run lint     # lint with eslint
```

## Environment Variables

Copy `.env.local.example` to `.env.local` and fill in each value.

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key — used by all four agents for extraction, prereads, readings curation, and editor picks |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key — server-side only, never exposed to the client |
| `BROWSERBASE_API_KEY` | Browserbase API key — Agent 1 (Exhibition Scraper) uses this to render gallery pages in the cloud. Get it at [browserbase.com/settings](https://www.browserbase.com/settings) |
| `BROWSERBASE_PROJECT_ID` | Browserbase project ID — paired with the API key above |
| `NEXT_PUBLIC_MAPBOX_TOKEN` | Mapbox public token — used for satellite maps on the Institution Page and Exhibition Page |
| `CRON_SECRET` | Shared secret that guards `/api/cron/*` routes — set the same value in Vercel Environment Variables so Vercel's cron runner can authenticate |
| `ADMIN_PASSWORD` | Password for the `/admin` route |

## Agents

- **Agent 1 — Exhibition Scraper** (`POST /api/scrape`): Renders gallery pages via Browserbase, extracts exhibitions with Claude, writes to Supabase. Runs on `check_back_date` schedule (daily check) plus a weekly force scrape of all venues.
- **Agent 2 — Prereads Generator**: Fires on exhibition publish, generates 2–4 editorial prereads per show via Claude web search.
- **Agent 3 — Readings Curator** (`POST /api/curate`): Daily job — RSS feeds → keyword filter → Claude relevance check → writes to `readings` table, prunes to 7 days.
- **Agent 4 — Editor's Picks**: Every Saturday surfaces 5 exhibition and 5 article suggestions; Franklin approves, goes live Monday.
