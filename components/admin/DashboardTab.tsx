'use client'

import { useState, useEffect, useCallback, useRef } from 'react'

const F = 'var(--font-inter-tight), system-ui, sans-serif'

type AgentName = 'agent1' | 'agent2' | 'agent3_daily' | 'agent3_hourly'
type NavTab = 'pending' | 'published' | 'issues'

interface PipelineStatus {
  exhibitions: {
    pending: number
    published: number
    upcoming: number
    manual_required: number
    needs_preread: number
  }
  readings: {
    total_today: number
    top_stories: number
    unclassified: number
  }
  agents: Record<AgentName, {
    last_run: string | null
    status: string | null
    items_processed: number
    items_succeeded: number
    items_failed: number
  }>
}

interface RunError {
  item: string
  step: string
  message: string
}

interface RunRow {
  id: string
  started_at: string
  completed_at: string | null
  status: string | null
  items_processed: number
  items_succeeded: number
  items_failed: number
  errors: RunError[]
  duration_ms: number | null
}

type AgentRunsMap = Record<AgentName, RunRow[]>

const AGENT_META: Record<AgentName, { title: string; description: string; triggerPath: string; needsAuthHeader: boolean }> = {
  agent1: {
    title: 'Agent 1 — Exhibition Scraper',
    description: 'Scrapes venue pages, extracts shows, writes to Supabase',
    triggerPath: '/api/scrape',
    needsAuthHeader: false,
  },
  agent2: {
    title: 'Agent 2 — Preread & Audit',
    description: 'Repairs prereads for gallery exhibitions (galleries only)',
    triggerPath: '/api/admin/audit-prereads',
    needsAuthHeader: false,
  },
  agent3_daily: {
    title: 'Agent 3 Daily — Readings Curator',
    description: 'Non-T1 publications, once daily',
    triggerPath: '/api/curate',
    needsAuthHeader: true,
  },
  agent3_hourly: {
    title: 'Agent 3 Hourly — Readings Curator',
    description: 'T1 publications, hourly',
    triggerPath: '/api/curate/hourly',
    needsAuthHeader: true,
  },
}

const AGENT_ORDER: AgentName[] = ['agent1', 'agent2', 'agent3_daily', 'agent3_hourly']

const STATUS_COLORS: Record<string, string> = {
  success: '#4CAF50',
  partial: '#FF9800',
  failed: '#F44336',
  running: '#2196F3',
}

function statusColor(status: string | null): string {
  return status ? STATUS_COLORS[status] ?? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.2)'
}

