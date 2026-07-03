'use client'

import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import type { Reading } from '@/lib/types'

type Tab = 'top-stories' | 'river'
type RiverGroupFilter = 'all' | 'news' | 'art_market' | 'people' | 'opinion'

const LAYOUT_CYCLE = ['a', 'b', 'c', 'a', 'b', 'c'] as const
type Layout = typeof LAYOUT_CYCLE[number]

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

function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(true)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 900px)')
    setIsDesktop(mq.matches)
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
  return isDesktop
}

// ── Top stories scoring ──────────────────────────────────────
// significance_score mirrors the server's deterministic top_story_candidate
// rules: institutional_news/interview lean on their persisted significance
// flags, and show_review falls back to top_story_candidate to also catch
// the "mentions a major museum" path that isn't stored as its own column.

function significanceScore(r: Reading): number {
  switch (r.category) {
    case 'breaking_news':       return 1.0
    case 'art_market':          return 0.9
    case 'institutional_news':  return r.significant_announcement ? 0.85 : 0.4
    case 'show_review':         return (r.major_artist || r.top_story_candidate) ? 0.8 : 0.5
    case 'interview':           return r.major_artist ? 0.75 : 0.5
    case 'opinion':             return 0.5
    case 'show_roundup':        return 0.0
    default:                    return 0.5
  }
}

function recencyDecay(r: Reading): number {
  const ageHours = r.published_at
    ? (Date.now() - new Date(r.published_at).getTime()) / 3600000
    : 72
  return ageHours <= 6 ? 1 : Math.max(0, 1 - (ageHours - 6) / 66)
}

function scoreReading(r: Reading): number {
  return (
    (r.art_relevance_score ?? 0.5) * 0.35 +
    significanceScore(r) * 0.40 +
    recencyDecay(r) * 0.25
  )
}

// nyc_relevance_score is a tiebreaker only — never part of the main formula.
function compareReadingScores(a: { r: Reading; score: number }, b: { r: Reading; score: number }): number {
  const diff = b.score - a.score
  if (Math.abs(diff) > 0.05) return diff
  return (b.r.nyc_relevance_score ?? 0) - (a.r.nyc_relevance_score ?? 0)
}

// Same-story dedup for Top Stories. There's no backend concept of "these
// articles corroborate the same story" (Exa's cross-source check only
// records a boolean, not which rows matched) — so this compares headline
// text directly: 2+ shared distinctive words after normalization counts as
// the same underlying story, most-common-word noise (museum, gallery, new
// york...) excluded so two unrelated stories don't collide on generic terms.
const HEADLINE_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'has', 'have', 'had',
  'was', 'were', 'are', 'into', 'over', 'their', 'which', 'your', 'after',
  'new', 'york', 'city', 'art', 'arts', 'museum', 'museums', 'gallery', 'galleries',
  'artist', 'artists', 'exhibition', 'exhibitions', 'show', 'shows',
])

function stem(word: string): string {
  return word.replace(/(ing|ies|es|ed|s)$/i, '')
}

function significantTokens(headline: string): Set<string> {
  const words = headline
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip diacritics: Laocoön -> laocoon
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !HEADLINE_STOPWORDS.has(w))
  return new Set(words.map(stem))
}

function sharedTokenCount(a: Set<string>, b: Set<string>): number {
  let count = 0
  for (const t of a) if (b.has(t)) count++
  return count
}

// Expects `scored` already sorted best-first — keeps the first (highest
// scoring) representative of each story cluster, drops the rest.
function dedupeSameStory(scored: { r: Reading; score: number }[]): { r: Reading; score: number }[] {
  const kept: { r: Reading; score: number; tokens: Set<string> }[] = []
  for (const item of scored) {
    const tokens = significantTokens(item.r.headline)
    if (!kept.some(k => sharedTokenCount(tokens, k.tokens) >= 2)) {
      kept.push({ ...item, tokens })
    }
  }
  return kept.map(({ r, score }) => ({ r, score }))
}

