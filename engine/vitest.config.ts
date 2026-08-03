import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

/**
 * `server.ts`'s `PUBLIC_DIR` is `fileURLToPath(new URL('./public/',
 * import.meta.url))` — fixed relative to its own file, and untouchable
 * (`CLAUDE.md`'s `engine/src/web/*.ts` constraint). In the shipped bundle
 * that resolves to `dist/web/public/`, the sibling `esbuild`/`build.mjs` put
 * next to `dist/web/cli.js` — correctly. `tests/web/server.test.ts` imports
 * `src/web/server.ts` directly, unbundled, so the same expression resolves
 * to `src/web/public/` — the hand-written tree Task 12 deleted from source.
 *
 * A test-time filesystem mirror (writing a real `src/web/public/` before
 * every run) was tried first and rejected: it resurrects the exact path this
 * task exists to retire, on every machine that runs the suite, and nothing
 * about `git status` would ever say so. This rewrites the *expression*
 * instead, at transform time, so nothing is ever written back to `src/`.
 *
 * The tripwire below covers the expression changing, not `server.ts` moving:
 * `id.endsWith('/src/web/server.ts')` is itself path-shaped, so a moved
 * `server.ts` would simply stop matching and this plugin would go silent —
 * that failure mode is a returned `null`, indistinguishable from any other
 * untransformed file. What it does catch is the literal this looks for
 * disappearing out from under it — an edit to `PUBLIC_DIR` itself — which
 * throws instead of silently leaving `PUBLIC_DIR` pointed at a directory
 * nothing serves.
 */
function serverPublicDirForTests(): Plugin {
  const distPublic = fileURLToPath(new URL('./dist/web/public/', import.meta.url))
  // Quote-agnostic: `code` here is post-esbuild, and esbuild's own TS
  // transform normalises single-quoted string literals to double quotes
  // before this plugin ever sees them — a literal `'./public/'` search
  // against the transformed code never matches the source's own quoting.
  const target = /new URL\((["'])\.\/public\/\1,\s*import\.meta\.url\)/
  return {
    name: 'server-public-dir-for-tests',
    transform(code, id) {
      if (!id.endsWith('/src/web/server.ts')) return null
      if (!target.test(code)) {
        throw new Error(
          "server-public-dir-for-tests: expected new URL('./public/', import.meta.url) in src/web/server.ts — the PUBLIC_DIR expression this plugin rewrites for tests has changed underneath it.",
        )
      }
      // The precondition the deleted filesystem mirror used to carry: fail
      // with a clear reason rather than let every PUBLIC_DIR-dependent test
      // in server.test.ts 404 against a directory nobody built yet.
      if (!fs.existsSync(distPublic)) {
        throw new Error('dist/web/public is missing — run `npm run build` first')
      }
      return code.replace(target, "new URL('../../dist/web/public/', import.meta.url)")
    },
  }
}

export default defineConfig({
  plugins: [vue(), serverPublicDirForTests()],
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})
