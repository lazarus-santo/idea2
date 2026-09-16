'use client'

import { useState, useEffect, useCallback, type CSSProperties } from 'react'
import { adminFetch } from '@/lib/admin-fetch'
import type { ScrapeStatus } from '@/lib/venue-scrape-schedule'

type VenueHealth = {
  id: string
  name: string
  exhibitions_url: string
  type: string
  published_count: number
  pending_count: number
  top_discard_stage: string | null
  top_discard_count: number
  last_scrape_at: string | null
  next_scrape_due: string | null
  consecutive_zero_scrapes: number
  attempts_recorded: number
  scrape_status: ScrapeStatus
  scrape_failures: number
  manual_entry_required: boolean
  scrapable: boolean
  scrape_day_of_week: number | null
}

const F = 'var(--font-inter-tight), system-ui, sans-serif'

const STAGE_LABELS: Record<string, string> = {
  temporal_discarded: 'Dropped as already closed',
  extraction_failed: 'Could not read the show page',
  fetch_failed: 'Could not load the show page',
  hallucination_rejected: 'Extracted text not found on the page',
  upsert_failed: 'Failed to save',
  location_rejected: 'Show was outside New York',
  no_date_evidence: 'No dates anywhere — listing or show page',
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function daysAgo(iso: string | null): string {
  if (!iso) return 'never scraped'
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms)) return 'never scraped'
  const days = Math.floor(ms / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}

// The count only means something once there are scrapes behind it. With no
// history at all, "0 in a row" would read as a clean bill of health for a venue
// that has simply never run.
function zeroStreakNote(v: VenueHealth): { text: string; tone: 'bad' | 'warn' | 'quiet' } {
  if (v.attempts_recorded === 0) return { text: 'No scrape history recorded yet', tone: 'quiet' }
  if (v.consecutive_zero_scrapes >= 3) {
    return { text: `${v.consecutive_zero_scrapes} scrapes in a row found nothing — likely broken`, tone: 'bad' }
  }
  if (v.consecutive_zero_scrapes > 0) {
    return { text: `${v.consecutive_zero_scrapes} scrape${v.consecutive_zero_scrapes > 1 ? 's' : ''} in a row found nothing`, tone: 'warn' }
  }
  return { text: 'Last scrape found shows', tone: 'quiet' }
}

const STATUS_RANK: Record<string, number> = { error3: 0, error2: 1, error1: 2, in_progress: 3 }

