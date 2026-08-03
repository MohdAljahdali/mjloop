# Carried forward from the Vue migration's foundation

Everything below was found during the foundation branch (`611119c..5513c9a`),
ruled non-blocking there, and belongs to the second plan — the eight panels, the
retirement of `src/web/public/`, and the switch. It is recorded here because the
scratch ledger it came from is not in git.

Nothing here is a known bug in shipped behaviour unless it says so.

## Decisions to inherit, not rediscover

**Write receipts never reach the notice feed.** They become toasts only, while
`notice.hint` promises write results in that panel. The old page routes both
through one door on purpose — `ui/notifications.js:15`, "the ephemeral toast and
the durable log can never disagree". The foundation plan specified the split.
This is a live wrong-content panel, not a missing feature, and it interacts with
the unread badge: the badge counts things the panel and the toasts disagree
about.

**No new locale key could be added anywhere in the foundation.**
`tests/web/locales.test.ts` guards `src/web/app/locales/*.json` as byte-identical
to `src/web/public/locales/*.json`, and `public/` was untouchable. Every string
in the new page reuses an existing key. The second plan retires `public/` and
frees the locale files — several strings deserve their own key at that point,
starting with the refusal a write gets when the socket is down, which currently
borrows `write.failed`.

**`aria-controls` is deliberately absent from the tab anchors.** The old page has
it; the new one omits it until the panels it would reference exist. Pointing at
a nonexistent id is worse than omitting the attribute. Restore it with the
panels.

**The reconnect retry is uncapped, on purpose.** `public/net/socket.js:19,58` has
no cap either, and fidelity to the old page won. What made a dead socket
dangerous was that the offline banner could not render before the first
snapshot; that is fixed.

## Structural work

**`tsconfig.web.json` carries `"types": ["vite/client", "node"]`.** Node globals
are resolvable throughout browser-only `app/` code, so the compiler will not
catch a component reaching for `process` or Node's `setTimeout` overloads. It is
there because `app/lib` imports `protocol.js`, which drags `writes.ts`,
`revision.ts` and `ops/summary.ts` into the web program. The narrow fix is a
project reference or a types-only barrel. **Do this early in the second plan, not
late** — it is the branch's widest hole and eight panels will only widen it.

**Markup-to-stylesheet contracts need a structural guard.** Four separate
defects on this branch were markup that stopped matching what the stylesheet
selects, and none was visible to any `.text()` assertion: a status pill writing
a class where the sheet keys on an attribute, tab anchors losing the ids their
icons are selected by, the page grid disabled by the mount root, and the notice
toggle rendered in the wrong container. The existing guards
(`tests/web/shell.test.ts`, `tests/web/layout.test.ts`) check hooks on elements
but never their position in the tree. The panels need a structural diff against
`src/web/public/index.html`, not more attribute assertions.

**`src/web/page-globals.d.ts` is in no tsconfig,** so the still-live old page has
lost its compiler check. Closes when `public/` goes.

## Small, specific

- `usePane`'s `chosen` flag is a module singleton while `usePane()` is called
  fresh per consumer. Correct while only `App.vue` boots it; fragile once panels
  call `follow()`.
- `Terminal.vue`'s `watch(activeJob)` is not `immediate`, so a `Terminal` mounted
  after a snapshot had already set `activeJob` would never adopt it. Unreachable
  while mount precedes any socket frame; add `{ immediate: true }` the moment a
  panel can unmount and remount the pane.
- `Terminal.vue` calls `new Terminal(...)` and resolves the xterm global only
  because `<script setup>`'s filename-derived self-reference is template-only. An
  `import Terminal from …` anywhere in that file would silently capture the
  component instead.
- `installAnnouncer` runs in `App.vue`'s setup while `connect()` runs in
  `main.ts`; a receipt landing in that window announces into the default no-op.
  Unreachable in practice — a receipt requires a prior `submit`.
- The pane is missing surface the stylesheet selects: `.pane-head`, the two view
  tabs, `#panel-queue`, the command form, `.pane > .hint`, `#terminal-empty`, and
  the `hidden` swap on `.terminal`. Also `usePane` has no `toggleFull()`, which
  `pane-full` needs.
- `NoticeFeed` omits the per-row `<time>`, so `20-rail.css:326` selects nothing.
- Two lying tests: `tests/web/toasts-vue.test.ts`'s "cancels the pending timer"
  asserts a length that is 0 either way, and its three sibling toast tests run on
  real timers, each arming a live 8s timeout that outlives the test.
  `tests/web/store.test.ts`'s online/offline case leaks a 1000ms
  `setTimeout(open)` — which is also why reconnection has no test.
- `tests/` is in no tsconfig, so `npm run typecheck` never typechecks a test
  file. Pre-existing.
- `verify-ship`'s vendor check compares a committed artefact against
  `node_modules`, which is not committed; it can false-fail on a tree out of sync
  with the lockfile. Its locales comparison is one-directional. Its
  `shipped.length >= 5` floor is two files below what actually ships.
- `tests/web/layout.test.ts` globs the first `style-*.css` and never builds, so it
  would pass against a stale `dist`. Only `verify-ship`'s fresh-build comparison
  closes that pair.

## Verified in a browser

The branch's one untestable risk is closed. The page was served from the
committed `dist/` by `node dist/web/cli.js --port 4199` and driven in Chrome.

