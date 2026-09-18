#!/usr/bin/env node
/**
 * Tests Agent 1's image-validity pattern (IMAGE_DISCARD_RE in lib/scraper.ts).
 *
 *     node scripts/test-image-validity.mjs
 *
 * The pattern is read out of the source file rather than re-typed here, so this
 * exercises the literal line that ships. lib/scraper.ts cannot simply be imported
 * — it pulls in the Browserbase and Supabase SDKs at module load — and a copy of
 * the regex in a test would be free to drift away from the one in the pipeline,
 * which is exactly how the regression this file exists to catch got in.
 *
 * Exit code 1 on any failure.
 */
process.removeAllListeners('warning')

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = readFileSync(join(ROOT, 'lib/scraper.ts'), 'utf8')

const found = SRC.match(/const IMAGE_DISCARD_RE = \/(.+)\/([a-z]*)\n/)
if (!found) {
  console.error('Could not find IMAGE_DISCARD_RE in lib/scraper.ts — has it been renamed?')
  process.exit(2)
}
const IMAGE_DISCARD_RE = new RegExp(found[1], found[2])
console.log(`pattern under test: /${found[1].slice(0, 80)}…/${found[2]}\n`)

let failures = 0
function check(url, shouldDiscard, note) {
  const got = IMAGE_DISCARD_RE.test(url)
  const ok = got === shouldDiscard
  if (!ok) failures++
  const verdict = shouldDiscard ? 'discard' : 'keep'
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${verdict.padEnd(7)} ${url}${note ? `   (${note})` : ''}`)
}

console.log('logos and icons as their own path segment')
check('https://g.com/logo/header.png', true, 'the original case')
check('https://g.com/assets/icon/badge.svg', true)
check('https://g.com/icons/menu.png', true, 'plural')
check('https://g.com/logos/primary.webp', true, 'plural')

console.log('\nlogos and icons inside the filename')
check('https://g.com/wp/uploads/Banner-Logo-2026-1024x234.jpg', true, 'the case found this session')
check('https://g.com/a/site-icon-32x32.png', true)
check('https://g.com/img/gallery-logo.webp', true)

console.log('\nreal exhibition images must survive')
check('https://g.com/logogram-gallery/show-view.jpg', false, 'a real word containing the letters')
check('https://g.com/media/yoshitomo-nara-install-01.jpg', false)
check('https://g.com/img/exhibition-hero-2026.jpg', false)
check('https://g.com/Bologna-Biennale-view.jpg', false, 'letters of "logo" split across the word')
check('https://g.com/iconography-lecture/still.jpg', false, 'directory is a real word')

console.log('\nthe other discards this pattern has always made')
check('https://g.com/placeholder.jpg', true)
check('https://g.com/img/default-thumb.png', true)
check('https://g.com/u/avatar.jpg', true)
check('https://g.com/img/spacer.gif', true)
check('https://g.com/img/blank.png', true)

console.log(failures === 0 ? '\nAll image-validity tests passed.' : `\n${failures} test(s) FAILED.`)
process.exit(failures > 0 ? 1 : 0)