export default function VenueHealthTab() {
  const [venues, setVenues] = useState<VenueHealth[]>([])
  const [loading, setLoading] = useState(true)
  const [messages, setMessages] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [onlyProblems, setOnlyProblems] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const res = await adminFetch('/api/admin/venues/health')
    const data = await res.json().catch(() => [])
    setVenues(Array.isArray(data) ? data : [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // Waits for the scrape, like Scrape Issues does — most venues take minutes.
  async function scrapeNow(venue: VenueHealth) {
    setBusy((p) => ({ ...p, [venue.id]: true }))
    setMessages((p) => ({ ...p, [venue.id]: 'Scraping — this can take several minutes...' }))
    const res = await adminFetch(`/api/admin/venues/${venue.id}/scrape`, { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    setBusy((p) => ({ ...p, [venue.id]: false }))
    if (!res.ok) {
      // 409 is the Run Lock: the queue already has this venue.
      setMessages((p) => ({ ...p, [venue.id]: data.error ?? 'Failed to scrape' }))
      await load()
      return
    }
    await load()
    setMessages((p) => ({
      ...p,
      [venue.id]: data.failure_reason
        ? `Scrape failed: ${data.failure_reason}`
        : `Scrape finished — ${data.exhibitions_upserted ?? 0} exhibition(s) saved`,
    }))
  }

  const sorted = [...venues].sort((a, b) => {
    if (b.consecutive_zero_scrapes !== a.consecutive_zero_scrapes) {
      return b.consecutive_zero_scrapes - a.consecutive_zero_scrapes
    }
    const ra = STATUS_RANK[a.scrape_status] ?? 9
    const rb = STATUS_RANK[b.scrape_status] ?? 9
    if (ra !== rb) return ra - rb
    return a.name.localeCompare(b.name)
  })

  const shown = onlyProblems
    ? sorted.filter((v) => v.consecutive_zero_scrapes > 0 || v.manual_entry_required || v.scrape_status.startsWith('error') || !v.scrapable)
    : sorted

  const pillStyle: CSSProperties = {
    fontFamily: F, fontSize: 11, fontWeight: 700, letterSpacing: '0.1em',
    textTransform: 'uppercase', padding: '5px 12px',
    borderRadius: 999, cursor: 'pointer', background: 'transparent',
  }

  if (loading) {
    return <p style={{ fontFamily: F, fontSize: 13, color: 'rgba(0,0,0,0.4)' }}>Loading...</p>
  }

  const noHistory = venues.filter((v) => v.attempts_recorded === 0).length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <p style={{ fontFamily: F, fontSize: 12, color: 'rgba(0,0,0,0.5)', margin: 0 }}>
          {venues.length} active venue{venues.length !== 1 ? 's' : ''}
          {noHistory > 0 && ` · ${noHistory} with no scrape history recorded yet`}
        </p>
        <button
          onClick={() => setOnlyProblems((v) => !v)}
          style={{ ...pillStyle, color: 'rgba(0,0,0,0.6)', border: '1px solid rgba(0,0,0,0.2)' }}
        >
          {onlyProblems ? 'Show All' : 'Only Problems'}
        </button>
        <button
          onClick={load}
          style={{ ...pillStyle, color: 'rgba(0,0,0,0.4)', border: '1px solid rgba(0,0,0,0.2)' }}
        >
          Refresh
        </button>
      </div>

      {shown.length === 0 && (
        <p style={{ fontFamily: F, fontSize: 13, color: 'rgba(0,0,0,0.4)' }}>
          Nothing to look at — no venue is failing or coming back empty.
        </p>
      )}

      {shown.map((venue) => {
        const streak = zeroStreakNote(venue)
        const isRunning = venue.scrape_status === 'in_progress'
        const streakColor = streak.tone === 'bad' ? '#991b1b' : streak.tone === 'warn' ? '#b45309' : 'rgba(0,0,0,0.45)'
        return (
          <div key={venue.id} style={{
            background: '#fff', border: '1px solid rgba(0,0,0,0.12)',
            padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 8,
          }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#000' }}>{venue.name}</span>
                <span style={{
                  fontFamily: F, fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
                  textTransform: 'uppercase', color: 'rgba(0,0,0,0.45)',
                  background: 'rgba(0,0,0,0.06)', padding: '2px 6px',
                }}>
                  {venue.type}
                </span>
                {isRunning && (
                  <span style={{
                    fontFamily: F, fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
                    textTransform: 'uppercase', color: '#1d4ed8', background: '#dbeafe', padding: '2px 6px',
                  }}>
                    Scraping Now
                  </span>
                )}
                {venue.manual_entry_required && (
                  <span style={{
                    fontFamily: F, fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
                    textTransform: 'uppercase', color: '#b45309', background: '#fef3c7', padding: '2px 6px',
                  }}>
                    Manual Entry
                  </span>
                )}
                {!venue.scrapable && (
                  <span style={{
                    fontFamily: F, fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
                    textTransform: 'uppercase', color: 'rgba(0,0,0,0.5)', background: 'rgba(0,0,0,0.06)', padding: '2px 6px',
                  }}>
                    Not Scrapable
                  </span>
                )}
              </div>
              <a
                href={venue.exhibitions_url}
                target="_blank"
                rel="noopener"
                style={{ fontFamily: F, fontSize: 11, color: 'rgba(0,0,0,0.4)', textDecoration: 'none' }}
              >
                {venue.exhibitions_url.replace(/^https?:\/\//, '')}
              </a>
            </div>

            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
              <Stat label="Published" value={String(venue.published_count)} />
              <Stat label="Pending" value={String(venue.pending_count)} />
              <Stat label="Last scrape" value={daysAgo(venue.last_scrape_at)} />
              <Stat
                label="Next due"
                value={venue.next_scrape_due
                  ? `${formatDate(venue.next_scrape_due)}${venue.scrape_day_of_week !== null ? ` (${DAYS[venue.scrape_day_of_week]}s)` : ''}`
                  : 'No weekly slot'}
              />
            </div>

            <p style={{ fontFamily: F, fontSize: 12, color: streakColor, margin: 0, fontWeight: streak.tone === 'quiet' ? 400 : 700 }}>
              {streak.text}
            </p>

            {venue.top_discard_stage && (
              <p style={{ fontFamily: F, fontSize: 12, color: 'rgba(0,0,0,0.55)', margin: 0 }}>
                Most shows lost at: {STAGE_LABELS[venue.top_discard_stage] ?? venue.top_discard_stage} ({venue.top_discard_count})
              </p>
            )}

            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                onClick={() => scrapeNow(venue)}
                disabled={isRunning || busy[venue.id]}
                title={isRunning ? 'A scrape of this venue is already running' : undefined}
                style={{
                  fontFamily: F, fontSize: 11, fontWeight: 700, letterSpacing: '0.1em',
                  textTransform: 'uppercase', padding: '5px 12px',
                  background: isRunning || busy[venue.id] ? 'rgba(0,0,0,0.25)' : '#000',
                  color: '#fff', border: 'none', borderRadius: 999,
                  cursor: isRunning || busy[venue.id] ? 'not-allowed' : 'pointer',
                }}
              >
                {isRunning ? 'Busy' : busy[venue.id] ? 'Scraping...' : 'Scrape Now'}
              </button>
              {messages[venue.id] && (
                <span style={{ fontFamily: F, fontSize: 12, color: 'rgba(0,0,0,0.5)' }}>{messages[venue.id]}</span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{
        fontFamily: F, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
        textTransform: 'uppercase', color: 'rgba(0,0,0,0.4)',
      }}>
        {label}
      </span>
      <span style={{ fontFamily: F, fontSize: 13, color: '#000' }}>{value}</span>
    </div>
  )
}
