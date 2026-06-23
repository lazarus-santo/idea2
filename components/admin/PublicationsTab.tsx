'use client'

import { useState, useEffect, useCallback } from 'react'

type Pub = {
  id: string
  name: string
  sample_headline: string | null
  sample_url: string | null
}

const F = 'var(--font-inter-tight), system-ui, sans-serif'

const btn: React.CSSProperties = {
  fontFamily: F, fontSize: 11, fontWeight: 700,
  letterSpacing: '0.1em', textTransform: 'uppercase',
  padding: '6px 14px', border: 'none', cursor: 'pointer',
}

function PubCard({ pub, onDone }: { pub: Pub; onDone: (id: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  async function act(status: 'approved' | 'rejected') {
    setBusy(true)
    try {
      const res = await fetch(`/api/admin/publications/${pub.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      if (!res.ok) throw new Error()
      onDone(pub.id)
    } catch {
      setMsg('Error')
      setBusy(false)
      setTimeout(() => setMsg(''), 2000)
    }
  }

  return (
    <div style={{ borderBottom: '1px solid rgba(0,0,0,0.1)', padding: '22px 0', fontFamily: F }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>{pub.name}</span>
        <a href={`https://${pub.name}`} target="_blank" rel="noopener noreferrer"
          style={{ fontFamily: F, fontSize: 11, color: 'rgba(0,0,0,0.4)', textDecoration: 'none', borderBottom: '1px solid rgba(0,0,0,0.25)' }}>
          Visit ↗
        </a>
      </div>

      {pub.sample_headline ? (
        <div style={{ fontSize: 13, color: 'rgba(0,0,0,0.55)', marginBottom: 14, maxWidth: 560 }}>
          {pub.sample_url ? (
            <a href={pub.sample_url} target="_blank" rel="noopener noreferrer"
              style={{ color: 'inherit', textDecoration: 'underline', textUnderlineOffset: 2 }}>
              {pub.sample_headline}
            </a>
          ) : pub.sample_headline}
        </div>
      ) : (
        <div style={{ fontSize: 13, color: 'rgba(0,0,0,0.3)', marginBottom: 14 }}>No sample article yet.</div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button onClick={() => act('approved')} disabled={busy} style={{ ...btn, background: '#1a5c2a', color: '#fff', opacity: busy ? 0.6 : 1 }}>
          Approve
        </button>
        <button onClick={() => act('rejected')} disabled={busy} style={{ ...btn, background: 'transparent', color: '#dc2626', border: '1px solid #dc2626', opacity: busy ? 0.6 : 1 }}>
          Reject
        </button>
        {msg && <span style={{ fontSize: 12, color: '#dc2626' }}>{msg}</span>}
      </div>
    </div>
  )
}

export default function PublicationsTab({ onCount }: { onCount: (n: number) => void }) {
  const [pubs, setPubs] = useState<Pub[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/publications')
      if (!res.ok) throw new Error(await res.text())
      const data = await res.json()
      setPubs(data)
      onCount(data.length)
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [onCount])

  useEffect(() => { load() }, [load])

  function done(id: string) {
    setPubs(prev => {
      const next = prev.filter(p => p.id !== id)
      onCount(next.length)
      return next
    })
  }

  if (loading) return <p style={{ fontFamily: F, fontSize: 13, color: 'rgba(0,0,0,0.4)' }}>Loading…</p>
  if (err) return <p style={{ fontFamily: F, fontSize: 13, color: '#dc2626' }}>{err}</p>
  if (pubs.length === 0) return <p style={{ fontFamily: F, fontSize: 13, color: 'rgba(0,0,0,0.4)' }}>No pending publications.</p>

  return (
    <div>
      {pubs.map(p => <PubCard key={p.id} pub={p} onDone={done} />)}
    </div>
  )
}
