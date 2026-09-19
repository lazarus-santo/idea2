'use client'

// Agent 2's admin surface for one exhibition (Trigger 3 in lib/agent2.ts):
//   - the show's preread_status and any missing-field warnings
//   - Retrigger (exhibition level) — never runs past a missing-field block
//   - per row: Blank / Activate, Replace (regular retry or custom search), Delete
//
// Blank is one click because it is undone by one click (Activate). Delete is
// permanent, so it is styled apart from the other actions and always asks first:
// on 2026-09-18 a wrong-artist article meant to be blanked was deleted instead,
// when the two sat side by side looking alike. Deletions are logged by the
// database (migration_v54), not here.
//
// Used by the Published tab card and the Pending tab modal. Every row is shown,
// blanked and flagged ones included; the public site shows only active rows.

import { useState, useCallback, type ReactNode } from 'react'
import { adminFetch } from '@/lib/admin-fetch'
import type { PrereadStatus, QualityFlag, RowStatus } from '@/lib/types'

export type AdminPreread = {
  id: string
  article_title: string | null
  publication: string | null
  article_url: string | null
  artist_name?: string | null
  quality_flag?: QualityFlag | null
  row_status?: RowStatus
}

const F = 'var(--font-inter-tight), system-ui, sans-serif'
const AMBER = '#C95712'
const RED = '#dc2626'
const GREEN = '#1a5c2a'

const STATUS_LABEL: Record<PrereadStatus, string> = {
  pending_artists: 'Blocked — no artists',
  pending_press_release: 'Blocked — no press release',
  empty: 'Ran, found nothing',
  error: 'Last run failed',
  success: 'Complete',
  needs_review: 'Needs review',
}

const STATUS_COLOR: Record<PrereadStatus, string> = {
  pending_artists: AMBER,
  pending_press_release: AMBER,
  empty: 'rgba(0,0,0,0.5)',
  error: RED,
  success: GREEN,
  needs_review: AMBER,
}

const FLAG_LABEL: Record<QualityFlag, string> = {
  self_sourced: "Artist's or venue's own site",
  unverified: 'Quality check failed to run',
  no_content: 'No usable text',
  mismatched: 'Not about this artist/show',
}

// Plain labels for missing_fields values; anything unlisted shows as its raw name.
const FIELD_LABEL: Record<string, string> = {
  artists: 'artists',
  press_release: 'press release',
  start_date: 'start date',
  end_date: 'end date',
  image_url: 'image',
  show_coverage: 'show review coverage',
  address_error: 'address',
  upcoming: 'not yet open',
}

const linkBtn: React.CSSProperties = {
  fontFamily: F, fontSize: 11, background: 'transparent', border: 'none',
  cursor: 'pointer', padding: '0 4px', flexShrink: 0, color: 'rgba(0,0,0,0.55)',
  textDecoration: 'underline', textUnderlineOffset: 2,
}

// Set apart from the other row actions (gap, red outline, trailing ellipsis for
// "asks first") because it is the only one that can't be undone.
const deleteBtn: React.CSSProperties = {
  fontFamily: F, fontSize: 11, fontWeight: 700, color: RED, background: 'transparent',
  border: `1px solid ${RED}`, borderRadius: 999, padding: '1px 8px', marginLeft: 14,
  cursor: 'pointer', flexShrink: 0,
}

const pill: React.CSSProperties = {
  fontFamily: F, fontSize: 11, fontWeight: 700, letterSpacing: '0.1em',
  textTransform: 'uppercase', padding: '5px 12px', borderRadius: 999,
  border: '1px solid rgba(0,0,0,0.25)', background: 'transparent', cursor: 'pointer',
}

const badge = (color: string): React.CSSProperties => ({
  fontFamily: F, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
  textTransform: 'uppercase', color, border: `1px solid ${color}`,
  padding: '1px 6px', borderRadius: 999, whiteSpace: 'nowrap',
})

