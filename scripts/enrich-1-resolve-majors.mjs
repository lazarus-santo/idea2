#!/usr/bin/env node
/**
 * Enrichment phase 1 — find websites for the major galleries Artguide omits.
 *
 * Artforum's Artguide is a paid listing, so roughly two thirds of major NYC
 * galleries are absent from it. Those arrive here as names only. Domains are
 * guessed from the name and then VERIFIED by requiring the fetched page to
 * actually mention the gallery — a domain that merely resolves proves nothing,
 * and squatters sit on plenty of gallery-shaped names.
 *
 *     node scripts/enrich-1-resolve-majors.mjs
 *
 * Writes seed-data/enrich-majors-resolved.json. Touches no database.
 */
import { readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = resolve(ROOT, 'seed-data/enrich-majors-resolved.json')
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

const MISSING = [
  '303 Gallery', 'Sean Kelly', 'Lehmann Maupin', 'Tanya Bonakdar Gallery', 'Bortolami', 'Kasmin',
  'Almine Rech', 'Thaddaeus Ropac', 'White Cube', 'Xavier Hufkens', 'Van Doren Waxter',
  'Bridget Donahue', 'James Cohan', 'Sikkema Jenkins', 'Tina Kim Gallery', 'Mnuchin Gallery',
  'Craig Starr Gallery', 'Peter Freeman', 'Cheim & Read', 'Galerie Lelong', 'Sperone Westwater',
  'Yancey Richardson Gallery', 'Yossi Milo', 'Anton Kern Gallery', 'Metro Pictures', 'Team Gallery',
  'Canada', 'Foxy Production', 'Kaufmann Repetto', 'Chapter NY', 'Kate Werble Gallery', 'JTT',
  'Nicelle Beauchene Gallery', 'Rachel Uffner Gallery', 'Jeffrey Deitch', 'The Hole',
  'Fredericks & Freiser', 'PPOW', 'Postmasters', 'Susan Inglett Gallery', 'Ronald Feldman',
  'Andrea Rosen Gallery', 'Simone Subal Gallery', 'Bureau', 'Off Paradise', 'Company Gallery',
  '47 Canal', 'Greene Naftali', 'Essex Street', 'Gordon Robichaux', 'Magenta Plains',
  'Deli Gallery', "Sargent's Daughters", 'Kerry Schuss', 'Karma', 'Blum', 'Sprüth Magers',
  'Ortuzar', 'Half Gallery', 'Nino Mier Gallery', 'Harkawik', 'Clearing', 'Andrew Edlin Gallery',
  'Ricco/Maresca Gallery', 'Alexander and Bonin', 'Alexander Berggruen', 'Eva Presenhuber',
  'Peter Blum Gallery', 'Garth Greenan Gallery', 'Hollis Taggart', 'Michael Rosenfeld Gallery',
  'Miles McEnery Gallery', 'DC Moore Gallery', 'Tibor de Nagy', 'Betty Cuningham Gallery',
  'Hirschl & Adler', 'Menconi + Schoelkopf', 'Jack Hanley Gallery', 'Derek Eller Gallery',
  'Kai Matsumiya', 'Fierman', 'Shrine', 'Ramiken', 'Nicola Vassell Gallery', 'Charles Moffett',
  'Kapp Kapp', 'James Fuentes', 'Grimm', 'Tilton Gallery', 'Mendes Wood DM', 'Pace Prints',
  'Marlborough Gallery', 'Skarstedt', 'Michael Werner Gallery', 'Salon 94',
  'Jack Shainman Gallery', 'Alexander Gray Associates', 'Miguel Abreu Gallery',
  'Acquavella Galleries', 'Di Donna Galleries', 'Nahmad Contemporary', 'Casey Kaplan',
  'Andrew Kreps Gallery', 'Perrotin', 'Bianca DAlessandro', 'Situations',
]

// Domains that guessing cannot reach — galleries whose site name bears no
// relation to the gallery name. Supplied as candidates only; each is still put
// through the same fetch-and-verify as a guess, so a wrong entry here fails
// closed rather than polluting the list.
const KNOWN = {
  'Sean Kelly': 'https://www.skny.com',
  '47 Canal': 'https://www.47canal.us',
  'Essex Street': 'https://www.essexstreet.biz',
  'Perrotin': 'https://www.perrotin.com',
  'Thaddaeus Ropac': 'https://ropac.net',
  'Sprüth Magers': 'https://spruethmagers.com',
  'Kaufmann Repetto': 'https://kaufmannrepetto.com',
  'Michael Rosenfeld Gallery': 'https://www.michaelrosenfeldart.com',
  'Sikkema Jenkins': 'https://www.sikkemajenkinsco.com',
  'Postmasters': 'https://www.postmastersart.com',
  'Ronald Feldman': 'https://feldmangallery.com',
  'Susan Inglett Gallery': 'https://www.inglettgallery.com',
  'Rachel Uffner Gallery': 'https://www.racheluffnergallery.com',
  'Bridget Donahue': 'https://bridgetdonahue.nyc',
  'Chapter NY': 'https://www.chapter-ny.com',
  'Bureau': 'https://www.bureau-inc.com',
  'JTT': 'https://www.jttnyc.com',
  'Foxy Production': 'https://www.foxyproduction.com',
  'Magenta Plains': 'https://www.magentaplains.com',
  'Deli Gallery': 'https://deli.gallery',
  'Kapp Kapp': 'https://www.kappkapp.com',
  'Peter Freeman': 'https://www.peterfreemaninc.com',
  'Betty Cuningham Gallery': 'https://www.bettycuninghamgallery.com',
  'Alexander and Bonin': 'https://www.alexanderandbonin.com',
  'Cheim & Read': 'https://www.cheimread.com',
  'Fredericks & Freiser': 'https://www.fredericksfreisergallery.com',
  'Menconi + Schoelkopf': 'https://www.menconischoelkopf.com',
  'Tilton Gallery': 'https://www.jacktiltongallery.com',
  'Michael Werner Gallery': 'https://www.michaelwerner.com',
  'DC Moore Gallery': 'https://www.dcmooregallery.com',
  'Karma': 'https://www.karmakarma.org',
  'Team Gallery': 'https://www.teamgal.com',
  'Canada': 'https://www.canadanewyork.com',
  'Situations': 'https://www.situations.us',
  'Metro Pictures': 'https://www.metropictures.com',
  'Andrea Rosen Gallery': 'https://www.andrearosengallery.com',
}

// Domain brokers, parking pages and unrelated sites that a name-shaped guess can
// land on. "Canada" reached a news site and "Team Gallery" reached atlassian.com
// before this existed.
const BAD_HOST = /expireddomains|hugedomains|afternic|sedo\.|dan\.com|godaddy|namecheap|squadhelp|brandbucket|brandsly|undeveloped|parkingcrew|bodis|above\.com|atlassian|canada\.com|wixsite|weebly|squarespace\.com$/i

const slug = (s, keepGallery) => {
  let t = s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  t = t.replace(/&/g, 'and').replace(/[’'.+/·]/g, '')
  if (!keepGallery) t = t.replace(/\b(gallery|galleries|projects|associates|contemporary|fine art|fine arts)\b/g, '')
  return t.replace(/[^a-z0-9]/g, '')
}

function candidates(name) {
  if (KNOWN[name]) return [KNOWN[name]]
  const a = slug(name, true)
  const b = slug(name, false)
  const set = new Set()
  for (const base of [b, a]) {
    if (!base || base.length < 3) continue
    set.add(`https://www.${base}.com`)
    set.add(`https://${base}.com`)
    set.add(`https://www.${base}gallery.com`)
    set.add(`https://${base}.art`)
    set.add(`https://${base}.nyc`)
  }
  return [...set]
}

const strip = (h) => h.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim()

// A domain counts only if the page mentions the gallery — a resolving domain
// proves nothing, and gallery-shaped names attract squatters.
function mentions(text, name) {
  const words = name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, 'and').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 2 && !['gallery', 'galleries', 'the', 'and', 'projects', 'new', 'york'].includes(w))
  if (words.length === 0) return false
  const hay = text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
  return words.every((w) => hay.includes(w))
}

async function resolveOne(name) {
  for (const url of candidates(name)) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(12000) })
      if (!res.ok) continue
      const text = strip(await res.text())
      if (text.length < 120 && !KNOWN[name]) continue
      if (/domain (?:is |may be )?for sale|buy this domain|parked/i.test(text) && text.length < 3000) continue
      const host = new URL(res.url).hostname.replace(/^www\./, '')
      if (BAD_HOST.test(host)) continue
      // A guessed domain must also look like the gallery. Known domains are
      // exempt: they were supplied precisely because the name does not match.
      if (!KNOWN[name]) {
        const hs = slug(host.split('.')[0], true)
        const ns = slug(name, false) || slug(name, true)
        const corresponds = hs.includes(ns.slice(0, 8)) || ns.includes(hs.slice(0, 8)) || hs.slice(0, 6) === ns.slice(0, 6)
        if (!corresponds) continue
      }
      if (!mentions(text, name)) continue
      return { name, website: res.url, verified: true, chars: text.length }
    } catch { /* try next candidate */ }
  }
  return { name, website: null, verified: false, chars: 0 }
}

const results = []
let i = 0
const CONC = 12
await Promise.all(Array.from({ length: CONC }, async () => {
  while (i < MISSING.length) {
    const n = MISSING[i++]
    const r = await resolveOne(n)
    results.push(r)
    console.log(`${r.verified ? 'OK  ' : 'MISS'} ${n.padEnd(30)} ${r.website ?? ''}`)
  }
}))

results.sort((a, b) => a.name.localeCompare(b.name))
writeFileSync(OUT, JSON.stringify(results, null, 1))
const ok = results.filter((r) => r.verified)
console.log(`\nresolved ${ok.length} of ${MISSING.length}`)
console.log(`unresolved: ${results.filter((r) => !r.verified).map((r) => r.name).join(', ')}`)
console.log(`wrote ${OUT}`)
