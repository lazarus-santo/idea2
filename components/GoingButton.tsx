'use client'

import { useState } from 'react'

interface GoingButtonProps {
  exhibitionId: string
  initialCount: number
}

export default function GoingButton({ exhibitionId, initialCount }: GoingButtonProps) {
  const [count, setCount] = useState(initialCount)
  const [clicked, setClicked] = useState(false)
  const [loading, setLoading] = useState(false)

  async function handleClick() {
    if (clicked || loading) return
    setLoading(true)

    try {
      const res = await fetch('/api/going', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exhibition_id: exhibitionId }),
      })
      const data = await res.json()
      setCount(data.count)
      setClicked(true)
    } catch {
      // Silent fail — optimistic update
      setCount((c) => c + 1)
      setClicked(true)
    } finally {
      setLoading(false)
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      className={`going-btn ${clicked ? 'going-btn--active' : ''}`}
      aria-label={clicked ? `${count} people going` : "Mark I'm going"}
    >
      {clicked ? '✓ Going' : "I'm going"}
      {count > 0 && <span className="going-count">{count}</span>}
    </button>
  )
}
