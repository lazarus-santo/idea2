'use client'

type SubFilter = 'closing-soon' | 'opening-soon' | null

interface Props {
  tabs: { label: string; value: string }[]
  activeTab: string
  subFilter: SubFilter
  onTabChange: (value: string) => void
  onSubFilterToggle: (f: 'closing-soon' | 'opening-soon') => void
}

export default function ExhibitionFilters({ tabs, activeTab, subFilter, onTabChange, onSubFilterToggle }: Props) {
  return (
    <div className="ei-controls-left">
      <div className="ei-tabs">
        {tabs.map(t => (
          <button
            key={t.value}
            className={`ei-tab${activeTab === t.value ? ' ei-tab--active' : ''}`}
            onClick={() => onTabChange(t.value)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="ei-filters">
        {(['closing-soon', 'opening-soon'] as const).map(f => (
          <button
            key={f}
            className={`ei-filter${subFilter === f ? ' ei-filter--active' : ''}`}
            onClick={() => onSubFilterToggle(f)}
          >
            {f === 'closing-soon' ? 'Closing Soon' : 'Opening Soon'}
          </button>
        ))}
      </div>
    </div>
  )
}
