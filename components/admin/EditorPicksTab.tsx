'use client'

import { useState, useEffect } from 'react'
import { adminFetch } from '@/lib/admin-fetch'

// ── Types ─────────────────────────────────────────────────────────────────────


type CurrentPick = {
  pick_id: string
  reference_id: string
}

type ExhibitionCurrentPick = CurrentPick & { show_title?: string; artists?: string[]; venue_name?: string; end_date?: string | null; image_url?: string | null }
type ArticleCurrentPick    = CurrentPick & { headline?: string; author?: string | null; publication?: string | null; published_at?: string | null }
type BookCurrentPick       = CurrentPick & { title?: string; author?: string | null; source?: string | null }

type PicksData = {
  exhibitions: { current: ExhibitionCurrentPick | null }
  articles:    { current: ArticleCurrentPick | null }
  books:       { current: BookCurrentPick | null }
}

type ExItem = { id: string; show_title: string; artists: string[]; venue_name: string; end_date: string | null; image_url: string | null }
type ArItem = { id: string; headline: string; author: string | null; publication_name: string | null; published_at: string | null }

// ── Shared styles ─────────────────────────────────────────────────────────────

const F = 'var(--font-inter-tight), system-ui, sans-serif'

const btnBase: React.CSSProperties = {
  fontFamily: F, fontSize: 11, fontWeight: 700,
  letterSpacing: '0.1em', textTransform: 'uppercase',
  padding: '5px 12px', border: 'none', borderRadius: 999, cursor: 'pointer',
}

const inputS: React.CSSProperties = {
  width: '100%', fontFamily: F, fontSize: 13, color: '#000',
  background: '#fff', border: '1px solid rgba(0,0,0,0.18)',
  padding: '7px 10px', outline: 'none', boxSizing: 'border-box',
}

const labelS: React.CSSProperties = {
  display: 'block', fontFamily: F, fontSize: 10, fontWeight: 700,
  letterSpacing: '0.12em', textTransform: 'uppercase',
  color: 'rgba(0,0,0,0.4)', marginBottom: 4,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(d: string | null | undefined) {
  if (!d) return null
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// ── Unpublish button ──────────────────────────────────────────────────────────

function UnpublishBtn({ pickId, onDone }: { pickId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false)

  async function go() {
    setBusy(true)
    try {
      await adminFetch(`/api/admin/editor-picks/${pickId}/unpublish`, { method: 'POST' })
      onDone()
    } finally {
      setBusy(false)
    }
  }

  return (
    <button onClick={go} disabled={busy}
      style={{ ...btnBase, background: 'transparent', color: '#dc2626', border: '1px solid #dc2626', opacity: busy ? 0.6 : 1 }}>
      {busy ? '…' : 'Unpublish'}
    </button>
  )
}

// ── Current pick panel ────────────────────────────────────────────────────────

function CurrentPickPanel({
  pickId, onUnpublish, children,
}: {
  pickId: string
  onUnpublish: () => void
  children: React.ReactNode
}) {
  return (
    <div style={{ background: '#f0ecde', padding: '14px 16px', marginBottom: 24 }}>
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 10, flexShrink: 0 }}>
          <span style={{
            fontFamily: F, fontSize: 10, fontWeight: 700,
            letterSpacing: '0.1em', textTransform: 'uppercase',
            color: '#1a5c2a', background: '#dcfce7',
            padding: '2px 8px',
          }}>
            Live now
          </span>
          <UnpublishBtn pickId={pickId} onDone={onUnpublish} />
        </div>
      </div>
    </div>
  )
}

// ── Search picker (exhibitions + articles) ────────────────────────────────────

function SearchPicker<T extends { id: string }>({
  pickType, fetchUrl, filterFn, renderRow, onSelected,
}: {
  pickType: 'exhibition' | 'article'
  fetchUrl: string
  filterFn: (item: T, q: string) => boolean
  renderRow: (item: T) => React.ReactNode
  onSelected: (referenceId: string) => void
}) {
  const [q, setQ] = useState('')
  const [items, setItems] = useState<T[]>([])
  const [loaded, setLoaded] = useState(false)
  const [selecting, setSelecting] = useState<string | null>(null)
  const [msg, setMsg] = useState('')

  async function load() {
    if (loaded) return
    try {
      const res = await adminFetch(fetchUrl)
      if (res.ok) { setItems(await res.json()); setLoaded(true) }
    } catch { /* silent */ }
  }

  async function select(id: string) {
    setSelecting(id)
    setMsg('')
    try {
      const res = await adminFetch('/api/admin/editor-picks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pick_type: pickType, reference_id: id }),
      })
      if (!res.ok) throw new Error()
      setQ('')
      setMsg('Live now')
      onSelected(id)
    } catch { setMsg('Error — try again') }
    finally { setSelecting(null) }
  }

  const filtered = q.length > 1 ? items.filter(i => filterFn(i, q)).slice(0, 8) : []

  return (
    <div>
      <input type="text" placeholder="Search…" value={q}
        onFocus={load} onChange={e => { setQ(e.target.value); load() }}
        style={inputS} />
      {msg && <p style={{ fontFamily: F, fontSize: 12, color: msg.startsWith('Error') ? '#dc2626' : '#1a5c2a', margin: '6px 0 0' }}>{msg}</p>}
      {q.length > 1 && loaded && (
        <div style={{ border: '1px solid rgba(0,0,0,0.12)', borderTop: 'none', background: '#fff' }}>
          {filtered.length === 0
            ? <div style={{ fontFamily: F, fontSize: 13, color: 'rgba(0,0,0,0.4)', padding: '10px 12px' }}>No results.</div>
            : filtered.map(item => (
              <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
                <div style={{ flex: 1, minWidth: 0 }}>{renderRow(item)}</div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button onClick={() => select(item.id)} disabled={!!selecting}
                    style={{ ...btnBase, background: '#000', color: '#FFFCEC', opacity: selecting === item.id ? 0.6 : 1 }}>
                    Make live
                  </button>
                </div>
              </div>
            ))
          }
        </div>
      )}
    </div>
  )
}

