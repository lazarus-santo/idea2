import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { isAuthorizedAgentRequest, unauthorized } from '@/lib/api-auth'

// GET /api/admin/editor-picks
// Returns the current live pick and any suggestions for each type.
export async function GET(request: Request) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()

  const db = getSupabaseAdmin()

  const { data: allPicks, error } = await db
    .from('editor_picks')
    .select('id, pick_type, reference_id, status')
    .in('status', ['live', 'suggested'])
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const picks = allPicks ?? []

  // Current = the live pick per type. migration_v27 guarantees there is at most
  // one, so the !currentByType guard is belt-and-braces, not a tie-break.
  const currentByType: Record<string, typeof picks[0] | undefined> = {}
  for (const p of picks) {
    if (p.status === 'live' && !currentByType[p.pick_type]) {
      currentByType[p.pick_type] = p
    }
  }

  const suggestedByType: Record<string, typeof picks> = {
    exhibition: picks.filter(p => p.pick_type === 'exhibition' && p.status === 'suggested').slice(0, 5),
    article:    picks.filter(p => p.pick_type === 'article'    && p.status === 'suggested').slice(0, 5),
    book:       picks.filter(p => p.pick_type === 'book'       && p.status === 'suggested').slice(0, 5),
  }

  // Collect all reference IDs by type for batch fetching
  const allExhibitionIds = [
    currentByType.exhibition?.reference_id,
    ...suggestedByType.exhibition.map(p => p.reference_id),
  ].filter(Boolean) as string[]

  const allArticleIds = [
    currentByType.article?.reference_id,
    ...suggestedByType.article.map(p => p.reference_id),
  ].filter(Boolean) as string[]

  const allBookIds = [
    currentByType.book?.reference_id,
    ...suggestedByType.book.map(p => p.reference_id),
  ].filter(Boolean) as string[]

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exMap: Record<string, any> = {}
  if (allExhibitionIds.length > 0) {
    const { data } = await db
      .from('exhibitions')
      .select('id, show_title, end_date, image_url, venues!inner(institutions(name)), exhibition_artists(artists(name))')
      .in('id', allExhibitionIds)
    ;(data ?? []).forEach((e: any) => {
      exMap[e.id] = {
        show_title: e.show_title,
        end_date: e.end_date,
        image_url: e.image_url,
        gallery: e.venues?.institutions?.name ?? e.venues?.name ?? '',
        artists: (e.exhibition_artists ?? []).map((ea: any) => ea.artists?.name).filter(Boolean),
      }
    })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const articleMap: Record<string, any> = {}
  if (allArticleIds.length > 0) {
    const { data } = await db
      .from('readings')
      .select('id, headline, author, rss_summary, published_at, publications(name)')
      .in('id', allArticleIds)
    ;(data ?? []).forEach((r: any) => {
      articleMap[r.id] = {
        headline: r.headline,
        author: r.author,
        rss_summary: r.rss_summary,
        published_at: r.published_at,
        publication: r.publications?.name ?? null,
      }
    })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bookMap: Record<string, any> = {}
  if (allBookIds.length > 0) {
    const { data } = await db
      .from('seed_books')
      .select('id, title, author, source, goodreads_rating')
      .in('id', allBookIds)
    ;(data ?? []).forEach((b: any) => {
      bookMap[b.id] = { title: b.title, author: b.author, source: b.source ?? null, goodreads_rating: b.goodreads_rating ?? null }
    })
  }

  function buildCurrentEx(p: typeof picks[0] | undefined) {
    if (!p) return null
    return { pick_id: p.id, reference_id: p.reference_id, status: p.status, ...(exMap[p.reference_id] ?? {}) }
  }
  function buildCurrentArticle(p: typeof picks[0] | undefined) {
    if (!p) return null
    return { pick_id: p.id, reference_id: p.reference_id, status: p.status, ...(articleMap[p.reference_id] ?? {}) }
  }
  function buildCurrentBook(p: typeof picks[0] | undefined) {
    if (!p) return null
    return { pick_id: p.id, reference_id: p.reference_id, status: p.status, ...(bookMap[p.reference_id] ?? {}) }
  }

  return NextResponse.json({
    exhibitions: {
      current: buildCurrentEx(currentByType.exhibition),
      suggestions: suggestedByType.exhibition.map(p => ({ pick_id: p.id, reference_id: p.reference_id, ...(exMap[p.reference_id] ?? {}) })),
    },
    articles: {
      current: buildCurrentArticle(currentByType.article),
      suggestions: suggestedByType.article.map(p => ({ pick_id: p.id, reference_id: p.reference_id, ...(articleMap[p.reference_id] ?? {}) })),
    },
    books: {
      current: buildCurrentBook(currentByType.book),
      suggestions: suggestedByType.book.map(p => ({ pick_id: p.id, reference_id: p.reference_id, ...(bookMap[p.reference_id] ?? {}) })),
    },
  })
}

// POST /api/admin/editor-picks — set a pick live, retiring whatever it replaces
// For exhibitions and articles: body = { pick_type, reference_id }
// For books: body = { pick_type: 'book', title, author, publisher, image_url }
export async function POST(request: NextRequest) {
  if (!isAuthorizedAgentRequest(request)) return unauthorized()

  const body = await request.json()
  const { pick_type } = body

  if (!['exhibition', 'article', 'book'].includes(pick_type)) {
    return NextResponse.json({ error: 'Invalid pick_type' }, { status: 400 })
  }

  const db = getSupabaseAdmin()
  let referenceId: string = body.reference_id

  if (pick_type === 'book') {
    const { title, author, publisher, image_url } = body
    if (!title) return NextResponse.json({ error: 'title is required for book picks' }, { status: 400 })

    // Try insert with image_url; fall back without if the column doesn't exist
    const withImage = { title, author: author ?? null, source: publisher ?? null, image_url: image_url ?? null }
    const withoutImage = { title, author: author ?? null, source: publisher ?? null }

    let seedId: string | null = null
    const { data: d1, error: e1 } = await db.from('seed_books').insert(withImage).select('id').single()
    if (e1) {
      const { data: d2, error: e2 } = await db.from('seed_books').insert(withoutImage).select('id').single()
      if (e2) return NextResponse.json({ error: e2.message }, { status: 500 })
      seedId = d2.id
    } else {
      seedId = d1.id
    }
    referenceId = seedId!
  }

  if (!referenceId) {
    return NextResponse.json({ error: 'reference_id required for this pick type' }, { status: 400 })
  }

  // Retire the current pick before inserting the replacement. This ordering is
  // load-bearing: editor_picks_one_live_per_type (migration_v27) is a partial
  // unique index on (pick_type) WHERE status = 'live', so inserting first would
  // hit a 23505.
  const { error: retireErr } = await db
    .from('editor_picks')
    .update({ status: 'past' })
    .eq('pick_type', pick_type)
    .neq('status', 'past')
  if (retireErr) console.error('retire error:', retireErr.message)

  const { data, error } = await db
    .from('editor_picks')
    .insert({ pick_type, reference_id: referenceId, status: 'live' })
    .select('id')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, pick_id: data.id, reference_id: referenceId, status: 'live' })
}