function statusLabel(status: string | null): string {
  if (!status) return 'never run'
  return status
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'never'
  const diffMs = Date.now() - new Date(iso).getTime()
  const sec = Math.floor(diffMs / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`
  const day = Math.floor(hr / 24)
  return `${day} day${day === 1 ? '' : 's'} ago`
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '—'
  const totalSec = Math.round(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

function StatCard({ label, count, tone }: { label: string; count: number; tone: 'green' | 'amber' | 'red' }) {
  const tones = {
    green: { bg: '#f0fdf4', fg: '#166534' },
    amber: { bg: '#fef3c7', fg: '#b45309' },
    red: { bg: '#fee2e2', fg: '#991b1b' },
  }[tone]

  return (
    <div style={{
      background: tones.bg,
      border: `1px solid ${tones.fg}22`,
      padding: '12px 16px',
      minWidth: 108,
      flex: '1 1 108px',
    }}>
      <div style={{ fontFamily: F, fontSize: 22, fontWeight: 700, color: tones.fg, lineHeight: 1.1 }}>
        {count}
      </div>
      <div style={{ fontFamily: F, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: tones.fg, opacity: 0.8, marginTop: 4 }}>
        {label}
      </div>
    </div>
  )
}

function PipelineFlowRow({ label, count, action, onAction, busy, first }: {
  label: string
  count: number
  action: string
  onAction: () => void
  busy?: boolean
  first?: boolean
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '12px 16px',
      borderTop: first ? 'none' : '1px solid rgba(0,0,0,0.08)',
    }}>
      <span style={{ fontFamily: F, fontSize: 13, color: '#000' }}>{label}</span>
      <span style={{ fontFamily: F, fontSize: 13, fontWeight: 700, color: '#000' }}>{count}</span>
      <button
        onClick={onAction}
        disabled={busy}
        style={{
          fontFamily: F, fontSize: 11, fontWeight: 700, letterSpacing: '0.08em',
          textTransform: 'uppercase', color: 'rgba(0,0,0,0.5)',
          background: 'none', border: '1px solid rgba(0,0,0,0.2)',
          padding: '5px 10px', cursor: 'pointer',
        }}
      >
        {busy ? 'Running…' : action}
      </button>
    </div>
  )
}

export default function DashboardTab({ adminPw, onNavigate }: { adminPw: string; onNavigate: (tab: NavTab) => void }) {
  const [status, setStatus] = useState<PipelineStatus | null>(null)
  const [runs, setRuns] = useState<AgentRunsMap | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [triggering, setTriggering] = useState<Set<AgentName>>(new Set())
  const [expandedErrors, setExpandedErrors] = useState<Set<AgentName>>(new Set())
  const triggeredAtRef = useRef<Record<string, number>>({})

  const fetchAll = useCallback(async () => {
    try {
      const [statusRes, runsRes] = await Promise.all([
        fetch('/api/admin/pipeline-status'),
        fetch('/api/admin/agent-runs'),
      ])
      if (statusRes.ok) setStatus(await statusRes.json())
      if (runsRes.ok) setRuns(await runsRes.json())
      setLastUpdated(new Date())
    } catch (err) {
      console.error('Dashboard fetch failed:', err)
    }
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  // Clear local "triggering" flags once the fetched status confirms the NEW
  // run (started after the click) is no longer 'running' — guards against a
  // stale prior run's status briefly showing right after a fresh click.
  useEffect(() => {
    if (!status) return
    setTriggering((prev) => {
      if (prev.size === 0) return prev
      const next = new Set(prev)
      for (const agent of prev) {
        const a = status.agents[agent]
        const startedAt = a.last_run ? new Date(a.last_run).getTime() : 0
        const triggeredAt = triggeredAtRef.current[agent] ?? 0
        if (a.status !== 'running' && startedAt >= triggeredAt - 1000) {
          next.delete(agent)
        }
      }
      return next
    })
  }, [status])

  // Single poller: fast (5s) while any agent is running (locally triggered or
  // cron-triggered), otherwise the base 30s cadence (which also covers the
  // 60s status-bar requirement since both sections share this one endpoint).
  useEffect(() => {
    const anyRunning = triggering.size > 0 || (status && AGENT_ORDER.some((a) => status.agents[a].status === 'running'))
    const delay = anyRunning ? 5000 : 30000
    const id = setInterval(fetchAll, delay)
    return () => clearInterval(id)
  }, [fetchAll, triggering, status])

  const runNow = useCallback(async (agent: AgentName) => {
    if (triggering.has(agent)) return
    triggeredAtRef.current[agent] = Date.now()
    setTriggering((prev) => new Set(prev).add(agent))

    const meta = AGENT_META[agent]
    try {
      await fetch(meta.triggerPath, {
        method: 'POST',
        headers: meta.needsAuthHeader ? { 'x-admin-secret': adminPw } : undefined,
      })
    } catch (err) {
      console.error(`Failed to trigger ${agent}:`, err)
    }
    fetchAll()
  }, [triggering, adminPw, fetchAll])

  const toggleErrors = useCallback((agent: AgentName) => {
    setExpandedErrors((prev) => {
      const next = new Set(prev)
      if (next.has(agent)) next.delete(agent)
      else next.add(agent)
      return next
    })
  }, [])

  if (!status) {
    return <p style={{ fontFamily: F, fontSize: 13, color: 'rgba(0,0,0,0.4)' }}>Loading dashboard…</p>
  }

  const { exhibitions, readings } = status

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 36 }}>
      {/* Section 1 — Pipeline Status Bar */}
      <div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <StatCard label="Pending" count={exhibitions.pending} tone="amber" />
          <StatCard label="Published" count={exhibitions.published} tone="green" />
          <StatCard label="Upcoming" count={exhibitions.upcoming} tone="amber" />
          <StatCard label="Manual Required" count={exhibitions.manual_required} tone={exhibitions.manual_required > 0 ? 'red' : 'green'} />
          <StatCard label="Needs Preread" count={exhibitions.needs_preread} tone="amber" />
          <StatCard label="Today's Reads" count={readings.total_today} tone="green" />
          <StatCard label="Top Stories" count={readings.top_stories} tone="green" />
          <StatCard label="Unclassified" count={readings.unclassified} tone="amber" />
        </div>
        <p style={{ fontFamily: F, fontSize: 11, color: 'rgba(0,0,0,0.35)', marginTop: 10, marginBottom: 0 }}>
          Last updated {lastUpdated ? lastUpdated.toLocaleTimeString() : '—'}
        </p>
      </div>

      {/* Section 2 — Agent Panels */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {AGENT_ORDER.map((agent) => {
          const meta = AGENT_META[agent]
          const a = status.agents[agent]
          const isTriggering = triggering.has(agent)
          const isRunning = isTriggering || a.status === 'running'
          const history = runs?.[agent] ?? []
          const lastErrors = history[0]?.errors ?? []
          const showAllErrors = expandedErrors.has(agent)
          const visibleErrors = showAllErrors ? lastErrors : lastErrors.slice(0, 5)
          const runningLong = isRunning && a.last_run && lastUpdated && (lastUpdated.getTime() - new Date(a.last_run).getTime() > 120000)

          return (
            <div key={agent} style={{
              background: '#fff',
              border: '1px solid rgba(0,0,0,0.12)',
              padding: '16px 18px',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}>
              <div>
                <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#000' }}>{meta.title}</div>
                <div style={{ fontFamily: F, fontSize: 11, color: 'rgba(0,0,0,0.45)', marginTop: 2 }}>{meta.description}</div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: statusColor(isRunning ? 'running' : a.status),
                  display: 'inline-block',
                  flexShrink: 0,
                }} />
                <span style={{ fontFamily: F, fontSize: 12, fontWeight: 600, color: '#000', textTransform: 'capitalize' }}>
                  {isRunning ? 'running' : statusLabel(a.status)}
                </span>
                <span style={{ fontFamily: F, fontSize: 11, color: 'rgba(0,0,0,0.4)' }}>
                  · last run {relativeTime(a.last_run)}
                </span>
              </div>

              {runningLong && (
                <p style={{ fontFamily: F, fontSize: 11, color: '#b45309', margin: 0 }}>Still running…</p>
              )}

              <div style={{ display: 'flex', gap: 16, fontFamily: F, fontSize: 12, color: 'rgba(0,0,0,0.6)' }}>
                <span>Duration: {formatDuration(history[0]?.duration_ms ?? null)}</span>
              </div>
              <div style={{ display: 'flex', gap: 16, fontFamily: F, fontSize: 12, color: 'rgba(0,0,0,0.6)' }}>
                <span>Processed: {a.items_processed}</span>
                <span>Succeeded: {a.items_succeeded}</span>
                <span>Failed: {a.items_failed}</span>
              </div>

              <button
                onClick={() => runNow(agent)}
                disabled={isRunning}
                style={{
                  fontFamily: F, fontSize: 11, fontWeight: 700, letterSpacing: '0.1em',
                  textTransform: 'uppercase', padding: '7px 14px',
                  background: isRunning ? 'rgba(0,0,0,0.15)' : '#000',
                  color: isRunning ? 'rgba(0,0,0,0.4)' : '#fff',
                  border: 'none', cursor: isRunning ? 'default' : 'pointer',
                  alignSelf: 'flex-start',
                }}
              >
                {isRunning ? 'Running…' : 'Run Now'}
              </button>

              {/* Run history timeline */}
              {history.length > 0 && (
                <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                  {history.map((r) => (
                    <span
                      key={r.id}
                      title={`${new Date(r.started_at).toLocaleString()} — processed ${r.items_processed}, succeeded ${r.items_succeeded}, failed ${r.items_failed}`}
                      style={{
                        width: 9, height: 9, borderRadius: '50%',
                        background: statusColor(r.status),
                        display: 'inline-block',
                        cursor: 'default',
                      }}
                    />
                  ))}
                </div>
              )}

              {/* Recent errors */}
              <div>
                {lastErrors.length === 0 ? (
                  <p style={{ fontFamily: F, fontSize: 11, color: 'rgba(0,0,0,0.35)', margin: 0 }}>No errors last run</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {visibleErrors.map((e, i) => (
                      <p key={i} style={{ fontFamily: F, fontSize: 11, color: '#991b1b', margin: 0 }}>
                        <strong>{e.item}</strong> ({e.step}): {e.message}
                      </p>
                    ))}
                    {lastErrors.length > 5 && (
                      <button
                        onClick={() => toggleErrors(agent)}
                        style={{
                          fontFamily: F, fontSize: 11, color: 'rgba(0,0,0,0.5)',
                          background: 'none', border: 'none', textDecoration: 'underline',
                          cursor: 'pointer', padding: 0, alignSelf: 'flex-start',
                        }}
                      >
                        {showAllErrors ? 'Show less' : `Show all ${lastErrors.length} errors`}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Section 3 — Exhibition Pipeline Flow */}
      <div>
        <p style={{ fontFamily: F, fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(0,0,0,0.5)', marginBottom: 8 }}>
          Exhibition Pipeline Flow
        </p>
        <div style={{ border: '1px solid rgba(0,0,0,0.12)', background: '#fff' }}>
          <PipelineFlowRow label="Scraped/Pending" count={exhibitions.pending} action="Go to Pending tab" onAction={() => onNavigate('pending')} first />
          <PipelineFlowRow label="Needs Preread" count={exhibitions.needs_preread} action="Run Agent 2 Now" onAction={() => runNow('agent2')} busy={triggering.has('agent2')} />
          <PipelineFlowRow label="Published" count={exhibitions.published} action="Go to Published tab" onAction={() => onNavigate('published')} />
          <PipelineFlowRow label="Manual Required" count={exhibitions.manual_required} action="Go to Scrape Issues" onAction={() => onNavigate('issues')} />
        </div>
      </div>
    </div>
  )
}
