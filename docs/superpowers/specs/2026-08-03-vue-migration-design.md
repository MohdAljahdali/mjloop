# Migrating the cockpit page to Vue 3

The dashboard under `engine/src/web/public/` is a hand-written vanilla-JS SPA:
~7,000 lines of JavaScript, a 1,891-line `index.html` carrying the markup and a
`<template>` per repeated row, and six stylesheets. It works, it is typechecked
through JSDoc, and it is covered by ~6,000 lines of tests.

This document specifies its full replacement by a Vue 3 + TypeScript
application, built by Vite, shipped the same way everything else in `dist/` is
shipped.

## Why

Four reasons, all of them held at once:

- **Maintenance cost.** Adding a panel means adding markup, a `<template>`, a
  reconciler call site, an action registration, and a locale key — in five
  files.
- **State synchronisation.** The server pushes a whole `Snapshot`; keeping the
  screen equal to it is done by hand, panel by panel.
- **Ecosystem.** Off-the-shelf components are unavailable to a page with no
  build step.
- **Fluency.** The maintainer works faster in Vue.

## The central observation

The server broadcasts a complete `Snapshot` and the page is already a pure
function of it. `ui/render.js` schedules a frame, skips hidden panels, and calls
`update(snapshot)` on each one; each panel then reconciles DOM by hand through
`ui/list.js` and `ui/dom.js`.

That is a hand-rolled reactive renderer. Vue is the same machine, written by
somebody else and tested by everybody else. Most of this migration is deletion.

## Scope

### Deleted outright (~500 lines of JS, plus 1,891 lines of HTML)

| File | Replaced by |
| --- | --- |
| `ui/render.js` | Vue's scheduler; `v-if` on the inactive tab |
| `ui/list.js` | `v-for` with `:key` |
| `ui/dom.js` (237 lines) | Templates |
| `ui/bus.js` | `@click` |
| `ui/tabs.js` | `<component :is>` plus the routing composable |
| every `<template>` in `index.html` | Components |

### Rewritten as components (~900 lines)

The rest of `ui/`: `pane`, `rail`, `worktabs`, `terminal`, `notifications`,
`toasts`, `dialog`, and `writes`. Their behaviour is kept; their DOM handling is
not. `writes.ts` is the exception — see below, it ports verbatim.

### Ported unchanged, converted to TypeScript

All of `lib/` — it is DOM-free and already node-tested: `i18n`, `api`, `fmt`,
`keys`, `local`, `plandoc`, `router`, `selection`, `stories`, `notifications`.
`net/socket.js` moves inside the store as the single source of truth.

### Untouched

Every `engine/src/web/*.ts` file — the server, `protocol.ts`, `api.ts`,
`writes.ts`. The page consumes their types exactly as it does today. The six
stylesheets carry their content across.

**`server.ts` needs no change at all.** It sets an `HttpOnly` cookie on the
first HTML response and `suppliedToken(url, cookie)` accepts it, so Vite's
hashed `/assets/*.js` requests authenticate without a `?t=` query parameter.

## Architecture

```
engine/src/web/app/
  main.ts              boot only, as app.js is today
  App.vue              header, rail, tabs, pane
  stores/session.ts    connection, reactive Snapshot, writes
  composables/         useI18n, useRouter, useSelection, useToasts
  components/          Rail, Tabs, Terminal, Toasts, Notifications, Dialog
  panels/              Run, Plans, Stories, Features, Skills, Evidence,
                       Memory, Config
  lib/                 ported as-is (TypeScript)
```

### State

**No Pinia.** The state is one object the server pushes. A module exporting refs
is enough and matches the existing architecture; a state library here is
unearned weight.

```ts
const snapshot = shallowRef<Snapshot | null>(null)
const online   = ref(false)
```

`shallowRef`, not `ref`. This is the migration's most important performance
decision. The server replaces the whole object up to 1.25 times a second; deep
proxying would walk `plans[].stories[]` and `queue[]` on every broadcast for
nothing, because no field of it is ever mutated by the page. Atomic replacement
is exactly what `shallowRef` means.

`ServerMessage` is demultiplexed in the store, along the same branches `app.js`
has today:

| Message | Destination |
| --- | --- |
| `snapshot` | `snapshot.value = …` — redraw follows |
| `output` / `transcript` | bypasses reactivity → event emitter read by `Terminal.vue` |
| `notice` | `useToasts().notify()` |
| `receipt` | `settle()`, ported verbatim |

### Writes

`submit(write, { undo, settled })` and the `pending` map port unchanged. The
reason is in `ui/writes.js`'s own header: the snapshot broadcast precedes the
receipt, so there is no optimistic render and no rollback. That is a property of
the server, not of the page, and it survives the framework change intact. The
practical consequence is that the riskiest layer moves without being rethought.

### Non-reactive islands

1. **`xterm`** lives in a `shallowRef`; output reaches it through the event
   emitter, never through a reactive prop. Thousands of lines per second through
   the reactivity system would freeze the page.
2. **The `config` editor's draft** (1,838 lines today) is local component state.
   The Save button remains the only path to the server, as it is today.
3. **`localStorage`** through the existing `lib/local.ts`, feeding composables:
   pane height, story tabs, language.

### Internationalisation

`locale` becomes a reactive ref and `t()` reads it, so every string on screen
re-renders by itself. `translateStatic` and the ~200 `data-i18n` attributes are
deleted, along with the manual `draw()` that follows a locale change today.

**The existing `i18n` module is kept; `vue-i18n` is not adopted.** The two
locale files (1,348 lines), the six Arabic plural categories, and
`locales.test.ts` all work today. Replacing them is risk without gain. `dir` and
`lang` on `<html>` are set by a watcher.

