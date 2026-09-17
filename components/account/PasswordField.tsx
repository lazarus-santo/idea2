'use client'

import { useState } from 'react'

/**
 * A password input with a show/hide toggle.
 *
 * Masked by default, and each field keeps its own visibility state — turning
 * one on does not reveal the others on the same form.
 *
 * Deliberately NOT wrapped in a <label> element: a button inside a label is
 * treated as part of the label, so clicking the eye would also focus (and on
 * some browsers re-trigger) the input. The label is bound with htmlFor/id
 * instead, which keeps the click target behaviour correct and the field still
 * properly named for screen readers.
 */
export default function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  minLength,
  required,
  autoFocus,
  hint,
  error,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  autoComplete: string
  minLength?: number
  required?: boolean
  autoFocus?: boolean
  hint?: string
  error?: string | null
}) {
  const [visible, setVisible] = useState(false)

  return (
    <div className="ac-field">
      <label className="ac-label" htmlFor={id}>{label}</label>

      <div className="ac-password">
        <input
          id={id}
          className="ac-input ac-input--password"
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          minLength={minLength}
          required={required}
          autoFocus={autoFocus}
        />
        <button
          type="button"
          className="ac-password-toggle"
          onClick={() => setVisible((v) => !v)}
          // The label carries the state, so a screen reader announces what the
          // button will do rather than just "button".
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          title={visible ? 'Hide password' : 'Show password'}
        >
          {visible ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      </div>

      {error ? <p className="ac-error">{error}</p> : hint ? <p className="ac-hint">{hint}</p> : null}
    </div>
  )
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M1.8 12s3.6-7 10.2-7 10.2 7 10.2 7-3.6 7-10.2 7S1.8 12 1.8 12z" />
      <circle cx="12" cy="12" r="3.2" />
    </svg>
  )
}

function EyeOffIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M2 12s3.6-7 10-7c2 0 3.7.7 5.1 1.6M22 12s-3.6 7-10 7c-2 0-3.7-.7-5.1-1.6" />
      <path d="M9.9 9.9a3.2 3.2 0 0 0 4.3 4.3" />
      <path d="M3 3l18 18" />
    </svg>
  )
}
