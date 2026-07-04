'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import TipTapEditor from './TipTapEditor'

type ScrapeFailedVenue = {
  id: string
  name: string
  exhibitions_url: string
}

type PendingEx = {
  id: string
  show_title: string
  artists: string[]
  institution_name: string
  venue_type: string
  venue_name: string
  venue_url: string | null
  start_date: string | null
  end_date: string | null
  is_ongoing: boolean
  description: string | null
  image_url: string | null
  press_release: string | null
  admin_notes: string | null
  address_override: string | null
  address_override_neighborhood: string | null
  venue_address: string | null
  venue_neighborhood: string | null
  missing_fields: string[]
  created_at: string
  prereads: { id: string; article_title: string | null; publication: string | null; article_url: string | null }[]
}

const F = 'var(--font-inter-tight), system-ui, sans-serif'
const AMBER = '#C95712'

function fmtDate(d: string | null) {
  if (!d) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function fmtDateRange(start: string | null, end: string | null, isOngoing: boolean) {
  if (!start && !end) return 'Dates TBD'
  if (start && end) return `${fmtDate(start)} – ${fmtDate(end)}`
  if (start) return `${fmtDate(start)} – Ongoing`
  if (isOngoing) return `${fmtDate(start)} – Ongoing`
  return fmtDate(end)
}

function fmtScrapeDate(iso: string) {
  return `Scraped ${new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
}

// ─── date filter helpers ───────────────────────────────────────────────────
function startOfDay(d: Date) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}
function daysAgo(n: number) {
  const x = startOfDay(new Date())
  x.setDate(x.getDate() - n)
  return x
}

type ScrapedFilter = 'today' | 'yesterday' | '7d' | '30d' | null
type StatusFilter = 'current' | 'upcoming' | null
type InstType = 'museum' | 'gallery' | 'fair'

function matchesScrapedDate(createdAt: string, filter: ScrapedFilter) {
  if (!filter) return true
  const created = new Date(createdAt)
  const cutoff = { today: daysAgo(0), yesterday: daysAgo(1), '7d': daysAgo(7), '30d': daysAgo(30) }[filter]
  return created >= cutoff
}

function matchesStatus(ex: PendingEx, filter: StatusFilter) {
  if (!filter) return true
  const today = startOfDay(new Date())
  const start = ex.start_date ? startOfDay(new Date(ex.start_date + 'T00:00:00')) : null
  const end = ex.end_date ? startOfDay(new Date(ex.end_date + 'T00:00:00')) : null
  if (filter === 'upcoming') return !!start && start > today
  const startOk = !start || start <= today
  const endOk = !end || end >= today
  return startOk && endOk
}

// ─── shared styles ──────────────────────────────────────────────────────────
const lbl: React.CSSProperties = {
  display: 'block', fontSize: 10, fontWeight: 700,
  letterSpacing: '0.12em', textTransform: 'uppercase',
  color: 'rgba(0,0,0,0.4)', marginBottom: 4, fontFamily: F,
}

function fieldInput(missing: boolean): React.CSSProperties {
  return {
    width: '100%', fontFamily: F, fontSize: 13, color: '#000',
    background: '#FFFCEC', padding: '9px 14px', outline: 'none', boxSizing: 'border-box',
    border: missing ? '1px solid #f59e0b' : '1px solid #000', borderRadius: 999,
  }
}

const readOnlyRow: React.CSSProperties = {
  fontFamily: F, fontSize: 13, color: 'rgba(0,0,0,0.7)', lineHeight: 1.5,
}

const pillBtn: React.CSSProperties = {
  fontFamily: F, fontSize: 11, fontWeight: 700,
  letterSpacing: '0.1em', textTransform: 'uppercase',
  width: 150, height: 42, border: '1px solid #000', borderRadius: 999,
  cursor: 'pointer', color: '#000',
}

// ─── filter pill (text-only, bold when active) ─────────────────────────────
function FilterOption({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        fontFamily: F, fontSize: 14, fontWeight: active ? 700 : 400,
        background: 'transparent', border: 'none', cursor: 'pointer',
        color: '#000', padding: 0,
      }}
    >
      {children}
    </button>
  )
}

// ─── filter group label — plain text toggle, bold while it has an active selection ──
function FilterLabel({ active, onClick, children, gridArea }: { active: boolean; onClick: () => void; children: React.ReactNode; gridArea: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        gridArea,
        fontFamily: F, fontSize: 14, fontWeight: active ? 700 : 400,
        background: 'transparent', border: 'none', cursor: 'pointer',
        color: '#000', padding: 0, textAlign: 'left',
      }}
    >
      {children}
    </button>
  )
}

function Collapsible({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div style={{
      overflow: 'hidden',
      maxHeight: open ? 3000 : 0,
      opacity: open ? 1 : 0,
      transition: 'max-height 320ms ease, opacity 220ms ease',
    }}>
      {children}
    </div>
  )
}

// ─── grid card ──────────────────────────────────────────────────────────────
function PendingCard({ ex, onOpen }: { ex: PendingEx; onOpen: () => void }) {
  const missing = ex.missing_fields ?? []
  return (
    <div onClick={onOpen} style={{ cursor: 'pointer', fontFamily: F }}>
      <div style={{ width: '100%', aspectRatio: '812 / 766', background: '#e0ddd0', overflow: 'hidden' }}>
        {ex.image_url && (
          <img src={ex.image_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        )}
      </div>
      <div style={{ marginTop: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 400, lineHeight: '18px', color: '#000' }}>{ex.show_title}</div>
        <div style={{ fontSize: 14, fontWeight: 400, lineHeight: '18px', color: '#000' }}>{ex.institution_name}</div>
        <div style={{ fontSize: 14, fontWeight: 400, lineHeight: '18px', color: 'rgba(0,0,0,0.5)' }}>{fmtScrapeDate(ex.created_at)}</div>
      </div>
      {missing.length > 0 && (
        <div style={{ fontSize: 14, fontWeight: 400, lineHeight: '18px', color: AMBER, marginTop: 4 }}>
          Missing {missing.map(f => f.replace(/_/g, ' ')).join(', ')}
        </div>
      )}
    </div>
  )
}

// ─── edit modal ─────────────────────────────────────────────────────────────
function EditModal({
  ex,
  onClose,
  onRemove,
  onPublished,
}: {
  ex: PendingEx
  onClose: () => void
  onRemove: (id: string) => void
  onPublished: (id: string) => void
}) {
  const [showTitle, setShowTitle]   = useState(ex.show_title)
  const [startDate, setStartDate]   = useState(ex.start_date ?? '')
  const [endDate, setEndDate]       = useState(ex.end_date ?? '')
  const [imageUrl, setImageUrl]     = useState(ex.image_url ?? '')
  const [addr, setAddr]             = useState(ex.address_override ?? '')
  const [neigh, setNeigh]           = useState(ex.address_override_neighborhood ?? '')
  const [adminNotes, setAdminNotes] = useState(ex.admin_notes ?? '')
  const [showDesc, setShowDesc]     = useState(false)
  const [showFeedback, setShowFeedback] = useState(false)
  const [saving, setSaving]         = useState(false)
  const [approving, setApproving]   = useState(false)
  const [deleting, setDeleting]     = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [msg, setMsg]               = useState('')
  const [notesSaveStatus, setNotesSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const notesRef = useRef(adminNotes)
  notesRef.current = adminNotes

  const isMuseum = ex.venue_type === 'museum'
  const prLabel = isMuseum ? 'Exhibition Description' : 'Press Release'
  const prValue = ex.press_release ?? ex.description ?? ''

  const isDirty =
    showTitle !== ex.show_title ||
    startDate !== (ex.start_date ?? '') ||
    endDate   !== (ex.end_date ?? '') ||
    imageUrl  !== (ex.image_url ?? '') ||
    addr      !== (ex.address_override ?? '') ||
    neigh     !== (ex.address_override_neighborhood ?? '')

  const missing = new Set(ex.missing_fields ?? [])

  function flash(m: string) {
    setMsg(m)
    setTimeout(() => setMsg(''), 2500)
  }

  function fieldPatchBody() {
    return {
      show_title:                    showTitle,
      start_date:                    startDate || null,
      end_date:                      endDate || null,
      image_url:                     imageUrl || null,
      address_override:              addr || null,
      address_override_neighborhood: neigh || null,
    }
  }

  async function save() {
    setSaving(true)
    try {
      const res = await fetch(`/api/admin/exhibitions/${ex.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fieldPatchBody()),
      })
      if (!res.ok) throw new Error()
      flash('Saved')
    } catch {
      flash('Error saving')
    } finally {
      setSaving(false)
    }
  }

  async function saveNotes() {
    const val = notesRef.current
    if (val === (ex.admin_notes ?? '')) return
    setNotesSaveStatus('saving')
    try {
      const res = await fetch(`/api/admin/exhibitions/${ex.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_notes: val || null }),
      })
      if (!res.ok) throw new Error()
      setNotesSaveStatus('saved')
      setTimeout(() => setNotesSaveStatus((cur) => (cur === 'saved' ? 'idle' : cur)), 2000)
    } catch {
      setNotesSaveStatus('error')
    }
  }

  async function approve() {
    setApproving(true)
    try {
      if (isDirty) {
        const patchRes = await fetch(`/api/admin/exhibitions/${ex.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(fieldPatchBody()),
        })
        if (!patchRes.ok) throw new Error()
      }
      const res = await fetch(`/api/admin/exhibitions/${ex.id}/approve`, { method: 'POST' })
      if (!res.ok) throw new Error()
      onPublished(ex.id)
    } catch {
      flash('Error approving')
      setApproving(false)
    }
  }

  async function doDelete() {
    setDeleting(true)
    try {
      await fetch(`/api/admin/exhibitions/${ex.id}`, { method: 'DELETE' })
      onRemove(ex.id)
    } finally {
      setDeleting(false)
    }
  }

  const dateDisplay = fmtDateRange(startDate || null, endDate || null, ex.is_ongoing)

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24, zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#FFFCEC', width: '100%', maxWidth: 1120, maxHeight: '90vh',
          overflowY: 'auto', display: 'flex', position: 'relative', fontFamily: F,
        }}
        className="pending-modal"
      >
        <button
          onClick={onClose}
          style={{
            position: 'absolute', top: 16, right: 20, background: 'transparent',
            border: 'none', cursor: 'pointer', fontSize: 20, color: '#000', fontFamily: F,
          }}
        >
          ✕
        </button>

        <div className="pending-modal-image" style={{ flex: '0 0 45%', background: '#e0ddd0', minHeight: 320 }}>
          {imageUrl && <img src={imageUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
        </div>

        <div style={{ flex: 1, padding: '48px 40px 32px', display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 }}>

          <div>
            <label style={lbl}>Exhibition Name</label>
            <input type="text" value={showTitle} onChange={e => setShowTitle(e.target.value)} style={fieldInput(false)} />
          </div>

          <div>
            <label style={lbl}>Venue</label>
            <div style={readOnlyRow}>{ex.venue_name}</div>
          </div>

          <div>
            <label style={lbl}>Artist(s)</label>
            <div style={readOnlyRow}>{ex.artists.length ? ex.artists.join(', ') : '—'}</div>
          </div>

          <div style={{ display: 'flex', gap: 16 }}>
            <div style={{ flex: 1 }}>
              <label style={{ ...lbl, color: missing.has('start_date') ? '#92400e' : 'rgba(0,0,0,0.4)' }}>Start Date</label>
              <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={fieldInput(missing.has('start_date'))} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ ...lbl, color: missing.has('end_date') ? '#92400e' : 'rgba(0,0,0,0.4)' }}>End Date</label>
              <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} style={fieldInput(missing.has('end_date'))} />
            </div>
          </div>
          <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.4)', marginTop: -12 }}>{dateDisplay}</div>

          <div>
            <label style={{ ...lbl, color: missing.has('image_url') ? '#92400e' : 'rgba(0,0,0,0.4)' }}>Image URL</label>
            <input type="text" value={imageUrl} onChange={e => setImageUrl(e.target.value)} placeholder="https://…" style={fieldInput(missing.has('image_url'))} />
          </div>

          <div style={{ display: 'flex', gap: 16 }}>
            <div style={{ flex: 1 }}>
              <label style={lbl}>Address Override</label>
              <input type="text" value={addr} onChange={e => setAddr(e.target.value)} placeholder={ex.venue_address ?? 'Venue default'} style={fieldInput(false)} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={lbl}>Neighborhood Override</label>
              <input type="text" value={neigh} onChange={e => setNeigh(e.target.value)} placeholder={ex.venue_neighborhood ?? 'Venue default'} style={fieldInput(false)} />
            </div>
          </div>

          {/* Description / Press Release — collapsible rich text */}
          <div>
            <button
              onClick={() => setShowDesc(v => !v)}
              style={{ fontFamily: F, fontSize: 13, background: 'transparent', border: 'none', cursor: 'pointer', color: missing.has('press_release') ? '#92400e' : '#000', padding: 0, display: 'flex', alignItems: 'center', gap: 6 }}
            >
              <span style={{ display: 'inline-block', transition: 'transform 200ms ease', transform: showDesc ? 'rotate(90deg)' : 'rotate(0deg)' }}>›</span>
              {showDesc ? 'Hide' : 'Edit'} {prLabel}
              {missing.has('press_release') && ' *'}
            </button>
            <Collapsible open={showDesc}>
              <TipTapEditor
                key={ex.id + '-pr'}
                initialValue={prValue}
                exhibitionId={ex.id}
                field="press_release"
                placeholder={isMuseum ? 'Exhibition description…' : 'Paste press release…'}
                borderColor={missing.has('press_release') ? '#f59e0b' : 'rgba(0,0,0,0.18)'}
              />
            </Collapsible>
          </div>

          {/* Scraper feedback — collapsible plain textarea, auto-saves on blur */}
          <div>
            <button
              onClick={() => setShowFeedback(v => !v)}
              style={{ fontFamily: F, fontSize: 13, background: 'transparent', border: 'none', cursor: 'pointer', color: '#000', padding: 0, display: 'flex', alignItems: 'center', gap: 6 }}
            >
              <span style={{ display: 'inline-block', transition: 'transform 200ms ease', transform: showFeedback ? 'rotate(90deg)' : 'rotate(0deg)' }}>›</span>
              Scraper Feedback
            </button>
            <Collapsible open={showFeedback}>
              <textarea
                value={adminNotes}
                onChange={e => setAdminNotes(e.target.value)}
                onBlur={saveNotes}
                placeholder="Note anything about scraper quality, data issues, or context for Claude Code improvements…"
                rows={3}
                style={{
                  display: 'block', width: '100%', fontFamily: F, marginTop: 8,
                  fontSize: 12, lineHeight: 1.6, color: '#000', background: '#FFFCEC',
                  border: '1px solid rgba(0,0,0,0.25)', borderRadius: 12, padding: '8px 12px',
                  outline: 'none', resize: 'vertical', boxSizing: 'border-box',
                }}
              />
              <div style={{ fontFamily: F, fontSize: 11, marginTop: 4, minHeight: 16 }}>
                {notesSaveStatus === 'saving' && <span style={{ color: 'rgba(0,0,0,0.35)' }}>Saving…</span>}
                {notesSaveStatus === 'saved' && <span style={{ color: '#1a5c2a' }}>Saved</span>}
                {notesSaveStatus === 'error' && (
                  <span style={{ color: '#dc2626' }}>
                    Save failed —{' '}
                    <button
                      type="button"
                      onClick={saveNotes}
                      style={{ fontFamily: F, fontSize: 11, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', color: '#dc2626', textDecoration: 'underline' }}
                    >
                      retry?
                    </button>
                  </span>
                )}
              </div>
            </Collapsible>
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginTop: 8 }}>
            <button
              onClick={save}
              disabled={saving || !isDirty}
              style={{ ...pillBtn, background: '#FFFCEC', opacity: isDirty ? 1 : 0.4, cursor: isDirty ? 'pointer' : 'default' }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>

            <button onClick={approve} disabled={approving} style={{ ...pillBtn, background: '#58914480', opacity: approving ? 0.6 : 1 }}>
              {approving ? 'Publishing…' : 'Approve'}
            </button>

            {confirmDel ? (
              <>
                <button onClick={doDelete} disabled={deleting} style={{ ...pillBtn, background: '#E62F2E80' }}>
                  {deleting ? 'Deleting…' : 'Confirm?'}
                </button>
                <button onClick={() => setConfirmDel(false)} style={{ ...pillBtn, background: '#FFFCEC' }}>
                  Cancel
                </button>
              </>
            ) : (
              <button onClick={() => setConfirmDel(true)} style={{ ...pillBtn, background: '#E62F2E80' }}>
                Delete
              </button>
            )}

            {msg && <span style={{ fontSize: 12, color: msg === 'Saved' ? '#1a5c2a' : '#dc2626' }}>{msg}</span>}
          </div>

          <div style={{ fontSize: 11, color: 'rgba(0,0,0,0.3)' }}>{ex.prereads.length} prereads</div>
        </div>
      </div>

      <style>{`
        @media (max-width: 800px) {
          .pending-modal { flex-direction: column; max-height: 92vh; }
          .pending-modal-image { flex: 0 0 260px !important; }
        }
      `}</style>
    </div>
  )
}

