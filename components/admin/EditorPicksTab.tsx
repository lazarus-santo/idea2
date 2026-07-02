'use client'

import { useState, useEffect } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

type PickStatus = 'live' | 'pending'
type Mode = 'now' | 'scheduled'

type CurrentPick = {
  pick_id: string
  reference_id: string
  status: PickStatus
  goes_live_at: string | null
}

type ExhibitionCurrentPick = CurrentPick & { show_title?: string; artists?: string[]; venue_name?: string; end_date?: string | null; image_url?: string | null }
type ArticleCurrentPick    = CurrentPick & { headline?: string; author?: string | null; publication?: string | null; published_at?: string | null }
type BookCurrentPick       = CurrentPick & { title?: string; author?: string | null; source?: string | null }

type ExhibitionSuggestion = { pick_id: string; reference_id: string; show_title: string; artists: string[]; venue_name: string; end_date: string | null; image_url: string | null }
type ArticleSuggestion    = { pick_id: string; reference_id: string; headline: string; publication: string | null; author: string | null; published_at: string | null; rss_summary: string | null }
type BookSuggestion       = { pick_id: string; reference_id: string; title: string; author: string | null; source: string | null; goodreads_rating: number | null }

type PicksData = {
  exhibitions: { current: ExhibitionCurrentPick | null; suggestions: ExhibitionSuggestion[] }
  articles:    { current: ArticleCurrentPick | null;    suggestions: ArticleSuggestion[] }
  books:       { current: BookCurrentPick | null;       suggestions: BookSuggestion[] }
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

const colHead: React.CSSProperties = {
  fontFamily: F, fontSize: 10, fontWeight: 700,
  letterSpacing: '0.14em', textTransform: 'uppercase',
  color: 'rgba(0,0,0,0.35)', marginBottom: 12,
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
      await fetch(`/api/admin/editor-picks/${pickId}/unpublish`, { method: 'POST' })
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
  pickId, status, goesLiveAt, onUnpublish, children,
}: {
  pickId: string
  status: PickStatus
  goesLiveAt: string | null
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
            color: status === 'live' ? '#1a5c2a' : '#92400e',
            background: status === 'live' ? '#dcfce7' : '#fef3c7',
            padding: '2px 8px',
          }}>
            {status === 'live' ? 'Live now' : `Scheduled · ${fmtDate(goesLiveAt) ?? 'Monday'}`}
          </span>
          <UnpublishBtn pickId={pickId} onDone={onUnpublish} />
        </div>
      </div>
    </div>
  )
}

// ── Dual action buttons (Now / Schedule) ──────────────────────────────────────

