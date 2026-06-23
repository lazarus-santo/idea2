'use client'

import Link from 'next/link'
import { useState, useRef, useLayoutEffect } from 'react'
import type { ExhibitionDetailData } from '@/lib/types'
import { sortByTier } from '@/lib/publication-tiers'
import dynamic from 'next/dynamic'

const ExhibitionMiniMap = dynamic(() => import('@/components/ExhibitionMiniMap'), { ssr: false })

const PR_TEASER_LEN = 300

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatDateShort(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function formatDateRange(start: string | null, end: string | null): string {
  if (!start && !end) return ''
  if (start && end) {
    const sy = new Date(start + 'T00:00:00').getFullYear()
    const ey = new Date(end + 'T00:00:00').getFullYear()
    return sy === ey
      ? `${formatDateShort(start)} – ${formatDate(end)}`
      : `${formatDate(start)} – ${formatDate(end)}`
  }
  if (end) return `Through ${formatDate(end)}`
  if (start) return `From ${formatDate(start)}`
  return ''
}

export default function ExhibitionDetail({ exhibition }: { exhibition: ExhibitionDetailData }) {
  const [prShowFull, setPrShowFull] = useState(false)
  const titleRef = useRef<HTMLHeadingElement>(null)

  // Shrink title font until it fits within 2 lines
  useLayoutEffect(() => {
    const el = titleRef.current
    if (!el) return
    el.style.fontSize = ''
    let size = 107
    while (size > 20) {
      const lh = parseFloat(window.getComputedStyle(el).lineHeight)
      if (el.scrollHeight <= lh * 2 + 1) break
      size -= 2
      el.style.fontSize = `${size}px`
    }
  }, [exhibition.show_title])

  const dateRange = formatDateRange(exhibition.start_date, exhibition.end_date)
  const hasCollapsibles = !!exhibition.press_release || exhibition.prereads.length > 0

  const prText = exhibition.press_release ?? ''
  const hasPrMore = prText.length > PR_TEASER_LEN
  const prDisplayText = hasPrMore && !prShowFull
    ? prText.slice(0, PR_TEASER_LEN).trimEnd() + '…'
    : prText

  return (
    <div className="ep-body">

      {/* ── Hero with nav overlaid ── */}
      <div className={`ep-hero${!exhibition.image_url ? ' ep-hero--no-image' : ''}`}>
        <nav className="ep-nav" aria-label="Site navigation">
          <div className="ep-nav-inner">
            <Link href="/" className="ep-wordmark">Idea 2</Link>
            <div className="ep-nav-links">
              <Link href="/exhibitions">Exhibitions</Link>
              <Link href="/readings">Readings</Link>
              <Link href="/editors-picks">Editor&apos;s Picks</Link>
            </div>
            <Link href="/search" className="ep-nav-search">Search</Link>
          </div>
        </nav>

        {exhibition.image_url ? (
          <img
            className="ep-hero-img"
            src={exhibition.image_url}
            alt={exhibition.show_title}
          />
        ) : (
          <div className="ep-hero-placeholder" />
        )}
      </div>

      {/* ── Two-column content ── */}
      <div className="ep-content">

        {/* Left: large display title — auto-sizes to fit 2 lines */}
        <h1 className="ep-title" ref={titleRef}>{exhibition.show_title}</h1>

        {/* Right: metadata + collapsibles */}
        <div className="ep-right">

          {exhibition.artists.map((artist, i) => (
            <Link key={i} href={`/search?q=${encodeURIComponent(artist)}&category=artists`} className="ep-artist-name artist-link">{artist}</Link>
          ))}

          {exhibition.institution_id ? (
            <Link href={`/venues/${exhibition.institution_id}`} className="ep-gallery-name ep-gallery-link">
              {exhibition.institution_name}
            </Link>
          ) : (
            <p className="ep-gallery-name">{exhibition.institution_name}</p>
          )}

          {dateRange && <p className="ep-meta">{dateRange}</p>}
          {exhibition.resolved_address && (
            <p className="ep-meta">
              <a
                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(exhibition.resolved_address)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="ep-meta-link"
              >
                {exhibition.resolved_address}
              </a>
            </p>
          )}

          {hasCollapsibles && <div className="ep-sections-gap" />}

          <div className="ep-sections-gap" />
          <Link href={`/map?add=${exhibition.id}`} className="ep-meta ep-meta-link">
            Create an itinerary &rsaquo;
          </Link>

          {exhibition.prereads.length > 0 && (
            <div className="ep-section">
              <p className="ep-pr-label">The Preread</p>
              <div className="ep-section-body">
                {sortByTier(exhibition.prereads).map((p) => {
                  const label = [p.publication, p.article_title].filter(Boolean).join(' — ')
                  return p.article_url ? (
                    <a
                      key={p.id}
                      href={p.article_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ep-preread-link"
                    >
                      {label || p.article_url}
                    </a>
                  ) : (
                    <span key={p.id} className="ep-preread-link ep-preread-link--no-url">
                      {label}
                    </span>
                  )
                })}
              </div>
            </div>
          )}

          {exhibition.press_release && (
            <div className="ep-pr-teaser">
              <p className="ep-pr-label">Press Release</p>
              {prDisplayText}
              {hasPrMore && (
                <button className="ep-readmore" onClick={() => setPrShowFull(v => !v)}>
                  {prShowFull ? ' Read less' : ' Read more'}
                </button>
              )}
            </div>
          )}

          {exhibition.lat && exhibition.lng && (
            <ExhibitionMiniMap
              exhibitionId={exhibition.id}
              lat={exhibition.lat}
              lng={exhibition.lng}
            />
          )}

        </div>
      </div>
    </div>
  )
}
