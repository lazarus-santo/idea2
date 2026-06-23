'use client'

import { useState, useEffect, useCallback } from 'react'

type PendingEx = {
  id: string
  show_title: string
  artists: string[]
  venue_name: string
  venue_url: string | null
  start_date: string | null
  end_date: string | null
  description: string | null
  image_url: string | null
  press_release: string | null
  address_override: string | null
  address_override_neighborhood: string | null
  venue_address: string | null
  venue_neighborhood: string | null
  missing_fields: string[]
  prereads: { id: string; article_title: string | null; publication: string | null; article_url: string | null }[]
}

const F = 'var(--font-inter-tight), system-ui, sans-serif'

function fmtDate(d: string | null) {
  if (!d) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

const lbl: React.CSSProperties = {
  display: 'block', fontSize: 10, fontWeight: 700,
  letterSpacing: '0.12em', textTransform: 'uppercase',
  color: 'rgba(0,0,0,0.4)', marginBottom: 4, fontFamily: F,
}

function fieldInput(missing: boolean): React.CSSProperties {
  return {
    width: '100%', fontFamily: F, fontSize: 13, color: '#000',
    background: '#fff', padding: '7px 10px', outline: 'none', boxSizing: 'border-box',
    border: missing ? '1px solid #f59e0b' : '1px solid rgba(0,0,0,0.18)',
  }
}

const btn: React.CSSProperties = {
  fontFamily: F, fontSize: 11, fontWeight: 700,
  letterSpacing: '0.1em', textTransform: 'uppercase',
  padding: '6px 14px', border: 'none', cursor: 'pointer',
}

function PendingCard({
  ex,
  onRemove,
  onPublished,
}: {
  ex: PendingEx
  onRemove: (id: string) => void
  onPublished: (id: string) => void
}) {
  const [startDate, setStartDate]   = useState(ex.start_date ?? '')
  const [endDate, setEndDate]       = useState(ex.end_date ?? '')
  const [imageUrl, setImageUrl]     = useState(ex.image_url ?? '')
  const [addr, setAddr]             = useState(ex.address_override ?? '')
  const [neigh, setNeigh]           = useState(ex.address_override_neighborhood ?? '')
  const [description, setDesc]      = useState(ex.description ?? '')
  const [pressRelease, setPR]       = useState(ex.press_release ?? '')
  const [showDesc, setShowDesc]     = useState(false)
  const [showPR, setShowPR]         = useState(false)
  const [saving, setSaving]         = useState(false)
  const [approving, setApproving]   = useState(false)
  const [deleting, setDeleting]     = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [msg, setMsg]               = useState('')

  const isDirty =
    startDate   !== (ex.start_date ?? '') ||
    endDate     !== (ex.end_date ?? '') ||
    imageUrl    !== (ex.image_url ?? '') ||
    addr        !== (ex.address_override ?? '') ||
    neigh       !== (ex.address_override_neighborhood ?? '') ||
    description !== (ex.description ?? '') ||
    pressRelease !== (ex.press_release ?? '')

  const missing = new Set(ex.missing_fields ?? [])

  function flash(m: string) {
    setMsg(m)
    setTimeout(() => setMsg(''), 2500)
  }

  async function save() {
    setSaving(true)
    try {
      const res = await fetch(`/api/admin/exhibitions/${ex.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start_date:                     startDate || null,
          end_date:                       endDate || null,
          image_url:                      imageUrl || null,
          address_override:               addr || null,
          address_override_neighborhood:  neigh || null,
          description:                    description || null,
          press_release:                  pressRelease || null,
        }),
      })
      if (!res.ok) throw new Error()
      flash('Saved')
    } catch {
      flash('Error saving')
    } finally {
      setSaving(false)
    }
  }

  async function approve() {
    setApproving(true)
    try {
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

  return (
    <div style={{ borderBottom: '1px solid rgba(0,0,0,0.1)', padding: '28px 0', fontFamily: F }}>

      {/* Header */}
      <div style={{ display: 'flex', gap: 14, marginBottom: 14 }}>
        <div style={{ width: 88, height: 66, flexShrink: 0, background: '#e0ddd0', overflow: 'hidden' }}>
          {imageUrl && <img src={imageUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'rgba(0,0,0,0.4)' }}>
              {ex.venue_name}
            </span>
            {ex.venue_url && (
              <a href={ex.venue_url} target="_blank" rel="noopener noreferrer"
                style={{ fontFamily: F, fontSize: 11, color: 'rgba(0,0,0,0.4)', textDecoration: 'none', borderBottom: '1px solid rgba(0,0,0,0.25)' }}>
                Gallery ↗
              </a>
            )}
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.3, marginBottom: 3 }}>{ex.show_title}</div>
          <div style={{ fontSize: 13, color: 'rgba(0,0,0,0.5)' }}>{ex.artists.join(', ')}</div>
          <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.4)', marginTop: 2 }}>
            {fmtDate(startDate || null)} – {fmtDate(endDate || null)}
          </div>
        </div>
      </div>

      {/* Missing field badges */}
      {missing.size > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
          {[...missing].map(f => (
            <span key={f} style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', background: '#fef3c7', color: '#92400e', padding: '2px 8px' }}>
              {f.replace(/_/g, ' ')}
            </span>
          ))}
        </div>
      )}

      {/* Editable fields grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 16px', marginBottom: 14 }}>

        <div>
          <label style={{ ...lbl, color: missing.has('start_date') ? '#92400e' : 'rgba(0,0,0,0.4)' }}>Start date</label>
          <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={fieldInput(missing.has('start_date'))} />
        </div>

        <div>
          <label style={{ ...lbl, color: missing.has('end_date') ? '#92400e' : 'rgba(0,0,0,0.4)' }}>End date</label>
          <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} style={fieldInput(missing.has('end_date'))} />
        </div>

        <div style={{ gridColumn: '1 / -1' }}>
          <label style={{ ...lbl, color: missing.has('image_url') ? '#92400e' : 'rgba(0,0,0,0.4)' }}>Image URL</label>
          <input type="text" value={imageUrl} onChange={e => setImageUrl(e.target.value)} placeholder="https://…" style={fieldInput(missing.has('image_url'))} />
        </div>

        <div>
          <label style={lbl}>Address override</label>
          <input type="text" value={addr} onChange={e => setAddr(e.target.value)} placeholder={ex.venue_address ?? 'Venue default'} style={fieldInput(false)} />
        </div>

        <div>
          <label style={lbl}>Neighborhood override</label>
          <input type="text" value={neigh} onChange={e => setNeigh(e.target.value)} placeholder={ex.venue_neighborhood ?? 'Venue default'} style={fieldInput(false)} />
        </div>

      </div>

      {/* Description */}
      <div style={{ marginBottom: 12 }}>
        <button
          onClick={() => setShowDesc(v => !v)}
          style={{ fontFamily: F, fontSize: 12, background: 'transparent', border: 'none', cursor: 'pointer', color: missing.has('description') ? '#92400e' : 'rgba(0,0,0,0.5)', padding: 0, textDecoration: 'underline', textUnderlineOffset: 2 }}
        >
          {showDesc ? 'Hide' : description ? 'Edit' : 'Add'} description
          {missing.has('description') && ' *'}
        </button>
        {showDesc && (
          <textarea
            value={description}
            onChange={e => setDesc(e.target.value)}
            placeholder="Short description of the exhibition…"
            rows={4}
            style={{
              display: 'block', marginTop: 8, width: '100%', fontFamily: F,
              fontSize: 13, lineHeight: 1.6, color: '#000', background: '#fff',
              border: missing.has('description') ? '1px solid #f59e0b' : '1px solid rgba(0,0,0,0.18)',
              padding: '8px 12px', outline: 'none', resize: 'vertical', boxSizing: 'border-box',
            }}
          />
        )}
      </div>

      {/* Press release */}
      <div style={{ marginBottom: 18 }}>
        <button
          onClick={() => setShowPR(v => !v)}
          style={{ fontFamily: F, fontSize: 12, background: 'transparent', border: 'none', cursor: 'pointer', color: missing.has('press_release') ? '#92400e' : 'rgba(0,0,0,0.5)', padding: 0, textDecoration: 'underline', textUnderlineOffset: 2 }}
        >
          {showPR ? 'Hide' : pressRelease ? 'Edit' : 'Add'} press release
          {missing.has('press_release') && ' *'}
        </button>
        {showPR && (
          <textarea
            value={pressRelease}
            onChange={e => setPR(e.target.value)}
            placeholder="Paste press release…"
            rows={8}
            style={{
              display: 'block', marginTop: 8, width: '100%', fontFamily: F,
              fontSize: 13, lineHeight: 1.6, color: '#000', background: '#fff',
              border: missing.has('press_release') ? '1px solid #f59e0b' : '1px solid rgba(0,0,0,0.18)',
              padding: '8px 12px', outline: 'none', resize: 'vertical', boxSizing: 'border-box',
            }}
          />
        )}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button
          onClick={save}
          disabled={saving || !isDirty}
          style={{ ...btn, background: isDirty ? '#000' : 'transparent', color: isDirty ? '#FFFCEC' : 'rgba(0,0,0,0.3)', border: isDirty ? 'none' : '1px solid rgba(0,0,0,0.18)', cursor: isDirty ? 'pointer' : 'default' }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>

        <button onClick={approve} disabled={approving} style={{ ...btn, background: '#1a5c2a', color: '#fff', opacity: approving ? 0.6 : 1 }}>
          {approving ? 'Publishing…' : 'Approve'}
        </button>

        {confirmDel ? (
          <>
            <button onClick={doDelete} disabled={deleting} style={{ ...btn, background: '#dc2626', color: '#fff' }}>
              {deleting ? 'Deleting…' : 'Confirm delete'}
            </button>
            <button onClick={() => setConfirmDel(false)} style={{ ...btn, background: 'transparent', color: 'rgba(0,0,0,0.5)', border: '1px solid rgba(0,0,0,0.18)' }}>
              Cancel
            </button>
          </>
        ) : (
          <button onClick={() => setConfirmDel(true)} style={{ ...btn, background: 'transparent', color: '#dc2626', border: '1px solid #dc2626' }}>
            Delete
          </button>
        )}

        {msg && <span style={{ fontSize: 12, color: msg === 'Saved' ? '#1a5c2a' : '#dc2626' }}>{msg}</span>}

        <span style={{ fontSize: 11, color: 'rgba(0,0,0,0.3)', marginLeft: 'auto' }}>
          {ex.prereads.length} prereads
        </span>
      </div>
    </div>
  )
}

export default function PendingTab({ onCount }: { onCount: (n: number) => void }) {
  const [exhibitions, setExhibitions] = useState<PendingEx[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/exhibitions')
      const all = await res.json()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pending = all.filter((e: any) => e.status === 'pending')
      setExhibitions(pending)
      onCount(pending.length)
    } finally {
      setLoading(false)
    }
  }, [onCount])

  useEffect(() => { load() }, [load])

  function remove(id: string) {
    setExhibitions(prev => {
      const next = prev.filter(e => e.id !== id)
      onCount(next.length)
      return next
    })
  }

  if (loading) return <p style={{ fontFamily: F, fontSize: 13, color: 'rgba(0,0,0,0.4)' }}>Loading…</p>
  if (exhibitions.length === 0) return <p style={{ fontFamily: F, fontSize: 13, color: 'rgba(0,0,0,0.4)' }}>No pending exhibitions.</p>

  return (
    <div>
      {exhibitions.map(ex => (
        <PendingCard key={ex.id} ex={ex} onRemove={remove} onPublished={remove} />
      ))}
    </div>
  )
}
