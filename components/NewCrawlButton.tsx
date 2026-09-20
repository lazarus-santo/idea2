'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { getSupabaseBrowser } from '@/lib/supabase-browser'
import { createCrawl } from '@/lib/crawl-writes'

/**
 * Start a crawl and go straight into it.
 *
 * It does NOT ask for a name first. A name for a route you have not planned
 * yet is a question nobody can answer, and a dialog between "new crawl" and
 * the map is a step with nothing in it. The crawl arrives called "Untitled
 * crawl" — a real title the builder's name field is already showing, ready to
 * be typed over — rather than blank, because migration_v66 refuses a blank one
 * and every surface that listed it would otherwise have to invent a placeholder.
 *
 * userId is passed in from the server page rather than read here. The INSERT
 * policy compares it to auth.uid(), so it is the caller proving the row is
 * theirs; a row claiming to be somebody else's is refused by the database.
 */
export default function NewCrawlButton({ userId }: { userId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function start() {
    setBusy(true)
    setError(null)

    const { id, error } = await createCrawl(
      getSupabaseBrowser(),
      userId,
      'Untitled crawl'
    )

    if (error || !id) {
      setBusy(false)
      setError(error?.message ?? 'Could not start a crawl.')
      return
    }

    router.push(`/crawls/${id}`)
  }

  return (
    <>
      <button type="button" className="cl-new" onClick={start} disabled={busy}>
        {busy ? 'Starting…' : 'New crawl'}
      </button>
      {error && <p className="cb-error">{error}</p>}
    </>
  )
}