- **It loads with zero console errors**: header, project path, language picker,
  status pill, notice toggle, eight tabs, an empty `<main>`, and a collapsed
  pane. No black terminal box on arrival.
- **xterm measures correctly** — the risk that mattered. With the pane docked:
  terminal box 1476×272, `.xterm-screen` 1440×240, 16 rows rendered. So booting
  `<body data-pane="docked">` and collapsing in `App.vue`'s `onMounted` does
  reproduce `app.js`'s `mountTerminal()`-then-`mountPane()` order, and xterm gets
  a laid-out box at `open()`.
- **RTL holds**: `?lang=ar` gives `dir="rtl"`, the whole shell in Arabic, and
  `scrollWidth === clientWidth` — no horizontal scrollbar from xterm's measuring
  span, which is the invariant `usePane.ts`'s header warns about.
- **The contracts hold at runtime**, not just in tests: `.rail #notice-toggle`
  present and `.brand #notice-toggle` absent, all eight `tab-<id>` ids, and
  `data-status` on the pill.

Still unverified, and cheap to check once the pane controls exist: that
collapsing and re-docking at runtime re-fits the terminal. The boot path is what
was dangerous, and it is now proven.

One cosmetic consequence of deferred scope, seen on screen: a docked pane with
nothing running is a bare black rectangle, where the old page shows the
`#terminal-empty` hint. That lands with the pane surface listed above.

---

# Carried forward from the panels plan and the switch

The second plan ported the eight panels, restored bidi isolation, unified the
notice door, deleted `src/web/public/`, and spent what that unlocked. Branch
`611119c..1c42724`, 61 commits, 92 test files / 2084 tests.

## Open, and nobody has closed it

**A ~1-in-40 whole-suite flake, never attributed.** One run in forty fails and
nobody has caught which test. Two hunts were run; the first was contaminated by
an implementer working in the same tree, the second could not reproduce it in
33 consecutive clean runs. Every reviewer's run since has been green. It is not
a merge blocker, but do not let it fall off: an intermittent failure teaches
every future maintainer to re-run instead of read, which is the habit that lets
the next real defect through.

**Terminal geometry on the real path.** A job actually starting, `shown` going
non-null, and the `flush: 'post'` refit running against a freshly-unhidden box.
The `ResizeObserver` backstop was verified in a browser and the deterministic
watcher is unit-tested against a fake xterm, but the two have never been
observed together with a live pty — running one writes to the project, so no
agent did it. Five minutes of human hands.

**The client's write path has no schema check of its own.** `WriteSchema` lives
on the server, `submit()` trusts its caller, and nothing re-validates an
outbound `Write`. This is why two test fixtures carrying a `Write` shape the
server would reject at the schema boundary — `{kind:'gate', run, open}` — passed
for the whole migration. A guard running each `submit()` payload the app can
produce through `WriteSchema.parse` would close it.

**Deactivated panels still render.** `<KeepAlive>` does not pause a deactivated
component's effects. `useFeed`'s I/O is now gated through
`onActivated`/`onDeactivated`, so no background panel fetches — but every
visited-then-closed panel still re-derives and patches its vnode tree into the
detached container on each broadcast, up to 1.25 times a second. The deleted
`ui/render.js` skipped hidden panels entirely. CPU only, no correctness or
network cost; closing it needs a different mechanism (`v-if` over `KeepAlive`,
or a render gate), which is a design change rather than a fix.

**The two-epoch i18n problem, still parked.** `useI18n`'s epoch ref mirrors
`lib/i18n.ts`'s own counter rather than being the same fact. A component calling
`setLocale` directly would change the language and repaint nothing. The barrier
comment at `useI18n.ts` is the entire mitigation, and it holds only because
`setLocale` has exactly one importer.

## Small and specific

- `useSelection`'s mutators now re-read their getter to match the module header,
  but nothing pins them there: reverting to the assignment leaves all 59 plans
  and stories tests green.
- `scripts/assets.d.mts` is a hand-written declaration for an untyped `.mjs`
  with nothing binding the two; a second export would be silently omitted. A
  `@ts-check`ed `.mjs` would make the pair self-enforcing.
- `tsconfig.tests.json` covers `tests/**/*.ts`; a future `.mts` under `tests/`
  falls outside it.
- `typeguard.test.ts` applies its `<script setup>` exemption file-wide, so a
  `.vue` carrying both a setup and a plain `<script>` would exempt the plain
  block too. No such file exists yet.
- A red first `typecheck` run was seen once and blamed on stale `.ts-out/`
  incremental state. **That explanation is unverified** — a reviewer could not
  reproduce it warm or cold. The cause is unexplained, not diagnosed.

## What this migration taught, worth keeping

Three tests on this branch were found to guard nothing, two of them after being
reported as verified. One whole class — fixtures asserting shapes the server can
never send — was invisible to 2,083 green tests and was found in one pass by
pointing a compiler at the test files for the first time.

And every defect of the worst class traced to a comment in the old page that
recorded a **decision** rather than a mechanism: "exported so it is not copied",
"these two buttons are adjacent deliberately", "an allowlist rather than an
exclusion", "hidden panels are skipped entirely". Porting the behaviour
succeeded each time while the decision behind it was lost. The old page is at
`git show 611119c:engine/src/web/public/<path>`; `App.vue`'s header says so.
