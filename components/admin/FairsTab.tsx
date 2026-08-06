'use client'

import { useState, useEffect, useCallback } from 'react'
import { adminFetch } from '@/lib/admin-fetch'

const F = 'var(--font-inter-tight), system-ui, sans-serif'

const btn: React.CSSProperties = {
  fontFamily: F, fontSize: 11, fontWeight: 700,
  letterSpacing: '0.1em', textTransform: 'uppercase',
  padding: '6px 14px', border: 'none', borderRadius: 999, cursor: 'pointer',
  background: '#000', color: '#FFFCEC',
}
const btnGhost: React.CSSProperties = {
  ...btn, background: 'transparent', color: '#000', border: '1px solid rgba(0,0,0,0.3)',
}
const input: React.CSSProperties = {
  width: '100%', fontFamily: F, fontSize: 13, color: '#000',
  background: '#fff', border: '1px solid rgba(0,0,0,0.18)',
  padding: '7px 10px', outline: 'none', boxSizing: 'border-box',
}
const label: React.CSSProperties = {
  display: 'block', fontFamily: F, fontSize: 10, fontWeight: 700,
  letterSpacing: '0.12em', textTransform: 'uppercase',
  color: 'rgba(0,0,0,0.4)', marginBottom: 4,
}

interface Fair {
  institution_id: string
  name: string
  fair_location: string | null
  exhibitor_count: number
  exhibitions_url: string | null
  exhibition_id: string | null
  start_date: string | null
  end_date: string | null
  status: string | null
  coverage_count: number
  preread_type: string | null
}

interface Exhibitor { name: string; section: string | null }
interface PageResult { url: string; section: string | null; status: string; found: number; rejected: string[]; page_chars: number }
interface Scraped {
  fair_name: string | null
  start_date: string | null
  end_date: string | null
  location: string | null
  exhibitors: Exhibitor[]
  rejected: string[]
  method: string
  page_chars: number
  pages: PageResult[]
}

