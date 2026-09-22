'use client'

import { useState, useEffect, createContext, useContext } from 'react'
import Link from 'next/link'
import type { Reading, TopStory, TopStoryOutlet } from '@/lib/types'
import AccountNav from '@/components/account/AccountNav'
import ReadingLog from '@/components/ReadingLog'
import { useReadingLogs, logFor, type ReadingLogStore } from '@/lib/reading-log-client'
import { readingKey } from '@/lib/reading-log-types'
import '@/app/reading-log.css'
import '@/app/top-stories.css'

/**
 * The visitor's own reading log, shared down the page.
 *
 * Context rather than props because the pill appears in several places — each
 * Top Story's lead, every outlet on its "More:" line, and every river row —
 * and threading a store through each of them would add a parameter to
 * components that only lay out articles. Nothing here is secret: the store holds the signed-in
 * person's own rows, read under the first-person policies in migration_v63.
 *
 * The default is an empty, signed-out store so a card rendered outside the
 * provider degrades to no pill rather than throwing.
 */
const LogStore = createContext<ReadingLogStore>({
  viewerId: null,
  logs: new Map(),
  topFour: new Set(),
  ready: false,
  refresh: () => {},
})

/** The pill for one article, wherever it is shown. Nothing when signed out. */
function ArticleLog({ reading, className }: {
  reading: Pick<Reading, 'id' | 'headline'>
  className?: string
}) {
  const store = useContext(LogStore)
  // `ready` keeps a signed-in person from seeing "Log" flash before their own
  // state arrives — the wrong answer, briefly, on every card at once.
  if (!store.ready || !store.viewerId) return null

  return (
    <div className={className}>
      <ReadingLog
        contentType="reading"
        contentId={reading.id}
        title={reading.headline}
        viewerId={store.viewerId}
        log={logFor(store, 'reading', reading.id)}
        variant="compact"
        signInNext="/readings"
        // No server render to refresh on this page: re-read the store instead.
        // The same refresh serves the Top Four control, which is why it does
        // not take an onChanged of its own — one re-read answers both.
        onSaved={store.refresh}
        inTopFour={store.topFour.has(readingKey('reading', reading.id))}
      />
    </div>
  )
}

type Tab = 'top-stories' | 'river'
type RiverGroupFilter = 'all' | 'news' | 'art_market' | 'people' | 'opinion'

// ── Helpers ──────────────────────────────────────────────────

function localDateKey(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA')
}

function formatTime(iso: string | null): string {
  if (!iso) return ''
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(iso)).toLowerCase()
}

function formatDateHeader(dateKey: string): string {
  const today = new Date().toLocaleDateString('en-CA')
  const yest = new Date(Date.now() - 86400000).toLocaleDateString('en-CA')
  if (dateKey === today) return 'Today'
  if (dateKey === yest) return 'Yesterday'
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  }).format(new Date(dateKey + 'T12:00:00'))
}

// Show roundups are admitted to the Opinion group but sink below show
// reviews and opinion pieces of similar recency (Part 5).
function sortForRiverGroup(items: Reading[], group: RiverGroupFilter): Reading[] {
  if (group !== 'opinion') return items
  const roundups = items.filter(r => r.category === 'show_roundup')
  const rest = items.filter(r => r.category !== 'show_roundup')
  return [...rest, ...roundups]
}

// ── Top stories view ──────────────────────────────────────────
// Techmeme-style: the lead article — outlet, headline, image — then a "More:"
// line with one link per other outlet on the same story. No summary.
// Stories arrive from /api/top-stories already filtered to the last seven
// days and in page order (lib/story-groups.ts buildTopStories).

function MoreOutlet({ outlet }: { outlet: TopStoryOutlet }) {
  return (
    <span className="ts-more-item">
      <a href={outlet.article_url} target="_blank" rel="noopener noreferrer"
        className="ts-more-link" title={outlet.headline}>
        {outlet.publication_name ?? 'Unknown outlet'}
      </a>
      <ArticleLog reading={{ id: outlet.reading_id, headline: outlet.headline }} className="ts-more-log" />
    </span>
  )
}

function TopStoryItem({ story }: { story: TopStory }) {
  const { lead } = story
  const source = [lead.author, lead.publication_name].filter(Boolean).join(' / ')
  return (
    <article className="ts-story">
      {lead.thumbnail_url && (
        <a href={lead.article_url} target="_blank" rel="noopener noreferrer" className="ts-image-link">
          <img src={lead.thumbnail_url} alt="" className="ts-image" loading="lazy" />
        </a>
      )}
      <div className="ts-body">
        {source && <p className="ts-source">{source}</p>}
        <div className="ts-headline-row">
          <a href={lead.article_url} target="_blank" rel="noopener noreferrer"
            className="ts-headline">{lead.headline}</a>
          <ArticleLog reading={{ id: lead.reading_id, headline: lead.headline }} className="ts-lead-log" />
        </div>
        {story.more.length > 0 && (
          <p className="ts-more">
            <span className="ts-more-label">More:</span>
            {story.more.map(o => <MoreOutlet key={o.reading_id} outlet={o} />)}
          </p>
        )}
      </div>
    </article>
  )
}

