'use client'

import { useEditor, EditorContent, Editor, Extension } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import TextAlign from '@tiptap/extension-text-align'
import { TextStyle } from '@tiptap/extension-text-style'
import { useRef, useState, useCallback, useEffect } from 'react'
import { sanitizeHtml, normalizeToHtml } from '@/lib/sanitize-html'

// ── FontSize: extend TextStyle mark with a fontSize attribute ─────────────────
const FontSizeTextStyle = TextStyle.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      fontSize: {
        default: null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        parseHTML: (el: any) => (el as HTMLElement).style.fontSize || null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        renderHTML: (attrs: any) =>
          attrs.fontSize ? { style: `font-size: ${attrs.fontSize}` } : {},
      },
    }
  },
  addCommands() {
    return {
      ...this.parent?.(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setFontSize: (size: string) => ({ chain }: any) =>
        chain().setMark('textStyle', { fontSize: size }).run(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      unsetFontSize: () => ({ chain }: any) =>
        chain().setMark('textStyle', { fontSize: null }).run(),
    }
  },
})

// ── Cmd+K: triggers link input via ref callback ───────────────────────────────
function makeCmdKExtension(onTrigger: React.RefObject<(() => void) | null>) {
  return Extension.create({
    name: 'cmdKLink',
    addKeyboardShortcuts() {
      return {
        'Mod-k': () => {
          onTrigger.current?.()
          return true
        },
      }
    },
  })
}

// ── Styles shared across toolbar ──────────────────────────────────────────────
const F = 'var(--font-inter-tight), system-ui, sans-serif'

const tbtnBase: React.CSSProperties = {
  fontFamily: F, fontSize: 12, fontWeight: 600,
  background: 'transparent', border: '1px solid transparent',
  padding: '3px 7px', cursor: 'pointer', lineHeight: 1.4,
  color: 'rgba(0,0,0,0.65)', borderRadius: 999,
  transition: 'background 100ms, color 100ms',
}
const tbtnActive: React.CSSProperties = {
  ...tbtnBase, background: 'rgba(0,0,0,0.08)', color: '#000',
  border: '1px solid rgba(0,0,0,0.15)',
}
const dividerS: React.CSSProperties = {
  width: 1, height: 16, background: 'rgba(0,0,0,0.15)',
  alignSelf: 'center', margin: '0 4px', flexShrink: 0,
}

// ── Toolbar ───────────────────────────────────────────────────────────────────
function Toolbar({ editor, onLinkOpen }: { editor: Editor; onLinkOpen: () => void }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fs = (editor.getAttributes('textStyle') as any).fontSize?.replace('px', '') ?? '16'

  function tbtn(active: boolean, label: string, onPress: () => void, title?: string) {
    return (
      <button
        key={label}
        type="button"
        title={title}
        onMouseDown={(e) => { e.preventDefault(); onPress() }}
        style={active ? tbtnActive : tbtnBase}
      >
        {label}
      </button>
    )
  }

  function setFontSize(size: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = editor.chain().focus() as any
    if (size === '16') c.unsetFontSize().run()
    else c.setFontSize(size + 'px').run()
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap',
      padding: '5px 8px', background: '#f5f2eb',
      borderBottom: '1px solid rgba(0,0,0,0.14)',
      position: 'sticky', top: 0, zIndex: 1,
    }}>
      {/* Font size */}
      <select
        value={fs}
        onChange={(e) => setFontSize(e.target.value)}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          fontFamily: F, fontSize: 12, height: 24,
          border: '1px solid rgba(0,0,0,0.18)', background: '#fff',
          padding: '0 4px', cursor: 'pointer', outline: 'none', color: '#000',
        }}
      >
        {['12', '14', '16', '18', '24', '32'].map((s) => (
          <option key={s} value={s}>{s}px</option>
        ))}
      </select>

      <div style={dividerS} />

      {tbtn(editor.isActive('bold'), 'B', () => editor.chain().focus().toggleBold().run(), 'Bold (⌘B)')}
      {tbtn(editor.isActive('italic'), 'I', () => editor.chain().focus().toggleItalic().run(), 'Italic (⌘I)')}
      {tbtn(editor.isActive('underline'), 'U', () => editor.chain().focus().toggleUnderline().run(), 'Underline (⌘U)')}

      <div style={dividerS} />

      {tbtn(editor.isActive({ textAlign: 'left' }),   'L', () => editor.chain().focus().setTextAlign('left').run(),   'Align left')}
      {tbtn(editor.isActive({ textAlign: 'center' }), 'C', () => editor.chain().focus().setTextAlign('center').run(), 'Align center')}
      {tbtn(editor.isActive({ textAlign: 'right' }),  'R', () => editor.chain().focus().setTextAlign('right').run(),  'Align right')}

      <div style={dividerS} />

      {tbtn(editor.isActive('link'), '⊞ Link', onLinkOpen, 'Link (⌘K)')}

      <div style={dividerS} />

      {tbtn(editor.isActive('bulletList'), '• List', () => editor.chain().focus().toggleBulletList().run(), 'Bullet list')}
      {tbtn(editor.isActive('orderedList'), '1. List', () => editor.chain().focus().toggleOrderedList().run(), 'Ordered list')}
    </div>
  )
}