function ActionBtns({
  onAction,
}: {
  onAction: (mode: Mode) => Promise<void>
}) {
  const [busy, setBusy] = useState<Mode | null>(null)
  const [done, setDone] = useState('')

  async function go(mode: Mode) {
    setBusy(mode)
    try {
      await onAction(mode)
      setDone(mode === 'now' ? 'Live' : 'Scheduled')
    } finally {
      setBusy(null)
    }
  }

  if (done) return <span style={{ fontFamily: F, fontSize: 12, color: '#1a5c2a', fontWeight: 600, flexShrink: 0 }}>{done}</span>

  return (
    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
      <button onClick={() => go('now')} disabled={!!busy}
        style={{ ...btnBase, background: '#000', color: '#FFFCEC', opacity: busy === 'now' ? 0.6 : 1 }}>
        {busy === 'now' ? '…' : 'Now'}
      </button>
      <button onClick={() => go('scheduled')} disabled={!!busy}
        style={{ ...btnBase, background: 'transparent', color: '#000', border: '1px solid rgba(0,0,0,0.3)', opacity: busy === 'scheduled' ? 0.6 : 1 }}>
        {busy === 'scheduled' ? '…' : 'Schedule'}
      </button>
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
  onSelected: (referenceId: string, mode: Mode) => void
}) {
  const [q, setQ] = useState('')
  const [items, setItems] = useState<T[]>([])
  const [loaded, setLoaded] = useState(false)
  const [selecting, setSelecting] = useState<string | null>(null)
  const [msg, setMsg] = useState('')

  async function load() {
    if (loaded) return
    try {
      const res = await fetch(fetchUrl)
      if (res.ok) { setItems(await res.json()); setLoaded(true) }
    } catch { /* silent */ }
  }

  async function select(id: string, mode: Mode) {
    setSelecting(id)
    setMsg('')
    try {
      const res = await fetch('/api/admin/editor-picks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pick_type: pickType, reference_id: id, mode }),
      })
      if (!res.ok) throw new Error()
      const { goes_live_at } = await res.json()
      setQ('')
      setMsg(mode === 'now' ? 'Live now' : `Scheduled · ${fmtDate(goes_live_at) ?? 'Monday'}`)
      onSelected(id, mode)
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
                  <button onClick={() => select(item.id, 'now')} disabled={!!selecting}
                    style={{ ...btnBase, background: '#000', color: '#FFFCEC', opacity: selecting === item.id ? 0.6 : 1 }}>
                    Now
                  </button>
                  <button onClick={() => select(item.id, 'scheduled')} disabled={!!selecting}
                    style={{ ...btnBase, background: 'transparent', color: '#000', border: '1px solid rgba(0,0,0,0.3)', opacity: selecting === item.id ? 0.6 : 1 }}>
                    Schedule
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

function BookForm({ onSelected }: { onSelected: (referenceId: string, mode: Mode, goesLiveAt: string | null) => void }) {
  const [title, setTitle]       = useState('')
  const [author, setAuthor]     = useState('')
  const [publisher, setPub]     = useState('')
  const [imageUrl, setImageUrl] = useState('')
  const [submitting, setSub]    = useState<Mode | null>(null)
  const [msg, setMsg]           = useState('')

  async function submit(mode: Mode) {
    if (!title.trim()) return
    setSub(mode)
    setMsg('')
    try {
      const res = await fetch('/api/admin/editor-picks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pick_type: 'book', title: title.trim(), author: author.trim() || null, publisher: publisher.trim() || null, image_url: imageUrl.trim() || null, mode }),
      })
      if (!res.ok) throw new Error()
      const { goes_live_at, reference_id } = await res.json()
      onSelected(reference_id, mode, goes_live_at)
      setTitle(''); setAuthor(''); setPub(''); setImageUrl('')
      setMsg(mode === 'now' ? 'Live now' : `Scheduled · ${fmtDate(goes_live_at) ?? 'Monday'}`)
    } catch { setMsg('Error — try again') }
    finally { setSub(null) }
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
        <button onClick={() => submit('now')} disabled={!!submitting || !canSubmit}
          style={{ ...btnBase, background: canSubmit ? '#000' : 'transparent', color: canSubmit ? '#FFFCEC' : 'rgba(0,0,0,0.3)', border: canSubmit ? 'none' : '1px solid rgba(0,0,0,0.18)', cursor: canSubmit ? 'pointer' : 'default', opacity: submitting === 'now' ? 0.6 : 1 }}>
          {submitting === 'now' ? '…' : 'Publish now'}
        </button>
        <button onClick={() => submit('scheduled')} disabled={!!submitting || !canSubmit}
          style={{ ...btnBase, background: 'transparent', color: canSubmit ? '#000' : 'rgba(0,0,0,0.3)', border: canSubmit ? '1px solid rgba(0,0,0,0.3)' : '1px solid rgba(0,0,0,0.18)', cursor: canSubmit ? 'pointer' : 'default', opacity: submitting === 'scheduled' ? 0.6 : 1 }}>
          {submitting === 'scheduled' ? '…' : 'Schedule'}
        </button>
        {msg && <span style={{ fontFamily: F, fontSize: 12, color: msg.startsWith('Error') ? '#dc2626' : '#1a5c2a' }}>{msg}</span>}
      </div>
    </form>
  )
}

// ── Section layout ────────────────────────────────────────────────────────────

function SectionLayout({ hasSuggestions, suggestionsPanel, manualPanel }: {
  hasSuggestions: boolean
  suggestionsPanel: React.ReactNode
  manualPanel: React.ReactNode
}) {
  if (!hasSuggestions) return <div>{manualPanel}</div>
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32, alignItems: 'start' }}>
      <div><p style={colHead}>Suggestions</p>{suggestionsPanel}</div>
      <div><p style={colHead}>Set pick</p>{manualPanel}</div>
    </div>
  )
}

// ── Exhibition section ────────────────────────────────────────────────────────

