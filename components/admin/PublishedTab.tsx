'use client'

import { useState, useEffect, useCallback } from 'react'

type Preread = {
  id: string
  article_title: string | null
  publication: string | null
  article_url: string | null
}

type PublishedEx = {
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
  prereads: Preread[]
}

const F = 'var(--font-inter-tight), system-ui, sans-serif'

const labelS: React.CSSProperties = {
  display: 'block', fontSize: 10, fontWeight: 700,
  letterSpacing: '0.12em', textTransform: 'uppercase',
  color: 'rgba(0,0,0,0.4)', marginBottom: 4, fontFamily: F,
}

const inputS: React.CSSProperties = {
  width: '100%', fontFamily: F, fontSize: 13, color: '#000',
  background: '#fff', border: '1px solid rgba(0,0,0,0.18)',
  padding: '7px 10px', outline: 'none', boxSizing: 'border-box',
}

const btnS: React.CSSProperties = {
  fontFamily: F, fontSize: 11, fontWeight: 700,
  letterSpacing: '0.1em', textTransform: 'uppercase',
  padding: '6px 14px', border: 'none', cursor: 'pointer',
}

function fmtDate(d: string | null) {
  if (!d) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function AddPrereadForm({ exhibitionId, onAdded }: { exhibitionId: string; onAdded: (p: Preread) => void }) {
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [pub, setPub] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  async function submit() {
    if (!url) return
    setSaving(true)
    try {
      const res = await fetch('/api/admin/prereads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exhibition_id: exhibitionId, article_url: url, article_title: title || null, publication: pub || null }),
      })
      if (!res.ok) throw new Error()
      const data = await res.json()
      onAdded(data)
      setUrl(''); setTitle(''); setPub('')
    } catch {
      setMsg('Error saving')
      setTimeout(() => setMsg(''), 2000)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ marginTop: 12, background: '#f5f2e8', padding: '14px 16px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 14px', marginBottom: 10 }}>
        <div style={{ gridColumn: '1 / -1' }}>
          <label style={labelS}>Article URL *</label>
          <input type="text" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://..." style={inputS} />
        </div>
        <div>
          <label style={labelS}>Article title</label>
          <input type="text" value={title} onChange={e => setTitle(e.target.value)} style={inputS} />
        </div>
        <div>
          <label style={labelS}>Publication</label>
          <input type="text" value={pub} onChange={e => setPub(e.target.value)} placeholder="Artforum, Frieze…" style={inputS} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button onClick={submit} disabled={saving || !url} style={{ ...btnS, background: url ? '#000' : 'transparent', color: url ? '#FFFCEC' : 'rgba(0,0,0,0.3)', border: url ? 'none' : '1px solid rgba(0,0,0,0.18)', cursor: url ? 'pointer' : 'default' }}>
          {saving ? 'Saving…' : 'Save preread'}
        </button>
        {msg && <span style={{ fontSize: 12, color: '#dc2626' }}>{msg}</span>}
      </div>
    </div>
  )
}

