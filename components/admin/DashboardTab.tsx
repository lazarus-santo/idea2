'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { adminFetch } from '@/lib/admin-fetch'

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

interface Agent3Summary {
  by_category?: Record<string, number>
  story_grouping?: {
    checked?: number
    started_group?: number
    joined_group?: number
    leads_set?: number
  } | null
  major_artist_articles?: number
  significant_announcements?: number
  nyc_roundups_excluded?: number
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
  summary?: Agent3Summary | null
}

const CATEGORY_LABELS: Record<string, string> = {
  breaking_news: 'Breaking',
  institutional_news: 'Institutional',
  art_market: 'Market',
  interview: 'Interview',
  opinion: 'Opinion',
  show_review: 'Review',
  show_roundup: 'Roundup',
}

function Agent3Breakdown({ summary }: { summary: Agent3Summary }) {
  const byCategory = Object.entries(summary.by_category ?? {}).filter(([, n]) => n > 0)
  const hasBreakdown = byCategory.length > 0
  const hasFlags =
    (summary.story_grouping?.checked ?? 0) > 0 ||
    (summary.major_artist_articles ?? 0) > 0 ||
    (summary.significant_announcements ?? 0) > 0 ||
    (summary.nyc_roundups_excluded ?? 0) > 0

  if (!hasBreakdown && !hasFlags) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {hasBreakdown && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {byCategory.map(([cat, n]) => (
            <span key={cat} style={{
              fontFamily: F, fontSize: 10, fontWeight: 600, color: 'rgba(0,0,0,0.55)',
              background: 'rgba(0,0,0,0.06)', borderRadius: 999, padding: '2px 8px',
            }}>
              {CATEGORY_LABELS[cat] ?? cat} {n}
            </span>
          ))}
        </div>
      )}
      {hasFlags && (
        <p style={{ fontFamily: F, fontSize: 11, color: 'rgba(0,0,0,0.45)', margin: 0 }}>
          {summary.story_grouping?.checked ?? 0} grouped · {summary.story_grouping?.leads_set ?? 0} new top stories · {summary.major_artist_articles ?? 0} major artist · {summary.significant_announcements ?? 0} significant · {summary.nyc_roundups_excluded ?? 0} roundups excluded
        </p>
      )}
    </div>
  )
}

type AgentRunsMap = Record<AgentName, RunRow[]>

// Every trigger route requires the admin credential; adminFetch attaches it,
// so there is no longer a per-agent flag for it. A null triggerPath means the
// agent has no Run Now button: Agent 1 runs only on its 15-minute queue, and a
// single venue is scraped on demand from Scrape Issues.
const AGENT_META: Record<AgentName, { title: string; description: string; triggerPath: string | null }> = {
  agent1: {
    title: 'Agent 1 — Exhibition Scraper',
    description: 'Scrapes venue pages, extracts shows, writes to Supabase',
    triggerPath: null,
  },
  agent2: {
    title: 'Agent 2 — Preread & Audit',
    description: 'Runs or repairs prereads and coverage for every published show that needs it',
    triggerPath: '/api/admin/audit-prereads',
  },
  // Retired: every publication is now checked in the hourly run. Kept only so
  // the type still covers the old agent3_daily rows in agent_runs; not shown.
  agent3_daily: {
    title: 'Agent 3 Daily — Readings Curator (retired)',
    description: 'Merged into the hourly run',
    triggerPath: null,
  },
  agent3_hourly: {
    title: 'Agent 3 — Readings Curator',
    description: 'Every active publication, hourly',
    triggerPath: '/api/curate/hourly',
  },
}

const AGENT_ORDER: AgentName[] = ['agent1', 'agent2', 'agent3_hourly']