// ── Link input panel ──────────────────────────────────────────────────────────
function LinkInput({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const existing = (editor.getAttributes('link') as { href?: string }).href ?? ''
  const [href, setHref] = useState(existing)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  function apply() {
    const val = href.trim()
    if (!val) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
      onClose(); return
    }
    const url = /^https?:\/\//i.test(val) ? val : `https://${val}`
    editor.chain().focus().extendMarkRange('link')
      .setLink({ href: url, target: '_blank', rel: 'noopener noreferrer' })
      .run()
    onClose()
  }

  function remove() {
    editor.chain().focus().extendMarkRange('link').unsetLink().run()
    onClose()
  }

  return (
    <div style={{
      display: 'flex', gap: 6, alignItems: 'center',
      padding: '6px 8px', background: '#fff', borderBottom: '1px solid rgba(0,0,0,0.14)',
    }}>
      <input
        ref={inputRef}
        type="text"
        value={href}
        onChange={(e) => setHref(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') apply(); if (e.key === 'Escape') onClose() }}
        placeholder="https://…"
        style={{ flex: 1, fontFamily: F, fontSize: 12, border: '1px solid rgba(0,0,0,0.25)', padding: '4px 8px', outline: 'none' }}
      />
      <button type="button" onMouseDown={(e) => { e.preventDefault(); apply() }}
        style={{ ...tbtnBase, background: '#000', color: '#fff', border: 'none', padding: '4px 10px' }}>
        Apply
      </button>
      {existing && (
        <button type="button" onMouseDown={(e) => { e.preventDefault(); remove() }}
          style={{ ...tbtnBase, color: '#dc2626', border: '1px solid #dc2626', padding: '4px 10px' }}>
          Remove
        </button>
      )}
      <button type="button" onMouseDown={(e) => { e.preventDefault(); onClose() }}
        style={{ ...tbtnBase, color: 'rgba(0,0,0,0.4)' }}>
        ✕
      </button>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
interface TipTapEditorProps {
  initialValue: string | null
  exhibitionId: string
  field?: 'press_release' | 'description'
  placeholder?: string
  borderColor?: string
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

export default function TipTapEditor({
  initialValue,
  exhibitionId,
  field = 'press_release',
  placeholder = 'Start typing…',
  borderColor = 'rgba(0,0,0,0.18)',
}: TipTapEditorProps) {
  const [showLink, setShowLink] = useState(false)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const retryHtml = useRef<string>('')
  const openLinkRef = useRef<(() => void) | null>(null)

  const scheduleSave = useCallback(
    (html: string) => {
      clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => doSave(html), 1000)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [exhibitionId, field],
  )

  async function doSave(html: string) {
    const clean = sanitizeHtml(html)
    retryHtml.current = clean
    setSaveStatus('saving')
    try {
      const res = await fetch(`/api/admin/exhibitions/${exhibitionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: clean || null }),
      })
      if (!res.ok) throw new Error()
      setSaveStatus('saved')
      setTimeout(() => setSaveStatus('idle'), 2000)
    } catch {
      setSaveStatus('error')
    }
  }

  const cmdK = makeCmdKExtension(openLinkRef)

  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      Link.configure({ openOnClick: false }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      FontSizeTextStyle,
      cmdK,
    ],
    content: normalizeToHtml(initialValue),
    editorProps: { attributes: { class: 'tiptap-content' } },
    onBlur: ({ editor: e }) => {
      setShowLink(false)
      scheduleSave(e.getHTML())
    },
  })

  useEffect(() => {
    if (!editor) return
    openLinkRef.current = () => {
      const { from, to } = editor.state.selection
      if (from !== to || editor.isActive('link')) setShowLink((v) => !v)
    }
  }, [editor])

  if (!editor) return null

  return (
    <div style={{ border: `1px solid ${borderColor}`, marginTop: 8, background: '#fff', display: 'flex', flexDirection: 'column' }}>
      <Toolbar editor={editor} onLinkOpen={() => setShowLink((v) => !v)} />
      {showLink && <LinkInput editor={editor} onClose={() => setShowLink(false)} />}

      <EditorContent editor={editor} style={{ padding: '10px 12px', minHeight: 180, cursor: 'text' }} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 12px 6px', minHeight: 22 }}>
        <span style={{ fontFamily: F, fontSize: 11, color: 'rgba(0,0,0,0.3)', fontStyle: 'italic' }}>
          {editor.isEmpty ? placeholder : ''}
        </span>
        <span style={{ fontFamily: F, fontSize: 11 }}>
          {saveStatus === 'saving' && <span style={{ color: 'rgba(0,0,0,0.35)' }}>Saving…</span>}
          {saveStatus === 'saved'  && <span style={{ color: '#1a5c2a' }}>Saved</span>}
          {saveStatus === 'error'  && (
            <span style={{ color: '#dc2626' }}>
              Save failed —{' '}
              <button
                type="button"
                onClick={() => doSave(retryHtml.current)}
                style={{ fontFamily: F, fontSize: 11, background: 'transparent', border: 'none', borderRadius: 999, padding: 0, cursor: 'pointer', color: '#dc2626', textDecoration: 'underline' }}
              >
                retry?
              </button>
            </span>
          )}
        </span>
      </div>

      <style>{`
        .tiptap-content { outline: none; font-family: ${F}; font-size: 13px; line-height: 1.65; color: #000; }
        .tiptap-content p { margin: 0 0 8px; }
        .tiptap-content p:last-child { margin-bottom: 0; }
        .tiptap-content ul, .tiptap-content ol { padding-left: 20px; margin: 0 0 8px; }
        .tiptap-content li { margin: 2px 0; }
        .tiptap-content h2 { font-size: 17px; font-weight: 700; margin: 0 0 6px; }
        .tiptap-content h3 { font-size: 15px; font-weight: 700; margin: 0 0 5px; }
        .tiptap-content blockquote { border-left: 3px solid rgba(0,0,0,0.2); margin: 0 0 8px 0; padding-left: 12px; color: rgba(0,0,0,0.6); }
        .tiptap-content a { color: #1a5c2a; text-decoration: underline; text-underline-offset: 2px; }
      `}</style>
    </div>
  )
}
