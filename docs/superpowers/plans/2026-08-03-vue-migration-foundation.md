# Vue Migration — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Vue 3 application shell — build pipeline, ported `lib/`, reactive store, i18n, chrome, terminal, notifications — so the eight panels have somewhere to land.

**Architecture:** A Vite-built Vue 3 SPA at `engine/src/web/app/`, emitting into the committed `dist/web/public/`. One module-level store owns the WebSocket and holds the server's `Snapshot` in a `shallowRef`; terminal output bypasses reactivity through an event emitter. The existing DOM-free `lib/` is ported to TypeScript and reused verbatim.

**Tech Stack:** Vue 3 (SFC, `<script setup>`, Composition API), TypeScript, Vite, `vue-tsc`, Vitest + `@vue/test-utils` + happy-dom, xterm.js (unbundled, from `vendor/`).

**Spec:** `docs/superpowers/specs/2026-08-03-vue-migration-design.md`

**Out of scope — second plan:** the eight panels (`Run`, `Plans`, `Stories`, `Features`, `Skills`, `Evidence`, `Memory`, `Config`), the halt dialog and the launcher (both belong to the `Run` panel, which owns the run id they act on), the `config_error` and `stalled` banners (each needs a panel that does not exist yet), retargeting `discipline.test.ts`, deleting the old `public/` tree, and the switch. The old page keeps working throughout this plan.

## Global Constraints

- **`engine/src/web/*.ts` is never modified.** The server, `protocol.ts`, `api.ts`, `writes.ts`, `codes.ts`, `revision.ts` are read-only for this plan. If a task appears to need a server change, stop and escalate.
- **`engine/src/web/public/` is never modified.** The old page must keep running until the second plan retires it.
- **`dist/` is committed to git** and must run with no `node_modules` and no compiler. `node scripts/verify-ship.mjs` is the judge.
- **Vite settings are binding:** `base: './'`, `assetsInlineLimit: Infinity`, `cssCodeSplit: false`, `sourcemap: false`. Each prevents a named failure; do not "clean them up".
- **xterm stays unbundled**, loaded from `vendor/` as a global via `<script src="vendor/xterm.js">`. It is not an npm import in app code.
- **The server sends codes, never prose.** No English or Arabic sentence may be written in a `.vue` or `.ts` file under `app/`. Every user-visible string resolves through `t()` against `locales/*.json`.
- **Identifiers never go through `Intl`.** Story ids, run ids, paths and commands render through the verbatim path (`<Bdi>`), never as `{n}` number params — `Intl.NumberFormat('ar')` turns `P001-S02` into `P٠٠١-S٠٢`.
- **Node >= 20.** Dependencies are pinned to exact versions, matching the existing `package.json` style (no `^`, no `~`).
- All commands run from `engine/`.

---

### Task 1: Vite scaffold that builds and ships

Stands up the whole shipping constraint before a single component exists. Nothing in this task renders the real UI.

**Files:**
- Create: `engine/src/web/app/index.html`
- Create: `engine/src/web/app/main.ts`
- Create: `engine/src/web/app/App.vue`
- Create: `engine/src/web/app/env.d.ts`
- Create: `engine/vite.config.ts`
- Create: `engine/scripts/assets.mjs`
- Create: `engine/tests/web/assets.test.ts`
- Modify: `engine/package.json` (deps, `build`, `typecheck`, new `dev` script)
- Modify: `engine/tsconfig.web.json` (full replacement)
- Modify: `engine/scripts/build.mjs` (the `fs.cp` of `public/`)
- Modify: `engine/scripts/verify-ship.mjs` (asset resolution check)

**Interfaces:**
- Consumes: `VENDOR`, `VENDOR_FILES` from `scripts/vendor.mjs` (unchanged).
- Produces: `referencedAssets(html: string): string[]` from `scripts/assets.mjs`; the built tree at `dist/web/public/`; the app root `engine/src/web/app/`.

- [ ] **Step 1: Install the dependencies**

```bash
npm install --save-exact --save-dev vue @vitejs/plugin-vue vite vue-tsc @vue/test-utils
```

`--save-exact` because every other dependency in this `package.json` is pinned. Record whatever versions npm resolves; do not hand-edit them afterwards. `happy-dom` (20.11.1) and `vitest` (4.1.10) are already present.

- [ ] **Step 2: Write the failing test for asset resolution**

This is the check `verify-ship.mjs` gains: a built `index.html` that points at an asset which is not in the shipped tree is the exact silent breakage that script exists for.

Create `engine/tests/web/assets.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { referencedAssets } from '../../scripts/assets.mjs'

describe('referencedAssets', () => {
  it('finds script and stylesheet references', () => {
    const html = `<link rel="stylesheet" href="./assets/index-a1b2.css"><script type="module" src="./assets/index-c3d4.js"></script>`
    expect(referencedAssets(html)).toEqual(['assets/index-a1b2.css', 'assets/index-c3d4.js'])
  })

  it('keeps the vendor scripts the page loads by hand', () => {
    expect(referencedAssets(`<script src="vendor/xterm.js"></script>`)).toEqual(['vendor/xterm.js'])
  })

  it('ignores data URIs and absolute URLs', () => {
    const html = `<link rel="icon" href="data:image/svg+xml,%3Csvg%3E"><script src="https://cdn.example/x.js"></script>`
    expect(referencedAssets(html)).toEqual([])
  })

  it('strips a leading slash so paths resolve under the public root', () => {
    expect(referencedAssets(`<script src="/assets/x.js"></script>`)).toEqual(['assets/x.js'])
  })
})
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run tests/web/assets.test.ts`
Expected: FAIL — `Cannot find module '../../scripts/assets.mjs'`

- [ ] **Step 4: Write `scripts/assets.mjs`**

```js
/**
 * The local files a built page asks the server for.
 *
 * Shared by `verify-ship.mjs`, which checks they all arrived. A hashed asset
 * name that no file answers is a blank page, and it is invisible in review
 * because the diff of a built `index.html` is one changed hash.
 */

/** @param {string} html @returns {string[]} */
export function referencedAssets(html) {
  const out = []
  for (const match of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
    const raw = match[1] ?? ''
    // Anything with a scheme, a protocol-relative host, or an inline payload is
    // not a file in the shipped tree.
    if (raw === '' || /^(?:[a-z]+:|\/\/)/i.test(raw)) continue
    out.push(raw.replace(/^\.?\//, ''))
  }
  return out
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `npx vitest run tests/web/assets.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Create the app entry, HTML and root component**

`engine/src/web/app/index.html` — the Vite root. It carries only what Vue cannot own: the favicon, the vendor scripts, and the mount point.

```html
<!doctype html>
<html lang="en" dir="ltr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>mjloop</title>
    <!-- Inline so the page pulls in nothing external and asks for no favicon.ico. -->
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='6' fill='none' stroke='%2358a6ff' stroke-width='2'/%3E%3C/svg%3E" />
    <link rel="stylesheet" href="vendor/xterm.css" />
  </head>
  <body data-pane="collapsed">
    <div id="app"></div>
    <script src="vendor/xterm.js"></script>
    <script src="vendor/addon-fit.js"></script>
    <script type="module" src="/main.ts"></script>
  </body>
</html>
```

`vendor/xterm.css` and `vendor/xterm.js` are left as plain references, not Vite imports: they are copied into place by `build.mjs`, and `referencedAssets` will assert they arrived.

`engine/src/web/app/main.ts`:

```ts
import { createApp } from 'vue'
import App from './App.vue'

createApp(App).mount('#app')
```

`engine/src/web/app/App.vue` — a placeholder that Task 5 replaces:

```vue
<script setup lang="ts"></script>

<template>
  <div class="boot"></div>
</template>
```

`engine/src/web/app/env.d.ts`:

```ts
/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

/**
 * xterm is loaded from `vendor/` as a global rather than bundled, so the page
 * ships one copy that a one-line UI change does not re-diff. These mirror
 * `src/web/page-globals.d.ts`, which serves the old page.
 */
declare const Terminal: any
declare const FitAddon: { FitAddon: any }
```

- [ ] **Step 7: Write `vite.config.ts`**

```ts
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

/**
 * The four settings below are load-bearing, each against a named failure:
 *
 *  base                  the page is served from `/`, but a relative base
 *                        survives any remount of the path
 *  assetsInlineLimit     `server.ts`'s MIME map knows .html/.js/.css/.json/.map
 *                        and nothing else; an emitted .svg or font would be
 *                        served as application/octet-stream
 *  cssCodeSplit          one stylesheet, so the page makes one request and the
 *                        committed diff has one CSS file in it
 *  sourcemap             `dist` is in git, and maps double every diff for a
 *                        user who does not have the source
 */
export default defineConfig({
  root: fileURLToPath(new URL('./src/web/app/', import.meta.url)),
  base: './',
  plugins: [vue()],
  build: {
    outDir: fileURLToPath(new URL('./dist/web/public/', import.meta.url)),
    emptyOutDir: true,
    assetsInlineLimit: Infinity,
    cssCodeSplit: false,
    sourcemap: false,
  },
  server: {
    // Only `/api` needs proxying. The WebSocket connects straight to the engine
    // origin: `server.ts` authenticates the upgrade by token (`server.ts:155`)
    // and never inspects `Origin`, and a cross-origin WebSocket is not subject
    // to CORS preflight. Set MJLOOP_DEV_ORIGIN to the URL `mjloop-web` printed.
    proxy: {
      '/api': process.env['MJLOOP_DEV_ORIGIN'] ?? 'http://127.0.0.1:7777',
    },
  },
})
```

