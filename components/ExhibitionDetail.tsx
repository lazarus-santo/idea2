'use client'

import Link from 'next/link'
import { useState, useRef, useLayoutEffect, useMemo } from 'react'
import type { ExhibitionDetailData } from '@/lib/types'
import { sortByTier } from '@/lib/publication-tiers'
import { sanitizeHtml, normalizeToHtml } from '@/lib/sanitize-html'
import dynamic from 'next/dynamic'

const ExhibitionMiniMap = dynamic(() => import('@/components/ExhibitionMiniMap'), { ssr: false })

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatDateShort(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// Coverage dates come from Exa as full ISO datetimes, unlike the plain YYYY-MM-DD
// exhibition dates formatDate/formatDateShort above expect.
function formatCoverageDate(dateStr: string | null): string | null {
  if (!dateStr) return null
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// Coverage titles come straight from a page's raw <title> tag, which often ends in a
// site-branding suffix (e.g. "... - The Art Newspaper - International art news and
// events") — redundant since the publication is already shown separately. Strips a
// trailing separator + the publication name (and anything after it), but only when
// preceded by a separator, so a legitimate in-title mention isn't cut.
function stripTitleSiteSuffix(title: string, publication: string | null): string {
  if (!publication) return title
  const idx = title.toLowerCase().lastIndexOf(publication.toLowerCase())
  if (idx <= 0) return title
  const before = title.slice(0, idx).trimEnd()
  return /[-|—·]\s*$/.test(before) ? before.replace(/[-|—·]\s*$/, '').trim() : title
}

function formatDateRange(start: string | null, end: string | null, isOngoing: boolean): string {
  if (!start && !end) return ''
  if (isOngoing || (!end && start)) {
    return `${formatDate(start!)} – Ongoing`
  }
  if (start && end) {
    const sy = new Date(start + 'T00:00:00').getFullYear()
    const ey = new Date(end + 'T00:00:00').getFullYear()
    return sy === ey
      ? `${formatDateShort(start)} – ${formatDate(end)}`
      : `${formatDate(start)} – ${formatDate(end)}`
  }
  if (end) return `Through ${formatDate(end)}`
  return ''
}

// Sized to match Search's result thumbnails (.sr-thumb / .sr-thumb-img, 40x40).
function PrereadThumbnail({ url }: { url: string | null }) {
  return (
    <div className="ep-preread-thumb-wrap">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" className="ep-preread-thumb" />
      ) : (
        <div className="ep-preread-thumb-empty" />
      )}
    </div>
  )
}

export default function ExhibitionDetail({ exhibition }: { exhibition: ExhibitionDetailData }) {
  const [prShowFull, setPrShowFull] = useState(false)
  const [prHasMore, setPrHasMore] = useState(false)
  const prRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)

  // Shrink title font until it fits within 2 lines
  useLayoutEffect(() => {
    const el = titleRef.current
    if (!el) return
    el.style.fontSize = ''
    let size = 64
    while (size > 20) {
      const lh = parseFloat(window.getComputedStyle(el).lineHeight)
      if (el.scrollHeight <= lh * 2 + 1) break
      size -= 2
      el.style.fontSize = `${size}px`
    }
  }, [exhibition.show_title])

  const dateRange = formatDateRange(exhibition.start_date, exhibition.end_date, exhibition.is_ongoing)
  const isMuseum = exhibition.preread_type === 'coverage_only'
  const hasCollapsibles = !!exhibition.press_release || exhibition.prereads.length > 0

  const prHtml = useMemo(() => {
    if (!exhibition.press_release) return ''
    const normalized = normalizeToHtml(exhibition.press_release)
    return sanitizeHtml(normalized)
  }, [exhibition.press_release])

  // Detect real overflow after paint so "Read more" only shows when content is clipped
  useLayoutEffect(() => {
    const el = prRef.current
    if (!el || prShowFull) return
    setPrHasMore(el.scrollHeight > el.clientHeight + 2)
  }, [prHtml, prShowFull])

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

          {exhibition.prereads.length > 0 && (
            <div className="ep-section">
              <p className="ep-pr-label">The Preread</p>
              <div className="ep-section-body">
                {sortByTier(exhibition.prereads).map((p) => {
                  const title = p.article_title ? stripTitleSiteSuffix(p.article_title, p.publication) : p.article_title
                  const label = [p.publication, title].filter(Boolean).join(' — ')
                  return p.article_url ? (
                    <a
                      key={p.id}
                      href={p.article_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ep-preread-row"
                    >
                      <PrereadThumbnail url={p.thumbnail_url} />
                      <span>{label || p.article_url}</span>
                    </a>
                  ) : (
                    <span key={p.id} className="ep-preread-row ep-preread-row--no-url">
                      <PrereadThumbnail url={p.thumbnail_url} />
                      <span>{label}</span>
                    </span>
                  )
                })}
              </div>
            </div>
          )}

          {exhibition.coverage.length > 0 && (
            <div className="ep-section">
              <p className="ep-pr-label">Coverage</p>
              <div className="ep-section-body">
                {exhibition.coverage.map((c) => {
                  const meta = [c.publication, formatCoverageDate(c.published_date)].filter(Boolean).join(' · ')
                  const title = c.title ? stripTitleSiteSuffix(c.title, c.publication) : c.title
                  const label = [meta, title].filter(Boolean).join(' — ')
                  const content = label || c.url
                  return c.reading_id ? (
                    <Link key={c.url} href={`/readings/${c.reading_id}`} className="ep-preread-row">
                      <PrereadThumbnail url={c.thumbnail_url} />
                      <span>{content}</span>
                    </Link>
                  ) : (
                    <a
                      key={c.url}
                      href={c.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ep-preread-row"
                    >
                      <PrereadThumbnail url={c.thumbnail_url} />
                      <span>{content}</span>
                    </a>
                  )
                })}
              </div>
            </div>
          )}

          {prHtml && (
            <div className="ep-pr-teaser">
              <p className="ep-pr-label">{isMuseum ? 'Exhibition Description' : 'Press Release'}</p>
              <div
                ref={prRef}
                className={`ep-pr-prose${prShowFull ? ' ep-pr-prose--expanded' : ''}`}
                dangerouslySetInnerHTML={{ __html: prHtml }}
              />
              {(prHasMore || prShowFull) && (
                <button className="ep-readmore" onClick={() => setPrShowFull(v => !v)}>
                  {prShowFull ? 'Read less' : 'Read more'}
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
