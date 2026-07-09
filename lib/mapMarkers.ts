// Shared Mapbox marker element builders — keeps pin styling identical across
// StandaloneMap, VenueMap, and ExhibitionMiniMap.

export function createPrimaryMarkerEl(dimmed = false): HTMLDivElement {
  const el = document.createElement('div')
  if (dimmed) {
    el.style.cssText =
      'width:12px;height:12px;border-radius:50%;background:#888;opacity:0.5;cursor:pointer;flex-shrink:0;'
  } else {
    el.style.cssText =
      'width:18px;height:18px;border-radius:50%;background:#3432A8;border:2px solid #FFFCEC;cursor:pointer;flex-shrink:0;box-sizing:border-box;'
  }
  return el
}

export function createSecondaryMarkerEl(): HTMLDivElement {
  const el = document.createElement('div')
  el.style.cssText =
    'width:12px;height:12px;border-radius:50%;background:#FFFCEC;border:2px solid #3432A8;cursor:pointer;flex-shrink:0;box-sizing:border-box;'
  return el
}