- [ ] **Step 8: Replace `tsconfig.web.json`**

The JSDoc + `checkJs` pass over `public/` is retired in favour of `vue-tsc` over `app/`. Templates get checked too, which the old setup could not do.

```json
{
  /*
   * Type checking for the page, including its templates.
   *
   * Run through `vue-tsc` in the `typecheck` script rather than `tsc`: a typo
   * in `{{ snapshot.state.trakc }}` is a compile error here, where the old
   * JSDoc pass over hand-written DOM could only see the JavaScript.
   *
   * It emits nothing. Vite does the emitting.
   */
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["vite/client"],
    "noEmit": true,
    "strict": true,
    "jsx": "preserve",
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true
  },
  "include": ["src/web/app/**/*.ts", "src/web/app/**/*.vue", "src/web/app/env.d.ts"]
}
```

- [ ] **Step 9: Wire the scripts in `package.json`**

Replace the `typecheck` line and add `dev`:

```json
    "dev": "vite",
    "typecheck": "tsc -p tsconfig.json --noEmit && vue-tsc -p tsconfig.web.json",
```

- [ ] **Step 10: Point `build.mjs` at Vite**

In `engine/scripts/build.mjs`, add the import beside the others:

```js
import { build as viteBuild } from 'vite'
```

Then replace this line:

```js
const target = path.join(root, 'dist', 'web', 'public')
await fs.cp(path.join(root, 'src', 'web', 'public'), target, { recursive: true })
```

with:

```js
// The page is compiled now, not copied: `src/web/app/` is Vue SFCs. Everything
// outside the import graph is still copied — `locales/` is fetched at runtime
// by `lib/i18n.ts`, and `vendor/` is loaded by hand from `index.html`.
const target = path.join(root, 'dist', 'web', 'public')
await viteBuild({ configFile: path.join(root, 'vite.config.ts'), logLevel: 'warn' })
await fs.cp(path.join(root, 'src', 'web', 'app', 'locales'), path.join(target, 'locales'), { recursive: true })
```

The `vendor/` copy loop below it stays exactly as it is — `emptyOutDir` runs before it, so ordering is already correct.

- [ ] **Step 11: Move the locale files into the app tree**

```bash
mkdir -p src/web/app/locales
cp src/web/public/locales/en.json src/web/app/locales/en.json
cp src/web/public/locales/ar.json src/web/app/locales/ar.json
```

Copied, not moved: the old page is still serving from `public/locales/` and must keep working. The two copies are reconciled when the second plan deletes `public/`.

- [ ] **Step 12: Teach `verify-ship.mjs` to check assets**

In `engine/scripts/verify-ship.mjs`, add to the imports:

```js
import { referencedAssets } from './assets.mjs'
```

and add this check next to the existing `VENDOR_FILES` check:

```js
  // The failure this catches: a build whose `index.html` names a hashed asset
  // that never made it into `dist`. Every test passes — they run against the
  // source tree — and the shipped page is blank.
  const pageDir = path.join(engine, 'dist/web/public')
  const page = await fs.readFile(path.join(pageDir, 'index.html'), 'utf8')
  const missing = []
  for (const asset of referencedAssets(page)) {
    if (!(await fs.stat(path.join(pageDir, asset)).catch(() => false))) missing.push(asset)
  }
  check('every asset the page references was shipped', missing.length === 0, missing.join(', '))
```

- [ ] **Step 13: Build and prove the whole pipeline**

```bash
npm run build
npm run typecheck
node scripts/verify-ship.mjs
```

Expected: the build prints `dist/web/public`; typecheck is silent; `verify-ship` prints `ok` on every line including the new asset check. Then confirm by hand that `dist/web/public/index.html` exists, references `assets/*.js`, and that `dist/web/public/locales/en.json` and `dist/web/public/vendor/xterm.js` are present.

- [ ] **Step 14: Commit**

```bash
git add engine/package.json engine/package-lock.json engine/vite.config.ts engine/tsconfig.web.json \
        engine/scripts/assets.mjs engine/scripts/build.mjs engine/scripts/verify-ship.mjs \
        engine/src/web/app engine/tests/web/assets.test.ts engine/dist
git commit -m "build: compile the cockpit page with vite

The page is Vue SFCs from here on, so the build compiles it instead of
copying it. verify-ship gains the check that matches: a hashed asset
named by index.html but missing from dist is a blank page that no test
sees, because the tests run against the source tree."
```

---

### Task 2: Port `lib/` to TypeScript

Ten DOM-free modules move to the app tree and gain real types. `lib.test.ts` is the gate: its assertions do not change, only its import paths.

**Files:**
- Create: `engine/src/web/app/lib/{i18n,local,api,fmt,keys,plandoc,router,selection,stories,notifications}.ts`
- Modify: `engine/tests/web/lib.test.ts` (import paths only)

**Interfaces:**
- Consumes: `Snapshot`, `PlanView`, `StoryView`, `Job` from `../../protocol.js` (unchanged, imported with `import type`).
- Produces: every export below. Later tasks import these exact names.

| Module | Exports to preserve |
| --- | --- |
| `i18n.ts` | `installLocales`, `locale`, `direction`, `localeEpoch`, `pickLocale`, `loadFallback`, `setLocale`, `known`, `t`, `tn`, `pluralKey`, `parts`, `installForTest`; types `LocaleMeta`, `LocaleRegistry`, `Params`, `LocaleIO` |
| `local.ts` | `installStorage`, `read`, `write`; types `Prefs`, `OpenStory` |
| `api.ts` | `installToken`, `get`, `feed`; type `Feed<T>` |
| `fmt.ts` | `time`, `stamp`, `duration` |
| `keys.ts` | `jobKey`, `planKey`, `storyKey`, `runKey` |
| `plandoc.ts` | `subscribe`, `mountPlanDoc`, `value` |
| `router.ts` | `routeFrom`, `startRouter` |
| `selection.ts` | `activePlan`, `setActivePlan`, `storyFilter`, `setStoryFilter`, `openStories`, `activeStory`, `openStory`, `closeStory`, `pinStory`, `reopenStory`, `recentlyClosed` |
| `stories.ts` | `FILTERS`, `DEP`, `SKILL`, `unmet`, `dependents`, `statusIndex`, `planIndex`, `planStatus`, `readyIn`, `ready`, `tally`, `planProgress`, `depTree`, `draftedAgents`, `routableAgents`, `relevantAcceptances`, `acceptancesFor`, `skillWarnings`, `sift` |
| `notifications.ts` | `deriveEvents` |

- [ ] **Step 1: Copy the ten modules and rename them**

```bash
mkdir -p src/web/app/lib
for f in i18n local api fmt keys plandoc router selection stories notifications; do
  cp src/web/public/lib/$f.js src/web/app/lib/$f.ts
done
```

Copied rather than moved — the old page still imports `public/lib/`.

- [ ] **Step 2: Convert each file, mechanically**

The conversion is the same four moves in every file, and nothing else. **No behaviour changes, no renames, no "while I'm here" cleanups** — this task's whole value is that `lib.test.ts` still passes unmodified.

1. `/** @typedef {A} B */` → `export interface B { … }` or `export type B = A`.
2. `/** @type {T} */ (expr)` cast → `expr as T`.
3. `/** @param {T} name */` on a function → `name: T` in the signature; `@returns {T}` → `: T`.
4. `import('../../protocol.js').Snapshot` → a top-of-file `import type { Snapshot } from '../../protocol.js'`.

Keep every explanatory comment. They record failures that already happened — `renderParam`'s note about `P001-S02` under `Intl.NumberFormat('ar')`, `local.ts`'s note about why `fields()` is written out longhand, `api.ts`'s generation counter. Deleting them re-opens those bugs for the next reader.

Two files need one judgement call each:

- **`i18n.ts`**: `installForTest` stays exported. It is the seam every component test uses to get real strings without a network fetch.
- **`api.ts`**: `get()` returns `{ ok: true, body: any }`. Keep `any` — it is deliberate, and each caller narrows. Do not widen it to `unknown`; that breaks every caller and is the second plan's business if it is anyone's.

- [ ] **Step 3: Point the test at the new modules**

