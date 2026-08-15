'use client'

import { useState, useId, useEffect } from 'react'
import { adminFetch, setAdminSecret } from '@/lib/admin-fetch'

// ── Types ─────────────────────────────────────────────────────────────────────

const F = 'var(--font-inter-tight), system-ui, sans-serif'
const MONO = 'var(--font-ibm-plex-mono), "IBM Plex Mono", monospace'

const TYPES = ['gallery', 'museum', 'nonprofit', 'experimental'] as const
type InstType = typeof TYPES[number]

type DayKey = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday'
type HoursDay = [string, string] | null
type HoursMap = Record<DayKey, HoursDay>

const DAYS: DayKey[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
const DAY_SHORT: Record<DayKey, string> = {
  monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu',
  friday: 'Fri', saturday: 'Sat', sunday: 'Sun',
}

const DEFAULT_HOURS: HoursMap = {
  monday: null,
  tuesday: ['10:00', '18:00'],
  wednesday: ['10:00', '18:00'],
  thursday: ['10:00', '18:00'],
  friday: ['10:00', '18:00'],
  saturday: ['10:00', '18:00'],
  sunday: null,
}

type GeoStatus = 'idle' | 'loading' | 'ok' | 'failed'

interface VenueDraft {
  _id: string
  name: string
  exhibitions_url: string
  address: string
  neighborhood: string
  latitude: string
  longitude: string
  hours: HoursMap
  // Scraping hint written while reviewing the batch, when you have the gallery's
  // site open anyway. Stored on the venue and fed to the extractor on every
  // scrape — the alternative is discovering the same thing next week from a
  // zero_links failure.
  scrape_notes: string
  _hoursOpen: boolean
  _notesOpen: boolean
  _geoStatus: GeoStatus
  _addressFallback: boolean
  _hoursFallback: boolean
}

interface InstitutionDraft {
  _id: string
  name: string
  website: string
  type: InstType
  venues: VenueDraft[]
  _dupWarning?: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

let _counter = 0
function uid() { return `d${++_counter}` }

function blankVenue(): VenueDraft {
  return {
    _id: uid(), name: '', exhibitions_url: '', address: '',
    neighborhood: '', latitude: '', longitude: '',
    hours: { ...DEFAULT_HOURS }, scrape_notes: '',
    _hoursOpen: false, _notesOpen: false, _geoStatus: 'idle',
    _addressFallback: false, _hoursFallback: false,
  }
}

function venueFromRaw(v: Record<string, unknown>): VenueDraft {
  return {
    _id: uid(),
    name: String(v.name ?? ''),
    exhibitions_url: String(v.exhibitions_url ?? ''),
    address: String(v.address ?? ''),
    neighborhood: String(v.neighborhood ?? ''),
    latitude: v.latitude != null ? String(v.latitude) : '',
    longitude: v.longitude != null ? String(v.longitude) : '',
    hours: { ...DEFAULT_HOURS },
    scrape_notes: String(v.scrape_notes ?? ''),
    _hoursOpen: false,
    _notesOpen: false,
    _geoStatus: 'idle',
    _addressFallback: false,
    _hoursFallback: false,
  }
}

function institutionFromRaw(inst: Record<string, unknown>): InstitutionDraft {
  const rawVenues = Array.isArray(inst.venues) ? inst.venues as Record<string, unknown>[] : []
  return {
    _id: uid(),
    name: String(inst.name ?? ''),
    website: String(inst.website ?? ''),
    type: (TYPES.includes(inst.type as InstType) ? inst.type : 'gallery') as InstType,
    venues: rawVenues.map(venueFromRaw),
    _dupWarning: typeof inst._dupWarning === 'string' ? inst._dupWarning : undefined,
  }
}

// Draft → insert-route payload. Single definition so a per-row insert, a batch
// insert and Manual Entry can never send subtly different shapes.
function toPayload(inst: InstitutionDraft) {
  return {
    name: inst.name.trim(),
    website: inst.website.trim(),
    type: inst.type,
    venues: inst.venues.map(v => ({
      name: v.name.trim(),
      exhibitions_url: v.exhibitions_url.trim(),
      address: v.address.trim(),
      neighborhood: v.neighborhood.trim(),
      latitude: v.latitude.trim(),
      longitude: v.longitude.trim(),
      hours: v.hours,
      scrape_notes: v.scrape_notes,
    })),
  }
}

// ── Shared style objects ──────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  fontFamily: F, fontSize: 13, color: '#000',
  background: '#fff', border: '1px solid rgba(0,0,0,0.18)',
  padding: '6px 8px', outline: 'none', width: '100%', boxSizing: 'border-box',
}

// Field and button styling mirrors the pending-exhibition editor in PendingTab —
// the two review surfaces do the same job (check a scraped/generated draft, fix
// it, commit it) and should not look like two different tools.
function pillInput(flagged = false): React.CSSProperties {
  return {
    width: '100%', fontFamily: F, fontSize: 13, color: '#000',
    background: '#FFFCEC', padding: '9px 14px', outline: 'none', boxSizing: 'border-box',
    border: flagged ? '1px solid #f59e0b' : '1px solid #000', borderRadius: 999,
  }
}

const pillBtn: React.CSSProperties = {
  fontFamily: F, fontSize: 11, fontWeight: 700,
  letterSpacing: '0.1em', textTransform: 'uppercase' as const,
  minWidth: 130, height: 42, padding: '0 18px',
  border: '1px solid #000', borderRadius: 999, cursor: 'pointer', color: '#000',
}

const AMBER = '#C95712'

const labelStyle: React.CSSProperties = {
  display: 'block', fontFamily: F, fontSize: 10, fontWeight: 700,
  letterSpacing: '0.12em', textTransform: 'uppercase' as const,
  color: 'rgba(0,0,0,0.4)', marginBottom: 6,
}

const btnSecondary: React.CSSProperties = {
  fontFamily: F, fontSize: 11, background: 'transparent',
  border: '1px solid rgba(0,0,0,0.2)', borderRadius: 999, padding: '4px 10px',
  cursor: 'pointer', color: 'rgba(0,0,0,0.6)',
}

const warnBadge: React.CSSProperties = {
  flexShrink: 0, fontFamily: F, fontSize: 10, fontWeight: 700,
  letterSpacing: '0.08em', textTransform: 'uppercase' as const,
  padding: '2px 6px', whiteSpace: 'nowrap' as const, cursor: 'help',
  background: '#fef3c7', color: '#92400e', border: '1px solid #fcd34d',
}

// ── HoursInput ────────────────────────────────────────────────────────────────

function HoursInput({ value, onChange }: { value: HoursMap; onChange: (v: HoursMap) => void }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {DAYS.map(day => {
        const times = value[day]
        const isOpen = times !== null && times !== undefined
        return (
          <div key={day} style={{
            display: 'flex', alignItems: 'center', gap: 5,
            padding: '5px 8px', background: '#fff',
            border: `1px solid ${isOpen ? 'rgba(0,0,0,0.18)' : 'rgba(0,0,0,0.08)'}`,
            opacity: isOpen ? 1 : 0.6,
          }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', userSelect: 'none' as const }}>
              <input
                type="checkbox"
                checked={isOpen}
                onChange={e => onChange({ ...value, [day]: e.target.checked ? ['10:00', '18:00'] : null })}
                style={{ cursor: 'pointer', margin: 0 }}
              />
              <span style={{ fontFamily: F, fontSize: 11, fontWeight: 700, color: 'rgba(0,0,0,0.55)', width: 28 }}>
                {DAY_SHORT[day]}
              </span>
            </label>
            {isOpen ? (
              <>
                <input
                  type="time"
                  value={times[0]}
                  onChange={e => onChange({ ...value, [day]: [e.target.value, times[1]] })}
                  style={{ ...inputStyle, width: 88, padding: '3px 5px', fontSize: 12 }}
                />
                <span style={{ fontSize: 11, color: 'rgba(0,0,0,0.3)' }}>–</span>
                <input
                  type="time"
                  value={times[1]}
                  onChange={e => onChange({ ...value, [day]: [times[0], e.target.value] })}
                  style={{ ...inputStyle, width: 88, padding: '3px 5px', fontSize: 12 }}
                />
              </>
            ) : (
              <span style={{ fontFamily: F, fontSize: 11, color: 'rgba(0,0,0,0.3)' }}>closed</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Draft issue flags ────────────────────────────────────────────────────────

// A venue nobody has typed into yet — the blank row Manual Entry starts with.
// Flagging every one of its fields as missing before the first keystroke is
// noise, so an untouched venue reports nothing. Drafts from AI Suggest or the
// CSV always arrive with at least a name, so they are never silenced by this.
function isUntouchedVenue(v: VenueDraft): boolean {
  return !v.name.trim() && !v.exhibitions_url.trim() && !v.address.trim()
    && !v.neighborhood.trim() && !v.latitude.trim() && !v.longitude.trim()
}

// What still needs a human eye on this venue. Surfaced on the collapsed row so
// a batch can be triaged without opening every card.
function venueIssues(v: VenueDraft): string[] {
  if (isUntouchedVenue(v)) return []
  const out: string[] = []
  if (!v.name.trim()) out.push('no venue name')
  if (!v.exhibitions_url.trim()) out.push('no exhibitions URL')
  if (!v.address.trim()) out.push('no address')
  else if (v._addressFallback) out.push('address unverified')
  if (!v.latitude || !v.longitude) out.push('no coordinates')
  if (v._hoursFallback) out.push('hours guessed')
  return out
}

function institutionIssues(inst: InstitutionDraft): string[] {
  const out: string[] = []
  if (!inst.name.trim()) out.push('no name')
  if (inst._dupWarning) out.push('possible duplicate')
  if (inst.venues.length === 0) out.push('no venues')
  if (inst.venues.length > 1) out.push(`${inst.venues.length} venues — verify each`)
  // Collapse per-venue issues to one mention each; on a multi-venue institution
  // the row would otherwise repeat "no coordinates" three times.
  const seen = new Set<string>()
  for (const v of inst.venues) {
    for (const issue of venueIssues(v)) {
      if (!seen.has(issue)) { seen.add(issue); out.push(issue) }
    }
  }
  return out
}

// ── Collapsible section toggle (matches the pending editor) ──────────────────

function SectionToggle({
  open, onToggle, label, flagged,
}: {
  open: boolean
  onToggle: () => void
  label: string
  flagged?: boolean
}) {
  return (
    <button
      onClick={onToggle}
      style={{
        fontFamily: F, fontSize: 13, background: 'transparent', border: 'none',
        cursor: 'pointer', color: flagged ? '#92400e' : '#000', padding: 0,
        display: 'flex', alignItems: 'center', gap: 6,
      }}
    >
      <span style={{ display: 'inline-block', transition: 'transform 200ms ease', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}>›</span>
      {label}
    </button>
  )
}

// ── GeoField ─────────────────────────────────────────────────────────────────

function GeoField({ venue, onUpdate }: {
  venue: VenueDraft
  onUpdate: (partial: Partial<VenueDraft>) => void
}) {
  const missing = !isUntouchedVenue(venue) && (!venue.latitude || !venue.longitude)

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' as const }}>
      <div style={{ flex: '2 1 200px', minWidth: 180, position: 'relative' as const }}>
        <label style={labelStyle}>Lat</label>
        <input
          style={pillInput(missing)}
          value={venue.latitude}
          onChange={e => onUpdate({ latitude: e.target.value, _geoStatus: 'idle' })}
          placeholder="auto from address"
        />
        {venue._geoStatus === 'loading' && (
          <span style={{ position: 'absolute' as const, right: 14, top: '68%', transform: 'translateY(-50%)', fontSize: 11, color: 'rgba(0,0,0,0.4)' }}>…</span>
        )}
      </div>
      <div style={{ flex: '2 1 200px', minWidth: 180 }}>
        <label style={labelStyle}>Lng</label>
        <input
          style={pillInput(missing)}
          value={venue.longitude}
          onChange={e => onUpdate({ longitude: e.target.value, _geoStatus: 'idle' })}
          placeholder="auto from address"
        />
      </div>
      <div style={{ flex: '0 0 auto', paddingTop: 28 }}>
        {venue._geoStatus === 'ok' && <span style={{ fontFamily: F, fontSize: 11, color: '#1a5c2a' }}>✓ geocoded</span>}
        {venue._geoStatus === 'failed' && <span style={{ fontFamily: F, fontSize: 11, color: '#dc2626' }}>geocode failed</span>}
      </div>
    </div>
  )
}

// ── VenueEditor ──────────────────────────────────────────────────────────────
// One venue's fields. Shared by the review card and Manual Entry so a venue is
// edited the same way regardless of where the draft came from.

function VenueEditor({
  venue, onChange, onDelete, canDelete, institutionName, index,
}: {
  venue: VenueDraft
  onChange: (v: VenueDraft) => void
  onDelete: () => void
  canDelete: boolean
  institutionName?: string
  index: number
}) {
  function set(key: keyof VenueDraft, val: string | boolean | HoursMap) {
    onChange({ ...venue, [key]: val })
  }

  async function handleAddressBlur() {
    if (!venue.address.trim()) return
    onChange({ ...venue, _geoStatus: 'loading' })
    try {
      const searchName = [institutionName, venue.name].filter(Boolean).join(' ').trim()
      const res = await adminFetch('/api/admin/seed/enrich', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: searchName, address: venue.address }),
      })
      if (!res.ok) throw new Error()
      const data = await res.json()
      onChange({
        ...venue,
        latitude: data.lat != null ? String(data.lat) : venue.latitude,
        longitude: data.lng != null ? String(data.lng) : venue.longitude,
        address: data.address ?? venue.address,
        hours: data.hours ?? venue.hours,
        _addressFallback: Boolean(data.addressFallback),
        _hoursFallback: Boolean(data.hoursFallback),
        _geoStatus: data.lat != null ? 'ok' : 'failed',
      })
    } catch {
      onChange({ ...venue, _geoStatus: 'failed', _addressFallback: true, _hoursFallback: true })
    }
  }

  const openCount = DAYS.filter(d => venue.hours[d] !== null).length
  const issues = venueIssues(venue)
  const untouched = isUntouchedVenue(venue)

  return (
    <div style={{ border: '1px solid rgba(0,0,0,0.12)', borderRadius: 18, padding: 20, marginBottom: 14, position: 'relative' as const }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, paddingRight: canDelete ? 24 : 0 }}>
        <span style={{ fontFamily: F, fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase' as const, color: 'rgba(0,0,0,0.4)' }}>
          Venue {index + 1}
        </span>
        {issues.length > 0 && (
          <span style={{ fontFamily: F, fontSize: 12, color: AMBER }}>{issues.join(' · ')}</span>
        )}
        {issues.length === 0 && !untouched && <span style={{ fontSize: 12, color: '#1a5c2a' }}>✓</span>}
      </div>

      {canDelete && (
        <button
          onClick={onDelete}
          title="Remove venue"
          style={{ position: 'absolute' as const, top: 14, right: 16, background: 'transparent', border: 'none', borderRadius: 999, fontSize: 16, cursor: 'pointer', color: 'rgba(0,0,0,0.3)' }}
        >×</button>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginBottom: 14 }}>
        <div>
          <label style={labelStyle}>Venue Name</label>
          <input style={pillInput(!untouched && !venue.name.trim())} value={venue.name} onChange={e => set('name', e.target.value)} placeholder="Gallery 23rd Street" />
        </div>
        <div>
          <label style={labelStyle}>Exhibitions URL</label>
          <input style={pillInput(!untouched && !venue.exhibitions_url.trim())} value={venue.exhibitions_url} onChange={e => set('exhibitions_url', e.target.value)} placeholder="https://…/exhibitions" />
        </div>
        <div>
          <label style={{ ...labelStyle, color: venue._addressFallback ? '#92400e' : 'rgba(0,0,0,0.4)' }}>
            Address{venue._addressFallback ? ' — unverified' : ''}
          </label>
          <input
            style={pillInput((!untouched && !venue.address.trim()) || venue._addressFallback)}
            value={venue.address}
            onChange={e => set('address', e.target.value)}
            onBlur={handleAddressBlur}
            placeholder="123 W 25th St, New York, NY 10001"
          />
        </div>
        <div>
          <label style={labelStyle}>Neighborhood</label>
          <input style={pillInput(false)} value={venue.neighborhood} onChange={e => set('neighborhood', e.target.value)} placeholder="Chelsea" />
        </div>
      </div>

      <GeoField venue={venue} onUpdate={partial => onChange({ ...venue, ...partial })} />

      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 10, marginTop: 18 }}>
        <SectionToggle
          open={venue._hoursOpen}
          onToggle={() => set('_hoursOpen', !venue._hoursOpen)}
          flagged={venue._hoursFallback}
          label={`Hours — ${openCount === 0 ? 'all closed' : `${openCount} days open`}${venue._hoursFallback ? ' (guessed)' : ''}`}
        />
        {venue._hoursOpen && (
          <div style={{ paddingBottom: 4 }}>
            <HoursInput value={venue.hours} onChange={hours => set('hours', hours)} />
          </div>
        )}

        <SectionToggle
          open={venue._notesOpen}
          onToggle={() => set('_notesOpen', !venue._notesOpen)}
          label={`Scraping Notes${venue.scrape_notes.trim() ? ' ✓' : ''}`}
        />
        {venue._notesOpen && (
          <div>
            <textarea
              value={venue.scrape_notes}
              onChange={e => set('scrape_notes', e.target.value)}
              placeholder='Scraping hint, e.g. "current shows are under the On View tab" or "ignore the Programs section"'
              rows={3}
              style={{
                display: 'block', width: '100%', fontFamily: F, fontSize: 12, lineHeight: 1.6,
                color: '#000', background: '#FFFCEC', border: '1px solid rgba(0,0,0,0.25)',
                borderRadius: 12, padding: '8px 12px', outline: 'none', resize: 'vertical',
                boxSizing: 'border-box',
              }}
            />
            <div style={{ fontFamily: F, fontSize: 11, color: 'rgba(0,0,0,0.4)', marginTop: 4 }}>
              Passed to the extractor as context on every scrape of this venue. Editable later under Scrape Issues.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Draft row ────────────────────────────────────────────────────────────────
// Collapsed summary of one institution draft. Opens the card; the quick Insert
// and dismiss actions stay on the row because a CSV batch is triaged by
// dismissing dozens of rows without ever opening them.

function DraftRow({
  inst, onOpen, onInsert, onDelete, inserting, error,
}: {
  inst: InstitutionDraft
  onOpen: () => void
  onInsert: () => void
  onDelete: () => void
  inserting: boolean
  error?: string
}) {
  const issues = institutionIssues(inst)
  const venueCount = inst.venues.length
  // On a single-venue draft the exhibitions URL is the field most likely to be
  // wrong — the CSV import guesses it as website + "/exhibitions" — so it stays
  // on the collapsed row, as a link, rather than only inside the card.
  const single = venueCount === 1 ? inst.venues[0] : null
  const rowUrl = single?.exhibitions_url.trim() || inst.website.trim()

  return (
    <div
      onClick={onOpen}
      className="seed-row"
      style={{ cursor: 'pointer', fontFamily: F, borderBottom: '1px solid rgba(0,0,0,0.1)', padding: '14px 4px' }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 15, color: '#000', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
          {inst.name || <span style={{ color: 'rgba(0,0,0,0.35)' }}>Untitled institution</span>}
          {inst._dupWarning && <span title={inst._dupWarning} style={{ ...warnBadge, marginLeft: 8 }}>⚠ dup?</span>}
        </div>
        <div style={{ fontSize: 13, color: 'rgba(0,0,0,0.45)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
          {rowUrl ? (
            <a
              href={rowUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              style={{ color: 'rgba(0,0,0,0.45)', textDecoration: 'none', borderBottom: '1px solid rgba(0,0,0,0.2)' }}
            >
              {rowUrl}
            </a>
          ) : '—'}
        </div>
        {single?.address.trim() && (
          <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.35)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
            {single.address}{single.neighborhood ? ` · ${single.neighborhood}` : ''}
          </div>
        )}
      </div>

      <div style={{ fontSize: 13, color: 'rgba(0,0,0,0.6)' }}>{inst.type}</div>

      <div style={{ fontSize: 13, color: 'rgba(0,0,0,0.6)' }}>
        {venueCount} venue{venueCount !== 1 ? 's' : ''}
      </div>

      <div style={{ fontSize: 13, minWidth: 0 }}>
        {issues.length > 0
          ? <span style={{ color: AMBER }}>{issues.join(', ')}</span>
          : <span style={{ color: '#1a5c2a' }}>✓ ready</span>}
        {error && <div style={{ color: '#dc2626', fontSize: 12, marginTop: 2 }}>{error}</div>}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifySelf: 'end' }}>
        <button
          onClick={e => { e.stopPropagation(); onOpen() }}
          style={{ ...btnSecondary, color: '#000', borderColor: 'rgba(0,0,0,0.4)' }}
        >
          Edit
        </button>
        <button
          onClick={e => { e.stopPropagation(); onInsert() }}
          disabled={inserting}
          title="Insert only this institution into the database"
          style={{
            ...btnSecondary, fontWeight: 700,
            background: inserting ? 'rgba(0,0,0,0.08)' : '#58914480',
            borderColor: 'rgba(0,0,0,0.4)', color: inserting ? 'rgba(0,0,0,0.3)' : '#000',
            cursor: inserting ? 'wait' : 'pointer',
          }}
        >
          {inserting ? '…' : 'Insert'}
        </button>
        <button
          onClick={e => { e.stopPropagation(); onDelete() }}
          title="Remove from this batch"
          style={{ background: 'transparent', border: 'none', borderRadius: 999, cursor: 'pointer', color: 'rgba(0,0,0,0.3)', fontSize: 18, lineHeight: 1, padding: '0 4px' }}
        >×</button>
      </div>
    </div>
  )
}

// ── Draft card ───────────────────────────────────────────────────────────────
// The expanded editor, built to match the pending-exhibition modal in
// PendingTab. Edits are applied to the draft as you type — nothing is written
// to the database until Insert.

function DraftCard({
  inst, onChange, onClose, onInsert, onDelete, inserting, error,
}: {
  inst: InstitutionDraft
  onChange: (v: InstitutionDraft) => void
  onClose: () => void
  onInsert: () => void
  onDelete: () => void
  inserting: boolean
  error?: string
}) {
  const [confirmDel, setConfirmDel] = useState(false)

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function setField(key: 'name' | 'website' | 'type', val: string) {
    onChange({ ...inst, [key]: val })
  }

  function updateVenue(idx: number, v: VenueDraft) {
    const venues = [...inst.venues]; venues[idx] = v; onChange({ ...inst, venues })
  }

  const issues = institutionIssues(inst)

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
        onClick={e => e.stopPropagation()}
        style={{
          background: '#FFFCEC', width: '100%', maxWidth: 900, maxHeight: '90vh',
          overflowY: 'auto', position: 'relative' as const, fontFamily: F,
          padding: '44px 40px 32px',
        }}
      >
        <button
          onClick={onClose}
          style={{ position: 'absolute' as const, top: 16, right: 20, background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 20, color: '#000', fontFamily: F }}
        >
          ✕
        </button>

        <div style={{ marginBottom: 8, fontSize: 20, color: '#000' }}>
          {inst.name || 'Untitled institution'}
        </div>
        <div style={{ fontSize: 13, marginBottom: 28, color: issues.length ? AMBER : '#1a5c2a' }}>
          {issues.length ? issues.join(' · ') : '✓ ready to insert'}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14, marginBottom: 28 }}>
          <div>
            <label style={labelStyle}>Institution Name</label>
            <input style={pillInput(!inst.name.trim())} value={inst.name} onChange={e => setField('name', e.target.value)} placeholder="Gallery Name" />
          </div>
          <div>
            <label style={labelStyle}>Website</label>
            <input style={pillInput(false)} value={inst.website} onChange={e => setField('website', e.target.value)} placeholder="https://…" />
          </div>
          <div>
            <label style={labelStyle}>Type</label>
            <select value={inst.type} onChange={e => setField('type', e.target.value)} style={{ ...pillInput(false), appearance: 'none' as const, cursor: 'pointer' }}>
              {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        </div>

        <div style={{ ...labelStyle, marginBottom: 12 }}>Venues</div>
        {inst.venues.map((v, i) => (
          <VenueEditor
            key={v._id}
            venue={v}
            index={i}
            institutionName={inst.name.trim()}
            canDelete
            onChange={updated => updateVenue(i, updated)}
            onDelete={() => onChange({ ...inst, venues: inst.venues.filter((_, j) => j !== i) })}
          />
        ))}
        <button
          onClick={() => onChange({ ...inst, venues: [...inst.venues, blankVenue()] })}
          style={{ ...btnSecondary, color: '#3432A8', borderColor: '#3432A8', marginBottom: 24 }}
        >
          + Add venue
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' as const, borderTop: '1px solid rgba(0,0,0,0.12)', paddingTop: 22 }}>
          <button onClick={onClose} style={{ ...pillBtn, background: '#FFFCEC' }}>Done</button>

          <button
            onClick={onInsert}
            disabled={inserting}
            style={{ ...pillBtn, background: '#58914480', opacity: inserting ? 0.6 : 1, cursor: inserting ? 'wait' : 'pointer' }}
          >
            {inserting ? 'Inserting…' : 'Insert'}
          </button>

          {confirmDel ? (
            <>
              <button onClick={onDelete} style={{ ...pillBtn, background: '#E62F2E80' }}>Confirm?</button>
              <button onClick={() => setConfirmDel(false)} style={{ ...pillBtn, background: '#FFFCEC' }}>Cancel</button>
            </>
          ) : (
            <button onClick={() => setConfirmDel(true)} style={{ ...pillBtn, background: '#E62F2E80' }}>Remove</button>
          )}

          {error && <span style={{ fontSize: 12, color: '#dc2626' }}>{error}</span>}
        </div>
      </div>
    </div>
  )
}

// ── Manual Entry form ─────────────────────────────────────────────────────────

function ManualEntryForm({ onInserted }: { onInserted: () => void }) {
  const [name, setName] = useState('')
  const [website, setWebsite] = useState('')
  const [type, setType] = useState<InstType>('gallery')
  const [venues, setVenues] = useState<VenueDraft[]>([blankVenue()])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function updateVenue(idx: number, v: VenueDraft) {
    setVenues(prev => { const next = [...prev]; next[idx] = v; return next })
  }

  async function handleSubmit() {
    if (!name.trim()) { setError('Institution name is required'); return }
    setSubmitting(true)
    setError(null)
    try {
      const res = await adminFetch('/api/admin/seed/insert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          institutions: [toPayload({ _id: 'manual', name, website, type, venues })],
        }),
      })
      const json = await res.json()
      if (!res.ok || json.error) { setError(json.error ?? `HTTP ${res.status}`); return }
      onInserted()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      {/* Institution fields */}
      <div style={{ marginBottom: 20 }}>
        <p style={{ fontFamily: F, fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase' as const, color: 'rgba(0,0,0,0.4)', marginBottom: 12 }}>
          Institution
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14, marginBottom: 12 }}>
          <div>
            <label style={labelStyle}>Name</label>
            <input style={pillInput(false)} value={name} onChange={e => setName(e.target.value)} placeholder="Gallery Name" />
          </div>
          <div>
            <label style={labelStyle}>Website</label>
            <input style={pillInput(false)} value={website} onChange={e => setWebsite(e.target.value)} placeholder="https://…" />
          </div>
          <div>
            <label style={labelStyle}>Type</label>
            <select value={type} onChange={e => setType(e.target.value as InstType)} style={{ ...pillInput(false), appearance: 'none' as const, cursor: 'pointer' }}>
              {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* Venue fields */}
      <div style={{ marginBottom: 20 }}>
        <p style={{ fontFamily: F, fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase' as const, color: 'rgba(0,0,0,0.4)', marginBottom: 12 }}>
          Venues
        </p>
        {venues.map((v, i) => (
          <VenueEditor
            key={v._id}
            venue={v}
            index={i}
            onChange={updated => updateVenue(i, updated)}
            onDelete={() => setVenues(prev => prev.filter((_, j) => j !== i))}
            canDelete={venues.length > 1}
            institutionName={name.trim()}
          />
        ))}
        <button
          onClick={() => setVenues(prev => [...prev, blankVenue()])}
          style={{ ...btnSecondary, marginTop: 4 }}
        >
          + Add another venue
        </button>
      </div>

      {error && (
        <div style={{ fontFamily: F, fontSize: 13, color: '#dc2626', background: '#fef2f2', border: '1px solid #fca5a5', padding: '10px 14px', marginBottom: 16 }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          onClick={handleSubmit}
          disabled={submitting}
          style={{
            fontFamily: F, fontSize: 12, fontWeight: 700, letterSpacing: '0.1em',
            textTransform: 'uppercase' as const, padding: '10px 28px', border: 'none', borderRadius: 999,
            cursor: submitting ? 'wait' : 'pointer',
            background: submitting ? 'rgba(0,0,0,0.15)' : '#3432A8',
            color: submitting ? 'rgba(0,0,0,0.3)' : '#fff',
          }}
        >
          {submitting ? 'Inserting…' : 'Add to database'}
        </button>
      </div>
    </div>
  )
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function Toast({ msg, ok }: { msg: string; ok: boolean }) {
  return (
    <div style={{
      position: 'fixed', bottom: 24, right: 24, zIndex: 9999,
      background: ok ? '#3432A8' : '#dc2626', color: '#fff',
      fontFamily: F, fontSize: 13, padding: '12px 20px', maxWidth: 380,
      boxShadow: '0 4px 20px rgba(0,0,0,0.25)',
    }}>
      {msg}
    </div>
  )
}

// ── Main SeedTool ─────────────────────────────────────────────────────────────

type Mode = 'suggest' | 'manual' | 'import'

// `adminPw` is only passed by /admin/seed, which renders this tool standalone.
// Inside the main dashboard it arrives as undefined because AdminPage has
// already recorded the secret.
export default function SeedTool({ inline, adminPw }: { inline?: boolean; adminPw?: string }) {
  if (adminPw) setAdminSecret(adminPw)

  const [mode, setMode] = useState<Mode>('suggest')
  // CSV import state. The import shares the review list, geocode step and
  // insert button with AI Suggest — only the source of the drafts differs.
  const [impStatus, setImpStatus] = useState<string[]>(['open'])
  const [impSearch, setImpSearch] = useState('')
  const [impOffset, setImpOffset] = useState(0)
  const [impLimit, setImpLimit] = useState(25)
  const [impMeta, setImpMeta] = useState<{ total: number; already_present: number; manually_excluded: number; counts_by_status: Record<string, number> } | null>(null)
  const [exclusions, setExclusions] = useState<{ dedup_key: string; name: string }[]>([])
  const [showExclusions, setShowExclusions] = useState(false)

  async function loadExclusions() {
    try {
      const r = await adminFetch('/api/admin/seed/exclusions')
      if (r.ok) setExclusions((await r.json()).exclusions ?? [])
    } catch { /* the list is informational; a failure here should not block the tool */ }
  }

  // Optimistic: the row is already gone from the table, so waiting on the round
  // trip would only add lag to a button pressed hundreds of times.
  async function excludeInstitution(name: string) {
    setExclusions(prev => [{ dedup_key: name.toLowerCase(), name }, ...prev])
    try {
      await adminFetch('/api/admin/seed/exclusions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, reason: 'dismissed in import review' }),
      })
      loadExclusions()
    } catch { showToast(`Could not remember "${name}" — it may reappear.`, false) }
  }

  async function restoreInstitution(dedup_key: string) {
    setExclusions(prev => prev.filter(e => e.dedup_key !== dedup_key))
    try {
      await adminFetch('/api/admin/seed/exclusions', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dedup_key }),
      })
      loadExclusions()
    } catch { loadExclusions() }
  }
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Non-fatal notice from the suggest route, e.g. the model's answer was cut
  // off. Distinct from `error`: results still rendered.
  const [warning, setWarning] = useState<string | null>(null)
  const [institutions, setInstitutions] = useState<InstitutionDraft[]>([])
  const [inserting, setInserting] = useState(false)
  const [enriching, setEnriching] = useState(false)
  // Which draft's card is expanded, and per-draft insert state. Keyed by draft
  // id rather than index so a dismissal elsewhere in the list cannot shift the
  // spinner or an error message onto a different institution.
  const [openId, setOpenId] = useState<string | null>(null)
  const [insertingId, setInsertingId] = useState<string | null>(null)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null)
  const inputId = useId()

  function showToast(msg: string, ok: boolean) {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 4500)
  }

  // Clearing the drafts has to clear what hangs off them — an open card or a
  // stale per-row error would otherwise survive into the next batch.
  function resetDrafts() {
    setInstitutions([])
    setOpenId(null)
    setRowErrors({})
  }

  function updateInstitution(id: string, next: InstitutionDraft) {
    setInstitutions(prev => prev.map(i => (i._id === id ? next : i)))
  }

  function dropInstitution(inst: InstitutionDraft) {
    setInstitutions(prev => prev.filter(i => i._id !== inst._id))
    setOpenId(cur => (cur === inst._id ? null : cur))
    // Only the CSV import remembers rejections. Suggest results are generated
    // fresh each time, so persisting a dismissal there would hide a gallery the
    // model may never offer again.
    if (mode === 'import') excludeInstitution(inst.name)
  }

  // Insert a single institution. Shared by the row's quick action and the card,
  // so both report failures the same way.
  async function insertOne(inst: InstitutionDraft) {
    setInsertingId(inst._id)
    setRowErrors(prev => { const next = { ...prev }; delete next[inst._id]; return next })
    try {
      const res = await adminFetch('/api/admin/seed/insert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ institutions: [toPayload(inst)] }),
      })
      const json = await res.json()
      if (!res.ok || json.error) {
        setRowErrors(prev => ({ ...prev, [inst._id]: json.error ?? `HTTP ${res.status}` }))
        return
      }
      setInstitutions(prev => prev.filter(i => i._id !== inst._id))
      setOpenId(cur => (cur === inst._id ? null : cur))
      showToast(`"${inst.name}" inserted successfully.`, true)
    } catch (e) {
      setRowErrors(prev => ({ ...prev, [inst._id]: e instanceof Error ? e.message : 'Network error' }))
    } finally {
      setInsertingId(null)
    }
  }

  // Geocoding every venue in a batch of drafts. Pulled out of handleSuggest so
  // the CSV import runs the identical step rather than a near-copy that drifts.
  async function enrichDrafts(mapped: InstitutionDraft[]): Promise<InstitutionDraft[]> {
    return Promise.all(
      mapped.map(async inst => ({
        ...inst,
        venues: await Promise.all(
          inst.venues.map(async v => {
            if (!v.address.trim()) {
              return { ...v, _addressFallback: true, _hoursFallback: true, _geoStatus: 'failed' as GeoStatus }
            }
            try {
              const er = await adminFetch('/api/admin/seed/enrich', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: `${v.name || inst.name}`, address: v.address }),
              })
              if (!er.ok) throw new Error()
              const data = await er.json()
              return {
                ...v,
                latitude: data.lat != null ? String(data.lat) : v.latitude,
                longitude: data.lng != null ? String(data.lng) : v.longitude,
                address: data.address ?? v.address,
                hours: data.hours ?? v.hours,
                _addressFallback: Boolean(data.addressFallback),
                _hoursFallback: Boolean(data.hoursFallback),
                _geoStatus: (data.lat != null ? 'ok' : 'failed') as GeoStatus,
              }
            } catch {
              return { ...v, _addressFallback: true, _hoursFallback: true, _geoStatus: 'failed' as GeoStatus }
            }
          })
        ),
      }))
    )
  }

  async function handleImport(nextOffset = impOffset) {
    setLoading(true); setEnriching(false); setError(null); setWarning(null); resetDrafts()
    try {
      const res = await adminFetch('/api/admin/seed/import-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: impStatus, search: impSearch, offset: nextOffset, limit: impLimit }),
      })
      const json = await res.json()
      if (!res.ok || json.error) { setError(json.error ?? `HTTP ${res.status}`); return }
      setImpMeta({ total: json.total, already_present: json.already_present, manually_excluded: json.manually_excluded ?? 0, counts_by_status: json.counts_by_status })
      loadExclusions()
      setImpOffset(nextOffset)
      const mapped: InstitutionDraft[] = (json.institutions as Record<string, unknown>[]).map(institutionFromRaw)
      setEnriching(true)
      setInstitutions(await enrichDrafts(mapped))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setEnriching(false); setLoading(false)
    }
  }

  async function handleSuggest() {
    if (!query.trim()) return
    setLoading(true)
    setEnriching(false)
    setError(null)
    resetDrafts()
    try {
      const res = await adminFetch('/api/admin/seed/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      })
      const json = await res.json()
      if (!res.ok || json.error) {
        setError(json.error ?? `HTTP ${res.status}`)
        return
      }
      if (typeof json.warning === 'string') setWarning(json.warning)
      const mapped: InstitutionDraft[] = (json.institutions as Record<string, unknown>[]).map(institutionFromRaw)
      setEnriching(true)
      setInstitutions(await enrichDrafts(mapped))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setEnriching(false)
      setLoading(false)
    }
  }

  async function handleInsert() {
    if (institutions.length === 0) return
    setInserting(true)
    const payload = institutions.map(toPayload)
    try {
      const res = await adminFetch('/api/admin/seed/insert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ institutions: payload }),
      })
      const json = await res.json()
      if (!res.ok || json.error) {
        showToast(json.error ?? `HTTP ${res.status}`, false)
      } else {
        const { institutionsInserted, venuesInserted, warnings } = json
        const base = `Inserted ${institutionsInserted} institution${institutionsInserted !== 1 ? 's' : ''} + ${venuesInserted} venue${venuesInserted !== 1 ? 's' : ''}.`
        showToast(warnings ? `${base} Warnings: ${warnings.join('; ')}` : base, true)
        resetDrafts()
        setQuery('')
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Network error', false)
    } finally {
      setInserting(false)
    }
  }

  const venueCount = institutions.reduce((s, i) => s + i.venues.length, 0)
  const openDraft = openId ? institutions.find(i => i._id === openId) ?? null : null

  const modeToggle = (
    <div style={{ display: 'flex', gap: 0, border: '1px solid rgba(0,0,0,0.18)', width: 'fit-content', marginBottom: 28 }}>
      {(['suggest', 'import', 'manual'] as Mode[]).map(m => (
        <button
          key={m}
          onClick={() => setMode(m)}
          style={{
            fontFamily: F, fontSize: 12, fontWeight: mode === m ? 700 : 400,
            padding: '6px 18px', border: 'none', borderRadius: 999, cursor: 'pointer',
            background: mode === m ? '#000' : 'transparent',
            color: mode === m ? '#fff' : 'rgba(0,0,0,0.5)',
            transition: 'all 150ms ease',
          }}
        >
          {m === 'suggest' ? 'AI Suggest' : m === 'import' ? 'Import CSV' : 'Manual Entry'}
        </button>
      ))}
    </div>
  )

  // The review list: one row per institution, expanding into the editable card.
  // Shared verbatim by AI Suggest and CSV Import so the two cannot drift apart.
  const resultsPanel = (

        <>
          <div style={{ marginBottom: 20 }}>
            <div className="seed-row seed-row-head">
              <div>Institution</div>
              <div>Type</div>
              <div>Venues</div>
              <div>Status</div>
              <div />
            </div>
            {institutions.map(inst => (
              <DraftRow
                key={inst._id}
                inst={inst}
                inserting={insertingId === inst._id}
                error={rowErrors[inst._id]}
                onOpen={() => setOpenId(inst._id)}
                onInsert={() => insertOne(inst)}
                onDelete={() => dropInstitution(inst)}
              />
            ))}
          </div>

          {openDraft && (
            <DraftCard
              inst={openDraft}
              inserting={insertingId === openDraft._id}
              error={rowErrors[openDraft._id]}
              onChange={updated => updateInstitution(openDraft._id, updated)}
              onClose={() => setOpenId(null)}
              onInsert={() => insertOne(openDraft)}
              onDelete={() => dropInstitution(openDraft)}
            />
          )}

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: 20, borderTop: '1px solid rgba(0,0,0,0.12)' }}>
            <span style={{ fontFamily: F, fontSize: 13, color: 'rgba(0,0,0,0.5)' }}>
              {institutions.length} institution{institutions.length !== 1 ? 's' : ''},{' '}
              {venueCount} venue{venueCount !== 1 ? 's' : ''} ready to insert
            </span>
            <button
              onClick={handleInsert}
              disabled={inserting}
              style={{
                fontFamily: F, fontSize: 12, fontWeight: 700, letterSpacing: '0.1em',
                textTransform: 'uppercase' as const, padding: '10px 28px', border: 'none', borderRadius: 999,
                cursor: inserting ? 'wait' : 'pointer',
                background: inserting ? 'rgba(0,0,0,0.12)' : '#3432A8',
                color: inserting ? 'rgba(0,0,0,0.3)' : '#fff',
              }}
            >
              {inserting ? 'Inserting…' : `Add ${institutions.length + venueCount} rows to database`}
            </button>
          </div>
        </>
  )

  const suggestPanel = (
    <>
      <div style={{ marginBottom: 28 }}>
        <label htmlFor={inputId} style={labelStyle}>Query</label>
        <div style={{ display: 'flex', gap: 10 }}>
          <input
            id={inputId}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !loading && handleSuggest()}
            placeholder="e.g. Chelsea galleries, Tribeca nonprofits, major NYC museums…"
            disabled={loading}
            style={{ ...inputStyle, flex: 1, fontSize: 14, padding: '10px 14px', fontFamily: MONO }}
          />
          <button
            onClick={handleSuggest}
            disabled={loading || !query.trim()}
            style={{
              fontFamily: F, fontSize: 12, fontWeight: 700, letterSpacing: '0.1em',
              textTransform: 'uppercase' as const, padding: '10px 24px', border: 'none', borderRadius: 999,
              cursor: loading ? 'wait' : 'pointer', whiteSpace: 'nowrap' as const,
              background: loading || !query.trim() ? 'rgba(0,0,0,0.12)' : '#000',
              color: loading || !query.trim() ? 'rgba(0,0,0,0.3)' : '#fff',
            }}
          >
            {loading ? 'Thinking…' : 'Suggest'}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', padding: '12px 16px', marginBottom: 20, fontFamily: F, fontSize: 13, color: '#dc2626' }}>
          {error}
          <button onClick={handleSuggest} style={{ marginLeft: 12, fontFamily: F, fontSize: 12, fontWeight: 700, background: 'transparent', border: '1px solid #dc2626', borderRadius: 999, color: '#dc2626', padding: '2px 10px', cursor: 'pointer' }}>Retry</button>
        </div>
      )}

      {warning && !error && (
        <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', padding: '12px 16px', marginBottom: 20, fontFamily: F, fontSize: 13, color: '#92400e' }}>
          {warning}
          <button onClick={handleSuggest} style={{ marginLeft: 12, fontFamily: F, fontSize: 12, fontWeight: 700, background: 'transparent', border: '1px solid #92400e', borderRadius: 999, color: '#92400e', padding: '2px 10px', cursor: 'pointer' }}>Ask again</button>
        </div>
      )}

      {loading && (
        <div style={{ color: 'rgba(0,0,0,0.4)', fontSize: 13, padding: '40px 0', textAlign: 'center', fontFamily: F }}>
          {enriching
            ? 'Enriching with Mapbox + Google Places…'
            : <>Asking Claude about &ldquo;{query}&rdquo;…</>
          }
        </div>
      )}

      {institutions.length > 0 && resultsPanel}
    </>
  )

  // Reuses resultsPanel — the review list, the expanding card and the insert
  // button are identical to AI Suggest. Only the source differs.
  const importPanel = (
    <>
      <p style={{ fontFamily: F, fontSize: 12, color: 'rgba(0,0,0,0.5)', margin: '0 0 14px', lineHeight: 1.6, maxWidth: 760 }}>
        Loads <code>seed-data/enriched-nyc-galleries.csv</code> in batches. Rows marked <b>closed</b> are excluded
        unless you ask for them. Every batch still goes through the same review list below — open a row to check the
        address and the guessed exhibitions URL before inserting. Nothing is written until you press the button.
      </p>

      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
        <div>
          <label style={labelStyle}>Status</label>
          <div style={{ display: 'flex', gap: 6 }}>
            {(['open', 'unclear', 'closed'] as const).map(st => (
              <button key={st}
                onClick={() => setImpStatus(prev => prev.includes(st) ? prev.filter(x => x !== st) : [...prev, st])}
                style={{
                  ...btnSecondary,
                  background: impStatus.includes(st) ? '#000' : 'transparent',
                  color: impStatus.includes(st) ? '#FFFCEC' : 'rgba(0,0,0,0.6)',
                  border: impStatus.includes(st) ? 'none' : '1px solid rgba(0,0,0,0.2)',
                }}>
                {st}{impMeta?.counts_by_status?.[st] != null ? ` (${impMeta.counts_by_status[st]})` : ''}
              </button>
            ))}
          </div>
        </div>
        <div style={{ minWidth: 200 }}>
          <label style={labelStyle}>Filter by name</label>
          <input style={inputStyle} value={impSearch} onChange={e => setImpSearch(e.target.value)} placeholder="e.g. Zwirner" />
        </div>
        <div style={{ width: 110 }}>
          <label style={labelStyle}>Batch size</label>
          <input style={inputStyle} type="number" min={1} max={100} value={impLimit}
            onChange={e => setImpLimit(Math.max(1, Math.min(100, Number(e.target.value) || 25)))} />
        </div>
        <button onClick={() => handleImport(0)} disabled={loading}
          style={{ ...btnSecondary, background: '#000', color: '#FFFCEC', border: 'none', opacity: loading ? 0.6 : 1, padding: '6px 16px' }}>
          {loading ? (enriching ? 'Geocoding…' : 'Loading…') : 'Load batch'}
        </button>
      </div>

      {impMeta && (
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 18, fontFamily: F, fontSize: 12, color: 'rgba(0,0,0,0.55)' }}>
          <span>
            Showing {impOffset + 1}–{Math.min(impOffset + impLimit, impMeta.total)} of {impMeta.total} matching institutions
            {impMeta.already_present > 0 && ` · ${impMeta.already_present} already in your database`}
          </span>
          <button onClick={() => handleImport(Math.max(0, impOffset - impLimit))} disabled={loading || impOffset === 0} style={btnSecondary}>← Prev</button>
          <button onClick={() => handleImport(impOffset + impLimit)} disabled={loading || impOffset + impLimit >= impMeta.total} style={btnSecondary}>Next →</button>
          {(impMeta.manually_excluded > 0 || exclusions.length > 0) && (
            <button onClick={() => setShowExclusions(v => !v)} style={btnSecondary}>
              {showExclusions ? 'Hide' : 'Show'} {Math.max(impMeta.manually_excluded, exclusions.length)} removed
            </button>
          )}
        </div>
      )}

      {showExclusions && (
        <div style={{ background: '#f0ecde', padding: '12px 14px', marginBottom: 18 }}>
          <p style={{ ...labelStyle, marginBottom: 8 }}>Removed from future batches — click to restore</p>
          {exclusions.length === 0 && <p style={{ fontFamily: F, fontSize: 12, color: 'rgba(0,0,0,0.4)', margin: 0 }}>Nothing removed yet.</p>}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {exclusions.map(e => (
              <button key={e.dedup_key} onClick={() => restoreInstitution(e.dedup_key)}
                title="Restore to the import list"
                style={{ ...btnSecondary, fontSize: 11, padding: '3px 9px' }}>
                {e.name} ↩
              </button>
            ))}
          </div>
        </div>
      )}

      {error && <p style={{ fontFamily: F, fontSize: 13, color: '#dc2626' }}>{error}</p>}
      {institutions.length > 0 && resultsPanel}
    </>
  )

  const content = (
    <>
      {modeToggle}
      {mode === 'suggest' && suggestPanel}
      {mode === 'import' && importPanel}
      {mode === 'manual' && (
        <ManualEntryForm
          onInserted={() => showToast('Institution + venue(s) added successfully.', true)}
        />
      )}
      {toast && <Toast msg={toast.msg} ok={toast.ok} />}
      <style>{`
        .seed-row {
          display: grid;
          grid-template-columns: minmax(0, 2.2fr) 110px 100px minmax(0, 1.6fr) auto;
          gap: 16px;
          align-items: center;
        }
        .seed-row:not(.seed-row-head):hover { background: rgba(52,50,168,0.04); }
        .seed-row-head {
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: rgba(0,0,0,0.4);
          padding: 0 4px 8px;
          border-bottom: 1px solid rgba(0,0,0,0.18);
        }
        @media (max-width: 820px) {
          .seed-row { grid-template-columns: minmax(0, 1fr); row-gap: 6px; }
          .seed-row > div:last-child { justify-self: start; }
          .seed-row-head { display: none; }
        }
      `}</style>
    </>
  )

  if (inline) return content

  return (
    <div style={{ minHeight: '100vh', background: '#FFFCEC', fontFamily: F }}>
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '40px 44px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 32 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 20 }}>
            <a href="/admin" style={{ fontFamily: F, fontSize: 11, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase' as const, color: '#000', textDecoration: 'none' }}>Admin</a>
            <span style={{ color: 'rgba(0,0,0,0.25)', fontSize: 11 }}>/</span>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase' as const, color: 'rgba(0,0,0,0.5)' }}>Seed Institutions</span>
          </div>
          <a href="/" style={{ fontFamily: F, fontSize: 13, color: 'rgba(0,0,0,0.4)', textDecoration: 'none' }}>← Site</a>
        </div>
        {content}
      </div>
    </div>
  )
}