export default function FairsTab() {
  const [fairs, setFairs] = useState<Fair[]>([])
  const [url, setUrl] = useState('')
  const [scraping, setScraping] = useState(false)
  const [scraped, setScraped] = useState<Scraped | null>(null)
  const [name, setName] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [location, setLocation] = useState('')
  const [imageUrl, setImageUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [busyCoverage, setBusyCoverage] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await adminFetch('/api/admin/fairs')
    if (res.ok) setFairs(await res.json())
  }, [])

  // Guarded rather than the bare `useEffect(() => { load() }, [load])` the sibling
  // tabs use: that form trips react-hooks/set-state-in-effect and would drop a
  // response arriving after unmount onto a dead component.
  useEffect(() => {
    let alive = true
    void (async () => {
      const res = await adminFetch('/api/admin/fairs')
      if (alive && res.ok) setFairs(await res.json())
    })()
    return () => { alive = false }
  }, [])

  async function scrape() {
    if (!url.trim()) return
    setScraping(true); setMsg(''); setScraped(null)
    try {
      // One URL per line. Sectioned fairs (Armory: Galleries, Solo, Focus,
      // Presents, Platform, Not-For-Profit) list one page each; all of them
      // render in a single Browserbase session.
      const urls = url.split('\n').map(u => u.trim()).filter(Boolean)
      const res = await adminFetch('/api/admin/fairs/scrape', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls }),
      })
      const data = await res.json()
      if (!res.ok) { setMsg(data.error ?? 'Scrape failed'); return }
      setScraped(data)
      setName(data.fair_name ?? '')
      setStart(data.start_date ?? '')
      setEnd(data.end_date ?? '')
      setLocation(data.location ?? '')
      const sections = new Set(data.exhibitors.map((e: Exhibitor) => e.section).filter(Boolean))
      setMsg(`Found ${data.exhibitors.length} exhibitor(s) across ${data.pages.length} page(s) via ${data.method}`
        + (sections.size ? ` · ${sections.size} section(s)` : '')
        + (data.rejected.length ? ` · ${data.rejected.length} dropped (not on page)` : ''))
    } catch { setMsg('Scrape failed') }
    finally { setScraping(false) }
  }

  async function save() {
    if (!name.trim() || !url.trim()) return
    setSaving(true); setMsg('')
    try {
      const res = await adminFetch('/api/admin/fairs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          exhibitions_url: url.split('\n').map(u => u.trim()).filter(Boolean)[0] ?? url.trim(),
          start_date: start || null,
          end_date: end || null,
          fair_location: location || null,
          image_url: imageUrl.trim() || null,
          exhibitors: scraped?.exhibitors ?? [],
        }),
      })
      const data = await res.json()
      if (!res.ok) { setMsg(data.error ?? 'Save failed'); return }
      setMsg(`Saved — ${data.exhibitor_count} exhibitors, status pending${data.geocoded ? ', geocoded' : ', no coordinates'}`)
      setScraped(null); setUrl(''); setName(''); setStart(''); setEnd(''); setLocation(''); setImageUrl('')
      load()
    } catch { setMsg('Save failed') }
    finally { setSaving(false) }
  }

  async function runCoverage(id: string) {
    setBusyCoverage(id)
    try {
      const res = await adminFetch(`/api/admin/fairs/${id}/coverage`, { method: 'POST' })
      const data = await res.json()
      setMsg(res.ok ? `Coverage: ${data.coverage_count} result(s) for ${data.fair}` : (data.error ?? 'Coverage failed'))
      load()
    } finally { setBusyCoverage(null) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 40 }}>
      <div>
        <p style={{ ...label, marginBottom: 12 }}>Add a fair</p>
        <p style={{ fontFamily: F, fontSize: 12, color: 'rgba(0,0,0,0.45)', margin: '0 0 14px', lineHeight: 1.5 }}>
          Paste the fair&apos;s exhibitor list page, scrape it once, review the extracted list, then save.
          Fairs are not part of the recurring scrape — this runs only when you press the button.
        </p>

        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 16 }}>
          <div style={{ flex: 1 }}>
            <label style={label}>Exhibitor list URL(s) * — one per line</label>
            <textarea style={{ ...input, minHeight: 76, fontFamily: 'var(--font-ibm-plex-mono), monospace', fontSize: 12 }}
              value={url} onChange={e => setUrl(e.target.value)}
              placeholder={'https://…/exhibitors\nhttps://…/solo-2026   (one line per section, if the fair splits them)'} />
          </div>
          <button style={{ ...btn, opacity: scraping || !url.trim() ? 0.5 : 1 }} onClick={scrape} disabled={scraping || !url.trim()}>
            {scraping ? 'Scraping…' : 'Scrape Exhibitor List'}
          </button>
        </div>

        {msg && <p style={{ fontFamily: F, fontSize: 12, color: msg.includes('fail') || msg.includes('error') ? '#dc2626' : '#1a5c2a', margin: '0 0 14px' }}>{msg}</p>}

        {scraped && (
          <div style={{ background: '#f0ecde', padding: 16, marginBottom: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 16px', marginBottom: 14 }}>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={label}>Fair name *</label>
                <input style={input} value={name} onChange={e => setName(e.target.value)} />
              </div>
              <div><label style={label}>Start date</label><input style={input} type="date" value={start} onChange={e => setStart(e.target.value)} /></div>
              <div><label style={label}>End date</label><input style={input} type="date" value={end} onChange={e => setEnd(e.target.value)} /></div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={label}>Location</label>
                <input style={input} value={location} onChange={e => setLocation(e.target.value)} placeholder="e.g. The Javits Center" />
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={label}>Image URL</label>
                <input style={input} value={imageUrl} onChange={e => setImageUrl(e.target.value)} placeholder="https://…" />
              </div>
            </div>

            <p style={{ ...label, marginBottom: 6 }}>
              Exhibitors — {scraped.exhibitors.length} verified on page
              {scraped.rejected.length > 0 && `, ${scraped.rejected.length} dropped`}
            </p>
            <div style={{ maxHeight: 240, overflowY: 'auto', background: '#fff', border: '1px solid rgba(0,0,0,0.12)', padding: '8px 10px', fontFamily: F, fontSize: 12, lineHeight: 1.7, color: 'rgba(0,0,0,0.7)' }}>
              {scraped.exhibitors.length === 0 ? 'None found.' : [...new Map(
                scraped.exhibitors.map(e => [e.section, scraped.exhibitors.filter(x => x.section === e.section).map(x => x.name)])
              ).entries()].map(([section, names]) => (
                <div key={section ?? '_'} style={{ marginBottom: 10 }}>
                  {section && <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(0,0,0,0.4)' }}>{section} ({names.length})</div>}
                  <div>{names.join(' · ')}</div>
                </div>
              ))}
            </div>

            <div style={{ marginTop: 10 }}>
              {scraped.pages.map(pg => (
                <div key={pg.url} style={{ fontFamily: F, fontSize: 11, color: pg.status === 'ok' ? 'rgba(0,0,0,0.5)' : '#92400e' }}>
                  {pg.status === 'ok' ? '✓' : '!'} {pg.section ?? '(no section)'} — {pg.found} found
                  {pg.status !== 'ok' && ` · ${pg.status}`} · {pg.url}
                </div>
              ))}
            </div>
            {scraped.rejected.length > 0 && (
              <p style={{ fontFamily: F, fontSize: 11, color: '#92400e', margin: '8px 0 0' }}>
                Dropped (not literally present on the page): {scraped.rejected.join(', ')}
              </p>
            )}

            <button style={{ ...btn, marginTop: 14, opacity: saving || !name.trim() ? 0.5 : 1 }} onClick={save} disabled={saving || !name.trim()}>
              {saving ? 'Saving…' : 'Save Fair'}
            </button>
          </div>
        )}
      </div>

      <div>
        <p style={{ ...label, marginBottom: 12 }}>Fairs ({fairs.length})</p>
        {fairs.length === 0 && <p style={{ fontFamily: F, fontSize: 13, color: 'rgba(0,0,0,0.4)' }}>No fairs yet.</p>}
        {fairs.map(f => (
          <div key={f.institution_id} style={{ borderBottom: '1px solid rgba(0,0,0,0.08)', padding: '12px 0', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0, fontFamily: F }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{f.name}</div>
              <div style={{ fontSize: 11, color: 'rgba(0,0,0,0.45)' }}>
                {[f.fair_location, f.start_date && f.end_date ? `${f.start_date} → ${f.end_date}` : null,
                  `${f.exhibitor_count} exhibitors`, `${f.coverage_count} coverage`, f.status,
                  f.preread_type].filter(Boolean).join(' · ')}
              </div>
            </div>
            <button style={{ ...btnGhost, opacity: busyCoverage === f.institution_id ? 0.5 : 1 }}
              onClick={() => runCoverage(f.institution_id)} disabled={busyCoverage === f.institution_id}>
              {busyCoverage === f.institution_id ? '…' : 'Run Coverage'}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