function ExhibitionSection({ current: init, suggestions: initSugg }: { current: ExhibitionCurrentPick | null; suggestions: ExhibitionSuggestion[] }) {
  const [current, setCurrent] = useState(init)
  const [suggestions, setSuggestions] = useState(initSugg)

  function applyCurrent(pick_id: string, reference_id: string, status: PickStatus, goes_live_at: string | null, details: Partial<ExhibitionCurrentPick>) {
    setCurrent({ pick_id, reference_id, status, goes_live_at, ...details })
  }

  return (
    <div>
      {current && (
        <CurrentPickPanel pickId={current.pick_id} status={current.status} goesLiveAt={current.goes_live_at} onUnpublish={() => setCurrent(null)}>
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
      <SectionLayout
        hasSuggestions={suggestions.length > 0}
        suggestionsPanel={
          <div>
            {suggestions.map((s, i) => (
              <div key={s.pick_id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', borderBottom: '1px solid rgba(0,0,0,0.08)', padding: '12px 0' }}>
                <span style={{ fontFamily: F, fontSize: 11, fontWeight: 700, color: 'rgba(0,0,0,0.3)', width: 16, flexShrink: 0, paddingTop: 2 }}>{i + 1}</span>
                <div style={{ width: 52, height: 40, flexShrink: 0, background: '#e0ddd0', overflow: 'hidden' }}>
                  {s.image_url && <img src={s.image_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
                </div>
                <div style={{ flex: 1, minWidth: 0, fontFamily: F }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{s.show_title}</div>
                  <div style={{ fontSize: 11, color: 'rgba(0,0,0,0.45)' }}>{s.artists.join(', ')}{s.end_date ? ` · Closes ${fmtDate(s.end_date)}` : ''}</div>
                </div>
                <ActionBtns onAction={async (mode) => {
                  const res = await fetch(`/api/admin/editor-picks/${s.pick_id}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) })
                  if (!res.ok) throw new Error()
                  const { status, goes_live_at } = await res.json()
                  applyCurrent(s.pick_id, s.reference_id, status, goes_live_at, { show_title: s.show_title, artists: s.artists, venue_name: s.venue_name, end_date: s.end_date, image_url: s.image_url })
                  setSuggestions(prev => prev.filter(x => x.pick_id !== s.pick_id))
                }} />
              </div>
            ))}
          </div>
        }
        manualPanel={
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
            onSelected={(refId, mode) => {
              applyCurrent('', refId, mode === 'now' ? 'live' : 'pending', mode === 'scheduled' ? 'next Monday' : null, {})
            }}
          />
        }
      />
    </div>
  )
}

// ── Article section ───────────────────────────────────────────────────────────

function ArticleSection({ current: init, suggestions: initSugg }: { current: ArticleCurrentPick | null; suggestions: ArticleSuggestion[] }) {
  const [current, setCurrent] = useState(init)
  const [suggestions, setSuggestions] = useState(initSugg)

  function applyCurrent(pick_id: string, reference_id: string, status: PickStatus, goes_live_at: string | null, details: Partial<ArticleCurrentPick>) {
    setCurrent({ pick_id, reference_id, status, goes_live_at, ...details })
  }

  return (
    <div>
      {current && (
        <CurrentPickPanel pickId={current.pick_id} status={current.status} goesLiveAt={current.goes_live_at} onUnpublish={() => setCurrent(null)}>
          <div style={{ fontFamily: F }}>
            <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.35 }}>{current.headline}</div>
            <div style={{ fontSize: 11, color: 'rgba(0,0,0,0.5)', marginTop: 2 }}>
              {[current.publication, current.author].filter(Boolean).join(' · ')}
            </div>
          </div>
        </CurrentPickPanel>
      )}
      <SectionLayout
        hasSuggestions={suggestions.length > 0}
        suggestionsPanel={
          <div>
            {suggestions.map((s, i) => (
              <div key={s.pick_id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', borderBottom: '1px solid rgba(0,0,0,0.08)', padding: '12px 0' }}>
                <span style={{ fontFamily: F, fontSize: 11, fontWeight: 700, color: 'rgba(0,0,0,0.3)', width: 16, flexShrink: 0, paddingTop: 2 }}>{i + 1}</span>
                <div style={{ flex: 1, minWidth: 0, fontFamily: F }}>
                  <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.35 }}>{s.headline}</div>
                  <div style={{ fontSize: 11, color: 'rgba(0,0,0,0.45)', marginBottom: s.rss_summary ? 4 : 0 }}>{[s.publication, s.author, fmtDate(s.published_at)].filter(Boolean).join(' · ')}</div>
                  {s.rss_summary && <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.5)', lineHeight: 1.5 }}>{s.rss_summary}</div>}
                </div>
                <ActionBtns onAction={async (mode) => {
                  const res = await fetch(`/api/admin/editor-picks/${s.pick_id}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) })
                  if (!res.ok) throw new Error()
                  const { status, goes_live_at } = await res.json()
                  applyCurrent(s.pick_id, s.reference_id, status, goes_live_at, { headline: s.headline, author: s.author, publication: s.publication })
                  setSuggestions(prev => prev.filter(x => x.pick_id !== s.pick_id))
                }} />
              </div>
            ))}
          </div>
        }
        manualPanel={
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
            onSelected={(refId, mode) => {
              applyCurrent('', refId, mode === 'now' ? 'live' : 'pending', mode === 'scheduled' ? 'next Monday' : null, {})
            }}
          />
        }
      />
    </div>
  )
}

// ── Book section ──────────────────────────────────────────────────────────────

function BookSection({ current: init, suggestions: initSugg }: { current: BookCurrentPick | null; suggestions: BookSuggestion[] }) {
  const [current, setCurrent] = useState(init)
  const [suggestions, setSuggestions] = useState(initSugg)

  function applyCurrent(pick_id: string, reference_id: string, status: PickStatus, goes_live_at: string | null, details: Partial<BookCurrentPick>) {
    setCurrent({ pick_id, reference_id, status, goes_live_at, ...details })
  }

  return (
    <div>
      {current && (
        <CurrentPickPanel pickId={current.pick_id} status={current.status} goesLiveAt={current.goes_live_at} onUnpublish={() => setCurrent(null)}>
          <div style={{ fontFamily: F }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{current.title}</div>
            <div style={{ fontSize: 11, color: 'rgba(0,0,0,0.5)', marginTop: 2 }}>
              {[current.author, current.source].filter(Boolean).join(' · ')}
            </div>
          </div>
        </CurrentPickPanel>
      )}
      <SectionLayout
        hasSuggestions={suggestions.length > 0}
        suggestionsPanel={
          <div>
            {suggestions.map((s, i) => (
              <div key={s.pick_id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', borderBottom: '1px solid rgba(0,0,0,0.08)', padding: '12px 0' }}>
                <span style={{ fontFamily: F, fontSize: 11, fontWeight: 700, color: 'rgba(0,0,0,0.3)', width: 16, flexShrink: 0, paddingTop: 2 }}>{i + 1}</span>
                <div style={{ flex: 1, minWidth: 0, fontFamily: F }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{s.title}</div>
                  <div style={{ fontSize: 11, color: 'rgba(0,0,0,0.45)' }}>{[s.author, s.source, s.goodreads_rating != null ? `${s.goodreads_rating} ★` : null].filter(Boolean).join(' · ')}</div>
                </div>
                <ActionBtns onAction={async (mode) => {
                  const res = await fetch(`/api/admin/editor-picks/${s.pick_id}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) })
                  if (!res.ok) throw new Error()
                  const { status, goes_live_at } = await res.json()
                  applyCurrent(s.pick_id, s.reference_id, status, goes_live_at, { title: s.title, author: s.author, source: s.source })
                  setSuggestions(prev => prev.filter(x => x.pick_id !== s.pick_id))
                }} />
              </div>
            ))}
          </div>
        }
        manualPanel={
          <BookForm onSelected={(refId, mode, goesLiveAt) => {
            applyCurrent('', refId, mode === 'now' ? 'live' : 'pending', goesLiveAt, {})
          }} />
        }
      />
    </div>
  )
}

// ── Main tab ──────────────────────────────────────────────────────────────────

export default function EditorPicksTab() {
  const [data, setData] = useState<PicksData | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  useEffect(() => {
    fetch('/api/admin/editor-picks')
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
        <ExhibitionSection current={data.exhibitions.current} suggestions={data.exhibitions.suggestions} />
      </div>
      <div>
        <p style={headStyle}>Article pick</p>
        <ArticleSection current={data.articles.current} suggestions={data.articles.suggestions} />
      </div>
      <div>
        <p style={headStyle}>Book pick</p>
        <BookSection current={data.books.current} suggestions={data.books.suggestions} />
      </div>
    </div>
  )
}