### Hidden panels

`v-if` on the inactive tab, wrapped in `<KeepAlive>` so the config draft and the
skills search results survive navigation. The nav counts and the plan document —
which `app.js` registers against `.tabs` precisely because a hidden node is
skipped — become computeds in `App.vue`, and the problem those comments describe
disappears.

## Build and shipping

The governing constraint is stated in `.gitignore` and in `build.mjs`: a Claude
Code plugin ships what is in git and runs it as-is, with no install step and no
compiler on the user's machine. `dist/` is therefore committed, and
`verify-ship.mjs` copies it into an empty directory with no `node_modules` and
proves it runs.

`build.mjs` changes in one place. Today:

```js
await fs.cp(src/web/public, dist/web/public, { recursive: true })
```

Tomorrow: invoke `vite build` with `dist/web/public` as its outDir, then copy
what falls outside the import graph — `locales/*.json`, fetched at runtime, and
the `vendor/` files from `vendor.mjs`.

**`xterm` stays in `vendor/` and is not bundled.** `VENDOR` is the last
hand-maintained asset list and is shared with `verify-ship.mjs`; bundling xterm
would also inflate the git diff on every one-line UI change. The page keeps
`<script src="vendor/xterm.js">` and `Terminal.vue` reads the global through
`page-globals.d.ts`.

Four Vite settings are binding, each preventing a real failure:

| Setting | Reason |
| --- | --- |
| `base: './'` | relative paths survive any path remounting |
| `assetsInlineLimit: Infinity` | the server's `MIME` map knows only `.html/.js/.css/.json/.map`; an emitted `.svg` or font would be served as `octet-stream` |
| `cssCodeSplit: false` | one stylesheet; the six files are `@import`ed from a single entry |
| `sourcemap: false` | `dist` is in git, and maps double the diff for a user who has no source |

**Development:** `vite dev` on its own port, proxying `/api` and the WebSocket to
the `mjloop-web` server. This provides HMR, which does not exist today.

**Typechecking:** `tsconfig.web.json`'s `allowJs` + `checkJs` JSDoc pass is
replaced by `vue-tsc` in the same `typecheck` script. Templates are now checked
too: `snapshot.state.trakc` in markup is a compile error rather than a silently
empty slot.

**Accepted cost:** reviewing `dist/` becomes reviewing generated, minified
output rather than readable files. This is inherent to SFCs and to the committed
`dist/`. What mitigates it is `verify-ship.mjs`, which stays the judge — extended
with a check that `dist/web/public/index.html` references an asset file that
actually exists, which is precisely the class of silent breakage that script was
written for.

## Testing

Of 19 test files, **9 are untouched** (`api`, `cli`, `completion`, `queue`,
`read`, `server`, `snapshot`, `writes`, and part of `discipline`) — ~3,900 lines
covering the server, which this migration does not reach.

| File | Fate |
| --- | --- |
| `lib.test.ts` (530) | **moves as-is** — DOM-free, and the modules move with it |
| `locales.test.ts` (299) | **moves**, with one change: keys are read from templates rather than `data-i18n` |
| `panels.test.ts` (3,744) | rebuilt as one file per panel via `@vue/test-utils` |
| `boot.test.ts` (671) | becomes a mount test for `App.vue` plus the store, with a fake socket |
| `render.test.ts` (202) | **deleted** — frame scheduling and hidden-skipping are no longer our code |
| `list.test.ts` (109) | **deleted** — `v-for :key` replaces the reconciler |
| `bus.test.ts` (61) | **deleted** — there is no bus |
| `notifications`, `toasts`, `boundary` (354) | rewritten as component tests |

Splitting `panels.test.ts` into eight files is a gain in itself, not a side
effect: nobody reads a 3,744-line test file end to end.

### `discipline.test.ts`

Nine disciplines enforced by reading source as text. Their fates differ:

**Kept, retargeted at `app/**/*.vue`:** accessibility (`aria-label` on every icon
button), keyboard-before-pointer, RTL, the invariants a stylesheet edit could
undo, and "the server can name everything it serves" — that last one grows in
importance, because it is exactly what catches an asset Vite emits with an
extension the `MIME` map does not know.

**Deleted, because the compiler subsumes them:** "every `data-act` is
registered", "no string-built DOM", and "every `<template>` is cloned".

Losing those three is not a regression. `vue-tsc` checks the templates
themselves, which is stronger than any text match can be.

## Execution order

Seven stages on one branch. The old page keeps working until stage 7.

1. **Scaffold.** Vite, `plugin-vue`, `vue-tsc` wired into `build.mjs` and
   `typecheck`; an empty Vue page that builds and ships. The entire shipping
   constraint is proven here, before a single component is written.
2. **`lib/` to TypeScript,** with `lib.test.ts` unchanged — green from day one.
3. **Store and `App.vue`:** socket, state, rail, header, banners, tabs, i18n.
4. **Terminal and bottom pane:** xterm, streaming, queue — the non-reactive
   island alone.
5. **The eight panels,** each with its tests in one batch. Heaviest first:
   `config` (1,838), then `stories` (1,098).
6. **Writes, notifications, dialogs:** `submit`/`settle` ported, undo.
7. **Delete and switch.** Remove the old `public/` and the retired test files;
   run `verify:ship` and the e2e suite.

## Risk

One risk is worth naming. A single-shot switch makes the rewritten component
tests the standard for "we lost nothing" — and they are written against the new
code, so they cannot catch behaviour that exists today and was forgotten
entirely.

The mitigation is procedural and belongs to stage 5: each panel's **old** tests
are read as a specification *before* its replacement is written, not after. That
turns 3,744 lines from code being thrown away into a specification being
carried across.
