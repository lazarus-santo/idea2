'use client'

import { useState, useEffect, useCallback, type CSSProperties } from 'react'
import { adminFetch } from '@/lib/admin-fetch'

type IssueVenue = {
  id: string
  name: string
  exhibitions_url: string
  institution_id?: string
  scrape_failed: boolean
  manual_entry_required: boolean
  scrape_failure_reason: string | null
  scrape_notes: string | null
  scrapable: boolean
}

type Institution = {
  id: string
  name: string
  status?: string
  status_note?: string | null
  active?: boolean
}

const F = 'var(--font-inter-tight), system-ui, sans-serif'

const REASON_LABELS: Record<string, string> = {
  fetch_failed:          'Fetch failed (both Browserbase and HTTP)',
  bot_protected:         'Bot protection / CAPTCHA wall',
  zero_links_after_retry:'Zero exhibition links after retry',
  no_exhibitions_url:    'No exhibitions URL set for this venue',
}

function reasonLabel(venue: IssueVenue): string {
  if (venue.manual_entry_required && venue.scrape_failure_reason) {
    return REASON_LABELS[venue.scrape_failure_reason] ?? venue.scrape_failure_reason
  }
  if (venue.scrape_failed && !venue.manual_entry_required) return 'Last scrape failed'
  if (venue.manual_entry_required) return 'Marked as manual entry'
  if (!venue.scrapable) return 'Excluded from scraping by you'
  return 'Unknown'
}

// Most failures are zero_links_after_retry — the page loaded and nothing was
// found — which usually means the shows sit behind a tab or on a different URL.
// That is exactly the case a one-line hint fixes, so the placeholder suggests it.
const NOTES_PLACEHOLDER =
  'Scraping hint, e.g. "current shows are under the On View tab" or "ignore the Programs section"'