// ── Book form ─────────────────────────────────────────────────────────────────

function BookForm({ onSelected }: { onSelected: (referenceId: string) => void }) {
  const [title, setTitle]       = useState('')
  const [author, setAuthor]     = useState('')
  const [publisher, setPub]     = useState('')
  const [imageUrl, setImageUrl] = useState('')
  const [submitting, setSub]    = useState(false)
  const [msg, setMsg]           = useState('')

  async function submit() {
    if (!title.trim()) return
    setSub(true)
    setMsg('')
    try {
      const res = await adminFetch('/api/admin/editor-picks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pick_type: 'book', title: title.trim(), author: author.trim() || null, publisher: publisher.trim() || null, image_url: imageUrl.trim() || null }),
      })
      if (!res.ok) throw new Error()
      const { reference_id } = await res.json()
      onSelected(reference_id)
      setTitle(''); setAuthor(''); setPub(''); setImageUrl('')
      setMsg('Live now')
    } catch { setMsg('Error — try again') }
    finally { setSub(false) }
  }

  const canSubmit = title.trim().length > 0

  return (
    <form onSubmit={e => e.preventDefault()}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 16px' }}>
        <div style={{ gridColumn: '1 / -1' }}>
          <label style={labelS}>Book title *</label>
          <input type="text" value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Ways of Seeing" style={inputS} />
        </div>
        <div>
          <label style={labelS}>Author</label>
          <input type="text" value={author} onChange={e => setAuthor(e.target.value)} placeholder="e.g. John Berger" style={inputS} />
        </div>
        <div>
          <label style={labelS}>Publisher</label>
          <input type="text" value={publisher} onChange={e => setPub(e.target.value)} placeholder="e.g. Penguin" style={inputS} />
        </div>
        <div style={{ gridColumn: '1 / -1' }}>
          <label style={labelS}>Image URL</label>
          <input type="text" value={imageUrl} onChange={e => setImageUrl(e.target.value)} placeholder="https://…" style={inputS} />
          {imageUrl && <img src={imageUrl} alt="" style={{ marginTop: 8, height: 80, objectFit: 'contain', display: 'block', background: '#e8e4d8' }} />}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14 }}>
        <button onClick={submit} disabled={submitting || !canSubmit}
          style={{ ...btnBase, background: canSubmit ? '#000' : 'transparent', color: canSubmit ? '#FFFCEC' : 'rgba(0,0,0,0.3)', border: canSubmit ? 'none' : '1px solid rgba(0,0,0,0.18)', cursor: canSubmit ? 'pointer' : 'default', opacity: submitting ? 0.6 : 1 }}>
          {submitting ? '…' : 'Publish now'}
        </button>
        {msg && <span style={{ fontFamily: F, fontSize: 12, color: msg.startsWith('Error') ? '#dc2626' : '#1a5c2a' }}>{msg}</span>}
      </div>
    </form>
  )
}

// ── Exhibition section ────────────────────────────────────────────────────────

