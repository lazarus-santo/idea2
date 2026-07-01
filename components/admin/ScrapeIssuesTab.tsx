'use client'

import { useState, useEffect, useCallback } from 'react'

type IssueVenue = {
  id: string
  name: string
  exhibitions_url: string
  scrape_failed: boolean
  manual_entry_required: boolean
  scrape_failure_reason: string | null
}

const F = 'var(--font-inter-tight), system-ui, sans-serif'

const REASON_LABELS: Record<string, string> = {
  fetch_failed:          'Fetch failed (both Browserbase and HTTP)',
  bot_protected:         'Bot protection / CAPTCHA wall',
  zero_links_after_retry:'Zero exhibition links after retry',
}

function reasonLabel(venue: IssueVenue): string {
  if (venue.manual_entry_required && venue.scrape_failure_reason) {
    return REASON_LABELS[venue.scrape_failure_reason] ?? venue.scrape_failure_reason
  }
  if (venue.scrape_failed && !venue.manual_entry_required) return 'Last scrape failed'
  if (venue.manual_entry_required) return 'Marked as manual entry'
  return 'Unknown'
}

export default function ScrapeIssuesTab({ onCount }: { onCount?: (n: number) => void }) {
  const [venues, setVenues] = useState<IssueVenue[]>([])
  const [loading, setLoading] = useState(true)
  const [messages, setMessages] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    setLoading(true)
    const res = await fetch('/api/admin/venues/issues')
    const data = await res.json()
    const list = Array.isArray(data) ? data : []
    setVenues(list)
    onCount?.(list.length)
    setLoading(false)
  }, [onCount])

  useEffect(() => { load() }, [load])

  function setMsg(id: string, msg: string) {
    setMessages((prev) => ({ ...prev, [id]: msg }))
  }

  async function retryScrape(venue: IssueVenue) {
    setMsg(venue.id, 'Starting scrape...')
    const res = await fetch(`/api/admin/venues/${venue.id}/retry-scrape`, { method: 'POST' })
    if (res.ok) {
      setMsg(venue.id, 'Scrape started in background')
    } else {
      setMsg(venue.id, 'Failed to start scrape')
    }
  }

  async function markManual(venue: IssueVenue) {
    setMsg(venue.id, 'Saving...')
    const res = await fetch(`/api/admin/venues/${venue.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manual_entry_required: true, scrape_failed: false }),
    })
    if (res.ok) {
      await load()
    } else {
      setMsg(venue.id, 'Failed to update')
    }
  }

  async function clearIssue(venue: IssueVenue) {
    setMsg(venue.id, 'Clearing...')
    const res = await fetch(`/api/admin/venues/${venue.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manual_entry_required: false, scrape_failed: false, scrape_failure_reason: null }),
    })
    if (res.ok) {
      await load()
    } else {
      setMsg(venue.id, 'Failed to update')
    }
  }

  if (loading) {
    return <p style={{ fontFamily: F, fontSize: 13, color: 'rgba(0,0,0,0.4)' }}>Loading...</p>
  }

  if (venues.length === 0) {
    return (
      <p style={{ fontFamily: F, fontSize: 13, color: 'rgba(0,0,0,0.4)' }}>
        No scrape issues — all venues are running cleanly.
      </p>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p style={{ fontFamily: F, fontSize: 12, color: 'rgba(0,0,0,0.5)', margin: 0 }}>
        {venues.length} venue{venues.length !== 1 ? 's' : ''} with scrape issues
      </p>
      {venues.map((venue) => (
        <div key={venue.id} style={{
          background: '#fff',
          border: '1px solid rgba(0,0,0,0.12)',
          padding: '14px 18px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <span style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#000' }}>
                {venue.name}
              </span>
              {venue.manual_entry_required && (
                <span style={{
                  fontFamily: F, fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
                  textTransform: 'uppercase', color: '#b45309',
                  background: '#fef3c7', padding: '2px 6px',
                }}>
                  Manual Entry
                </span>
              )}
              {venue.scrape_failed && !venue.manual_entry_required && (
                <span style={{
                  fontFamily: F, fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
                  textTransform: 'uppercase', color: '#991b1b',
                  background: '#fee2e2', padding: '2px 6px',
                }}>
                  Scrape Failed
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

          <p style={{ fontFamily: F, fontSize: 12, color: 'rgba(0,0,0,0.55)', margin: 0 }}>
            {reasonLabel(venue)}
          </p>
          {venue.manual_entry_required && venue.scrape_failure_reason === 'zero_links_after_retry' && (
            <p style={{ fontFamily: F, fontSize: 12, color: '#b45309', margin: 0 }}>
              Gallery site structure unsupported — add exhibitions manually.
            </p>
          )}

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {!venue.manual_entry_required && (
              <button
                onClick={() => retryScrape(venue)}
                style={{
                  fontFamily: F, fontSize: 11, fontWeight: 700, letterSpacing: '0.1em',
                  textTransform: 'uppercase', padding: '5px 12px',
                  background: '#000', color: '#fff', border: 'none', cursor: 'pointer',
                }}
              >
                Retry Scrape
              </button>
            )}
            {!venue.manual_entry_required && (
              <button
                onClick={() => markManual(venue)}
                style={{
                  fontFamily: F, fontSize: 11, fontWeight: 700, letterSpacing: '0.1em',
                  textTransform: 'uppercase', padding: '5px 12px',
                  background: 'transparent', color: '#b45309',
                  border: '1px solid #b45309', cursor: 'pointer',
                }}
              >
                Mark as Manual Entry
              </button>
            )}
            {(venue.scrape_failed || venue.manual_entry_required) && (
              <button
                onClick={() => clearIssue(venue)}
                style={{
                  fontFamily: F, fontSize: 11, fontWeight: 700, letterSpacing: '0.1em',
                  textTransform: 'uppercase', padding: '5px 12px',
                  background: 'transparent', color: 'rgba(0,0,0,0.4)',
                  border: '1px solid rgba(0,0,0,0.2)', cursor: 'pointer',
                }}
              >
                Clear Issue
              </button>
            )}
            {messages[venue.id] && (
              <span style={{ fontFamily: F, fontSize: 12, color: 'rgba(0,0,0,0.5)' }}>
                {messages[venue.id]}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