// ─── scrape-failed venues list (unchanged feature, kept below the grid) ────
function ScrapeFailed({ venues, onRetried }: { venues: ScrapeFailedVenue[]; onRetried: (id: string) => void }) {
  const [retrying, setRetrying] = useState<Record<string, boolean>>({})
  const [msgs, setMsgs] = useState<Record<string, string>>({})

  async function retry(id: string) {
    setRetrying((prev) => ({ ...prev, [id]: true }))
    try {
      const res = await fetch(`/api/admin/venues/${id}/retry-scrape`, { method: 'POST' })
      if (!res.ok) throw new Error()
      setMsgs((prev) => ({ ...prev, [id]: 'Retry started' }))
      setTimeout(() => {
        setMsgs((prev) => ({ ...prev, [id]: '' }))
        onRetried(id)
      }, 3000)
    } catch {
      setMsgs((prev) => ({ ...prev, [id]: 'Error' }))
    } finally {
      setRetrying((prev) => ({ ...prev, [id]: false }))
    }
  }

  return (
    <div style={{ marginTop: 48, borderTop: '1px solid rgba(0,0,0,0.1)', paddingTop: 28 }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#dc2626', marginBottom: 16, fontFamily: F }}>
        Scrape Failed ({venues.length})
      </div>
      {venues.map((v) => (
        <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '10px 0', borderBottom: '1px solid rgba(0,0,0,0.06)', fontFamily: F }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#000' }}>{v.name}</div>
            <a href={v.exhibitions_url} target="_blank" rel="noopener noreferrer"
              style={{ fontSize: 11, color: 'rgba(0,0,0,0.4)', textDecoration: 'none', borderBottom: '1px solid rgba(0,0,0,0.2)' }}>
              {v.exhibitions_url}
            </a>
          </div>
          <button
            onClick={() => retry(v.id)}
            disabled={retrying[v.id]}
            style={{ fontFamily: F, fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '6px 14px', border: 'none', borderRadius: 999, cursor: 'pointer', background: retrying[v.id] ? 'rgba(0,0,0,0.1)' : '#000', color: '#FFFCEC', opacity: retrying[v.id] ? 0.6 : 1 }}
          >
            {retrying[v.id] ? 'Retrying…' : 'Retry Scrape'}
          </button>
          {msgs[v.id] && (
            <span style={{ fontSize: 11, color: msgs[v.id] === 'Retry started' ? '#1a5c2a' : '#dc2626' }}>
              {msgs[v.id]}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

// ─── filter bar ─────────────────────────────────────────────────────────────
const SCRAPED_OPTIONS: { value: Exclude<ScrapedFilter, null>; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: '7d', label: '7 Days' },
  { value: '30d', label: '30 Days' },
]
const STATUS_OPTIONS: { value: Exclude<StatusFilter, null>; label: string }[] = [
  { value: 'current', label: 'Current' },
  { value: 'upcoming', label: 'Upcoming' },
]
const TYPE_OPTIONS: { value: InstType; label: string }[] = [
  { value: 'museum', label: 'Museums' },
  { value: 'gallery', label: 'Galleries' },
  { value: 'fair', label: 'Fairs' },
]

export default function PendingTab({ onCount }: { onCount: (n: number) => void }) {
  const [exhibitions, setExhibitions] = useState<PendingEx[]>([])
  const [failedVenues, setFailedVenues] = useState<ScrapeFailedVenue[]>([])
  const [loading, setLoading] = useState(true)
  const [openId, setOpenId] = useState<string | null>(null)

  const [instTypes, setInstTypes] = useState<Set<InstType>>(new Set())
  const [instSearch, setInstSearch] = useState('')
  const [scrapedFilter, setScrapedFilter] = useState<ScrapedFilter>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(null)
  const [openGroup, setOpenGroup] = useState<'type' | 'name' | 'scraped' | 'status' | null>(null)
  const filterBarRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (filterBarRef.current && !filterBarRef.current.contains(e.target as Node)) {
        setOpenGroup(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [exRes, venueRes] = await Promise.all([
        fetch('/api/admin/exhibitions'),
        fetch('/api/admin/venues'),
      ])
      const all = await exRes.json()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pending = all.filter((e: any) => e.status === 'pending')
      setExhibitions(pending)
      onCount(pending.length)

      const failed = await venueRes.json()
      setFailedVenues(Array.isArray(failed) ? failed : [])
    } finally {
      setLoading(false)
    }
  }, [onCount])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    onCount(exhibitions.length)
  }, [exhibitions.length, onCount])

  function remove(id: string) {
    setExhibitions((prev) => prev.filter((e) => e.id !== id))
    setOpenId((cur) => (cur === id ? null : cur))
  }

  function removeFailedVenue(id: string) {
    setFailedVenues((prev) => prev.filter((v) => v.id !== id))
  }

  function toggleType(t: InstType) {
    setInstTypes((prev) => {
      const next = new Set(prev)
      if (next.has(t)) next.delete(t); else next.add(t)
      return next
    })
  }

  const filtered = useMemo(() => {
    const q = instSearch.toLowerCase().trim()
    return exhibitions.filter((e) => {
      if (instTypes.size > 0 && !instTypes.has(e.venue_type as InstType)) return false
      if (q && !e.institution_name.toLowerCase().includes(q)) return false
      if (!matchesScrapedDate(e.created_at, scrapedFilter)) return false
      if (!matchesStatus(e, statusFilter)) return false
      return true
    })
  }, [exhibitions, instTypes, instSearch, scrapedFilter, statusFilter])

  const openEx = openId ? exhibitions.find((e) => e.id === openId) ?? null : null

  if (loading) return <p style={{ fontFamily: F, fontSize: 13, color: 'rgba(0,0,0,0.4)' }}>Loading…</p>

  return (
    <div style={{ fontFamily: F }}>
      <div style={{ fontSize: 16, marginBottom: 24, color: '#000' }}>Filters</div>

      <div ref={filterBarRef} className="pending-filters">
        {/* row 1 — group labels */}
        <FilterLabel gridArea="typeLabel" active={instTypes.size > 0} onClick={() => setOpenGroup((cur) => (cur === 'type' ? null : 'type'))}>
          Institution Type
        </FilterLabel>
        <FilterLabel gridArea="nameLabel" active={instSearch.trim() !== ''} onClick={() => setOpenGroup((cur) => (cur === 'name' ? null : 'name'))}>
          Institution Name
        </FilterLabel>
        <FilterLabel gridArea="scrapedLabel" active={scrapedFilter !== null} onClick={() => setOpenGroup((cur) => (cur === 'scraped' ? null : 'scraped'))}>
          Scraped Date
        </FilterLabel>
        <FilterLabel gridArea="statusLabel" active={statusFilter !== null} onClick={() => setOpenGroup((cur) => (cur === 'status' ? null : 'status'))}>
          Current vs. Upcoming
        </FilterLabel>

        {/* row 2 — whichever group is open reveals its content in place, same column. Content is
            allowed to overflow its 150px column into the (empty) neighboring columns, same as
            the Paper mock, since only one group's content is ever shown at a time. */}
        <div style={{ gridArea: 'typeBody', display: 'flex', gap: 20, flexWrap: 'nowrap', width: 'max-content' }}>
          {openGroup === 'type' && TYPE_OPTIONS.map((o) => (
            <FilterOption key={o.value} active={instTypes.has(o.value)} onClick={() => toggleType(o.value)}>
              {o.label}
            </FilterOption>
          ))}
        </div>

        <div style={{ gridArea: 'nameBody' }}>
          {openGroup === 'name' && (
            <input
              type="text"
              autoFocus
              value={instSearch}
              onChange={(e) => setInstSearch(e.target.value)}
              placeholder="Search…"
              style={{ ...fieldInput(false), width: '100%', maxWidth: 200, padding: '4px 10px', fontSize: 14 }}
            />
          )}
        </div>

        <div style={{ gridArea: 'scrapedBody', display: 'flex', gap: 20, flexWrap: 'nowrap', width: 'max-content' }}>
          {openGroup === 'scraped' && SCRAPED_OPTIONS.map((o) => (
            <FilterOption key={o.value} active={scrapedFilter === o.value} onClick={() => setScrapedFilter((cur) => (cur === o.value ? null : o.value))}>
              {o.label}
            </FilterOption>
          ))}
        </div>

        <div style={{ gridArea: 'statusBody', display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          {openGroup === 'status' && STATUS_OPTIONS.map((o) => (
            <FilterOption key={o.value} active={statusFilter === o.value} onClick={() => setStatusFilter((cur) => (cur === o.value ? null : o.value))}>
              {o.label}
            </FilterOption>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <p style={{ fontSize: 13, color: 'rgba(0,0,0,0.4)' }}>No pending exhibitions match these filters.</p>
      ) : (
        <div className="pending-grid">
          {filtered.map((ex) => (
            <PendingCard key={ex.id} ex={ex} onOpen={() => setOpenId(ex.id)} />
          ))}
        </div>
      )}

      {openEx && (
        <EditModal
          ex={openEx}
          onClose={() => setOpenId(null)}
          onRemove={remove}
          onPublished={remove}
        />
      )}

      {failedVenues.length > 0 && (
        <ScrapeFailed venues={failedVenues} onRetried={removeFailedVenue} />
      )}

      <style>{`
        .pending-filters {
          display: grid;
          grid-template-columns: 150px 150px 150px auto;
          grid-template-areas:
            "typeLabel nameLabel scrapedLabel statusLabel"
            "typeBody  nameBody  scrapedBody  statusBody";
          row-gap: 6px;
          align-items: start;
          margin-bottom: 32px;
        }
        @media (max-width: 900px) {
          .pending-filters {
            grid-template-columns: repeat(2, 1fr);
            grid-template-areas:
              "typeLabel nameLabel"
              "typeBody nameBody"
              "scrapedLabel statusLabel"
              "scrapedBody statusBody";
            row-gap: 16px;
          }
        }
        @media (max-width: 520px) {
          .pending-filters {
            grid-template-columns: 1fr;
            grid-template-areas:
              "typeLabel" "typeBody"
              "nameLabel" "nameBody"
              "scrapedLabel" "scrapedBody"
              "statusLabel" "statusBody";
          }
        }
        .pending-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 72px 10px;
        }
        @media (max-width: 900px) {
          .pending-grid { grid-template-columns: 1fr; }
        }
      `}</style>
    </div>
  )
}
