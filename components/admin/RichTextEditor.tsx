'use client'

import { useEffect, useRef } from 'react'

// Allowed tags for the description/press-release field.
// Strips everything else (including contenteditable's <div> wrappers → <p>).
function sanitizeHtml(html: string): string {
  if (typeof document === 'undefined') return html
  const tmp = document.createElement('div')
  tmp.innerHTML = html
    .replace(/<div(\s[^>]*)?>/gi, '<p>')
    .replace(/<\/div>/gi, '</p>')

  const allowed = new Set(['b', 'i', 'em', 'strong', 'p', 'br'])
  const strip = (node: Node) => {
    Array.from(node.childNodes).forEach((child) => {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as Element
        if (!allowed.has(el.tagName.toLowerCase())) {
          // Replace disallowed element with its text/child content
          const frag = document.createDocumentFragment()
          Array.from(el.childNodes).forEach((c) => frag.appendChild(c.cloneNode(true)))
          node.replaceChild(frag, el)
        } else {
          // Remove all attributes from allowed tags
          Array.from(el.attributes).forEach((a) => el.removeAttribute(a.name))
          strip(el)
        }
      }
    })
  }
  strip(tmp)
  return tmp.innerHTML.trim()
}

interface RichTextEditorProps {
  value: string
  onChange: (html: string) => void
  placeholder?: string
  rows?: number
  borderColor?: string
}

export default function RichTextEditor({
  value,
  onChange,
  placeholder = '',
  rows = 8,
  borderColor = 'rgba(0,0,0,0.18)',
}: RichTextEditorProps) {
  const ref = useRef<HTMLDivElement>(null)

  // Set initial HTML once on mount
  useEffect(() => {
    if (ref.current) ref.current.innerHTML = value || ''
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleInput() {
    if (!ref.current) return
    onChange(sanitizeHtml(ref.current.innerHTML))
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key === 'b') { e.preventDefault(); document.execCommand('bold', false) }
    if (mod && e.key === 'i') { e.preventDefault(); document.execCommand('italic', false) }
  }

  const F = 'var(--font-inter-tight), system-ui, sans-serif'

  return (
    <div
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      onInput={handleInput}
      onKeyDown={handleKeyDown}
      data-placeholder={placeholder}
      style={{
        display: 'block',
        marginTop: 8,
        width: '100%',
        fontFamily: F,
        fontSize: 13,
        lineHeight: 1.6,
        color: '#000',
        background: '#fff',
        border: `1px solid ${borderColor}`,
        padding: '8px 12px',
        outline: 'none',
        boxSizing: 'border-box',
        minHeight: `${rows * 1.6 * 13 + 16}px`,
        whiteSpace: 'pre-wrap',
      }}
    />
  )
}
