'use client'

import { useState, useId, useCallback } from 'react'

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
  _hoursOpen: boolean
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
    hours: { ...DEFAULT_HOURS }, _hoursOpen: false, _geoStatus: 'idle',
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
    _hoursOpen: false,
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

// ── Shared style objects ──────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  fontFamily: F, fontSize: 13, color: '#000',
  background: '#fff', border: '1px solid rgba(0,0,0,0.18)',
  padding: '6px 8px', outline: 'none', width: '100%', boxSizing: 'border-box',
}

const cellStyle: React.CSSProperties = { padding: '4px 6px', verticalAlign: 'middle' }

const thStyle: React.CSSProperties = {
  fontFamily: F, fontSize: 10, fontWeight: 700,
  letterSpacing: '0.12em', textTransform: 'uppercase' as const,
  color: 'rgba(0,0,0,0.4)', padding: '4px 6px', textAlign: 'left' as const,
  whiteSpace: 'nowrap' as const,
}

const labelStyle: React.CSSProperties = {
  display: 'block', fontFamily: F, fontSize: 10, fontWeight: 700,
  letterSpacing: '0.12em', textTransform: 'uppercase' as const,
  color: 'rgba(0,0,0,0.4)', marginBottom: 6,
}

const btnSecondary: React.CSSProperties = {
  fontFamily: F, fontSize: 11, background: 'transparent',
  border: '1px solid rgba(0,0,0,0.2)', padding: '4px 10px',
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

// ── Preview table: VenueRow ───────────────────────────────────────────────────

function VenueRow({
  venue, onChange, onDelete,
}: {
  venue: VenueDraft
  onChange: (v: VenueDraft) => void
  onDelete: () => void
}) {
  function set(key: keyof VenueDraft, val: string | boolean | HoursMap) {
    onChange({ ...venue, [key]: val })
  }

  const openCount = DAYS.filter(d => venue.hours[d] !== null).length
  const hoursLabel = openCount === 0 ? 'all closed' : `${openCount}d open`
  const hasAddressFlag = venue._addressFallback
  const hasGeoFlag = !venue.latitude || !venue.longitude
  const hasHoursFlag = venue._hoursFallback

  return (
    <>
      <tr style={{ background: 'rgba(0,0,0,0.015)' }}>
        <td style={{ ...cellStyle, paddingLeft: 24, color: 'rgba(0,0,0,0.3)', fontSize: 11, whiteSpace: 'nowrap' as const }}>↳ venue</td>
        <td style={cellStyle}><input style={inputStyle} value={venue.name} onChange={e => set('name', e.target.value)} /></td>
        <td style={cellStyle}><input style={inputStyle} value={venue.exhibitions_url} onChange={e => set('exhibitions_url', e.target.value)} placeholder="https://…" /></td>
        <td style={cellStyle}>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input style={{ ...inputStyle, flex: 1, minWidth: 0 }} value={venue.address} onChange={e => set('address', e.target.value)} />
            {hasAddressFlag && <span title="Address resolution failed — verify manually" style={warnBadge}>⚠</span>}
          </div>
        </td>
        <td style={cellStyle}><input style={inputStyle} value={venue.neighborhood} onChange={e => set('neighborhood', e.target.value)} /></td>
        <td style={cellStyle}>
          <input
            style={{ ...inputStyle, width: 90, background: hasGeoFlag ? '#fef2f2' : undefined }}
            value={venue.latitude} onChange={e => set('latitude', e.target.value)} placeholder="40.72…"
          />
        </td>
        <td style={cellStyle}>
          <input
            style={{ ...inputStyle, width: 90, background: hasGeoFlag ? '#fef2f2' : undefined }}
            value={venue.longitude} onChange={e => set('longitude', e.target.value)} placeholder="-73.99…"
          />
        </td>
        <td style={cellStyle}>
          <button
            onClick={() => set('_hoursOpen', !venue._hoursOpen)}
            style={{
              ...btnSecondary,
              whiteSpace: 'nowrap' as const,
              color: hasHoursFlag ? '#92400e' : venue._hoursOpen ? '#000' : 'rgba(0,0,0,0.5)',
              borderColor: hasHoursFlag ? '#fcd34d' : venue._hoursOpen ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.15)',
              background: hasHoursFlag ? '#fef3c7' : 'transparent',
            }}
          >
            {venue._hoursOpen ? '▾' : '▸'} {hoursLabel}{hasHoursFlag ? ' ⚠' : ''}
          </button>
        </td>
        <td style={cellStyle}>
          <button onClick={onDelete} title="Remove" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'rgba(0,0,0,0.3)', fontSize: 16, lineHeight: 1, padding: '0 4px' }}>×</button>
        </td>
      </tr>
      {venue._hoursOpen && (
        <tr>
          <td colSpan={9} style={{ padding: '8px 12px 12px 28px', background: 'rgba(52,50,168,0.025)' }}>
            <HoursInput
              value={venue.hours}
              onChange={hours => onChange({ ...venue, hours })}
            />
          </td>
        </tr>
      )}
    </>
  )
}

