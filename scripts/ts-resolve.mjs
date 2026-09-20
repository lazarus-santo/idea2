/**
 * Let a test script import the app's own TypeScript modules.
 *
 *   node --env-file=.env.local --import ./scripts/ts-resolve.mjs scripts/<test>.mjs
 *
 * Node 24 strips the types itself; what it will not do is guess an extension,
 * so `import { getSupabaseAdmin } from './supabase'` — the style every file in
 * lib/ is written in — fails to resolve. This adds the one rule that fixes
 * that: a relative import with no extension tries `.ts`, then `.tsx`, then an
 * `index.ts` inside a directory of that name, and otherwise hands the
 * specifier back for Node to resolve as usual.
 *
 * WHY THIS EXISTS AT ALL. scripts/test-reading-logs.mjs has to prove that the
 * FREEZE FIRES — that lib/preread-logs.ts, which was a stub until
 * migration_v63, now answers truthfully from the database. A test that
 * re-implemented that query would prove only that the query works, not that
 * the repair path is asking it, which is the thing that was broken. So it
 * imports the real function and calls it.
 *
 * `@/…` aliases are deliberately NOT resolved. Only modules that stick to
 * relative imports can be loaded this way, which is every pure-logic file in
 * lib/ and none of the React or server-only ones.
 */

import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

const CANDIDATES = ['.ts', '.tsx', '/index.ts', '/index.tsx']

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      const from = context.parentURL ? dirname(fileURLToPath(context.parentURL)) : process.cwd()
      for (const ext of CANDIDATES) {
        const candidate = resolvePath(from, specifier + ext)
        if (existsSync(candidate)) {
          return { url: pathToFileURL(candidate).href, shortCircuit: true }
        }
      }
    }
    return nextResolve(specifier, context)
  },
})
