// Shared Mapbox popup card builder — the same `.mp-popup` card is used across
// StandaloneMap, VenueMap, ExhibitionMiniMap, and ExhibitionsSplitView so every map
// popup looks identical. The card has a fixed size (see .mp-popup in globals.css):
// every text slot is always rendered (blank if the field is absent) and truncates
// instead of wrapping, so the footprint never changes based on item content. When
// multiple items share one marker (co-located shows at the same venue), a prev/next
// arrow strip is overlaid on the thumbnail corner — absolutely positioned, so paging
// through shows swaps the card's content in place without resizing anything.

export interface PopupCardItem {
  title: string
  subtitle?: string
  meta?: string
  dateLabel?: string
  imageUrl?: string | null
  href: string
  linkLabel?: string
  // "Add to itinerary" slot: a same-page callback (StandaloneMap, which has an itinerary
  // panel open in the same view) or a deep-link to /map?add=id (ExhibitionsSplitView, which
  // doesn't). Same visual button either way — rendered as <button> or <a> underneath.
  addAction?: { onClick: () => void; label?: string } | { href: string; label?: string }
}

export function formatArtists(artists: string[]): string {
  if (artists.length <= 3) return artists.join(', ')
  return `${artists.slice(0, 3).join(', ')} +${artists.length - 3}`
}

export function formatEndDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function buildPopupCard(items: PopupCardItem[]): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'mp-popup'

  const thumb = document.createElement('div')
  thumb.className = 'mp-popup-thumb'
  wrap.appendChild(thumb)

  const body = document.createElement('div')
  body.className = 'mp-popup-body'

  const titleEl = document.createElement('p')
  titleEl.className = 'mp-popup-title'

  const subtitleEl = document.createElement('p')
  subtitleEl.className = 'mp-popup-artist'

  const metaEl = document.createElement('p')
  metaEl.className = 'mp-popup-gallery'

  const dateEl = document.createElement('p')
  dateEl.className = 'mp-popup-date'

  const actions = document.createElement('div')
  actions.className = 'mp-popup-actions'

  const viewLink = document.createElement('a')
  viewLink.className = 'mp-popup-view'

  const addBtn = document.createElement('button')
  addBtn.type = 'button'
  addBtn.className = 'mp-popup-add'

  let currentOnClick: (() => void) | null = null
  addBtn.addEventListener('click', () => currentOnClick?.())

  const addLink = document.createElement('a')
  addLink.className = 'mp-popup-add'

  actions.appendChild(viewLink)
  actions.appendChild(addBtn)
  actions.appendChild(addLink)
  body.appendChild(titleEl)
  body.appendChild(subtitleEl)
  body.appendChild(metaEl)
  body.appendChild(dateEl)
  body.appendChild(actions)
  wrap.appendChild(body)

  // Nav overlay lives on the thumbnail corner — absolutely positioned, so its presence
  // never changes the card's size whether it's a single show or a group of them.
  let prevBtn: HTMLButtonElement | null = null
  let nextBtn: HTMLButtonElement | null = null
  let counter: HTMLSpanElement | null = null

  if (items.length > 1) {
    const nav = document.createElement('div')
    nav.className = 'mp-popup-nav'

    prevBtn = document.createElement('button')
    prevBtn.type = 'button'
    prevBtn.className = 'mp-popup-nav-btn'
    prevBtn.textContent = '‹'
    prevBtn.setAttribute('aria-label', 'Previous show at this venue')

    counter = document.createElement('span')
    counter.className = 'mp-popup-nav-counter'

    nextBtn = document.createElement('button')
    nextBtn.type = 'button'
    nextBtn.className = 'mp-popup-nav-btn'
    nextBtn.textContent = '›'
    nextBtn.setAttribute('aria-label', 'Next show at this venue')

    nav.appendChild(prevBtn)
    nav.appendChild(counter)
    nav.appendChild(nextBtn)
    thumb.appendChild(nav)
  }

  function renderItem(item: PopupCardItem) {
    if (item.imageUrl) {
      thumb.style.backgroundImage = `url("${item.imageUrl}")`
      thumb.setAttribute('role', 'img')
      thumb.setAttribute('aria-label', item.title)
    } else {
      thumb.style.backgroundImage = 'none'
      thumb.removeAttribute('role')
      thumb.removeAttribute('aria-label')
    }

    titleEl.textContent = item.title
    subtitleEl.textContent = item.subtitle ?? ''
    metaEl.textContent = item.meta ?? ''
    dateEl.textContent = item.dateLabel ?? ''

    viewLink.href = item.href
    viewLink.textContent = item.linkLabel ?? 'View Show'

    const addAction = item.addAction

    if (addAction && 'onClick' in addAction) {
      currentOnClick = addAction.onClick
      addBtn.style.display = ''
      addBtn.textContent = addAction.label ?? '+ Add to itinerary'
      addLink.style.display = 'none'
    } else if (addAction && 'href' in addAction) {
      currentOnClick = null
      addBtn.style.display = 'none'
      addLink.style.display = ''
      addLink.href = addAction.href
      addLink.textContent = addAction.label ?? '+ Add to itinerary'
    } else {
      currentOnClick = null
      addBtn.style.display = 'none'
      addLink.style.display = 'none'
    }
  }

  let idx = 0
  function update() {
    renderItem(items[idx])
    if (counter) counter.textContent = `${idx + 1}/${items.length}`
    if (prevBtn) prevBtn.disabled = idx === 0
    if (nextBtn) nextBtn.disabled = idx === items.length - 1
  }

  prevBtn?.addEventListener('click', (e) => {
    e.stopPropagation()
    if (idx > 0) { idx--; update() }
  })
  nextBtn?.addEventListener('click', (e) => {
    e.stopPropagation()
    if (idx < items.length - 1) { idx++; update() }
  })

  update()

  return wrap
}
