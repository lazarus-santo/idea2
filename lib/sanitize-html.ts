const ALLOWED_TAGS = new Set(['p', 'br', 'strong', 'em', 'u', 'a', 'ul', 'ol', 'li', 'h2', 'h3', 'span', 'blockquote'])
const LINK_ATTRS = new Set(['href', 'target', 'rel'])

// Client-side: uses DOM for accurate processing
function sanitizeClient(html: string): string {
  const div = document.createElement('div')
  div.innerHTML = html

  function walk(parent: Node) {
    let i = 0
    while (i < parent.childNodes.length) {
      const node = parent.childNodes[i]
      if (node.nodeType !== Node.ELEMENT_NODE) { i++; continue }

      const el = node as Element
      const tag = el.tagName.toLowerCase()

      if (!ALLOWED_TAGS.has(tag)) {
        while (el.firstChild) parent.insertBefore(el.firstChild, el)
        parent.removeChild(el)
        continue // don't increment — we inserted at position i
      }

      // Strip disallowed attributes
      Array.from(el.attributes).forEach((attr) => {
        const keep =
          (tag === 'a' && LINK_ATTRS.has(attr.name)) ||
          (tag === 'span' && attr.name === 'style')
        if (!keep) el.removeAttribute(attr.name)
      })

      if (tag === 'a') {
        el.setAttribute('target', '_blank')
        el.setAttribute('rel', 'noopener noreferrer')
      }

      if (tag === 'span') {
        const style = el.getAttribute('style') ?? ''
        const m = style.match(/font-size\s*:\s*[^;]+/)
        if (m) el.setAttribute('style', m[0])
        else el.removeAttribute('style')
      }

      walk(el)
      i++
    }
  }

  walk(div)
  return div.innerHTML
}

// Server-side: regex-based (less precise but safe for known-valid input)
function sanitizeServer(html: string): string {
  // Remove script/style/on* attributes as a safety net
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/\s+on\w+="[^"]*"/gi, '')
    .replace(/\s+on\w+='[^']*'/gi, '')
    // Ensure links open in new tab
    .replace(/<a\s/gi, '<a target="_blank" rel="noopener noreferrer" ')
}

export function sanitizeHtml(html: string): string {
  if (!html) return ''
  if (typeof document !== 'undefined') return sanitizeClient(html)
  return sanitizeServer(html)
}

// Normalize plain text to HTML paragraph(s)
export function normalizeToHtml(value: string | null | undefined): string {
  if (!value) return ''
  // Already has block-level HTML — return as is
  if (/<(?:p|h[123456]|ul|ol|blockquote)\b/i.test(value)) return value
  // Plain text — wrap each double-newline block in <p>
  return value
    .split(/\n{2,}/)
    .map((block) => `<p>${block.replace(/\n/g, '<br>')}</p>`)
    .join('')
}