In `engine/tests/web/lib.test.ts`, change every import specifier from `../../src/web/public/lib/<name>.js` to `../../src/web/app/lib/<name>.ts`. Change nothing else in the file — not a describe, not an assertion.

- [ ] **Step 4: Run the ported tests**

Run: `npx vitest run tests/web/lib.test.ts`
Expected: PASS, with the same test count as before the port. If a test needs editing to pass, the port changed behaviour — revert that file and redo it.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: silent. `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are all on, and these modules were already written against them through `checkJs` — so real errors here are conversion mistakes, not pre-existing debt.

- [ ] **Step 6: Commit**

```bash
git add engine/src/web/app/lib engine/tests/web/lib.test.ts
git commit -m "refactor(web): port the DOM-free lib to typescript

Same behaviour, same exports, same tests — lib.test.ts changes only its
import paths. The JSDoc these modules carried was already checked under
checkJs, so this is a transcription, not a rewrite."
```

---

### Task 3: The session store

One module owns the socket, the snapshot, and the write door. Output frames deliberately do not pass through reactivity.

**Files:**
- Create: `engine/src/web/app/stores/session.ts`
- Create: `engine/tests/web/store.test.ts`

**Interfaces:**
- Consumes: `Snapshot`, `ServerMessage`, `ClientMessage`, `Message` from `../../protocol.js`; `Write` from `../../writes.js`.
- Produces:
  - `snapshot: Readonly<ShallowRef<Snapshot | null>>`
  - `online: Readonly<Ref<boolean>>`
  - `connect(ports: { token: string, socketFactory?: (url: string) => WebSocketLike }): void`
  - `send(message: ClientMessage): void`
  - `submit(write: Write, options?: { undo?: Write, settled?: (receipt: Receipt) => void }): void`
  - `onOutput(fn: (frame: OutputFrame) => void): () => void`
  - `onNotice(fn: (message: Message) => void): () => void`
  - `activeJob: ComputedRef<string | null>`
  - types `Receipt = { id: string, ok: boolean, code: Message['code'] }`, `OutputFrame = { kind: 'append' | 'replace', jobId: string, data: string }`, `WebSocketLike`

- [ ] **Step 1: Write the failing test**

Create `engine/tests/web/store.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerMessage } from '../../src/web/protocol.js'
import { emptySnapshot } from './helpers/page.js'

/**
 * A socket the test drives by hand. The store must never construct a real one
 * in a test environment, which is why `connect` takes a factory.
 */
class FakeSocket {
  static last: FakeSocket | null = null
  sent: string[] = []
  readyState = 1
  listeners = new Map<string, (event: any) => void>()
  constructor(public url: string) {
    FakeSocket.last = this
  }
  addEventListener(type: string, fn: (event: any) => void) {
    this.listeners.set(type, fn)
  }
  send(data: string) {
    this.sent.push(data)
  }
  emit(type: string, event?: any) {
    this.listeners.get(type)?.(event)
  }
  deliver(message: ServerMessage) {
    this.emit('message', { data: JSON.stringify(message) })
  }
}

let store: typeof import('../../src/web/app/stores/session.ts')

beforeEach(async () => {
  vi.resetModules()
  store = await import('../../src/web/app/stores/session.ts')
  store.connect({ token: 'tok', socketFactory: (url) => new FakeSocket(url) as any })
})

describe('the connection', () => {
  it('carries the token in the url', () => {
    expect(FakeSocket.last?.url).toContain('t=tok')
  })

  it('reports online only while open', () => {
    expect(store.online.value).toBe(false)
    FakeSocket.last?.emit('open')
    expect(store.online.value).toBe(true)
    FakeSocket.last?.emit('close')
    expect(store.online.value).toBe(false)
  })
})

describe('snapshots', () => {
  it('replaces the held snapshot wholesale', () => {
    FakeSocket.last?.deliver({ type: 'snapshot', snapshot: emptySnapshot({ project: '/a' }) })
    expect(store.snapshot.value?.project).toBe('/a')
    FakeSocket.last?.deliver({ type: 'snapshot', snapshot: emptySnapshot({ project: '/b' }) })
    expect(store.snapshot.value?.project).toBe('/b')
  })

  it('is not deeply reactive', () => {
    const snap = emptySnapshot()
    FakeSocket.last?.deliver({ type: 'snapshot', snapshot: snap })
    // shallowRef, so what comes back is the very object the socket delivered —
    // no proxy walked over plans[].stories[] and queue[] 1.25 times a second.
    expect(store.snapshot.value).toBe(snap)
  })

  it('ignores a frame that is not json', () => {
    FakeSocket.last?.emit('message', { data: 'not json' })
    expect(store.snapshot.value).toBe(null)
  })
})

describe('output', () => {
  it('reaches subscribers without touching the snapshot', () => {
    const frames: unknown[] = []
    store.onOutput((frame) => frames.push(frame))
    FakeSocket.last?.deliver({ type: 'output', jobId: 'j1', data: 'hello' })
    FakeSocket.last?.deliver({ type: 'transcript', jobId: 'j1', data: 'all of it' })
    expect(frames).toEqual([
      { kind: 'append', jobId: 'j1', data: 'hello' },
      { kind: 'replace', jobId: 'j1', data: 'all of it' },
    ])
    expect(store.snapshot.value).toBe(null)
  })

  it('stops delivering after unsubscribe', () => {
    const frames: unknown[] = []
    const off = store.onOutput((frame) => frames.push(frame))
    off()
    FakeSocket.last?.deliver({ type: 'output', jobId: 'j1', data: 'x' })
    expect(frames).toEqual([])
  })
})