function ExhibitionSection({ current: init }: { current: ExhibitionCurrentPick | null }) {
  const [current, setCurrent] = useState(init)

  function applyCurrent(pick_id: string, reference_id: string, details: Partial<ExhibitionCurrentPick>) {
    setCurrent({ pick_id, reference_id, ...details })
  }

  return (
    <div>
      {current && (
        <CurrentPickPanel pickId={current.pick_id} onUnpublish={() => setCurrent(null)}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            {current.image_url && (
              <div style={{ width: 60, height: 46, flexShrink: 0, background: '#e0ddd0', overflow: 'hidden' }}>
                <img src={current.image_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
              </div>
            )}
            <div style={{ fontFamily: F }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{current.show_title}</div>
              <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.55)' }}>{current.artists?.join(', ')}</div>
              <div style={{ fontSize: 11, color: 'rgba(0,0,0,0.4)' }}>{current.venue_name}{current.end_date ? ` · Closes ${fmtDate(current.end_date)}` : ''}</div>
            </div>
          </div>
        </CurrentPickPanel>
      )}
      <SearchPicker<ExItem>
        pickType="exhibition"
        fetchUrl="/api/admin/exhibitions"
        filterFn={(item, q) => item.show_title.toLowerCase().includes(q.toLowerCase()) || item.artists.some(a => a.toLowerCase().includes(q.toLowerCase()))}
        renderRow={item => (
          <div style={{ fontFamily: F }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{item.show_title}</div>
            <div style={{ fontSize: 11, color: 'rgba(0,0,0,0.45)' }}>{item.artists.join(', ')}{item.venue_name ? ` · ${item.venue_name}` : ''}</div>
          </div>
        )}
        onSelected={(refId) => {
          applyCurrent('', refId, {})
        }}
      />
    </div>
  )
}

// ── Article section ───────────────────────────────────────────────────────────

function ArticleSection({ current: init }: { current: ArticleCurrentPick | null }) {
  const [current, setCurrent] = useState(init)

  function applyCurrent(pick_id: string, reference_id: string, details: Partial<ArticleCurrentPick>) {
    setCurrent({ pick_id, reference_id, ...details })
  }

  return (
    <div>
      {current && (
        <CurrentPickPanel pickId={current.pick_id} onUnpublish={() => setCurrent(null)}>
          <div style={{ fontFamily: F }}>
            <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.35 }}>{current.headline}</div>
            <div style={{ fontSize: 11, color: 'rgba(0,0,0,0.5)', marginTop: 2 }}>
              {[current.publication, current.author].filter(Boolean).join(' · ')}
            </div>
          </div>
        </CurrentPickPanel>
      )}
      <SearchPicker<ArItem>
        pickType="article"
        fetchUrl="/api/readings"
        filterFn={(item, q) => item.headline.toLowerCase().includes(q.toLowerCase()) || (item.publication_name ?? '').toLowerCase().includes(q.toLowerCase()) || (item.author ?? '').toLowerCase().includes(q.toLowerCase())}
        renderRow={item => (
          <div style={{ fontFamily: F }}>
            <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.35 }}>{item.headline}</div>
            <div style={{ fontSize: 11, color: 'rgba(0,0,0,0.45)' }}>{[item.publication_name, item.author].filter(Boolean).join(' · ')}</div>
          </div>
        )}
        onSelected={(refId) => {
          applyCurrent('', refId, {})
        }}
      />
    </div>
  )
}

// ── Book section ──────────────────────────────────────────────────────────────

function BookSection({ current: init }: { current: BookCurrentPick | null }) {
  const [current, setCurrent] = useState(init)

  function applyCurrent(pick_id: string, reference_id: string, details: Partial<BookCurrentPick>) {
    setCurrent({ pick_id, reference_id, ...details })
  }

  return (
    <div>
      {current && (
        <CurrentPickPanel pickId={current.pick_id} onUnpublish={() => setCurrent(null)}>
          <div style={{ fontFamily: F }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{current.title}</div>
            <div style={{ fontSize: 11, color: 'rgba(0,0,0,0.5)', marginTop: 2 }}>
              {[current.author, current.source].filter(Boolean).join(' · ')}
            </div>
          </div>
        </CurrentPickPanel>
      )}
      <BookForm onSelected={(refId) => {
        applyCurrent('', refId, {})
      }} />
    </div>
  )
}

// ── Main tab ──────────────────────────────────────────────────────────────────

export default function EditorPicksTab() {
  const [data, setData] = useState<PicksData | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  useEffect(() => {
    adminFetch('/api/admin/editor-picks')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(setData)
      .catch(() => setErr('Failed to load'))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <p style={{ fontFamily: F, fontSize: 13, color: 'rgba(0,0,0,0.4)' }}>Loading…</p>
  if (err) return <p style={{ fontFamily: F, fontSize: 13, color: '#dc2626' }}>{err}</p>
  if (!data) return null

  const headStyle: React.CSSProperties = {
    fontFamily: F, fontSize: 10, fontWeight: 700,
    letterSpacing: '0.16em', textTransform: 'uppercase',
    color: 'rgba(0,0,0,0.4)', margin: '0 0 16px',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 52 }}>
      <div>
        <p style={headStyle}>Exhibition pick</p>
        <ExhibitionSection current={data.exhibitions.current} />
      </div>
      <div>
        <p style={headStyle}>Article pick</p>
        <ArticleSection current={data.articles.current} />
      </div>
      <div>
        <p style={headStyle}>Book pick</p>
        <BookSection current={data.books.current} />
      </div>
    </div>
  )
}