// Show roundups are admitted to the Opinion group but sink below show
// reviews and opinion pieces of similar recency (Part 5).
function sortForRiverGroup(items: Reading[], group: RiverGroupFilter): Reading[] {
  if (group !== 'opinion') return items
  const roundups = items.filter(r => r.category === 'show_roundup')
  const rest = items.filter(r => r.category !== 'show_roundup')
  return [...rest, ...roundups]
}

// ── Paper layout sub-components ──────────────────────────────
// All positions are percentages of the layout container, derived directly
// from Paper's absolute pixel values on the 1728px canvas.

function CardImg({ r, left, top, width, height }: {
  r: Reading | undefined; left: string; top: string; width: string; height: string
}) {
  if (!r) return null
  return (
    <div style={{
      position: 'absolute', left, top, width, height,
      backgroundColor: '#c4c0b0',
      backgroundImage: r.thumbnail_url ? `url(${r.thumbnail_url})` : undefined,
      backgroundSize: 'cover',
      backgroundPosition: '50%',
      boxSizing: 'border-box',
    }} />
  )
}

function CardText({ r, left, top, width, height, maxLines = 2 }: {
  r: Reading | undefined; left: string; top: string; width: string; height: string; maxLines?: number
}) {
  if (!r) return null
  return (
    <div style={{
      position: 'absolute', left, top, width, height,
      display: 'flex', flexDirection: 'column', justifyContent: 'flex-start',
      overflow: 'hidden', boxSizing: 'border-box',
    }}>
      <a href={r.article_url} target="_blank" rel="noopener noreferrer"
        className="rd-card-headline rd-card-headline--clamp"
        style={{ WebkitLineClamp: maxLines }}>{r.headline}</a>
      {r.author && <span className="rd-card-source">{r.author}</span>}
      {r.publication_name && <span className="rd-card-source">{r.publication_name}</span>}
    </div>
  )
}

// ── Layout A — Paper "Layout One" (5A-0) ─────────────────────
function LayoutA({ cards }: { cards: Reading[] }) {
  const [c1, c2, c3] = cards
  return (
    <div style={{ position: 'relative', width: '100%', aspectRatio: '1637 / 897', overflow: 'visible' }}>
      <CardImg  r={c1} left="0%"     top="0%"     width="49.60%" height="85.40%" />
      <CardText r={c1} left="0%"     top="86.62%" width="49.66%" height="11.15%" />
      <CardImg  r={c2} left="50.34%" top="0%"     width="49.66%" height="51.17%" />
      <CardText r={c2} left="50.34%" top="51.17%" width="49.66%" height="11.04%" />
      <CardImg  r={c3} left="50.34%" top="62.21%" width="49.36%" height="26.64%" />
      <CardText r={c3} left="50.34%" top="88.85%" width="49.36%" height="11.15%" />
    </div>
  )
}

// ── Layout B — Paper "Layout Two" (7H-0) ─────────────────────
function LayoutB({ cards }: { cards: Reading[] }) {
  const [c1, c2, c3] = cards
  return (
    <div style={{ position: 'relative', width: '100%', aspectRatio: '1637 / 805', overflow: 'visible' }}>
      <CardImg  r={c1} left="69.52%" top="0%"     width="29.81%" height="88.70%" />
      <CardText r={c1} left="69.52%" top="90.06%" width="29.81%" height="88.70%" maxLines={10} />
      <CardImg  r={c2} left="0%"     top="0%"     width="61.76%" height="31.18%" />
      <CardText r={c2} left="0%"     top="31.18%" width="61.76%" height="11.80%" />
      <CardImg  r={c3} left="0%"     top="42.98%" width="49.66%" height="57.02%" />
      <CardText r={c3} left="50.52%" top="42.98%" width="11.24%" height="57.02%" maxLines={10} />
    </div>
  )
}