function PublishedCard({ ex, onUnpublish }: { ex: PublishedEx; onUnpublish: (id: string) => void }) {
  const [startDate, setStartDate]   = useState(ex.start_date ?? '')
  const [endDate, setEndDate]       = useState(ex.end_date ?? '')
  const [imageUrl, setImageUrl]     = useState(ex.image_url ?? '')
  const [addr, setAddr]             = useState(ex.address_override ?? '')
  const [neigh, setNeigh]           = useState(ex.address_override_neighborhood ?? '')
  const [description, setDesc]      = useState(ex.description ?? '')
  const [pressRelease, setPR]       = useState(ex.press_release ?? '')
  const [showDesc, setShowDesc]     = useState(false)
  const [showPR, setShowPR]         = useState(false)
  const [prereads, setPrereads]     = useState<Preread[]>(ex.prereads)
  const [showAdd, setShowAdd]       = useState(false)
  const [saving, setSaving]         = useState(false)
  const [unpublishing, setUnpublishing] = useState(false)
  const [msg, setMsg]               = useState('')

  const isDirty =
    startDate    !== (ex.start_date ?? '') ||
    endDate      !== (ex.end_date ?? '') ||
    imageUrl     !== (ex.image_url ?? '') ||
    addr         !== (ex.address_override ?? '') ||
    neigh        !== (ex.address_override_neighborhood ?? '') ||
    description  !== (ex.description ?? '') ||
    pressRelease !== (ex.press_release ?? '')

  async function saveAddr() {
    setSaving(true)
    try {
      const res = await fetch(`/api/admin/exhibitions/${ex.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start_date:                    startDate || null,
          end_date:                      endDate || null,
          image_url:                     imageUrl || null,
          address_override:              addr || null,
          address_override_neighborhood: neigh || null,
          description:                   description || null,
          press_release:                 pressRelease || null,
        }),
      })
      if (!res.ok) throw new Error()
      setMsg('Saved')
    } catch {
      setMsg('Error')
    } finally {
      setSaving(false)
      setTimeout(() => setMsg(''), 2000)
    }
  }

  async function unpublish() {
    setUnpublishing(true)
    try {
      await fetch(`/api/admin/exhibitions/${ex.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'pending' }),
      })
      onUnpublish(ex.id)
    } finally {
      setUnpublishing(false)
    }
  }

  async function deletePreread(prId: string) {
    await fetch(`/api/admin/prereads/${prId}`, { method: 'DELETE' })
    setPrereads(prev => prev.filter(p => p.id !== prId))
  }

  return (
    <div style={{ borderBottom: '1px solid rgba(0,0,0,0.1)', padding: '28px 0', fontFamily: F }}>
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
            <a href={`/exhibitions/${ex.id}`} target="_blank" rel="noopener noreferrer"
              style={{ fontFamily: F, fontSize: 11, color: 'rgba(0,0,0,0.4)', textDecoration: 'none', borderBottom: '1px solid rgba(0,0,0,0.25)' }}>
              View on site ↗
            </a>
          </div>
          <div style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.3, marginBottom: 3 }}>{ex.show_title}</div>
          <div style={{ fontSize: 13, color: 'rgba(0,0,0,0.5)' }}>{ex.artists.join(', ')}</div>
          <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.4)', marginTop: 2 }}>
            {fmtDate(startDate || null)} – {fmtDate(endDate || null)}
          </div>
        </div>
      </div>

      {/* Editable fields */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 16px', marginBottom: 12 }}>
        <div>
          <label style={labelS}>Start date</label>
          <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={inputS} />
        </div>
        <div>
          <label style={labelS}>End date</label>
          <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} style={inputS} />
        </div>
        <div style={{ gridColumn: '1 / -1' }}>
          <label style={labelS}>Image URL</label>
          <input type="text" value={imageUrl} onChange={e => setImageUrl(e.target.value)} placeholder="https://…" style={inputS} />
        </div>
        <div>
          <label style={labelS}>Address override</label>
          <input type="text" value={addr} onChange={e => setAddr(e.target.value)} placeholder={ex.venue_address ?? 'Venue default'} style={inputS} />
        </div>
        <div>
          <label style={labelS}>Neighborhood override</label>
          <input type="text" value={neigh} onChange={e => setNeigh(e.target.value)} placeholder={ex.venue_neighborhood ?? 'Venue default'} style={inputS} />
        </div>
      </div>

      <div style={{ marginBottom: 10 }}>
        <button onClick={() => setShowDesc(v => !v)} style={{ fontFamily: F, fontSize: 12, background: 'transparent', border: 'none', cursor: 'pointer', color: 'rgba(0,0,0,0.5)', padding: 0, textDecoration: 'underline', textUnderlineOffset: 2 }}>
          {showDesc ? 'Hide' : description ? 'Edit' : 'Add'} description
        </button>
        {showDesc && (
          <textarea value={description} onChange={e => setDesc(e.target.value)} placeholder="Short description…" rows={4}
            style={{ display: 'block', marginTop: 8, width: '100%', fontFamily: F, fontSize: 13, lineHeight: 1.6, color: '#000', background: '#fff', border: '1px solid rgba(0,0,0,0.18)', padding: '8px 12px', outline: 'none', resize: 'vertical', boxSizing: 'border-box' }} />
        )}
      </div>

      <div style={{ marginBottom: 16 }}>
        <button onClick={() => setShowPR(v => !v)} style={{ fontFamily: F, fontSize: 12, background: 'transparent', border: 'none', cursor: 'pointer', color: 'rgba(0,0,0,0.5)', padding: 0, textDecoration: 'underline', textUnderlineOffset: 2 }}>
          {showPR ? 'Hide' : pressRelease ? 'Edit' : 'Add'} press release
        </button>
        {showPR && (
          <textarea value={pressRelease} onChange={e => setPR(e.target.value)} placeholder="Paste press release…" rows={8}
            style={{ display: 'block', marginTop: 8, width: '100%', fontFamily: F, fontSize: 13, lineHeight: 1.6, color: '#000', background: '#fff', border: '1px solid rgba(0,0,0,0.18)', padding: '8px 12px', outline: 'none', resize: 'vertical', boxSizing: 'border-box' }} />
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
        <button
          onClick={saveAddr}
          disabled={saving || !isDirty}
          style={{ ...btnS, background: isDirty ? '#000' : 'transparent', color: isDirty ? '#FFFCEC' : 'rgba(0,0,0,0.3)', border: isDirty ? 'none' : '1px solid rgba(0,0,0,0.18)', cursor: isDirty ? 'pointer' : 'default' }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {msg && <span style={{ fontSize: 12, color: msg === 'Saved' ? '#1a5c2a' : '#dc2626' }}>{msg}</span>}
      </div>

      {/* Prereads */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'rgba(0,0,0,0.4)', marginBottom: 10 }}>
          Prereads ({prereads.length})
        </div>
        {prereads.length === 0 && (
          <div style={{ fontSize: 13, color: 'rgba(0,0,0,0.35)', marginBottom: 8 }}>No prereads yet.</div>
        )}
        {prereads.map((pr) => (
          <div key={pr.id} style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '5px 0', borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
            <div style={{ flex: 1, fontSize: 13 }}>
              {pr.article_url ? (
                <a href={pr.article_url} target="_blank" rel="noopener noreferrer"
                  style={{ color: '#000', textDecoration: 'underline', textUnderlineOffset: 2 }}>
                  {pr.article_title ?? pr.article_url}
                </a>
              ) : (pr.article_title ?? '(no title)')}
              {pr.publication && (
                <span style={{ fontSize: 11, color: 'rgba(0,0,0,0.4)', marginLeft: 8 }}>{pr.publication}</span>
              )}
            </div>
            <button
              onClick={() => deletePreread(pr.id)}
              style={{ fontFamily: F, fontSize: 11, background: 'transparent', border: 'none', cursor: 'pointer', color: '#dc2626', padding: '0 4px', flexShrink: 0 }}
            >
              Remove
            </button>
          </div>
        ))}

        {!showAdd && (
          <button
            onClick={() => setShowAdd(true)}
            style={{ marginTop: 10, fontFamily: F, fontSize: 12, background: 'transparent', border: 'none', cursor: 'pointer', color: 'rgba(0,0,0,0.5)', padding: 0, textDecoration: 'underline', textUnderlineOffset: 2 }}
          >
            + Add preread
          </button>
        )}
        {showAdd && (
          <>
            <AddPrereadForm
              exhibitionId={ex.id}
              onAdded={(p) => {
                setPrereads(prev => [...prev, p])
                setShowAdd(false)
              }}
            />
            <button
              onClick={() => setShowAdd(false)}
              style={{ marginTop: 8, fontFamily: F, fontSize: 12, background: 'transparent', border: 'none', cursor: 'pointer', color: 'rgba(0,0,0,0.4)', padding: 0 }}
            >
              Cancel
            </button>
          </>
        )}
      </div>

      <button
        onClick={unpublish}
        disabled={unpublishing}
        style={{ ...btnS, background: 'transparent', color: 'rgba(0,0,0,0.5)', border: '1px solid rgba(0,0,0,0.2)', opacity: unpublishing ? 0.6 : 1 }}
      >
        {unpublishing ? 'Unpublishing…' : 'Unpublish'}
      </button>
    </div>
  )
}