const AGENT_LOGIC: Record<AgentName, string> = {
  agent1: `Every 15 minutes, scrapes the venues due that day. Each venue has its own fixed day of the week, so the roster is spread evenly across the week instead of piling up on one day. Venues are scraped one at a time, and a run stops before starting a venue that likely won't finish in the time left. For each venue it renders the exhibitions page, pulls out show titles, dates, artists, and images using Claude, then verifies the extracted details actually appear on the page so hallucinated results get thrown out. Shows outside NYC or already closed are filtered out before anything is saved. New gallery shows get editorial prereads in the same pass; museum and fair shows get press coverage links. A venue that fails to scrape is retried automatically about 6 hours later, up to 3 attempts in a row; after the third failure it stops retrying and appears on the Scrape Issues tab. To scrape one venue right away, use Retry Scrape on that tab.`,
  agent2: `Finds reading for each show: editorial prereads for galleries, press coverage for museums and fairs. It runs automatically when Agent 1 adds or re-scrapes a show, and Run Now sweeps every published show that has never been run, last failed, or needs review. Shows already complete, or that ran and found nothing, are left alone. A gallery show with no artists or no press release is blocked until that is filled in. Any article whose quality check could not run is kept but hidden from the site and marked for review; the next run re-checks it and, if it still fails, searches for a replacement. Per-show Retrigger, and per-article Replace and Blank, are on each show in the Published and Pending tabs.`,
  agent3_daily: `Retired. Every publication is now checked in the hourly run below.`,
  agent3_hourly: `Every hour, pulls the RSS feeds of every approved, active art publication, several at a time, and skips anything that doesn't mention art/gallery/museum keywords, anything already saved, anything it has already turned down, and anything older than 7 days. Claude then judges which of the rest are genuinely about the art world, and sorts each one into one of seven categories (breaking news, institutional news, art market, interview, opinion, show review, or show roundup), scored for art and NYC relevance. Show roundups with no NYC angle at all are excluded. Articles it turns down are remembered so they are never sent to Claude twice. After saving, it groups new readings into Top Stories: 3 or more outlets covering the same event within three days, with the highest-tier outlet's article as the lead. Each run has to finish within 5 minutes, so sorting, image fetching and Top Stories grouping each stop at a fixed point in the run; anything they don't reach is picked up the next hour. Nothing is ever deleted: articles older than 7 days stay in the database and simply drop off the River page.`,
}

const STATUS_COLORS: Record<string, string> = {
  success: '#4CAF50',
  partial: '#FF9800',
  failed: '#F44336',
  running: '#2196F3',
  timed_out: '#991b1b',
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
      display: 'grid', gridTemplateColumns: '1fr 70px 190px', alignItems: 'center', columnGap: 16,
      padding: '12px 16px',
      borderTop: first ? 'none' : '1px solid rgba(0,0,0,0.08)',
    }}>
      <span style={{ fontFamily: F, fontSize: 13, color: '#000' }}>{label}</span>
      <span style={{ fontFamily: F, fontSize: 13, fontWeight: 700, color: '#000', textAlign: 'right' }}>{count}</span>
      <button
        onClick={onAction}
        disabled={busy}
        style={{
          fontFamily: F, fontSize: 11, fontWeight: 700, letterSpacing: '0.08em',
          textTransform: 'uppercase', color: 'rgba(0,0,0,0.5)',
          background: 'none', border: '1px solid rgba(0,0,0,0.2)', borderRadius: 999,
          padding: '5px 10px', cursor: 'pointer', justifySelf: 'end',
        }}
      >
        {busy ? 'Running…' : action}
      </button>
    </div>
  )
}