// ── Layout C — Paper "Layout Three" (AB-0) ───────────────────
function LayoutC({ cards }: { cards: Reading[] }) {
  const [c1, c2, c3] = cards
  return (
    <div style={{ position: 'relative', width: '100%', aspectRatio: '1637 / 887', overflow: 'visible' }}>
      <CardImg  r={c1} left="56.08%" top="0%"     width="30.79%" height="90.76%" />
      <CardText r={c1} left="88.03%" top="41.60%" width="14.35%" height="11%"    />
      <CardImg  r={c2} left="0%"     top="0%"     width="49.60%" height="30.78%" />
      <CardText r={c2} left="0%"     top="30.44%" width="49.60%" height="8.57%"  />
      <CardImg  r={c3} left="0%"     top="39.01%" width="49.66%" height="51.75%" />
      <CardText r={c3} left="0%"     top="90.76%" width="49.66%" height="12%"    />
    </div>
  )
}

// ── Fallback card (mobile / incomplete groups) ────────────────

function StoryCard({ reading }: { reading: Reading }) {
  const source = [reading.author, reading.publication_name].filter(Boolean).join(' / ')
  return (
    <div className="rd-card">
      <div className="rd-card-img-wrap">
        {reading.thumbnail_url ? (
          <img src={reading.thumbnail_url} alt={reading.headline}
            className="rd-card-img" loading="lazy" />
        ) : (
          <div className="rd-card-img-placeholder" />
        )}
      </div>
      <div className="rd-card-body">
        <a href={reading.article_url} target="_blank" rel="noopener noreferrer"
          className="rd-card-headline">{reading.headline}</a>
        {source && <span className="rd-card-source">{source}</span>}
      </div>
    </div>
  )
}

// ── Top stories view ──────────────────────────────────────────

function TopStoriesView({ stories }: { stories: Reading[] }) {
  const isDesktop = useIsDesktop()

  if (stories.length === 0) {
    return <p className="rd-empty">No top stories yet.</p>
  }

  const groups: Reading[][] = []
  for (let i = 0; i < stories.length; i += 3) {
    groups.push(stories.slice(i, i + 3))
  }

  return (
    <div className="rd-sections">
      {groups.map((group, i) => {
        const layout = LAYOUT_CYCLE[i % LAYOUT_CYCLE.length]

        if (!isDesktop) {
          return (
            <div key={i} className="rd-grid rd-grid--simple">
              {group.map(r => <StoryCard key={r.id} reading={r} />)}
            </div>
          )
        }

        switch (layout) {
          case 'a': return <LayoutA key={i} cards={group} />
          case 'b': return <LayoutB key={i} cards={group} />
          case 'c': return <LayoutC key={i} cards={group} />
        }
      })}
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
  const [tab, setTab] = useState<Tab>('top-stories')
  const [readings, setReadings] = useState<Reading[]>([])
  const [riverReadings, setRiverReadings] = useState<Reading[]>([])
  const [riverGroup, setRiverGroup] = useState<RiverGroupFilter>('all')
  const [loadingTop, setLoadingTop] = useState(true)
  const [loadingRiver, setLoadingRiver] = useState(false)

  useEffect(() => {
    fetch('/api/readings')
      .then(r => { if (!r.ok) throw new Error(); return r.json() })
      .then(data => { setReadings(Array.isArray(data) ? data : []); setLoadingTop(false) })
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

  const topStories = useMemo(() => {
    // Every Top Stories layout is image-led — a flagged story with no
    // thumbnail would render a blank/placeholder card, so it's excluded
    // before scoring rather than padding the grid with an empty slot.
    const flagged = readings.filter(r => r.top_story && r.thumbnail_url)
    const scored = flagged.map(r => ({ r, score: scoreReading(r) }))
    scored.sort(compareReadingScores)
    return dedupeSameStory(scored).slice(0, 9).map(s => s.r)
  }, [readings])

  return (
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
  )
}