describe('writes', () => {
  it('sends a correlated write frame', () => {
    store.submit({ kind: 'halt', run: 'run-1', reason: 'because' })
    const frame = JSON.parse(FakeSocket.last?.sent[0] ?? '{}')
    expect(frame.type).toBe('write')
    expect(frame.id).toMatch(/^w\d+$/)
    expect(frame.write).toEqual({ kind: 'halt', run: 'run-1', reason: 'because' })
  })

  it('settles the matching receipt exactly once', () => {
    const settled = vi.fn()
    store.submit({ kind: 'halt', run: 'run-1', reason: 'r' }, { settled })
    const id = JSON.parse(FakeSocket.last?.sent[0] ?? '{}').id
    FakeSocket.last?.deliver({ type: 'receipt', id, ok: true, code: 'write.ok.halt' })
    FakeSocket.last?.deliver({ type: 'receipt', id, ok: true, code: 'write.ok.halt' })
    expect(settled).toHaveBeenCalledTimes(1)
  })

  it('offers the inverse write only when one was given and the write landed', () => {
    const notices: unknown[] = []
    store.onNotice((message) => notices.push(message))
    store.submit({ kind: 'gate', run: 'r', open: true }, { undo: { kind: 'gate', run: 'r', open: false } })
    const id = JSON.parse(FakeSocket.last?.sent[0] ?? '{}').id
    FakeSocket.last?.deliver({ type: 'receipt', id, ok: false, code: 'write.stale' })
    // A refusal is announced, but there is nothing to undo: it did not happen.
    expect(notices).toEqual([{ code: 'write.stale' }])
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/web/store.test.ts`
Expected: FAIL — cannot resolve `../../src/web/app/stores/session.ts`

- [ ] **Step 3: Write the store**

Create `engine/src/web/app/stores/session.ts`:

```ts
/**
 * The one connection, the one snapshot, and the one write door.
 *
 * No Pinia: the state is a single object the server pushes whole, and a module
 * holding refs is the smallest thing that models that honestly.
 */
import { computed, readonly, ref, shallowRef } from 'vue'
import type { ClientMessage, Message, ServerMessage, Snapshot } from '../../protocol.js'
import type { Write } from '../../writes.js'

export type Receipt = { id: string; ok: boolean; code: Message['code'] }
export type OutputFrame = { kind: 'append' | 'replace'; jobId: string; data: string }

/** The slice of `WebSocket` this module uses, so a test can hand it a fake. */
export interface WebSocketLike {
  readyState: number
  send: (data: string) => void
  addEventListener: (type: string, fn: (event: any) => void) => void
}

const RETRY_MS = 1000

/**
 * `shallowRef`, and this is the migration's load-bearing performance decision.
 *
 * The server replaces this object up to 1.25 times a second. A deep proxy would
 * walk `plans[].stories[]` and `queue[]` on every broadcast to watch for
 * mutations that never come — nothing on this page writes to a snapshot field.
 * Atomic replacement is exactly what `shallowRef` means.
 */
const held = shallowRef<Snapshot | null>(null)
const connected = ref(false)

export const snapshot = readonly(held) as Readonly<typeof held>
export const online = readonly(connected)
export const activeJob = computed(() => held.value?.session.jobId ?? null)

const outputSubscribers = new Set<(frame: OutputFrame) => void>()
const noticeSubscribers = new Set<(message: Message) => void>()

let socket: WebSocketLike | null = null
let token = ''
let factory: (url: string) => WebSocketLike = (url) => new WebSocket(url)

export function connect(ports: { token: string; socketFactory?: (url: string) => WebSocketLike }): void {
  token = ports.token
  if (ports.socketFactory !== undefined) factory = ports.socketFactory
  open()
}

function open(): void {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  const next = factory(`${scheme}://${location.host}/?t=${encodeURIComponent(token)}`)
  socket = next

  next.addEventListener('open', () => (connected.value = true))
  next.addEventListener('message', (event: { data: unknown }) => receive(String(event.data)))
  next.addEventListener('close', () => {
    connected.value = false
    // Silent and automatic. The usual cause is the server restarting under a
    // rebuild, and the page recovers on its own.
    setTimeout(open, RETRY_MS)
  })
}

function receive(raw: string): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Nothing on this socket but our own server. A frame that is not JSON is
    // not a case to recover from, it is a case to ignore.
    return
  }
  if (typeof parsed !== 'object' || parsed === null) return
  const message = parsed as ServerMessage
  if (message.type === 'snapshot') held.value = message.snapshot
  else if (message.type === 'output') emit({ kind: 'append', jobId: message.jobId, data: message.data })
  else if (message.type === 'transcript') emit({ kind: 'replace', jobId: message.jobId, data: message.data })
  else if (message.type === 'notice') for (const fn of noticeSubscribers) fn(message.message)
  else if (message.type === 'receipt') settle(message)
}

/**
 * Output never becomes reactive state.
 *
 * A running agent emits thousands of lines a second. Routed through a ref, each
 * one would schedule a render of a component whose only job is to hand the
 * bytes to xterm, which keeps its own buffer anyway.
 */
function emit(frame: OutputFrame): void {
  for (const fn of outputSubscribers) fn(frame)
}

export function onOutput(fn: (frame: OutputFrame) => void): () => void {
  outputSubscribers.add(fn)
  return () => void outputSubscribers.delete(fn)
}

export function onNotice(fn: (message: Message) => void): () => void {
  noticeSubscribers.add(fn)
  return () => void noticeSubscribers.delete(fn)
}

export function send(message: ClientMessage): void {
  if (socket !== null && socket.readyState === 1) socket.send(JSON.stringify(message))
}

/** Pending writes by correlation id, so a receipt knows what it answers. */
const pending = new Map<string, { undo?: Write; settled?: (receipt: Receipt) => void }>()
let counter = 0

/**
 * Every write carries what was on record when the button was pressed, and the
 * server evaluates that inside the lock the op already takes. So: no optimistic
 * render, no rollback, no confirmation dialog on anything reversible — a stale
 * click is refused rather than obeyed. The snapshot broadcast goes out before
 * the receipt, so by the time one arrives the page already shows the result.
 */
export function submit(write: Write, options: { undo?: Write; settled?: (receipt: Receipt) => void } = {}): void {
  const id = `w${++counter}`
  pending.set(id, options)
  send({ type: 'write', id, write })
}

function settle(receipt: Receipt): void {
  const heldWrite = pending.get(receipt.id)
  if (heldWrite === undefined) return
  pending.delete(receipt.id)
  heldWrite.settled?.(receipt)
  for (const fn of noticeSubscribers) fn({ code: receipt.code })
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/web/store.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add engine/src/web/app/stores engine/tests/web/store.test.ts
git commit -m "feat(web): the session store

One socket, one snapshot in a shallowRef, one write door. Output frames
route around reactivity entirely: a running agent emits thousands of
lines a second and xterm keeps its own buffer."
```

Note for Task 7: `settle` currently announces every receipt through `onNotice` and ignores `undo`. The undo offer needs the toast layer, which does not exist yet; Task 7 completes it and the third write test above is extended there.

---

### Task 4: The i18n composable

Makes `locale` reactive so that changing language repaints the page by itself — deleting `translateStatic`, the ~200 `data-i18n` attributes, and the manual `draw()` that follows a locale change today.

**Files:**
- Create: `engine/src/web/app/composables/useI18n.ts`
- Create: `engine/src/web/app/components/Bdi.vue`
- Create: `engine/tests/web/i18n-composable.test.ts`

**Interfaces:**
- Consumes: `t`, `tn`, `known`, `parts`, `setLocale`, `locale`, `direction`, `pickLocale`, `loadFallback`, `installLocales` from `../lib/i18n.ts`; `read`, `write` from `../lib/local.ts`.
- Produces: `useI18n(): { t, tn, known, locale, direction }` where `t(key: string, params?: Params): string`; `bootLocales(token: string): Promise<void>`; `applyLocale(code: string): Promise<void>`; `LOCALES`, `FALLBACK`; component `Bdi` with prop `value: string`.

- [ ] **Step 1: Write the failing test**

Create `engine/tests/web/i18n-composable.test.ts`:

```ts
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { installForTest } from '../../src/web/app/lib/i18n.ts'
import { applyLocale, useI18n } from '../../src/web/app/composables/useI18n.ts'
import Bdi from '../../src/web/app/components/Bdi.vue'

const Probe = defineComponent({
  setup() {
    const { t, direction } = useI18n()
    return { t, direction }
  },
  template: `<p :dir="direction">{{ t('rail.track') }}</p>`,
})

beforeEach(() => {
  installForTest({ code: 'en', strings: { 'rail.track': 'Track' }, fallback: { 'rail.track': 'Track' } })
})

describe('useI18n', () => {
  it('renders the string for the current locale', () => {
    expect(mount(Probe).text()).toBe('Track')
  })

  it('repaints every subscriber when the locale changes', async () => {
    const probe = mount(Probe)
    installForTest({ code: 'ar', strings: { 'rail.track': 'المسار' } })
    await applyLocale('ar')
    // No snapshot field moved. Under the old page this needed translateStatic()
    // plus a manual draw(); here the ref does it.
    expect(probe.text()).toBe('المسار')
    expect(probe.get('p').attributes('dir')).toBe('rtl')
  })
})

describe('Bdi', () => {
  it('isolates an identifier and pins it left-to-right', () => {
    const wrapper = mount(Bdi, { props: { value: 'P001-S02' } })
    // Intl would render this P٠٠١-S٠٢ in Arabic, and an unisolated Latin run
    // inside an Arabic sentence drags the punctuation around it.
    expect(wrapper.element.tagName).toBe('BDI')
    expect(wrapper.attributes('dir')).toBe('ltr')
    expect(wrapper.text()).toBe('P001-S02')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/web/i18n-composable.test.ts`
Expected: FAIL — cannot resolve `composables/useI18n.ts`

- [ ] **Step 3: Write the composable**

Create `engine/src/web/app/composables/useI18n.ts`:

```ts
/**
 * The reactive skin over `lib/i18n.ts`.
 *
 * The module underneath stays exactly as it was — plural categories, per-key
 * fallback, the bidi split. All this adds is an epoch ref that every `t()` call
 * reads, so a locale change invalidates every render that used a string. The
 * old page had to walk the document and repaint by hand.
 */
import { computed, ref } from 'vue'
import {
  direction as currentDirection,
  installLocales,
  known as knownKey,
  loadFallback,
  locale as currentLocale,
  pickLocale,
  setLocale,
  t as translate,
  tn as translatePlural,
  type LocaleRegistry,
  type Params,
} from '../lib/i18n.js'
import { read as prefs, write as remember } from '../lib/local.js'

/**
 * Adding a language: drop `locales/<code>.json` beside the others, add a line.
 *
 * Kept as a literal with two-space keys and a closing brace at column 0,
 * because `locales.test.ts` reads it as source text — a locale file nobody
 * registered is a translation the user cannot pick.
 */
export const LOCALES: LocaleRegistry = {
  en: { name: 'English', dir: 'ltr' },
  ar: { name: 'العربية', dir: 'rtl' },
}
export const FALLBACK = 'en'

/** Bumped on every locale change; every reactive read below depends on it. */
const epoch = ref(0)

export function useI18n() {
  return {
    t: (key: string, params?: Params) => (epoch.value, translate(key, params)),
    tn: (stem: string, count: number, params?: Params) => (epoch.value, translatePlural(stem, count, params)),
    known: (key: string) => (epoch.value, knownKey(key)),
    locale: computed(() => (epoch.value, currentLocale())),
    direction: computed(() => (epoch.value, currentDirection())),
  }
}

/** Wire the loader. Called once, from `main.ts`, before the app mounts. */
export function bootLocales(token: string): void {
  installLocales(LOCALES, FALLBACK, {
    load: async (code) => {
      const response = await fetch(`locales/${code}.json?t=${encodeURIComponent(token)}`, { cache: 'no-store' })
      if (!response.ok) throw new Error(String(response.status))
      return response.json()
    },
    saved: () => prefs().lang,
    save: (code) => void remember({ lang: code }),
    preferred: () => navigator.languages ?? [],
    forced: () => new URLSearchParams(location.search).get('lang'),
  })
}

export async function applyLocale(code: string): Promise<void> {
  await setLocale(code)
  document.documentElement.lang = currentLocale()
  document.documentElement.dir = currentDirection()
  epoch.value += 1
}

/** The opening locale: `?lang=`, then the remembered choice, then the browser. */
export async function startLocale(): Promise<void> {
  await loadFallback()
  await applyLocale(pickLocale())
}
```

The `(epoch.value, translate(...))` comma expression is deliberate and must not be "simplified": reading `epoch.value` is what registers the dependency, and `translate` is a plain function Vue cannot see into.

- [ ] **Step 4: Write `Bdi.vue`**

```vue
<script setup lang="ts">
/**
 * An identifier, isolated from the sentence around it.
 *
 * Story ids, run ids, paths and commands go through here and never through a
 * `{n}` param: `Intl.NumberFormat('ar')` renders Arabic-Indic digits, so
 * `P001-S02` would become `P٠٠١-S٠٢`. The `dir` pin is the other half — an
 * unisolated Latin run inside an Arabic sentence drags the punctuation next to
 * it to the wrong end of the line.
 */
defineProps<{ value: string }>()
</script>

<template>
  <bdi dir="ltr">{{ value }}</bdi>
</template>
```

- [ ] **Step 5: Guard the new locale registry**

`locales.test.ts:291` reads the `LOCALES` literal out of `src/web/public/app.js`. It keeps passing during this plan — `public/` is untouched — but it now guards a file the new page does not use, and a locale file nobody registered is a translation the reader cannot pick. Close the gap here rather than in the second plan. Append to `engine/tests/web/i18n-composable.test.ts`:

```ts
import fs from 'node:fs/promises'
import path from 'node:path'

describe('the locale registry', () => {
  it('registers exactly the locale files that ship', async () => {
    const dir = path.resolve(process.cwd(), 'src', 'web', 'app', 'locales')
    const shipped = (await fs.readdir(dir)).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5))
    const { LOCALES } = await import('../../src/web/app/composables/useI18n.ts')
    expect(Object.keys(LOCALES).sort()).toEqual(shipped.sort())
  })
})
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/web/i18n-composable.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 7: Commit**

```bash
git add engine/src/web/app/composables engine/src/web/app/components/Bdi.vue engine/tests/web/i18n-composable.test.ts
git commit -m "feat(web): reactive i18n

lib/i18n keeps every rule it had; this only adds the epoch ref that makes
a locale change repaint by itself. translateStatic and the data-i18n
sweep over the document go away with the old page."
```

---

### Task 5: The application shell

Header, banners, rail, tabs and routing. After this task the built page shows live state for the first time.

**Files:**
- Create: `engine/src/web/app/App.vue` (replaces the Task 1 placeholder)
- Create: `engine/src/web/app/components/Rail.vue`
- Create: `engine/src/web/app/components/Banners.vue`
- Create: `engine/src/web/app/components/LanguagePicker.vue`
- Create: `engine/src/web/app/composables/useTabs.ts`
- Create: `engine/src/web/app/styles/index.css`
- Create: `engine/tests/web/shell.test.ts`
- Modify: `engine/src/web/app/main.ts`

**Interfaces:**
- Consumes: `snapshot`, `online`, `connect`, `send` from `../stores/session.ts`; `useI18n`, `startLocale`, `bootLocales`, `LOCALES`, `applyLocale`; `installToken` from `../lib/api.ts`; `installStorage` from `../lib/local.ts`; `routeFrom`, `startRouter` from `../lib/router.ts`; `ready` from `../lib/stories.ts`.
- Produces: `useTabs(): { tabs: readonly TabId[], active: Ref<TabId>, show(id: TabId): void }` with `type TabId = 'run' | 'plans' | 'stories' | 'features' | 'skills' | 'evidence' | 'memory' | 'config'`.

- [ ] **Step 1: Write the failing test**

Create `engine/tests/web/shell.test.ts`:

```ts
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { installForTest } from '../../src/web/app/lib/i18n.ts'
import Rail from '../../src/web/app/components/Rail.vue'
import Banners from '../../src/web/app/components/Banners.vue'
import { emptySnapshot, readLocale } from './helpers/page.js'

const english = await readLocale('en')

beforeEach(() => {
  installForTest({ code: 'en', strings: english })
})

describe('Rail', () => {
  it('shows the run detail only once a run is open', () => {
    const idle = mount(Rail, { props: { snapshot: emptySnapshot({ state: { ...emptySnapshot().state, run_id: null } }) } })
    expect(idle.find('.rail-detail').exists()).toBe(false)

    const running = emptySnapshot()
    running.state = { ...running.state, status: 'running', run_id: 'run-1', track: 'build', cycle: 2 }
    const live = mount(Rail, { props: { snapshot: running } })
    expect(live.find('.rail-detail').exists()).toBe(true)
    expect(live.text()).toContain('build')
  })

  it('renders the run id verbatim, never through Intl', () => {
    const running = emptySnapshot()
    running.state = { ...running.state, status: 'running', run_id: '20260803-1' }
    const live = mount(Rail, { props: { snapshot: running } })
    // An id inside a translated sentence must be a <bdi dir=ltr>, or Arabic
    // renders it with Arabic-Indic digits and reorders the hyphen.
    expect(live.find('bdi[dir="ltr"]').text()).toContain('20260803-1')
  })

  it('shows the strike counter only when strikes have been taken', () => {
    const clean = mount(Rail, { props: { snapshot: emptySnapshot({ guards: { strikes: 0, strikesAllowed: 3, cycleErrors: [], errorArmed: null } }) } })
    expect(clean.find('[data-test="strikes"]').exists()).toBe(false)
    const struck = mount(Rail, { props: { snapshot: emptySnapshot({ guards: { strikes: 2, strikesAllowed: 3, cycleErrors: [], errorArmed: null } }) } })
    expect(struck.find('[data-test="strikes"]').text()).toContain('2')
  })
})

describe('Banners', () => {
  it('says the page is offline when the socket is down', () => {
    const wrapper = mount(Banners, { props: { snapshot: emptySnapshot(), online: false } })
    expect(wrapper.find('.banner.offline').exists()).toBe(true)
  })

  it('says nothing when everything is fine', () => {
    const wrapper = mount(Banners, { props: { snapshot: emptySnapshot(), online: true } })
    expect(wrapper.findAll('.banner')).toHaveLength(0)
  })

  it('warns when the project has no design system', () => {
    const snap = emptySnapshot()
    snap.state = { ...snap.state, design_system: false }
    const wrapper = mount(Banners, { props: { snapshot: snap, online: true } })
    expect(wrapper.find('.banner.note').exists()).toBe(true)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/web/shell.test.ts`
Expected: FAIL — cannot resolve `components/Rail.vue`

- [ ] **Step 3: Write `useTabs.ts`**

```ts
/**
 * Which tab is open, kept in the hash so a tab is a link somebody can send.
 *
 * `lib/router.ts` owns the parsing; this owns the reactive cell it writes into.
 */
import { ref, type Ref } from 'vue'
import { routeFrom, startRouter } from '../lib/router.js'

export type TabId = 'run' | 'plans' | 'stories' | 'features' | 'skills' | 'evidence' | 'memory' | 'config'

export const TABS: readonly TabId[] = ['run', 'plans', 'stories', 'features', 'skills', 'evidence', 'memory', 'config']

const active = ref<TabId>('run') as Ref<TabId>

export function useTabs() {
  return { tabs: TABS, active, show: (id: TabId) => void (location.hash = `#${id}`) }
}

/** Called once from `App.vue`'s setup. */
export function startTabs(): void {
  startRouter(
    {
      hash: () => location.hash,
      setHash: (hash) => void (location.hash = hash),
      onChange: (fn) => addEventListener('hashchange', fn),
    },
    [...TABS],
    'run',
    (id) => (active.value = id as TabId),
  )
}
```

If `lib/router.ts`'s `startRouter` signature differs from the four arguments above, use the signature the ported module actually has — read it, do not adapt the module to this call.

- [ ] **Step 4: Write `Rail.vue`**

```vue
<script setup lang="ts">
/**
 * The one line that says what the loop is doing, on screen in every tab.
 *
 * Nothing here is a sentence: every label is a key, and every value that is an
 * identifier goes through `Bdi`.
 */
import { computed } from 'vue'
import type { Snapshot } from '../../protocol.js'
import { useI18n } from '../composables/useI18n.js'
import Bdi from './Bdi.vue'

const props = defineProps<{ snapshot: Snapshot }>()
const { t } = useI18n()

const state = computed(() => props.snapshot.state)
const open = computed(() => state.value.run_id !== null)
const strikes = computed(() => props.snapshot.guards?.strikes ?? 0)
const findings = computed(() => state.value.findings)
</script>

<template>
  <div class="rail">
    <span class="pill" :class="`status-${state.status}`">{{ t(`status.${state.status}`) }}</span>
    <span v-if="open" class="rail-detail">
      <span class="bit">
        <span class="k">{{ t('rail.track') }}</span>
        <span class="v"><Bdi :value="state.track ?? ''" /></span>
      </span>
      <span class="bit">
        <span class="k">{{ t('rail.cycle') }}</span>
        <span class="v">{{ t('rail.cycleOf', { n: state.cycle, max: state.max_cycles ?? 0 }) }}</span>
      </span>
      <span class="bit">
        <span class="k">{{ t('rail.stage') }}</span>
        <span class="v">{{ t(`stage.${state.stage}`) }}</span>
      </span>
      <span class="bit"><Bdi :value="state.run_id ?? ''" /></span>
      <span v-if="findings.high > 0" class="bit warnish">{{ t('rail.findingsHigh', { n: findings.high }) }}</span>
      <span v-if="strikes > 0" class="bit warnish" data-test="strikes">
        <span class="k">{{ t('rail.strikes') }}</span>
        <span class="v">{{ t('rail.strikesOf', { n: strikes, max: snapshot.guards?.strikesAllowed ?? 0 }) }}</span>
      </span>
    </span>
  </div>
</template>
```

Before writing this, open `src/web/public/ui/rail.js` and `src/web/public/locales/en.json` and use the **keys that already exist** — `rail.cycleOf`, `status.*`, `stage.*` above are the shapes the old rail uses, but confirm each one. A key invented here ships as its own dotted name on screen, and `locales.test.ts` will fail the build for it.

- [ ] **Step 5: Write `Banners.vue`**

```vue
<script setup lang="ts">
/**
 * Page-level outages, above everything and never inside a list.
 *
 * `config_error` is a total outage and must not read at the weight of a normal
 * row — that is why these live in the header rather than in the panel whose
 * data went missing.
 */
import { computed } from 'vue'
import type { Snapshot } from '../../protocol.js'
import { useI18n } from '../composables/useI18n.js'

const props = defineProps<{ snapshot: Snapshot; online: boolean }>()
const { t } = useI18n()

const stale = computed(() => props.snapshot.state.recovered)
const noDesignSystem = computed(() => !props.snapshot.state.design_system)
</script>

<template>
  <div class="banners" role="status" aria-live="polite">
    <p v-if="!online" class="banner offline">{{ t('app.disconnected') }}</p>
    <p v-if="stale" class="banner warn">{{ t('banner.stale') }}</p>
    <p v-if="noDesignSystem" class="banner note">{{ t('banner.designSystem') }}</p>
  </div>
</template>
```

The `configBanner` and `stalledBanner` from the old header are **not** here: the first needs the config panel's error feed (second plan, Task for `Config`) and the second needs the nudge action (Task 7). Leaving them out now is deliberate, not forgotten.

- [ ] **Step 6: Write `LanguagePicker.vue`**

```vue
<script setup lang="ts">
import { LOCALES, applyLocale, useI18n } from '../composables/useI18n.js'

const { t, locale } = useI18n()
</script>

<template>
  <label class="lang">
    <span>{{ t('lang.label') }}</span>
    <select name="lang" :value="locale" @change="applyLocale(($event.target as HTMLSelectElement).value)">
      <option v-for="(meta, code) in LOCALES" :key="code" :value="code">{{ meta.name }}</option>
    </select>
  </label>
</template>
```

- [ ] **Step 7: Write `App.vue`**

```vue
<script setup lang="ts">
import { computed } from 'vue'
import { online, snapshot } from './stores/session.js'
import { useI18n } from './composables/useI18n.js'
import { startTabs, useTabs } from './composables/useTabs.js'
import { ready } from './lib/stories.js'
import Banners from './components/Banners.vue'
import Bdi from './components/Bdi.vue'
import LanguagePicker from './components/LanguagePicker.vue'
import Rail from './components/Rail.vue'

const { t, tn } = useI18n()
const { tabs, active, show } = useTabs()
startTabs()

/**
 * The two navigation counts.
 *
 * Computed here rather than inside a panel: a count that lives in a panel stops
 * updating the moment that panel's tab is closed, which is most of the time.
 */
const readyCount = computed(() => (snapshot.value === null ? 0 : ready(snapshot.value.plans).length))
const highCount = computed(() => snapshot.value?.state.findings.high ?? 0)
</script>

<template>
  <header class="top">
    <div class="brand">
      <h1>{{ t('app.title') }}</h1>
      <span class="project"><Bdi :value="snapshot?.project ?? ''" /></span>
      <LanguagePicker />
    </div>
    <Banners v-if="snapshot !== null" :snapshot="snapshot" :online="online" />
    <Rail v-if="snapshot !== null" :snapshot="snapshot" />
  </header>

  <nav class="tabs" :aria-label="t('tabs.label')">
    <a
      v-for="id in tabs"
      :key="id"
      :href="`#${id}`"
      :aria-current="active === id ? 'page' : undefined"
      :title="id === 'stories' && readyCount > 0 ? tn('tabs.readyCount', readyCount) : id === 'run' && highCount > 0 ? tn('tabs.highCount', highCount) : undefined"
      @click.prevent="show(id)"
    >
      {{ t(`tabs.${id}`) }}
      <span v-if="id === 'stories' && readyCount > 0" class="badge" aria-hidden="true">{{ readyCount }}</span>
      <span v-if="id === 'run' && highCount > 0" class="badge" aria-hidden="true">{{ highCount }}</span>
    </a>
  </nav>

  <!-- Panels arrive in the second plan; the shell must build and ship first. -->
  <main class="panel"></main>
</template>
```

The badge digits are `aria-hidden` and the sentence goes on the anchor's `title`: a bare number announced after a view's name is a riddle, and the view already has a good accessible name. The plural goes through `tn`, because Arabic has six categories and a flat key would ship the English singular for all of them.

- [ ] **Step 8: Write `styles/index.css` and rewrite `main.ts`**

`engine/src/web/app/styles/index.css` — one entry, because `cssCodeSplit` is off:

```css
/* The six stylesheets carry across unchanged; only their entry point moved. */
@import './app.css';
@import './10-layout.css';
@import './20-rail.css';
@import './30-tabs.css';
@import './40-terminal.css';
@import './50-controls.css';
@import './60-panels.css';
```

Copy the seven files themselves:

```bash
mkdir -p src/web/app/styles
cp src/web/public/app.css src/web/app/styles/app.css
cp src/web/public/css/*.css src/web/app/styles/
```

`engine/src/web/app/main.ts`:

```ts
import { createApp } from 'vue'
import App from './App.vue'
import './styles/index.css'
import { installToken } from './lib/api.js'
import { installStorage } from './lib/local.js'
import { bootLocales, startLocale } from './composables/useI18n.js'
import { connect } from './stores/session.js'

const token = new URLSearchParams(location.search).get('t') ?? ''

installStorage(localStorage)
installToken(token)
bootLocales(token)
// Awaited before mount so the first paint is already in the reader's language
// rather than a flash of English.
await startLocale()
connect({ token })

createApp(App).mount('#app')
```

- [ ] **Step 9: Run everything**

```bash
npx vitest run tests/web/shell.test.ts
npm run typecheck
npm run build
node scripts/verify-ship.mjs
```

Expected: 6 shell tests pass; typecheck silent; build and ship checks green.

- [ ] **Step 10: Look at it**

```bash
node dist/web/cli.js
```

Open the printed URL. Expected: the header, the project path, the language picker, the rail reflecting real state, and eight tab links that change the hash. The main area is empty — the panels are the second plan. Switch the language to العربية and confirm the whole header flips to RTL with no reload.

- [ ] **Step 11: Commit**

```bash
git add engine/src/web/app engine/tests/web/shell.test.ts engine/dist
git commit -m "feat(web): the vue shell — header, banners, rail, tabs

First live state on the new page. The nav counts are computed in App
rather than in a panel, which is what the old page needed those
register-against-.tabs comments for; a computed has no hidden node to
be skipped over."
```

---

### Task 6: Terminal and the bottom pane

The non-reactive island, alone. xterm mounts once and is never re-rendered.

**Files:**
- Create: `engine/src/web/app/components/Terminal.vue`
- Create: `engine/src/web/app/composables/usePane.ts`
- Create: `engine/tests/web/terminal.test.ts`
- Modify: `engine/src/web/app/App.vue` (mount the pane)

**Interfaces:**
- Consumes: `onOutput`, `send`, `activeJob`, `snapshot` from `../stores/session.ts`; `read`, `write` from `../lib/local.ts`.
- Produces: `usePane(): { mode: Ref<PaneMode>, view: Ref<'session' | 'queue'>, set(mode: PaneMode): void, cycle(): void, follow(): void, reveal(): void, setView(v): void }`, `type PaneMode = 'collapsed' | 'docked' | 'full'`; `Terminal.vue` with no props.

- [ ] **Step 1: Write the failing test**

Create `engine/tests/web/terminal.test.ts`:

```ts
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

/**
 * xterm is a global from `vendor/`, not an import, so the test installs a
 * recording double in its place — the same shape `page-globals.d.ts` declares.
 */
const written: string[] = []
let resets = 0

beforeEach(() => {
  written.length = 0
  resets = 0
  vi.resetModules()
  ;(globalThis as any).Terminal = class {
    cols = 80
    rows = 24
    loadAddon() {}
    open() {}
    onData() {}
    write(data: string) {
      written.push(data)
    }
    reset() {
      resets += 1
    }
  }
  ;(globalThis as any).FitAddon = { FitAddon: class { fit() {} } }
  ;(globalThis as any).ResizeObserver = class {
    observe() {}
    disconnect() {}
  }
})

describe('Terminal', () => {
  it('writes an append frame straight through', async () => {
    const store = await import('../../src/web/app/stores/session.ts')
    const Terminal = (await import('../../src/web/app/components/Terminal.vue')).default
    mount(Terminal)
    store.__emitForTest({ kind: 'append', jobId: 'j1', data: 'hello' })
    expect(written).toEqual(['hello'])
  })

  it('resets before a transcript, because it replaces the buffer', async () => {
    const store = await import('../../src/web/app/stores/session.ts')
    const Terminal = (await import('../../src/web/app/components/Terminal.vue')).default
    mount(Terminal)
    store.__emitForTest({ kind: 'replace', jobId: 'j1', data: 'all of it' })
    expect(resets).toBe(1)
    expect(written).toEqual(['all of it'])
  })

  it('unsubscribes on unmount', async () => {
    const store = await import('../../src/web/app/stores/session.ts')
    const Terminal = (await import('../../src/web/app/components/Terminal.vue')).default
    const wrapper = mount(Terminal)
    wrapper.unmount()
    store.__emitForTest({ kind: 'append', jobId: 'j1', data: 'late' })
    expect(written).toEqual([])
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/web/terminal.test.ts`
Expected: FAIL — `__emitForTest` is not exported, and `components/Terminal.vue` does not resolve

- [ ] **Step 3: Add the test seam to the store**

At the bottom of `engine/src/web/app/stores/session.ts`:

```ts
/** Test seam: production drives `emit` from a socket frame. */
export function __emitForTest(frame: OutputFrame): void {
  emit(frame)
}
```

- [ ] **Step 4: Write `usePane.ts`**

```ts
/**
 * Collapsed, docked, fullscreen. `body.dataset.pane` is the whole mechanism and
 * CSS does the rest.
 *
 * `data-pane` must never set `overflow: visible`. `.terminal { overflow: hidden }`
 * is what clips xterm's measuring span, which it parks at `left:-9999em` — in an
 * RTL document that span otherwise gives the entire page a horizontal scrollbar.
 */
import { ref } from 'vue'
import { read as prefs, write as remember } from '../lib/local.js'

export type PaneMode = 'collapsed' | 'docked' | 'full'
const ORDER: readonly PaneMode[] = ['collapsed', 'docked', 'full']

const mode = ref<PaneMode>(prefs().pane)
const view = ref<'session' | 'queue'>('session')
/** True once the reader has chosen a height themselves; nothing may override it after. */
let chosen = false

function apply(next: PaneMode): void {
  mode.value = next
  document.body.dataset['pane'] = next
  remember({ pane: next })
}

export function usePane() {
  return {
    mode,
    view,
    set(next: PaneMode) {
      chosen = true
      apply(next)
    },
    cycle() {
      chosen = true
      apply(ORDER[(ORDER.indexOf(mode.value) + 1) % ORDER.length] ?? 'docked')
    },
    /** Work opens the pane it needs — but never over a height the reader set. */
    follow() {
      if (!chosen && mode.value === 'collapsed') apply('docked')
    },
    /** The reader asked for this one explicitly, so it wins even over their height. */
    reveal() {
      if (mode.value === 'collapsed') apply('docked')
    },
    setView(next: 'session' | 'queue') {
      view.value = next
    },
  }
}
```

- [ ] **Step 5: Write `Terminal.vue`**

```vue
<script setup lang="ts">
/**
 * The only component that touches xterm, and the only one that opts out of
 * reactivity on purpose.
 *
 * xterm mounts once and is never inside a re-rendered container: a terminal
 * that is torn down and rebuilt loses its scrollback, its selection and its pty
 * geometry, and it is the one part of this page whose contents the server
 * cannot replay in full.
 */
import { onBeforeUnmount, onMounted, shallowRef } from 'vue'
import { activeJob, onOutput, send } from '../stores/session.js'
import { usePane } from '../composables/usePane.js'

const host = shallowRef<HTMLElement | null>(null)
const term = shallowRef<any>(null)
const fit = shallowRef<any>(null)
/** The job whose output is on screen, which is not always the running one. */
const shown = shallowRef<string | null>(null)
const { mode } = usePane()

let unsubscribe = () => {}
let observer: ResizeObserver | null = null

function refit(): void {
  try {
    fit.value?.fit()
    if (term.value !== null) send({ type: 'resize', cols: term.value.cols, rows: term.value.rows })
  } catch {
    // Not laid out yet — the pane is collapsed or the tab is hidden. The
    // observer fires again the moment it has a box.
  }
}

onMounted(() => {
  const instance = new Terminal({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 10_000,
    theme: { background: '#000000', foreground: '#e6edf3' },
  })
  const addon = new FitAddon.FitAddon()
  instance.loadAddon(addon)
  if (host.value !== null) instance.open(host.value)
  // Typing reaches the pty only while the live job is the one on screen.
  instance.onData((data: string) => {
    if (shown.value !== null && shown.value === activeJob.value) send({ type: 'input', data })
  })
  term.value = instance
  fit.value = addon

  // A ResizeObserver rather than a window resize listener: collapsing the pane,
  // switching tabs or opening the queue view changes the terminal's box without
  // firing a window resize, and xterm then reports stale columns to the pty —
  // which is what makes a TUI redraw over itself.
  if (host.value !== null && typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => refit())
    observer.observe(host.value)
  }

  unsubscribe = onOutput((frame) => {
    if (frame.kind === 'replace') {
      shown.value = frame.jobId
      instance.reset()
      instance.write(frame.data)
      return
    }
    // A late chunk from a job the reader has navigated away from is dropped
    // rather than drawn into somebody else's transcript.
    if (shown.value !== null && frame.jobId !== shown.value) return
    shown.value = frame.jobId
    instance.write(frame.data)
  })
})

onBeforeUnmount(() => {
  unsubscribe()
  observer?.disconnect()
})
</script>

<template>
  <div class="terminal" ref="host" :data-pane="mode"></div>
</template>
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/web/terminal.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 7: Mount the pane in `App.vue`**

Add the import and place it after `<main class="panel"></main>`:

```vue
import Terminal from './components/Terminal.vue'
```

```vue
  <section class="pane">
    <Terminal />
  </section>
```

- [ ] **Step 8: Build and watch a real job**

```bash
npm run build && node dist/web/cli.js
```

In the browser, confirm the terminal renders, then drag or toggle the pane and confirm the terminal refits rather than clipping. Expected: no horizontal scrollbar in either language — that is the `overflow: hidden` invariant the `usePane` comment names.

- [ ] **Step 9: Commit**

```bash
git add engine/src/web/app engine/tests/web/terminal.test.ts engine/dist
git commit -m "feat(web): terminal and pane

The one component that opts out of reactivity. Output reaches xterm
through the store's emitter, never a ref: an agent emits thousands of
lines a second and xterm keeps its own buffer already."
```

---

### Task 7: Toasts, notices, and the write door's other half

Completes `settle()`: a refusal is announced, and a write with an inverse offers an undo.

**Files:**
- Create: `engine/src/web/app/components/Toasts.vue`
- Create: `engine/src/web/app/components/NoticeFeed.vue`
- Create: `engine/src/web/app/composables/useToasts.ts`
- Create: `engine/tests/web/toasts-vue.test.ts`
- Modify: `engine/src/web/app/stores/session.ts` (`settle` gains the undo offer)
- Modify: `engine/tests/web/store.test.ts` (extend the undo test)
- Modify: `engine/src/web/app/App.vue` (mount both components)

**Interfaces:**
- Consumes: `onNotice`, `submit` from `../stores/session.ts`; `useI18n`.
- Produces: `useToasts(): { toasts: Readonly<Ref<Toast[]>>, notify(message: Message, action?: ToastAction): void, dismiss(id: number): void }`; `type Toast = { id: number, message: Message, action: ToastAction | null }`; `type ToastAction = { code: string, run: () => void }`.

- [ ] **Step 1: Write the failing test**

Create `engine/tests/web/toasts-vue.test.ts`:

```ts
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { installForTest } from '../../src/web/app/lib/i18n.ts'
import { useToasts } from '../../src/web/app/composables/useToasts.ts'
import Toasts from '../../src/web/app/components/Toasts.vue'
import { readLocale } from './helpers/page.js'

const english = await readLocale('en')

beforeEach(() => {
  installForTest({ code: 'en', strings: english })
  const { toasts, dismiss } = useToasts()
  for (const toast of [...toasts.value]) dismiss(toast.id)
})

describe('Toasts', () => {
  it('shows a notice as its translated code', () => {
    const { notify } = useToasts()
    notify({ code: 'write.ok.halt' })
    const wrapper = mount(Toasts)
    expect(wrapper.text()).toBe(english['write.ok.halt'])
  })

  it('runs an offered action and then clears the toast', async () => {
    const run = vi.fn()
    const { notify } = useToasts()
    notify({ code: 'write.ok.gate' }, { code: 'write.undo', run })
    const wrapper = mount(Toasts)
    await wrapper.get('button.toast-action').trigger('click')
    expect(run).toHaveBeenCalledOnce()
    expect(wrapper.findAll('.toast')).toHaveLength(0)
  })

  it('dismisses without running anything', async () => {
    const run = vi.fn()
    const { notify } = useToasts()
    notify({ code: 'write.ok.gate' }, { code: 'write.undo', run })
    const wrapper = mount(Toasts)
    await wrapper.get('button.toast-dismiss').trigger('click')
    expect(run).not.toHaveBeenCalled()
    expect(wrapper.findAll('.toast')).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/web/toasts-vue.test.ts`
Expected: FAIL — cannot resolve `composables/useToasts.ts`

- [ ] **Step 3: Write `useToasts.ts`**

```ts
/**
 * Transient messages, and the only place an undo is offered.
 *
 * A toast holds a `Message` — a code and parameters — never a sentence. The
 * wording is resolved at render time, so a locale change while a toast is on
 * screen re-renders it in the new language.
 */
import { readonly, ref } from 'vue'
import type { Message } from '../../protocol.js'

export type ToastAction = { code: string; run: () => void }
export type Toast = { id: number; message: Message; action: ToastAction | null }

const held = ref<Toast[]>([])
let counter = 0

export function useToasts() {
  return {
    toasts: readonly(held) as Readonly<typeof held>,
    notify(message: Message, action?: ToastAction) {
      held.value = [...held.value, { id: ++counter, message, action: action ?? null }]
    },
    dismiss(id: number) {
      held.value = held.value.filter((toast) => toast.id !== id)
    },
  }
}
```

- [ ] **Step 4: Write `Toasts.vue`**

```vue
<script setup lang="ts">
import { useI18n } from '../composables/useI18n.js'
import { useToasts } from '../composables/useToasts.js'

const { t } = useI18n()
const { toasts, dismiss } = useToasts()

function act(id: number, run: () => void): void {
  run()
  dismiss(id)
}
</script>

<template>
  <div class="toasts" role="status" aria-live="polite">
    <div v-for="toast in toasts" :key="toast.id" class="toast">
      <span>{{ t(toast.message.code, toast.message.params) }}</span>
      <button v-if="toast.action !== null" type="button" class="toast-action" @click="act(toast.id, toast.action.run)">
        {{ t(toast.action.code) }}
      </button>
      <button type="button" class="toast-dismiss" :aria-label="t('toast.dismiss')" @click="dismiss(toast.id)">×</button>
    </div>
  </div>
</template>
```

- [ ] **Step 5: Write `NoticeFeed.vue`**

The header's bell: the same messages, kept after their toast has gone.

```vue
<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import type { Message } from '../../protocol.js'
import { onNotice } from '../stores/session.js'
import { useI18n } from '../composables/useI18n.js'

/** Bounded: this is a feed, not a log, and it is rendered. */
const LIMIT = 50

const { t, tn } = useI18n()
const open = ref(false)
const feed = ref<{ id: number; message: Message }[]>([])
let counter = 0

const off = onNotice((message) => {
  feed.value = [{ id: ++counter, message }, ...feed.value].slice(0, LIMIT)
})
onBeforeUnmount(off)
</script>

<template>
  <div class="notices">
    <button type="button" :aria-expanded="open" :aria-label="t('notice.toggle')" @click="open = !open">
      <span v-if="feed.length > 0" class="count" aria-hidden="true">{{ feed.length }}</span>
    </button>
    <div v-if="open" class="notice-panel">
      <p v-if="feed.length === 0" class="empty">{{ t('notice.empty') }}</p>
      <ul v-else>
        <li v-for="entry in feed" :key="entry.id">{{ t(entry.message.code, entry.message.params) }}</li>
      </ul>
    </div>
  </div>
</template>
```

- [ ] **Step 6: Complete `settle()` in the store**

Replace the `settle` function written in Task 3 with:

```ts
function settle(receipt: Receipt): void {
  const heldWrite = pending.get(receipt.id)
  if (heldWrite === undefined) return
  pending.delete(receipt.id)
  heldWrite.settled?.(receipt)

  // A refusal is worth saying out loud: the user pressed something, it did not
  // happen, and the reason is that the world moved underneath them. There is
  // nothing to undo, because nothing was done.
  if (!receipt.ok) {
    announce({ code: receipt.code })
    return
  }
  const undo = heldWrite.undo
  if (undo === undefined) {
    announce({ code: receipt.code })
    return
  }
  announce({ code: receipt.code }, { code: 'write.undo', run: () => submit(undo) })
}
```

and add, beside the other subscriber sets:

```ts
type Announcer = (message: Message, action?: { code: string; run: () => void }) => void
let announce: Announcer = () => {}

/** Installed once from `App.vue`, so the store never imports a component. */
export function installAnnouncer(fn: Announcer): void {
  announce = fn
}
```

Then delete the `for (const fn of noticeSubscribers) fn({ code: receipt.code })` line the old `settle` ended with. `onNotice` keeps its job: server-pushed `{type:'notice'}` frames.

- [ ] **Step 7: Extend the store's undo test**

In `engine/tests/web/store.test.ts`, replace the third write test with:

```ts
  it('offers the inverse write only when one was given and the write landed', () => {
    const announced: unknown[] = []
    store.installAnnouncer((message, action) => announced.push({ message, undo: action !== undefined }))

    store.submit({ kind: 'gate', run: 'r', open: true }, { undo: { kind: 'gate', run: 'r', open: false } })
    const first = JSON.parse(FakeSocket.last?.sent[0] ?? '{}').id
    FakeSocket.last?.deliver({ type: 'receipt', id: first, ok: false, code: 'write.stale' })
    // Refused: announced, but there is nothing to undo — it did not happen.
    expect(announced).toEqual([{ message: { code: 'write.stale' }, undo: false }])

    store.submit({ kind: 'gate', run: 'r', open: true }, { undo: { kind: 'gate', run: 'r', open: false } })
    const second = JSON.parse(FakeSocket.last?.sent[1] ?? '{}').id
    FakeSocket.last?.deliver({ type: 'receipt', id: second, ok: true, code: 'write.ok.gate' })
    expect(announced[1]).toEqual({ message: { code: 'write.ok.gate' }, undo: true })
  })
```

- [ ] **Step 8: Mount both in `App.vue`**

Add the imports, install the announcer in setup, and place the components:

```ts
import { installAnnouncer, onNotice } from './stores/session.js'
import { useToasts } from './composables/useToasts.js'
import NoticeFeed from './components/NoticeFeed.vue'
import Toasts from './components/Toasts.vue'

const { notify } = useToasts()
installAnnouncer(notify)
// Server-pushed notices become toasts too; NoticeFeed keeps its own copy.
onNotice((message) => notify(message))
```

`<NoticeFeed />` goes inside `.brand`, after `<LanguagePicker />`. `<Toasts />` goes last, after the pane.

- [ ] **Step 9: Run everything**

```bash
npx vitest run tests/web/
npm run typecheck
npm run build
node scripts/verify-ship.mjs
```

Expected: every web test passes — the ported `lib.test.ts`, `assets`, `store` (10, one rewritten), `i18n-composable`, `shell`, `terminal`, `toasts-vue` — plus the untouched server-side suites. Typecheck silent. Ship checks green.

- [ ] **Step 10: Commit**

```bash
git add engine/src/web/app engine/tests/web engine/dist
git commit -m "feat(web): toasts, the notice feed, and undo

Completes the write door: a refusal is announced and a write with an
inverse offers it. The store installs an announcer rather than importing
a component, so it stays testable without a DOM."
```

---

## Done when

- `npm run build && npm run typecheck && npx vitest run && node scripts/verify-ship.mjs` are all green.
- The built page shows live header, banners, rail, tabs, terminal and toasts, in both languages, with the main area intentionally empty.
- `engine/src/web/public/` is untouched and the old page still works.
- No file under `engine/src/web/*.ts` was modified.

## Then

Write the second plan: the eight panels, the retirement of `public/`, the `discipline.test.ts` retarget, and the switch. Its task shapes depend on the composable signatures this plan settles, which is why it is written after this one lands rather than now.