type SubTab = 'active' | 'expired'

export default function PublishedTab() {
  const [exhibitions, setExhibitions] = useState<PublishedEx[]>([])
  const [loading, setLoading] = useState(true)
  const [subTab, setSubTab] = useState<SubTab>('active')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/exhibitions')
      const all = await res.json()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setExhibitions(all.filter((e: any) => e.status === 'published'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  function handleUnpublish(id: string) {
    setExhibitions(prev => prev.filter(e => e.id !== id))
  }

  const today = new Date().toISOString().slice(0, 10)
  const active = exhibitions.filter(e => !e.end_date || e.end_date >= today)
  const expired = exhibitions.filter(e => e.end_date && e.end_date < today)
  const visible = subTab === 'active' ? active : expired

  function subTabStyle(t: SubTab): React.CSSProperties {
    const on = subTab === t
    return {
      fontFamily: F, fontSize: 12,
      fontWeight: on ? 700 : 400,
      background: 'transparent', border: 'none',
      borderBottom: on ? '1px solid #000' : '1px solid transparent',
      color: on ? '#000' : 'rgba(0,0,0,0.4)',
      padding: '4px 0', cursor: 'pointer',
      transition: 'color 150ms ease',
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 24, marginBottom: 28 }}>
        <button style={subTabStyle('active')} onClick={() => setSubTab('active')}>
          Active {!loading && `(${active.length})`}
        </button>
        <button style={subTabStyle('expired')} onClick={() => setSubTab('expired')}>
          Expired {!loading && `(${expired.length})`}
        </button>
      </div>

      {loading
        ? <p style={{ fontFamily: F, fontSize: 13, color: 'rgba(0,0,0,0.4)' }}>Loading…</p>
        : visible.length === 0
          ? <p style={{ fontFamily: F, fontSize: 13, color: 'rgba(0,0,0,0.4)' }}>No {subTab} exhibitions.</p>
          : visible.map(ex => <PublishedCard key={ex.id} ex={ex} onUnpublish={handleUnpublish} />)
      }
    </div>
  )
}