function TopStoriesView({ stories }: { stories: TopStory[] }) {
  if (stories.length === 0) {
    return <p className="rd-empty">No top stories this week.</p>
  }
  return (
    <div className="ts-list">
      {stories.map(s => <TopStoryItem key={s.id} story={s} />)}
    </div>
  )
}

// ── River view ────────────────────────────────────────────────

function RiverView({
  readings,
  group,
  onGroupChange,
  loading,
}: {
  readings: Reading[]
  group: RiverGroupFilter
  onGroupChange: (g: RiverGroupFilter) => void
  loading: boolean
}) {
  const GROUPS: { value: RiverGroupFilter; label: string }[] = [
    { value: 'all',        label: 'All'        },
    { value: 'news',       label: 'News'       },
    { value: 'art_market', label: 'Art Market' },
    { value: 'people',     label: 'People'     },
    { value: 'opinion',    label: 'Opinion'    },
  ]

  const groups = readings.reduce<Record<string, Reading[]>>((acc, r) => {
    const key = r.published_at ? localDateKey(r.published_at) : localDateKey(r.created_at)
    if (!acc[key]) acc[key] = []
    acc[key].push(r)
    return acc
  }, {})

  const sortedDates = Object.keys(groups).sort((a, b) => b.localeCompare(a))

  return (
    <div className="rd-river-wrapper">
      <div className="rd-river-filter">
        {GROUPS.map(({ value, label }) => (
          <button
            key={value}
            className={`rd-tab${group === value ? ' rd-tab--active' : ''}`}
            onClick={() => onGroupChange(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="rd-skeleton-grid" />
      ) : readings.length === 0 ? (
        <p className="rd-empty">No articles in this category yet.</p>
      ) : (
        <div className="rd-river">
          {sortedDates.map(date => (
            <div key={date} className="rd-river-group">
              <p className="rd-river-date">{formatDateHeader(date)}</p>
              {sortForRiverGroup(groups[date], group).map(r => {
                const source = [r.author, r.publication_name].filter(Boolean).join(' / ')
                const entry = source ? `${source} - ${r.headline}` : r.headline
                return (
                  <div key={r.id} className="rd-river-row">
                    <span className="rd-river-time">{formatTime(r.published_at)}</span>
                    <a href={r.article_url} target="_blank" rel="noopener noreferrer"
                      className="rd-river-entry">{entry}</a>
                    <ArticleLog reading={r} />
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────

export default function ReadingsPage() {
  const logStore = useReadingLogs()
  const [tab, setTab] = useState<Tab>('top-stories')
  const [topStories, setTopStories] = useState<TopStory[]>([])
  const [riverReadings, setRiverReadings] = useState<Reading[]>([])
  const [riverGroup, setRiverGroup] = useState<RiverGroupFilter>('all')
  const [loadingTop, setLoadingTop] = useState(true)
  const [loadingRiver, setLoadingRiver] = useState(false)

  useEffect(() => {
    fetch('/api/top-stories')
      .then(r => { if (!r.ok) throw new Error(); return r.json() })
      .then(data => { setTopStories(Array.isArray(data) ? data : []); setLoadingTop(false) })
      .catch(() => setLoadingTop(false))
  }, [])

  useEffect(() => {
    if (tab !== 'river') return
    setLoadingRiver(true)
    const url = riverGroup === 'all'
      ? '/api/river'
      : `/api/river?group=${riverGroup}`
    fetch(url)
      .then(r => { if (!r.ok) throw new Error(); return r.json() })
      .then(data => { setRiverReadings(Array.isArray(data) ? data : []); setLoadingRiver(false) })
      .catch(() => setLoadingRiver(false))
  }, [tab, riverGroup])

  return (
    <LogStore.Provider value={logStore}>
    <div className="rd-page">
      <nav className="ei-nav">
        <div className="ep-nav-inner">
          <Link href="/" className="ep-wordmark">Idea 2</Link>
          <div className="ep-nav-links">
            <Link href="/exhibitions">Exhibitions</Link>
            <Link href="/readings">Readings</Link>
            <Link href="/editors-picks">Editor&rsquo;s Picks</Link>
          </div>
          <Link href="/search" className="ep-nav-search">Search</Link>
          <AccountNav />
        </div>
      </nav>

      <main className="rd-main">
        <div className="rd-tabs">
          <button
            className={`rd-tab${tab === 'top-stories' ? ' rd-tab--active' : ''}`}
            onClick={() => setTab('top-stories')}
          >
            Top Stories
          </button>
          <button
            className={`rd-tab${tab === 'river' ? ' rd-tab--active' : ''}`}
            onClick={() => setTab('river')}
          >
            River
          </button>
        </div>

        {tab === 'top-stories' ? (
          loadingTop ? (
            <div className="rd-skeleton-grid" />
          ) : (
            <TopStoriesView stories={topStories} />
          )
        ) : (
          <RiverView
            readings={riverReadings}
            group={riverGroup}
            onGroupChange={setRiverGroup}
            loading={loadingRiver}
          />
        )}
      </main>
    </div>
    </LogStore.Provider>
  )
}