function ReplaceControls({ prereadId, onDone }: { prereadId: string; onDone: (msg: string, ok: boolean) => void }) {
  const [mode, setMode] = useState<'retry' | 'custom'>('retry')
  const [query, setQuery] = useState('')
  const [running, setRunning] = useState(false)

  async function run() {
    setRunning(true)
    try {
      const res = await adminFetch(`/api/admin/prereads/${prereadId}/replace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === 'custom' ? { query } : {}),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) onDone(data.error ?? 'Replace failed', false)
      else onDone(data.message ?? 'Done', !!data.replaced)
    } catch {
      onDone('Replace failed', false)
    } finally {
      setRunning(false)
    }
  }

  const canRun = !running && (mode === 'retry' || query.trim().length > 0)

  return (
    <div style={{ background: '#f5f2e8', padding: '10px 12px', margin: '4px 0 8px', fontFamily: F, fontSize: 12 }}>
      <div style={{ display: 'flex', gap: 16, marginBottom: 8 }}>
        <label style={{ cursor: 'pointer' }}>
          <input type="radio" checked={mode === 'retry'} onChange={() => setMode('retry')} /> Regular Agent 2 retry
        </label>
        <label style={{ cursor: 'pointer' }}>
          <input type="radio" checked={mode === 'custom'} onChange={() => setMode('custom')} /> Custom search
        </label>
      </div>
      {mode === 'custom' && (
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder='e.g. "Jane Doe" interview Frieze 2026'
          style={{ width: '100%', fontFamily: F, fontSize: 12, padding: '6px 8px', border: '1px solid rgba(0,0,0,0.18)', boxSizing: 'border-box', marginBottom: 8 }}
        />
      )}
      <button onClick={run} disabled={!canRun} style={{ ...pill, opacity: canRun ? 1 : 0.4, cursor: canRun ? 'pointer' : 'default' }}>
        {running ? 'Searching…' : 'Run replace'}
      </button>
      <span style={{ marginLeft: 10, color: 'rgba(0,0,0,0.45)' }}>
        Only an article that passes the quality check replaces this one.
      </span>
    </div>
  )
}

export default function PrereadPanel({
  exhibitionId,
  venueType,
  initialPrereads,
  initialStatus,
  initialMissingFields,
  onRemove,
  renderAdd,
}: {
  exhibitionId: string
  venueType: string
  initialPrereads: AdminPreread[]
  initialStatus?: PrereadStatus | null
  initialMissingFields?: string[]
  /** Existing delete behaviour, kept where the host tab already offered it. */
  onRemove?: (id: string) => Promise<void>
  /** Slot below the list, e.g. the Published tab's "Add preread" form. Rows it
   *  creates are handed back through `onAdded`, so the panel stays the one owner
   *  of the list. */
  renderAdd?: (onAdded: (p: AdminPreread) => void) => ReactNode
}) {
  const [rows, setRows] = useState<AdminPreread[]>(initialPrereads)
  const [status, setStatus] = useState<PrereadStatus | null>(initialStatus ?? null)
  const [missing, setMissing] = useState<string[]>(initialMissingFields ?? [])
  const [retriggering, setRetriggering] = useState(false)
  const [panelMsg, setPanelMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [rowMsgs, setRowMsgs] = useState<Record<string, { text: string; ok: boolean }>>({})
  const [replacing, setReplacing] = useState<string | null>(null)
  const [busyRow, setBusyRow] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)

  // Fair coverage has no quality check yet, so there's nothing for Replace to check
  // a new article against (lib/agent2.ts refuses it too).
  const canReplace = venueType !== 'fair'

  const reload = useCallback(async () => {
    const res = await adminFetch(`/api/admin/prereads?exhibition_id=${exhibitionId}`)
    if (!res.ok) return
    const data = await res.json()
    setRows(data.prereads)
    setStatus(data.preread_status)
    setMissing(data.missing_fields ?? [])
  }, [exhibitionId])

  async function retrigger() {
    setRetriggering(true)
    setPanelMsg(null)
    try {
      const res = await adminFetch(`/api/admin/exhibitions/${exhibitionId}/retrigger-prereads`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      await reload()
      if (!res.ok) {
        setPanelMsg({ text: data.error ?? 'Retrigger failed', ok: false })
      } else {
        setPanelMsg({ text: data.message, ok: data.action === 'generated' || data.action === 'repaired' })
        // After reload: the run's list also names a missing artist list or press
        // release, which the stored missing_fields may not.
        if (Array.isArray(data.missingFields)) setMissing(data.missingFields)
      }
    } catch {
      setPanelMsg({ text: 'Retrigger failed', ok: false })
    } finally {
      setRetriggering(false)
    }
  }

  async function setRowStatus(id: string, rowStatus: RowStatus) {
    setBusyRow(id)
    try {
      const res = await adminFetch(`/api/admin/prereads/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ row_status: rowStatus }),
      })
      if (!res.ok) throw new Error()
      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, row_status: rowStatus } : r)))
    } catch {
      setRowMsgs((prev) => ({ ...prev, [id]: { text: 'Could not update', ok: false } }))
    } finally {
      setBusyRow(null)
    }
  }

  // Only ever reached from the confirmation strip's own button.
  async function remove(id: string) {
    if (!onRemove) return
    setBusyRow(id)
    try {
      await onRemove(id)
      setRows((prev) => prev.filter((r) => r.id !== id))
      setConfirmingDelete(null)
    } catch {
      setRowMsgs((prev) => ({ ...prev, [id]: { text: 'Delete failed — the article is still there', ok: false } }))
    } finally {
      setBusyRow(null)
    }
  }

  const blocked = status === 'pending_artists' || status === 'pending_press_release'
  const visibleCount = rows.filter((r) => (r.row_status ?? 'active') === 'active').length

  return (
    <div style={{ fontFamily: F }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'rgba(0,0,0,0.4)' }}>
          Prereads ({visibleCount} shown{rows.length !== visibleCount ? `, ${rows.length - visibleCount} hidden` : ''})
        </span>
        <span style={badge(status ? STATUS_COLOR[status] : 'rgba(0,0,0,0.4)')}>
          {status ? STATUS_LABEL[status] : 'Never run'}
        </span>
        <button onClick={retrigger} disabled={retriggering} style={{ ...pill, opacity: retriggering ? 0.5 : 1 }}>
          {retriggering ? 'Running Agent 2…' : 'Retrigger'}
        </button>
      </div>

      {missing.length > 0 && (
        <div style={{ fontSize: 12, color: blocked ? AMBER : 'rgba(0,0,0,0.5)', marginBottom: 8 }}>
          {blocked ? 'Retrigger stays blocked until this is filled in — ' : 'Missing: '}
          {missing.map((f) => FIELD_LABEL[f] ?? f).join(', ')}
        </div>
      )}

      {panelMsg && (
        <div style={{ fontSize: 12, color: panelMsg.ok ? GREEN : 'rgba(0,0,0,0.6)', marginBottom: 8 }}>{panelMsg.text}</div>
      )}

      {rows.length === 0 && (
        <div style={{ fontSize: 13, color: 'rgba(0,0,0,0.35)', marginBottom: 8 }}>No prereads yet.</div>
      )}

      {rows.map((pr) => {
        const hidden = (pr.row_status ?? 'active') === 'blanked'
        const flag = pr.quality_flag ?? null
        const rowMsg = rowMsgs[pr.id]
        return (
          <div key={pr.id} style={{ borderBottom: '1px solid rgba(0,0,0,0.06)', padding: '5px 0' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 200, fontSize: 13, opacity: hidden ? 0.5 : 1 }}>
                {pr.article_url ? (
                  <a href={pr.article_url} target="_blank" rel="noopener noreferrer" style={{ color: '#000', textDecoration: 'underline', textUnderlineOffset: 2 }}>
                    {pr.article_title ?? pr.article_url}
                  </a>
                ) : (pr.article_title ?? '(no title)')}
                {pr.publication && <span style={{ fontSize: 11, color: 'rgba(0,0,0,0.4)', marginLeft: 8 }}>{pr.publication}</span>}
                {pr.artist_name && <span style={{ fontSize: 11, color: 'rgba(0,0,0,0.4)', marginLeft: 8 }}>· {pr.artist_name}</span>}
              </div>
              {flag && <span style={badge(AMBER)} title={FLAG_LABEL[flag]}>{FLAG_LABEL[flag]}</span>}
              {hidden && <span style={badge('rgba(0,0,0,0.45)')}>Hidden from site</span>}
              <button
                onClick={() => setRowStatus(pr.id, hidden ? 'active' : 'blanked')}
                disabled={busyRow === pr.id}
                style={linkBtn}
              >
                {hidden ? 'Activate' : 'Blank'}
              </button>
              {canReplace && (
                <button onClick={() => setReplacing(replacing === pr.id ? null : pr.id)} style={linkBtn}>
                  {replacing === pr.id ? 'Close' : 'Replace'}
                </button>
              )}
              {onRemove && (
                <button
                  onClick={() => setConfirmingDelete(confirmingDelete === pr.id ? null : pr.id)}
                  disabled={busyRow === pr.id}
                  aria-expanded={confirmingDelete === pr.id}
                  style={deleteBtn}
                >
                  Delete…
                </button>
              )}
            </div>
            {confirmingDelete === pr.id && (
              <div role="alertdialog" aria-label="Confirm permanent delete" style={{ background: '#fdecec', border: `1px solid ${RED}`, padding: '10px 12px', margin: '4px 0 8px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ flex: 1, minWidth: 220 }}>
                  <strong>Delete this article permanently?</strong> This can&apos;t be undone.
                  {!hidden && <> To hide it from the site but keep it, use <strong>Blank</strong> instead.</>}
                </span>
                <button onClick={() => remove(pr.id)} disabled={busyRow === pr.id} style={{ ...pill, background: RED, color: '#fff', border: `1px solid ${RED}` }}>
                  {busyRow === pr.id ? 'Deleting…' : 'Delete permanently'}
                </button>
                <button onClick={() => setConfirmingDelete(null)} style={pill}>Cancel</button>
              </div>
            )}
            {replacing === pr.id && (
              <ReplaceControls
                prereadId={pr.id}
                onDone={async (text, ok) => {
                  setRowMsgs((prev) => ({ ...prev, [pr.id]: { text, ok } }))
                  if (ok) setReplacing(null)
                  await reload()
                }}
              />
            )}
            {rowMsg && <div style={{ fontSize: 11, color: rowMsg.ok ? GREEN : 'rgba(0,0,0,0.55)', marginTop: 2 }}>{rowMsg.text}</div>}
          </div>
        )
      })}

      {renderAdd?.((p) => setRows((prev) => [...prev, p]))}
    </div>
  )
}
