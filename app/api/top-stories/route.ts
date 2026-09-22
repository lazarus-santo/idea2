import { NextResponse } from 'next/server'
import he from 'he'
import { getSupabaseAdmin } from '@/lib/supabase'
import { loadTopStories } from '@/lib/story-groups'

// The Top Stories tab: story groups of 3+ outlets whose first article is under
// seven days old, already in page order (lib/story-groups.ts buildTopStories).
// Like /api/readings and /api/river, no summary text is sent (d3fde0f).

export async function GET() {
  try {
    const stories = await loadTopStories(getSupabaseAdmin())
    const decoded = stories.map((s) => ({
      ...s,
      lead: {
        ...s.lead,
        headline: he.decode(s.lead.headline),
        author: s.lead.author ? he.decode(s.lead.author) : null,
      },
      more: s.more.map((m) => ({ ...m, headline: he.decode(m.headline) })),
    }))
    return NextResponse.json(decoded)
  } catch (err) {
    console.error('Failed to load top stories:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