// ── Preview table: InstitutionGroup ──────────────────────────────────────────

function InstitutionGroup({
  inst, onChange, onDelete, onInserted,
}: {
  inst: InstitutionDraft
  onChange: (v: InstitutionDraft) => void
  onDelete: () => void
  onInserted?: () => void
}) {
  const [instInserting, setInstInserting] = useState(false)
  const [instInsertError, setInstInsertError] = useState<string | null>(null)

  function setInst(key: keyof InstitutionDraft, val: string) {
    onChange({ ...inst, [key]: val })
  }

  function updateVenue(idx: number, v: VenueDraft) {
    const venues = [...inst.venues]; venues[idx] = v; onChange({ ...inst, venues })
  }

  const handleInstInsert = useCallback(async () => {
    setInstInserting(true)
    setInstInsertError(null)
    try {
      const res = await fetch('/api/admin/seed/insert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          institutions: [{
            name: inst.name, website: inst.website, type: inst.type,
            venues: inst.venues.map(v => ({
              name: v.name, exhibitions_url: v.exhibitions_url,
              address: v.address, neighborhood: v.neighborhood,
              latitude: v.latitude, longitude: v.longitude,
              hours: v.hours,
            })),
          }],
        }),
      })
      const json = await res.json()
      if (!res.ok || json.error) {
        setInstInsertError(json.error ?? `HTTP ${res.status}`)
      } else {
        onInserted?.()
      }
    } catch (e) {
      setInstInsertError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setInstInserting(false)
    }
  }, [inst, onInserted])

  const isMultiVenue = inst.venues.length > 1
  const allReady = inst.venues.length > 0 && inst.venues.every(
    v => !v._addressFallback && !v._hoursFallback && !!v.latitude && !!v.longitude
  )

  return (
    <>
      <tr style={{ borderTop: '2px solid rgba(0,0,0,0.1)', background: '#fffcec' }}>
        <td style={{ ...cellStyle, fontFamily: F, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' as const, color: '#000' }}>
          institution
          {isMultiVenue && (
            <span title="Multiple venues — verify each location individually" style={{ ...warnBadge, marginLeft: 6 }}>
              ⚠ multi
            </span>
          )}
          {!isMultiVenue && allReady && (
            <span style={{ marginLeft: 6, color: '#16a34a', fontSize: 12, fontWeight: 400 }}>✓</span>
          )}
        </td>
        <td style={cellStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input style={inputStyle} value={inst.name} onChange={e => setInst('name', e.target.value)} />
            {inst._dupWarning && (
              <span title={inst._dupWarning} style={{ ...warnBadge }}>⚠ dup?</span>
            )}
          </div>
        </td>
        <td style={cellStyle}>
          <input style={inputStyle} value={inst.website} onChange={e => setInst('website', e.target.value)} placeholder="https://…" />
        </td>
        <td style={cellStyle}>
          <select value={inst.type} onChange={e => setInst('type', e.target.value)} style={{ ...inputStyle, width: 'auto', paddingRight: 20 }}>
            {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </td>
        <td colSpan={4} style={{ ...cellStyle }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' as const }}>
            <button
              onClick={() => onChange({ ...inst, venues: [...inst.venues, blankVenue()] })}
              style={{ fontFamily: F, fontSize: 11, color: '#3432A8', background: 'transparent', border: '1px solid #3432A8', padding: '3px 10px', cursor: 'pointer', whiteSpace: 'nowrap' as const }}
            >
              + add venue
            </button>
            {onInserted && (
              <button
                onClick={handleInstInsert}
                disabled={instInserting}
                title="Insert only this institution into the database"
                style={{
                  fontFamily: F, fontSize: 11, fontWeight: 700,
                  background: instInserting ? 'rgba(0,0,0,0.08)' : '#3432A8',
                  color: instInserting ? 'rgba(0,0,0,0.3)' : '#fff',
                  border: 'none', padding: '3px 10px',
                  cursor: instInserting ? 'wait' : 'pointer',
                  whiteSpace: 'nowrap' as const,
                }}
              >
                {instInserting ? '…' : '↑ Insert'}
              </button>
            )}
            {instInsertError && (
              <span style={{ fontFamily: F, fontSize: 11, color: '#dc2626', flexShrink: 0 }}>
                {instInsertError}
              </span>
            )}
          </div>
        </td>
        <td style={cellStyle}>
          <button onClick={onDelete} title="Remove institution" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'rgba(0,0,0,0.3)', fontSize: 16, lineHeight: 1, padding: '0 4px' }}>×</button>
        </td>
      </tr>
      {inst.venues.map((v, i) => (
        <VenueRow
          key={v._id}
          venue={v}
          onChange={updated => updateVenue(i, updated)}
          onDelete={() => onChange({ ...inst, venues: inst.venues.filter((_, j) => j !== i) })}
        />
      ))}
    </>
  )
}

// ── Manual Entry: GeoField ────────────────────────────────────────────────────

function GeoField({ venue, onUpdate }: {
  venue: VenueDraft
  onUpdate: (partial: Partial<VenueDraft>) => void
}) {
  const bg = venue._geoStatus === 'ok' ? '#f0fdf4' : venue._geoStatus === 'failed' ? '#fef2f2' : '#f8f8f4'

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' as const }}>
      <div style={{ flex: '2 1 200px', minWidth: 180, position: 'relative' as const }}>
        <label style={labelStyle}>Lat</label>
        <input
          style={{ ...inputStyle, background: bg, color: 'rgba(0,0,0,0.5)' }}
          value={venue.latitude}
          onChange={e => onUpdate({ latitude: e.target.value, _geoStatus: 'idle' })}
          placeholder="auto from address"
        />
        {venue._geoStatus === 'loading' && (
          <span style={{ position: 'absolute' as const, right: 8, top: '65%', transform: 'translateY(-50%)', fontSize: 11, color: 'rgba(0,0,0,0.4)' }}>…</span>
        )}
      </div>
      <div style={{ flex: '2 1 200px', minWidth: 180 }}>
        <label style={labelStyle}>Lng</label>
        <input
          style={{ ...inputStyle, background: bg, color: 'rgba(0,0,0,0.5)' }}
          value={venue.longitude}
          onChange={e => onUpdate({ longitude: e.target.value, _geoStatus: 'idle' })}
          placeholder="auto from address"
        />
      </div>
      <div style={{ flex: '0 0 auto', paddingTop: 22 }}>
        {venue._geoStatus === 'ok' && <span style={{ fontFamily: F, fontSize: 11, color: '#16a34a' }}>✓ geocoded</span>}
        {venue._geoStatus === 'failed' && <span style={{ fontFamily: F, fontSize: 11, color: '#dc2626' }}>geocode failed</span>}
      </div>
    </div>
  )
}

// ── Manual Entry: single venue form ──────────────────────────────────────────

function ManualVenueForm({
  venue, onChange, onDelete, canDelete, institutionName,
}: {
  venue: VenueDraft
  onChange: (v: VenueDraft) => void
  onDelete: () => void
  canDelete: boolean
  institutionName?: string
}) {
  function set(key: keyof VenueDraft, val: string | HoursMap) {
    onChange({ ...venue, [key]: val })
  }

  async function handleAddressBlur() {
    if (!venue.address.trim()) return
    onChange({ ...venue, _geoStatus: 'loading' })
    try {
      const searchName = [institutionName, venue.name].filter(Boolean).join(' ').trim()
      const res = await fetch('/api/admin/seed/enrich', {
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

  return (
    <div style={{ border: '1px solid rgba(0,0,0,0.1)', padding: 16, marginBottom: 12, position: 'relative' as const }}>
      {canDelete && (
        <button
          onClick={onDelete}
          style={{ position: 'absolute' as const, top: 10, right: 10, background: 'transparent', border: 'none', fontSize: 16, cursor: 'pointer', color: 'rgba(0,0,0,0.3)' }}
        >×</button>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div>
          <label style={labelStyle}>Venue Name</label>
          <input style={inputStyle} value={venue.name} onChange={e => set('name', e.target.value)} placeholder="Gallery 23rd Street" />
        </div>
        <div>
          <label style={labelStyle}>Exhibitions URL</label>
          <input style={inputStyle} value={venue.exhibitions_url} onChange={e => set('exhibitions_url', e.target.value)} placeholder="https://…/exhibitions" />
        </div>
        <div>
          <label style={labelStyle}>Address</label>
          <input
            style={inputStyle}
            value={venue.address}
            onChange={e => set('address', e.target.value)}
            onBlur={handleAddressBlur}
            placeholder="123 W 25th St, New York, NY 10001"
          />
        </div>
        <div>
          <label style={labelStyle}>Neighborhood</label>
          <input style={inputStyle} value={venue.neighborhood} onChange={e => set('neighborhood', e.target.value)} placeholder="Chelsea" />
        </div>
      </div>

      <GeoField venue={venue} onUpdate={partial => onChange({ ...venue, ...partial })} />

      <div style={{ marginTop: 16 }}>
        <label style={{ ...labelStyle, marginBottom: 10 }}>Hours</label>
        <HoursInput value={venue.hours} onChange={hours => set('hours', hours)} />
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
      const res = await fetch('/api/admin/seed/insert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          institutions: [{
            name: name.trim(),
            website: website.trim(),
            type,
            venues: venues.map(v => ({
              name: v.name, exhibitions_url: v.exhibitions_url,
              address: v.address, neighborhood: v.neighborhood,
              latitude: v.latitude, longitude: v.longitude,
              hours: v.hours,
            })),
          }],
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
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 12, marginBottom: 12 }}>
          <div>
            <label style={labelStyle}>Name</label>
            <input style={inputStyle} value={name} onChange={e => setName(e.target.value)} placeholder="Gallery Name" />
          </div>
          <div>
            <label style={labelStyle}>Website</label>
            <input style={inputStyle} value={website} onChange={e => setWebsite(e.target.value)} placeholder="https://…" />
          </div>
          <div>
            <label style={labelStyle}>Type</label>
            <select value={type} onChange={e => setType(e.target.value as InstType)} style={{ ...inputStyle, paddingRight: 20, width: 'auto' }}>
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
          <ManualVenueForm
            key={v._id}
            venue={v}
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
            textTransform: 'uppercase' as const, padding: '10px 28px', border: 'none',
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

type Mode = 'suggest' | 'manual'

export default function SeedTool({ inline }: { inline?: boolean }) {
  const [mode, setMode] = useState<Mode>('suggest')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [institutions, setInstitutions] = useState<InstitutionDraft[]>([])
  const [inserting, setInserting] = useState(false)
  const [enriching, setEnriching] = useState(false)
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null)
  const inputId = useId()

  function showToast(msg: string, ok: boolean) {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 4500)
  }

  async function handleSuggest() {
    if (!query.trim()) return
    setLoading(true)
    setEnriching(false)
    setError(null)
    setInstitutions([])
    try {
      const res = await fetch('/api/admin/seed/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      })
      const json = await res.json()
      if (!res.ok || json.error) {
        setError(json.error ?? `HTTP ${res.status}`)
        return
      }
      const mapped: InstitutionDraft[] = (json.institutions as Record<string, unknown>[]).map(institutionFromRaw)
      setEnriching(true)
      const enriched = await Promise.all(
        mapped.map(async inst => ({
          ...inst,
          venues: await Promise.all(
            inst.venues.map(async v => {
              if (!v.address.trim()) {
                return { ...v, _addressFallback: true, _hoursFallback: true, _geoStatus: 'failed' as GeoStatus }
              }
              try {
                const er = await fetch('/api/admin/seed/enrich', {
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
      setInstitutions(enriched)
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
    const payload = institutions.map(inst => ({
      name: inst.name, website: inst.website, type: inst.type,
      venues: inst.venues.map(v => ({
        name: v.name, exhibitions_url: v.exhibitions_url,
        address: v.address, neighborhood: v.neighborhood,
        latitude: v.latitude, longitude: v.longitude,
        hours: v.hours,
      })),
    }))
    try {
      const res = await fetch('/api/admin/seed/insert', {
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
        setInstitutions([])
        setQuery('')
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Network error', false)
    } finally {
      setInserting(false)
    }
  }

  const venueCount = institutions.reduce((s, i) => s + i.venues.length, 0)

  const modeToggle = (
    <div style={{ display: 'flex', gap: 0, border: '1px solid rgba(0,0,0,0.18)', width: 'fit-content', marginBottom: 28 }}>
      {(['suggest', 'manual'] as Mode[]).map(m => (
        <button
          key={m}
          onClick={() => setMode(m)}
          style={{
            fontFamily: F, fontSize: 12, fontWeight: mode === m ? 700 : 400,
            padding: '6px 18px', border: 'none', cursor: 'pointer',
            background: mode === m ? '#000' : 'transparent',
            color: mode === m ? '#fff' : 'rgba(0,0,0,0.5)',
            transition: 'all 150ms ease',
          }}
        >
          {m === 'suggest' ? 'AI Suggest' : 'Manual Entry'}
        </button>
      ))}
    </div>
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
              textTransform: 'uppercase' as const, padding: '10px 24px', border: 'none',
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
          <button onClick={handleSuggest} style={{ marginLeft: 12, fontFamily: F, fontSize: 12, fontWeight: 700, background: 'transparent', border: '1px solid #dc2626', color: '#dc2626', padding: '2px 10px', cursor: 'pointer' }}>Retry</button>
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

      {institutions.length > 0 && (
        <>
          <div style={{ overflowX: 'auto', marginBottom: 20 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={thStyle}>Kind</th>
                  <th style={thStyle}>Name</th>
                  <th style={thStyle}>Website / Exhibitions URL</th>
                  <th style={thStyle}>Type / Address</th>
                  <th style={thStyle}>Neighborhood</th>
                  <th style={thStyle}>Lat</th>
                  <th style={thStyle}>Lng</th>
                  <th style={thStyle}>Hours</th>
                  <th style={thStyle}></th>
                </tr>
              </thead>
              <tbody>
                {institutions.map((inst, i) => (
                  <InstitutionGroup
                    key={inst._id}
                    inst={inst}
                    onChange={updated => { const next = [...institutions]; next[i] = updated; setInstitutions(next) }}
                    onDelete={() => setInstitutions(institutions.filter((_, j) => j !== i))}
                    onInserted={() => {
                      setInstitutions(prev => prev.filter((_, j) => j !== i))
                      showToast(`"${inst.name}" inserted successfully.`, true)
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>

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
                textTransform: 'uppercase' as const, padding: '10px 28px', border: 'none',
                cursor: inserting ? 'wait' : 'pointer',
                background: inserting ? 'rgba(0,0,0,0.12)' : '#3432A8',
                color: inserting ? 'rgba(0,0,0,0.3)' : '#fff',
              }}
            >
              {inserting ? 'Inserting…' : `Add ${institutions.length + venueCount} rows to database`}
            </button>
          </div>
        </>
      )}
    </>
  )

  const content = (
    <>
      {modeToggle}
      {mode === 'suggest' && suggestPanel}
      {mode === 'manual' && (
        <ManualEntryForm
          onInserted={() => showToast('Institution + venue(s) added successfully.', true)}
        />
      )}
      {toast && <Toast msg={toast.msg} ok={toast.ok} />}
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
