'use client'

import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import { publicationTier } from '@/lib/publication-tiers'
import type { Reading } from '@/lib/types'

type Tab = 'top-stories' | 'river'

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

function CardText({ r, left, top, width, height }: {
  r: Reading | undefined; left: string; top: string; width: string; height: string
}) {
  if (!r) return null
  return (
    <div style={{
      position: 'absolute', left, top, width, height,
      display: 'flex', flexDirection: 'column', justifyContent: 'center',
      overflow: 'hidden', boxSizing: 'border-box',
    }}>
      <a href={r.article_url} target="_blank" rel="noopener noreferrer"
        className="rd-card-headline">{r.headline}</a>
      {r.author && <span className="rd-card-source">{r.author}</span>}
      {r.publication_name && <span className="rd-card-source">{r.publication_name}</span>}
    </div>
  )
}

// ── Layout A — Paper "Layout One" (5A-0) ─────────────────────
// Canvas 1728px, content origin left=45.5 top=193.5, content size 1637×897.
// Card 1: left image spans full height, text below.
// Card 2: right-top image, text between the two right images.
// Card 3: right-bottom image (ultra-wide panoramic 808×239), text below.
function LayoutA({ cards }: { cards: Reading[] }) {
  const [c1, c2, c3] = cards
  return (
    <div style={{ position: 'relative', width: '100%', aspectRatio: '1637 / 897', overflow: 'visible' }}>
      {/* Card 1 — left image */}
      <CardImg  r={c1} left="0%"     top="0%"     width="49.60%" height="85.40%" />
      {/* Card 1 — text below left image (11px gap in Paper) */}
      <CardText r={c1} left="0%"     top="86.62%" width="49.66%" height="11.15%" />
      {/* Card 2 — right-top image */}
      <CardImg  r={c2} left="50.34%" top="0%"     width="49.66%" height="51.17%" />
      {/* Card 2 — text between right images, flush below right-top */}
      <CardText r={c2} left="50.34%" top="51.17%" width="49.66%" height="11.04%" />
      {/* Card 3 — right-bottom image, flush below Card 2 text */}
      <CardImg  r={c3} left="50.34%" top="62.21%" width="49.36%" height="26.64%" />
      {/* Card 3 — text below right-bottom image */}
      <CardText r={c3} left="50.34%" top="88.85%" width="49.36%" height="11.15%" />
    </div>
  )
}

// ── Layout B — Paper "Layout Two" (7H-0) ─────────────────────
// Canvas 1728px, content origin left=52 top=194, content size 1637×805.
// Card 1: right tall image spanning full height, text below (11px gap).
// Card 2: left-top wide panoramic image (1011×251), text flush below.
// Card 3: left-bottom image (813×459), text appears BESIDE the image to the right.
function LayoutB({ cards }: { cards: Reading[] }) {
  const [c1, c2, c3] = cards
  return (
    <div style={{ position: 'relative', width: '100%', aspectRatio: '1637 / 805', overflow: 'visible' }}>
      {/* Card 1 — right tall image */}
      <CardImg  r={c1} left="69.52%" top="0%"     width="29.81%" height="88.70%" />
      {/* Card 1 — text below right image (11px gap) */}
      <CardText r={c1} left="69.52%" top="90.06%" width="29.81%" height="9.94%"  />
      {/* Card 2 — left-top wide panoramic image */}
      <CardImg  r={c2} left="0%"     top="0%"     width="61.76%" height="31.18%" />
      {/* Card 2 — text flush below left-top image */}
      <CardText r={c2} left="0%"     top="31.18%" width="61.76%" height="11.80%" />
      {/* Card 3 — left-bottom image */}
      <CardImg  r={c3} left="0%"     top="42.98%" width="49.66%" height="57.02%" />
      {/* Card 3 — text beside left-bottom image, aligned to its top */}
      <CardText r={c3} left="50.52%" top="42.98%" width="11.24%" height="14.29%" />
    </div>
  )
}

// ── Layout C — Paper "Layout Three" (AB-0) ───────────────────
// Canvas 1728px, content origin left=52 top=194, content size 1637×887.
// Card 1: right tall image (504×805), text appears at RIGHT MARGIN beyond container.
// Card 2: left-top image (812×273), text flush below.
// Card 3: left-bottom image (813×459), text flush below.
function LayoutC({ cards }: { cards: Reading[] }) {
  const [c1, c2, c3] = cards
  return (
    <div style={{ position: 'relative', width: '100%', aspectRatio: '1637 / 887', overflow: 'visible' }}>
      {/* Card 1 — right tall image */}
      <CardImg  r={c1} left="56.08%" top="0%"     width="30.79%" height="90.76%" />
      {/* Card 1 — text at right margin, beyond container right edge */}
      <CardText r={c1} left="88.03%" top="41.60%" width="14.35%" height="7.67%"  />
      {/* Card 2 — left-top image */}
      <CardImg  r={c2} left="0%"     top="0%"     width="49.60%" height="30.78%" />
      {/* Card 2 — text, using Paper's exact top=464→30.44% */}
      <CardText r={c2} left="0%"     top="30.44%" width="49.60%" height="8.57%"  />
      {/* Card 3 — left-bottom image, flush with Card 2 text bottom */}
      <CardImg  r={c3} left="0%"     top="39.01%" width="49.66%" height="51.75%" />
      {/* Card 3 — text flush below left-bottom image */}
      <CardText r={c3} left="0%"     top="90.76%" width="49.66%" height="9.24%"  />
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

function RiverView({ readings }: { readings: Reading[] }) {
  if (readings.length === 0) {
    return <p className="rd-empty">No articles in the last 7 days.</p>
  }

  const groups = readings.reduce<Record<string, Reading[]>>((acc, r) => {
    const key = r.published_at ? localDateKey(r.published_at) : localDateKey(r.created_at)
    if (!acc[key]) acc[key] = []
    acc[key].push(r)
    return acc
  }, {})

  const sortedDates = Object.keys(groups).sort((a, b) => b.localeCompare(a))

  return (
    <div className="rd-river">
      {sortedDates.map(date => (
        <div key={date} className="rd-river-group">
          <p className="rd-river-date">{formatDateHeader(date)}</p>
          {groups[date].map(r => {
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
  )
}

// ── Page ──────────────────────────────────────────────────────

export default function ReadingsPage() {
  const [tab, setTab] = useState<Tab>('top-stories')
  const [readings, setReadings] = useState<Reading[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/readings')
      .then(r => { if (!r.ok) throw new Error(); return r.json() })
      .then(data => { setReadings(Array.isArray(data) ? data : []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  const topStories = useMemo(() => {
    const flagged = readings.filter(r => r.top_story).slice(0, 18)
    if (flagged.length >= 18) return flagged
    const flaggedIds = new Set(flagged.map(r => r.id))
    const tier1 = readings.filter(
      r => !r.top_story && publicationTier(r.publication_name) === 1 && !flaggedIds.has(r.id)
    )
    return [...flagged, ...tier1].slice(0, 18)
  }, [readings])

  const riverReadings = useMemo(() => {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    return readings.filter(r => r.published_at && new Date(r.published_at).getTime() >= cutoff)
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

        {loading ? (
          <div className="rd-skeleton-grid" />
        ) : tab === 'top-stories' ? (
          <TopStoriesView stories={topStories} />
        ) : (
          <RiverView readings={riverReadings} />
        )}
      </main>
    </div>
  )
}
