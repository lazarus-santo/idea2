'use client'

import { useState } from 'react'
import Link from 'next/link'
import PrereadCard from './PrereadCard'
import type { Exhibition } from '@/lib/types'

function formatDate(dateStr: string | null): string {
  if (!dateStr) return ''
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatDateRange(start: string | null, end: string | null): string {
  if (!start && !end) return ''
  if (start && end) return `${formatDate(start)} — ${formatDate(end)}`
  if (end) return `Through ${formatDate(end)}`
  if (start) return `From ${formatDate(start)}`
  return ''
}

interface ExhibitionCardProps {
  exhibition: Exhibition
}

export default function ExhibitionCard({ exhibition }: ExhibitionCardProps) {
  const [showPrereads, setShowPrereads] = useState(false)
  const prereads = exhibition.prereads ?? []
  const dateRange = formatDateRange(exhibition.start_date, exhibition.end_date)

  return (
    <article className="exhibition-card">
      <header className="card-header">
        <span className="venue-label">{exhibition.venue_name}</span>
        {dateRange && <span className="date-range">{dateRange}</span>}
      </header>

      <h2 className="show-title">{exhibition.show_title}</h2>

      <p className="artists">
        {exhibition.artists.map((name, i) => (
          <span key={name}>
            {i > 0 && ', '}
            <Link href={`/search?q=${encodeURIComponent(name)}&category=artists`} className="artist-link">{name}</Link>
          </span>
        ))}
      </p>

      {prereads.length > 0 && (
        <footer className="card-footer">
          <button
            className="prereads-toggle"
            onClick={() => setShowPrereads((v) => !v)}
            aria-expanded={showPrereads}
          >
            {showPrereads ? 'Hide prereads' : `${prereads.length} prereads`}
          </button>
        </footer>
      )}

      {showPrereads && prereads.length > 0 && (
        <section className="prereads-section" aria-label="Prereads">
          {prereads.map((p) => (
            <PrereadCard
              key={p.id}
              preread={p}
              placeholderLabel={exhibition.show_title}
            />
          ))}
        </section>
      )}
    </article>
  )
}