export default function DashboardTab({ onNavigate }: { onNavigate: (tab: NavTab) => void }) {
  const [status, setStatus] = useState<PipelineStatus | null>(null)
  const [runs, setRuns] = useState<AgentRunsMap | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [triggering, setTriggering] = useState<Set<AgentName>>(new Set())
  const [expandedErrors, setExpandedErrors] = useState<Set<AgentName>>(new Set())
  const [expandedLogic, setExpandedLogic] = useState<Set<AgentName>>(new Set())
  const triggeredAtRef = useRef<Record<string, number>>({})

  const fetchAll = useCallback(async () => {
    try {
      const [statusRes, runsRes] = await Promise.all([
        adminFetch('/api/admin/pipeline-status'),
        adminFetch('/api/admin/agent-runs'),
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
    const { triggerPath } = AGENT_META[agent]
    if (!triggerPath || triggering.has(agent)) return
    triggeredAtRef.current[agent] = Date.now()
    setTriggering((prev) => new Set(prev).add(agent))

    try {
      await adminFetch(triggerPath, { method: 'POST' })
    } catch (err) {
      console.error(`Failed to trigger ${agent}:`, err)
    }
    fetchAll()
  }, [triggering, fetchAll])

  const toggleErrors = useCallback((agent: AgentName) => {
    setExpandedErrors((prev) => {
      const next = new Set(prev)
      if (next.has(agent)) next.delete(agent)
      else next.add(agent)
      return next
    })
  }, [])

  const toggleLogic = useCallback((agent: AgentName) => {
    setExpandedLogic((prev) => {
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
              background: '#FFFCEC',
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

              {(agent === 'agent3_daily' || agent === 'agent3_hourly') && history[0]?.summary && (
                <Agent3Breakdown summary={history[0].summary} />
              )}

              {meta.triggerPath && (
                <button
                  onClick={() => runNow(agent)}
                  disabled={isRunning}
                  style={{
                    fontFamily: F, fontSize: 11, fontWeight: 700, letterSpacing: '0.1em',
                    textTransform: 'uppercase', padding: '7px 14px',
                    background: isRunning ? 'rgba(0,0,0,0.15)' : '#000',
                    color: isRunning ? 'rgba(0,0,0,0.4)' : '#fff',
                    border: 'none', borderRadius: 999, cursor: isRunning ? 'default' : 'pointer',
                    alignSelf: 'flex-start',
                  }}
                >
                  {isRunning ? 'Running…' : 'Run Now'}
                </button>
              )}

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
                          background: 'none', border: 'none', borderRadius: 999, textDecoration: 'underline',
                          cursor: 'pointer', padding: 0, alignSelf: 'flex-start',
                        }}
                      >
                        {showAllErrors ? 'Show less' : `Show all ${lastErrors.length} errors`}
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* How this agent works — collapsible plain-English explanation */}
              <div style={{ borderTop: '1px solid rgba(0,0,0,0.08)', paddingTop: 10 }}>
                <button
                  onClick={() => toggleLogic(agent)}
                  style={{
                    fontFamily: F, fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
                    textTransform: 'uppercase', color: 'rgba(0,0,0,0.5)',
                    background: 'none', border: 'none', borderRadius: 999,
                    cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: 4,
                  }}
                >
                  <span style={{ display: 'inline-block', transform: expandedLogic.has(agent) ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 150ms ease' }}>›</span>
                  How this works
                </button>
                {expandedLogic.has(agent) && (
                  <p style={{ fontFamily: F, fontSize: 12, color: 'rgba(0,0,0,0.6)', lineHeight: 1.5, marginTop: 8, marginBottom: 0 }}>
                    {AGENT_LOGIC[agent]}
                  </p>
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
        <div style={{ border: '1px solid rgba(0,0,0,0.12)', background: '#FFFCEC' }}>
          <PipelineFlowRow label="Scraped/Pending" count={exhibitions.pending} action="Go to Pending tab" onAction={() => onNavigate('pending')} first />
          <PipelineFlowRow label="Needs Preread" count={exhibitions.needs_preread} action="Run Agent 2 Now" onAction={() => runNow('agent2')} busy={triggering.has('agent2')} />
          <PipelineFlowRow label="Published" count={exhibitions.published} action="Go to Published tab" onAction={() => onNavigate('published')} />
          <PipelineFlowRow label="Manual Required" count={exhibitions.manual_required} action="Go to Scrape Issues" onAction={() => onNavigate('issues')} />
        </div>
      </div>
    </div>
  )
}
