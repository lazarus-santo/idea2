'use client'

import { useState } from 'react'
import DashboardTab from '@/components/admin/DashboardTab'
import PendingTab from '@/components/admin/PendingTab'
import PublicationsTab from '@/components/admin/PublicationsTab'
import EditorPicksTab from '@/components/admin/EditorPicksTab'
import PublishedTab from '@/components/admin/PublishedTab'
import SeedTool from '@/components/admin/SeedTool'
import ScrapeIssuesTab from '@/components/admin/ScrapeIssuesTab'

type Tab = 'dashboard' | 'pending' | 'publications' | 'picks' | 'published' | 'seed' | 'issues'

const F = 'var(--font-inter-tight), system-ui, sans-serif'

export default function AdminPage({ adminPw }: { adminPw: string }) {
  const [tab, setTab] = useState<Tab>('dashboard')
  const [pendingCount, setPendingCount] = useState(0)
  const [pubCount, setPubCount] = useState(0)
  const [issueCount, setIssueCount] = useState(0)

  function tabStyle(t: Tab): React.CSSProperties {
    const active = tab === t
    return {
      fontFamily: F,
      fontSize: 13,
      fontWeight: active ? 700 : 400,
      background: 'transparent',
      border: 'none',
      borderBottom: active ? '2px solid #000' : '2px solid transparent',
      color: active ? '#000' : 'rgba(0,0,0,0.4)',
      padding: '6px 0',
      cursor: 'pointer',
      transition: 'color 150ms ease',
    }
  }

  function label(t: Tab) {
    if (t === 'dashboard') return 'Dashboard'
    if (t === 'pending') return `Pending${pendingCount > 0 ? ` (${pendingCount})` : ''}`
    if (t === 'publications') return `Publications${pubCount > 0 ? ` (${pubCount})` : ''}`
    if (t === 'picks') return `Editor's Picks`
    if (t === 'seed') return 'Seed'
    if (t === 'issues') return `Scrape Issues${issueCount > 0 ? ` (${issueCount})` : ''}`
    return 'Published'
  }

  return (
    <div style={{ minHeight: '100vh', background: '#FFFCEC', fontFamily: F }}>
      <div style={{ maxWidth: 1040, margin: '0 auto', padding: '40px 44px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 32 }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: '#000' }}>
            Admin
          </span>
          <div style={{ display: 'flex', gap: 20, alignItems: 'baseline' }}>
            <a
              href="/api/admin/scraper-feedback"
              download
              style={{ fontFamily: F, fontSize: 11, color: 'rgba(0,0,0,0.4)', textDecoration: 'none', borderBottom: '1px solid rgba(0,0,0,0.2)' }}
            >
              Export Scraper Feedback
            </a>
            <a href="/" style={{ fontFamily: F, fontSize: 13, color: 'rgba(0,0,0,0.4)', textDecoration: 'none' }}>
              ← Site
            </a>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 32, borderBottom: '1px solid rgba(0,0,0,0.12)', marginBottom: 36 }}>
          {(['dashboard', 'pending', 'publications', 'picks', 'published', 'issues', 'seed'] as Tab[]).map(t => (
            <button key={t} style={tabStyle(t)} onClick={() => setTab(t)}>
              {label(t)}
            </button>
          ))}
        </div>

        {tab === 'dashboard' && <DashboardTab adminPw={adminPw} onNavigate={setTab} />}
        {tab === 'pending' && <PendingTab onCount={setPendingCount} />}
        {tab === 'publications' && <PublicationsTab onCount={setPubCount} />}
        {tab === 'picks' && <EditorPicksTab />}
        {tab === 'published' && <PublishedTab />}
        {tab === 'issues' && <ScrapeIssuesTab onCount={setIssueCount} />}
        {tab === 'seed' && <SeedTool inline />}
      </div>
    </div>
  )
}