export default function ScrapeIssuesTab({ onCount }: { onCount?: (n: number) => void }) {
  const [venues, setVenues] = useState<IssueVenue[]>([])
  const [loading, setLoading] = useState(true)
  const [messages, setMessages] = useState<Record<string, string>>({})
  // Draft note text, keyed by venue id. Held separately from `venues` so a
  // reload does not clobber something half-typed.
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({})

  const [institutions, setInstitutions] = useState<Institution[]>([])
  const [reportInstitutionId, setReportInstitutionId] = useState('')
  const [reportShowName, setReportShowName] = useState('')
  const [reportNotes, setReportNotes] = useState('')
  const [reportStatus, setReportStatus] = useState<string | null>(null)

  // Institutions load alongside the venues rather than in their own effect:
  // marking a gallery closed changes both lists at once — its venues vanish from
  // the issue list and it appears under "Not Being Scraped" — so refreshing them
  // separately would leave the tab briefly self-contradictory.
  const load = useCallback(async () => {
    setLoading(true)
    const [venueRes, instRes] = await Promise.all([
      adminFetch('/api/admin/venues/issues'),
      adminFetch('/api/admin/institutions'),
    ])
    const data = await venueRes.json()
    const instData = await instRes.json()
    const list = Array.isArray(data) ? data : []
    setVenues(list)
    setInstitutions(Array.isArray(instData) ? instData : [])
    onCount?.(list.length)
    setLoading(false)
  }, [onCount])

  useEffect(() => { load() }, [load])

  async function submitMissingShowReport() {
    if (!reportInstitutionId || !reportShowName.trim()) {
      setReportStatus('Institution and exhibition name are required')
      return
    }
    setReportStatus('Saving...')
    const res = await adminFetch('/api/admin/missing-show-reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        institution_id: reportInstitutionId,
        exhibition_name: reportShowName,
        notes: reportNotes,
      }),
    })
    if (res.ok) {
      setReportStatus('Report saved')
      setReportInstitutionId('')
      setReportShowName('')
      setReportNotes('')
    } else {
      setReportStatus('Failed to save report')
    }
  }

  function setMsg(id: string, msg: string) {
    setMessages((prev) => ({ ...prev, [id]: msg }))
  }

  async function retryScrape(venue: IssueVenue) {
    setMsg(venue.id, 'Starting scrape...')
    const res = await adminFetch(`/api/admin/venues/${venue.id}/retry-scrape`, { method: 'POST' })
    if (res.ok) {
      setMsg(venue.id, 'Scrape started in background')
    } else {
      setMsg(venue.id, 'Failed to start scrape')
    }
  }

  async function markManual(venue: IssueVenue) {
    setMsg(venue.id, 'Saving...')
    const res = await adminFetch(`/api/admin/venues/${venue.id}`, {
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
    const res = await adminFetch(`/api/admin/venues/${venue.id}`, {
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

  async function patchVenue(venue: IssueVenue, body: Record<string, unknown>, pending: string, done: string) {
    setMsg(venue.id, pending)
    const res = await adminFetch(`/api/admin/venues/${venue.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.ok) {
      await load()
      setMsg(venue.id, done)
    } else {
      setMsg(venue.id, 'Failed to update')
    }
  }

  async function saveNotes(venue: IssueVenue) {
    const text = noteDrafts[venue.id] ?? venue.scrape_notes ?? ''
    await patchVenue(venue, { scrape_notes: text }, 'Saving note...',
      text.trim() ? 'Note saved — it will be used on the next scrape' : 'Note cleared')
    // Drop the draft so the row falls back to the saved value after reload.
    setNoteDrafts((prev) => {
      const next = { ...prev }
      delete next[venue.id]
      return next
    })
  }

  // Setting scrapable also clears scrape_failed: a venue you have decided not to
  // scrape should not keep displaying a failure it is no longer attempting.
  async function setScrapable(venue: IssueVenue, scrapable: boolean) {
    await patchVenue(
      venue,
      scrapable ? { scrapable: true } : { scrapable: false, scrape_failed: false },
      'Saving...',
      scrapable ? 'Back in the scrape queue' : 'Removed from the scrape queue'
    )
  }

  // Marks the whole institution, not just this venue — "this gallery closed"
  // is a statement about the gallery. The route deactivates every venue under
  // it, which is what actually stops the scraper.
  async function setInstitutionStatus(venue: IssueVenue, status: 'closed' | 'not_relevant') {
    if (!venue.institution_id) {
      setMsg(venue.id, 'No institution linked to this venue')
      return
    }
    const label = status === 'closed' ? 'closed' : 'not relevant'
    if (!confirm(
      `Mark the institution behind "${venue.name}" as ${label}?\n\n` +
      `This deactivates all of its venues and stops future scraping. ` +
      `Exhibitions already published stay up until their end dates pass. Reversible.`
    )) return

    setMsg(venue.id, 'Saving...')
    const res = await adminFetch(`/api/admin/institutions/${venue.institution_id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    const data = await res.json().catch(() => ({}))
    if (res.ok) {
      await load()
      setMsg(venue.id, `Marked ${label} — ${data.venues_updated ?? 0} venue(s) deactivated`)
    } else {
      setMsg(venue.id, data.error ?? 'Failed to update')
    }
  }

  async function restoreInstitution(inst: Institution) {
    setMsg(inst.id, 'Restoring...')
    const res = await adminFetch(`/api/admin/institutions/${inst.id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    })
    if (res.ok) {
      await load()
      setMsg(inst.id, '')
    } else {
      setMsg(inst.id, 'Failed to restore')
    }
  }

  const inputStyle: CSSProperties = {
    fontFamily: F, fontSize: 13, padding: '8px 10px',
    border: '1px solid rgba(0,0,0,0.2)', borderRadius: 4, background: '#fff',
  }

  const reportForm = (
    <div style={{
      background: '#fff',
      border: '1px solid rgba(0,0,0,0.12)',
      padding: '14px 18px',
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
    }}>
      <span style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#000' }}>
        Report Missing Show
      </span>
      <p style={{ fontFamily: F, fontSize: 12, color: 'rgba(0,0,0,0.5)', margin: 0 }}>
        Saw a show on an institution&apos;s site or Instagram that never showed up in a scrape? Log it here.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <select
          value={reportInstitutionId}
          onChange={(e) => setReportInstitutionId(e.target.value)}
          style={{ ...inputStyle, minWidth: 220 }}
        >
          <option value="">Select institution...</option>
          {institutions.map((inst) => (
            <option key={inst.id} value={inst.id}>{inst.name}</option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Exhibition name"
          value={reportShowName}
          onChange={(e) => setReportShowName(e.target.value)}
          style={{ ...inputStyle, flex: 1, minWidth: 200 }}
        />
      </div>
      <textarea
        placeholder='Notes (e.g. "Saw this on their Instagram, not showing up in scrape")'
        value={reportNotes}
        onChange={(e) => setReportNotes(e.target.value)}
        rows={2}
        style={{ ...inputStyle, resize: 'vertical' }}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          onClick={submitMissingShowReport}
          style={{
            fontFamily: F, fontSize: 11, fontWeight: 700, letterSpacing: '0.1em',
            textTransform: 'uppercase', padding: '5px 12px',
            background: '#000', color: '#fff', border: 'none', borderRadius: 999, cursor: 'pointer',
          }}
        >
          Submit Report
        </button>
        {reportStatus && (
          <span style={{ fontFamily: F, fontSize: 12, color: 'rgba(0,0,0,0.5)' }}>{reportStatus}</span>
        )}
      </div>
    </div>
  )

  const pillStyle: CSSProperties = {
    fontFamily: F, fontSize: 11, fontWeight: 700, letterSpacing: '0.1em',
    textTransform: 'uppercase', padding: '5px 12px',
    borderRadius: 999, cursor: 'pointer', background: 'transparent',
  }

  // Institutions taken out of circulation. They need their own block because
  // marking one deactivates its venues, which drops them out of the venue list
  // above — without this there would be no way to undo the decision.
  const retired = institutions.filter((i) => i.status && i.status !== 'active')

  const retiredPanel = retired.length > 0 && (
    <div style={{
      background: '#fff', border: '1px solid rgba(0,0,0,0.12)',
      padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <span style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#000' }}>
        Not Being Scraped
      </span>
      <p style={{ fontFamily: F, fontSize: 12, color: 'rgba(0,0,0,0.5)', margin: 0 }}>
        Institutions marked closed or not relevant. All of their venues are deactivated.
      </p>
      {retired.map((inst) => (
        <div key={inst.id} style={{
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          borderTop: '1px solid rgba(0,0,0,0.06)', paddingTop: 8,
        }}>
          <span style={{ fontFamily: F, fontSize: 13, color: '#000' }}>{inst.name}</span>
          <span style={{
            fontFamily: F, fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
            textTransform: 'uppercase', color: 'rgba(0,0,0,0.5)',
            background: 'rgba(0,0,0,0.06)', padding: '2px 6px',
          }}>
            {inst.status === 'closed' ? 'Closed' : 'Not Relevant'}
          </span>
          {inst.status_note && (
            <span style={{ fontFamily: F, fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>
              {inst.status_note}
            </span>
          )}
          <button
            onClick={() => restoreInstitution(inst)}
            style={{ ...pillStyle, color: 'rgba(0,0,0,0.5)', border: '1px solid rgba(0,0,0,0.2)' }}
          >
            Restore
          </button>
          {messages[inst.id] && (
            <span style={{ fontFamily: F, fontSize: 12, color: 'rgba(0,0,0,0.5)' }}>
              {messages[inst.id]}
            </span>
          )}
        </div>
      ))}
    </div>
  )

  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {reportForm}
        <p style={{ fontFamily: F, fontSize: 13, color: 'rgba(0,0,0,0.4)' }}>Loading...</p>
      </div>
    )
  }

  if (venues.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {reportForm}
        {retiredPanel}
        <p style={{ fontFamily: F, fontSize: 13, color: 'rgba(0,0,0,0.4)' }}>
          No scrape issues — all venues are running cleanly.
        </p>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {reportForm}
      {retiredPanel}
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
              {!venue.scrapable && (
                <span style={{
                  fontFamily: F, fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
                  textTransform: 'uppercase', color: 'rgba(0,0,0,0.5)',
                  background: 'rgba(0,0,0,0.06)', padding: '2px 6px',
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

          <p style={{ fontFamily: F, fontSize: 12, color: 'rgba(0,0,0,0.55)', margin: 0 }}>
            {reasonLabel(venue)}
          </p>
          {venue.manual_entry_required && venue.scrape_failure_reason === 'zero_links_after_retry' && (
            <p style={{ fontFamily: F, fontSize: 12, color: '#b45309', margin: 0 }}>
              Nothing found on the page — often the shows sit behind a tab or on another URL.
              A note below usually fixes this; check the site, then retry.
            </p>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontFamily: F, fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(0,0,0,0.45)' }}>
              Scraping notes
            </label>
            <textarea
              value={noteDrafts[venue.id] ?? venue.scrape_notes ?? ''}
              onChange={(e) => setNoteDrafts((prev) => ({ ...prev, [venue.id]: e.target.value }))}
              placeholder={NOTES_PLACEHOLDER}
              rows={2}
              style={{ ...inputStyle, resize: 'vertical' }}
            />
            <span style={{ fontFamily: F, fontSize: 11, color: 'rgba(0,0,0,0.4)' }}>
              Passed to the extractor as context on every scrape of this venue.
            </span>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              onClick={() => saveNotes(venue)}
              disabled={(noteDrafts[venue.id] ?? venue.scrape_notes ?? '') === (venue.scrape_notes ?? '')}
              style={{
                ...pillStyle,
                color: 'rgba(0,0,0,0.6)', border: '1px solid rgba(0,0,0,0.2)',
                opacity: (noteDrafts[venue.id] ?? venue.scrape_notes ?? '') === (venue.scrape_notes ?? '') ? 0.4 : 1,
              }}
            >
              Save Note
            </button>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              onClick={() => retryScrape(venue)}
              style={{
                fontFamily: F, fontSize: 11, fontWeight: 700, letterSpacing: '0.1em',
                textTransform: 'uppercase', padding: '5px 12px',
                background: '#000', color: '#fff', border: 'none', borderRadius: 999, cursor: 'pointer',
              }}
            >
              Retry Scrape
            </button>
            {!venue.manual_entry_required && (
              <button
                onClick={() => markManual(venue)}
                style={{
                  fontFamily: F, fontSize: 11, fontWeight: 700, letterSpacing: '0.1em',
                  textTransform: 'uppercase', padding: '5px 12px',
                  background: 'transparent', color: '#b45309',
                  border: '1px solid #b45309', borderRadius: 999, cursor: 'pointer',
                }}
              >
                Mark as Manual Entry
              </button>
            )}
            {(venue.scrape_failed || venue.manual_entry_required) && (
              <button
                onClick={() => clearIssue(venue)}
                style={{ ...pillStyle, color: 'rgba(0,0,0,0.4)', border: '1px solid rgba(0,0,0,0.2)' }}
              >
                Clear Issue
              </button>
            )}
            {venue.scrapable ? (
              <button
                onClick={() => setScrapable(venue, false)}
                style={{ ...pillStyle, color: 'rgba(0,0,0,0.5)', border: '1px solid rgba(0,0,0,0.25)' }}
              >
                Don&apos;t Scrape
              </button>
            ) : (
              <button
                onClick={() => setScrapable(venue, true)}
                style={{ ...pillStyle, color: '#166534', border: '1px solid #166534' }}
              >
                Resume Scraping
              </button>
            )}
            <button
              onClick={() => setInstitutionStatus(venue, 'closed')}
              style={{ ...pillStyle, color: '#991b1b', border: '1px solid #991b1b' }}
            >
              Mark Closed
            </button>
            <button
              onClick={() => setInstitutionStatus(venue, 'not_relevant')}
              style={{ ...pillStyle, color: 'rgba(0,0,0,0.5)', border: '1px solid rgba(0,0,0,0.25)' }}
            >
              Not Relevant
            </button>
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
