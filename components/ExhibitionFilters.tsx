'use client'

// 'closing-soon' is the only sub-filter. There was an 'Opening Soon' alongside it,
// removed deliberately: most galleries do not publish a show before it opens, so
// the filter surfaced whichever handful of venues happened to announce early
// rather than what is actually opening. The union is kept rather than collapsed
// to a boolean so a future second filter slots in without reshaping the props.
type SubFilter = 'closing-soon' | null

interface Props {
  tabs: { label: string; value: string }[]
  activeTab: string
  subFilter: SubFilter
  onTabChange: (value: string) => void
  onSubFilterToggle: (f: 'closing-soon') => void
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
        <button
          className={`ei-filter${subFilter === 'closing-soon' ? ' ei-filter--active' : ''}`}
          onClick={() => onSubFilterToggle('closing-soon')}
        >
          Closing Soon
        </button>
      </div>
    </div>
  )
}
