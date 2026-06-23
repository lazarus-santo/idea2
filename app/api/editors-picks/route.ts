import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'

export async function GET() {
  const supabase = getSupabaseAdmin()

  const { data: picks, error } = await supabase
    .from('editor_picks')
    .select('id, pick_type, reference_id, status, created_at')
    .eq('status', 'live')
    .order('created_at', { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const exhibitionPick = picks?.find(p => p.pick_type === 'exhibition') ?? null
  const articlePick   = picks?.find(p => p.pick_type === 'article')    ?? null
  const bookPick      = picks?.find(p => p.pick_type === 'book')       ?? null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: Record<string, any> = { exhibition: null, article: null, book: null }

  if (exhibitionPick) {
    const { data: ex } = await supabase
      .from('exhibitions')
      .select(`
        id, show_title, image_url,
        venues!inner(name, institutions(name, type)),
        exhibition_artists(artists(name))
      `)
      .eq('id', exhibitionPick.reference_id)
      .single()

    if (ex) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = ex as any
      result.exhibition = {
        pick_id:      exhibitionPick.id,
        reference_id: ex.id,
        image_url:    ex.image_url,
        show_title:   ex.show_title,
        artists: (raw.exhibition_artists ?? [])
          .map((ea: { artists: { name: string } | null }) => ea.artists?.name)
          .filter(Boolean) as string[],
        gallery_name: raw.venues?.institutions?.name ?? raw.venues?.name ?? '',
      }
    }
  }

  if (articlePick) {
    const { data: reading } = await supabase
      .from('readings')
      .select('id, headline, author, thumbnail_url, article_url, publications(name)')
      .eq('id', articlePick.reference_id)
      .single()

    if (reading) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = reading as any
      result.article = {
        pick_id:          articlePick.id,
        reference_id:     reading.id,
        thumbnail_url:    reading.thumbnail_url,
        headline:         reading.headline,
        author:           reading.author,
        publication_name: raw.publications?.name ?? null,
        article_url:      reading.article_url,
      }
    }
  }

  if (bookPick) {
    // Try with image_url; fall back to base columns if the column doesn't exist yet.
    let bookRow: { id: string; title: string; author: string | null; image_url?: string | null } | null = null

    const { data: withImg, error: imgErr } = await supabase
      .from('seed_books')
      .select('id, title, author, image_url')
      .eq('id', bookPick.reference_id)
      .single()

    if (imgErr) {
      const { data: base } = await supabase
        .from('seed_books')
        .select('id, title, author')
        .eq('id', bookPick.reference_id)
        .single()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bookRow = base ? { ...(base as any), image_url: null } : null
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bookRow = withImg as any
    }

    if (bookRow) {
      result.book = {
        pick_id:      bookPick.id,
        reference_id: bookRow.id,
        title:        bookRow.title,
        author:       bookRow.author,
        image_url:    bookRow.image_url ?? null,
      }
    }
  }

  return NextResponse.json(result)
}
