# MjLoop Control Center Slice A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the current single-project cockpit clear and reliable, repair the apparently unresponsive Plans interaction, and add safe comment-preserving project configuration editing.

**Architecture:** Keep the existing single-project server, queue, API, retained DOM, and WebSocket write door. Add a dedicated config mutation in the config store that uses a content revision, the project lock, YAML `Document` edits, whole-config validation, backup, and atomic rename. Expose that mutation as a fourth tightly scoped conditional web write; do not expose raw YAML editing or any evidence-producing engine operation.

**Tech Stack:** TypeScript 5.9, Zod 4, YAML 2, Node.js filesystem primitives, Vitest 4, happy-dom, vanilla checked JavaScript, HTML/CSS, English/Arabic JSON locales.

## Global Constraints

- Preserve one active MjLoop session and one sequential queue for the current project.
- Keep `runStart`, `rosterSet`, `runLog`, and `cycleAdvance` unreachable from browser code.
- Keep the server bound to `127.0.0.1` and protected by the existing token.
- Keep terminal transcripts bounded and xterm permanently LTR and clipped.
- Keep all model- and user-authored text on the retained-DOM `verbatim()` path.
- Keep every server-authored user-facing message inside the closed `WebCode` locale catalog.
- Do not let the browser send raw YAML paths, executable paths, or shell commands through config writes.
- An active run continues with its pinned settings; saved config changes affect the next run.
- Preserve comments, ordering, legacy inert keys, and unrelated YAML spelling wherever the edited node does not require replacement.
- Tests must observe each new behavior fail before production code is written.

---

## Locked File Structure

### New files

- `engine/src/store/config-mutation.ts` — schemas, revision calculation, comment-preserving conditional config mutation, and structured mutation errors.
- `engine/tests/store/config-mutation.test.ts` — real filesystem tests for validation, comments, CAS, locking, backup, and atomic replacement.

### Existing files changed

- `engine/src/web/writes.ts` — add only the `config.patch` handler to the existing typed write door.
- `engine/src/web/codes.ts` — add closed config receipt/error codes.
- `engine/src/web/read.ts` — add the content revision to `ConfigView`.
- `engine/src/web/public/index.html` — add visible panel headings, master-detail Plans structure, and config editor controls/templates.
- `engine/src/web/public/ui/tabs.js` — keep anchor routing, add `aria-selected`-equivalent clarity through page heading association and selected-state data.
- `engine/src/web/public/panels/plans.js` — expose plan detail beside the list, manage focus and `aria-expanded`.
- `engine/src/web/public/panels/config.js` — mount uncontrolled config forms, derive patches from the last fetched config, and submit conditionally.
- `engine/src/web/public/ui/writes.js` — map config receipts to localized notices and refresh behavior.
- `engine/src/web/public/css/30-tabs.css` — stronger active navigation surface.
- `engine/src/web/public/css/60-panels.css` — page headers, Plans master-detail layout, and config editor layout.
- `engine/src/web/public/locales/en.json` — English headings, help, buttons, receipts, and validation labels.
- `engine/src/web/public/locales/ar.json` — Arabic equivalents with the same keys.
- `engine/tests/web/lib.test.ts` — full router interaction behavior if the new route helper requires it.
- `engine/tests/web/panels.test.ts` — Run/Plans/config interaction tests against shipped HTML.
- `engine/tests/web/writes.test.ts` — config write integration and refusal tests.
- `engine/tests/web/boundary.test.ts` — allow only the dedicated mutation entrypoint and continue forbidding raw `writeConfig`.
- `engine/tests/web/discipline.test.ts` — active navigation, focus target, accessible control, and responsive-layout invariants.
- `engine/tests/web/locales.test.ts` — automatically covers the new closed keys.

---

### Task 1: Make the current view unmistakable

**Files:**
- Modify: `engine/src/web/public/index.html`
- Modify: `engine/src/web/public/css/30-tabs.css`
- Modify: `engine/src/web/public/css/60-panels.css`
- Modify: `engine/src/web/public/locales/en.json`
- Modify: `engine/src/web/public/locales/ar.json`
- Test: `engine/tests/web/discipline.test.ts`
- Test: `engine/tests/web/panels.test.ts`

**Interfaces:**
- Consumes: `showTab(active: string): void`, ordinary `href="#route"` anchors, existing `aria-current="page"`.
- Produces: one visible `.panel-head > h1` per top-level panel and a high-contrast active anchor with the stable routes unchanged.

- [ ] **Step 1: Write failing structure and rendering tests**

Add a discipline assertion that every `panel-*` section begins with a heading referenced by its navigation anchor:

```ts
it('gives every top-level view a visible heading and an unmistakable selected route', () => {
  for (const route of ['run', 'plans', 'evidence', 'memory', 'config']) {
    expect(html).toMatch(new RegExp(`id="tab-${route}"[^>]+aria-controls="panel-${route}"`))
    expect(html).toMatch(new RegExp(`id="panel-${route}"[^>]+aria-labelledby="panel-${route}-title"`))
    expect(html).toMatch(new RegExp(`id="panel-${route}-title"`))
  }
  expect(read('css/30-tabs.css')).toMatch(/\.tabs a\[aria-current="page"\][^{]*\{[^}]*background:/)
})
```

Add a panel test that reveals `panel-run`, translates the page, and asserts the Run heading uses the new `panel.run.title` locale key while `#tab-run` still links to `#run`.

- [ ] **Step 2: Run the tests and verify the expected failures**

Run:

```bash
cd engine
npx vitest run tests/web/discipline.test.ts tests/web/panels.test.ts
```

Expected: FAIL because the panel headings, control relationships, and selected background do not exist.

- [ ] **Step 3: Add panel headers and selected styling**

For every panel, add:

```html
<header class="panel-head">
  <div>
    <h1 id="panel-run-title" data-i18n="panel.run.title"></h1>
    <p class="hint" data-i18n="panel.run.help"></p>
  </div>
</header>
```

Add `aria-controls` to each top-level anchor and `aria-labelledby` to each panel. Keep IDs and fragments unchanged.

Style the selected anchor with text color, border, and background:

```css
.tabs a[aria-current="page"] {
  color: var(--text);
  border-block-end-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  font-weight: 650;
}
```

Add matching English and Arabic keys for all five headings and help lines.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```bash
cd engine
npx vitest run tests/web/discipline.test.ts tests/web/panels.test.ts tests/web/locales.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add engine/src/web/public/index.html engine/src/web/public/css/30-tabs.css engine/src/web/public/css/60-panels.css engine/src/web/public/locales/en.json engine/src/web/public/locales/ar.json engine/tests/web/discipline.test.ts engine/tests/web/panels.test.ts
git commit -m "fix(web): clarify the active control center view"
```

---

### Task 2: Repair the Plans interaction at its root cause

**Files:**
- Modify: `engine/src/web/public/index.html`
- Modify: `engine/src/web/public/panels/plans.js`
- Modify: `engine/src/web/public/css/60-panels.css`
- Modify: `engine/src/web/public/locales/en.json`
- Modify: `engine/src/web/public/locales/ar.json`
- Test: `engine/tests/web/panels.test.ts`
- Test: `engine/tests/web/discipline.test.ts`

**Interfaces:**
- Consumes: `mountPlans(): { toggle(id), decide(decision), requeue(story, from) }`, retained keyed list, `feed<PlanDetail>`.
- Produces: `toggle(id)` updates `aria-expanded`, reveals a master-detail region in the current viewport, and focuses `#plan-detail-title` after detail data lands.

- [ ] **Step 1: Write the failing Plans interaction test**

Serve a plan detail response, render one plan with twenty-two stories, call the real `toggle`, and assert observable interaction state:

```ts
it('opens plan detail in context and exposes the state to keyboard and screen-reader users', async () => {
  serve({
    '/api/plans/P001': {
      id: 'P001',
      title: 'Large plan',
      approval: null,
      body: '# Large plan',
      review: null,
      stories: [],
    },
  })
  reveal('panel-plans')
  const plans = mountPlans()
  draw(
    emptySnapshot({
      plans: [
        plan({
          id: 'P001',
          title: 'Large plan',
          stories: Array.from({ length: 22 }, (_, index) =>
            story({ id: `P001-S${String(index + 1).padStart(2, '0')}` }),
          ),
        }),
      ],
    }),
  )

  const open = document.querySelector('[data-act="open-plan"]') as HTMLButtonElement
  expect(open.getAttribute('aria-expanded')).toBe('false')

  plans.toggle('P001')
  await vi.waitFor(() => expect((document.getElementById('plan-detail') as HTMLElement).hidden).toBe(false))

  expect(open.getAttribute('aria-expanded')).toBe('true')
  expect(open.getAttribute('aria-controls')).toBe('plan-detail')
  expect(document.activeElement).toBe(document.getElementById('plan-detail-title'))
})
```

The production mutation this catches is removing the detail focus/expanded update and returning to an off-screen state change.

- [ ] **Step 2: Run the test and verify the expected failure**

Run:

```bash
cd engine
npx vitest run tests/web/panels.test.ts -t "opens plan detail in context"
```

Expected: FAIL because the button has no expanded relationship and detail focus is not moved.

- [ ] **Step 3: Implement master-detail behavior**

Wrap the list and detail in `.plans-workspace`; place the singleton detail as its second child. Give `#plan-detail-title` `tabindex="-1"`.

In `planRow.update`:

```js
attr(open, 'aria-controls', 'plan-detail')
attr(open, 'aria-expanded', opened === view.id ? 'true' : 'false')
```

In `drawDetail`, after a newly fetched open plan is drawn:

```js
if (focusPending === view.id) {
  focusPending = null
  detailTitle.focus({ preventScroll: true })
  const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
  detail.scrollIntoView({ block: 'nearest', behavior })
}
```

Set `focusPending` only from the user `toggle` action. Do not focus on background snapshot refreshes.

On wide screens use two columns with the detail sticky at the top of the scrolling region. Below the existing narrow breakpoint use one column and an explicit localized Back button that calls `toggle(opened)`.

- [ ] **Step 4: Run Plans, discipline, RTL, and type checks**

Run:

```bash
cd engine
npx vitest run tests/web/panels.test.ts tests/web/discipline.test.ts tests/web/locales.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add engine/src/web/public/index.html engine/src/web/public/panels/plans.js engine/src/web/public/css/60-panels.css engine/src/web/public/locales/en.json engine/src/web/public/locales/ar.json engine/tests/web/panels.test.ts engine/tests/web/discipline.test.ts
git commit -m "fix(web): make plan details open where users can see them"
```

---

### Task 3: Add a safe comment-preserving config mutation

**Files:**
- Create: `engine/src/store/config-mutation.ts`
- Modify: `engine/src/store/atomic.ts`
- Modify: `engine/src/web/read.ts`
- Test: `engine/tests/store/config-mutation.test.ts`
- Test: `engine/tests/web/read.test.ts`

**Interfaces:**
- Consumes: `ConfigSchema`, `TrackSchema`, `SpecialistModeSchema`, `resolveLoopPaths`, `withLock`.
- Produces:

```ts
export const ConfigChangeSchema: z.ZodType<ConfigChange>
export const ConfigPatchSchema: z.ZodType<ConfigPatch>
export type ConfigPatch = { revision: string; changes: ConfigChange[] }
export type ConfigMutationFailure = 'stale' | 'invalid' | 'missing'
export class ConfigMutationError extends Error {
  kind: ConfigMutationFailure
  path: (string | number)[]
}
export function configRevision(raw: string): string
export async function mutateConfig(projectDir: string, patch: ConfigPatch): Promise<{ revision: string }>
export async function writeTextAtomic(file: string, text: string, options?: WriteOptions): Promise<void>
```

- [ ] **Step 1: Write real-filesystem failing tests**

Cover these behaviors with literal YAML fixtures:

```ts
it('changes an allowlisted value without losing comments or inert legacy keys', async () => {
  await writeRaw(`# project policy\nversion: 1\nautonomous: false # supervised\n${tracks}\ncustom_dirs:\n  agents: old\n`)
  const before = await raw()
  await mutateConfig(project.dir, {
    revision: configRevision(before),
    changes: [{ kind: 'root', key: 'autonomous', value: true }],
  })
  expect(await raw()).toContain('# project policy')
  expect(await raw()).toContain('autonomous: true # supervised')
  expect(await raw()).toContain('custom_dirs:')
})
```

Also assert:

- stale revision changes no byte;
- unknown change kind/path fails schema parsing;
- contradictory `specialists.security: never` with required security is invalid and changes no byte;
- two callers with one revision produce one success and one stale result;
- the old file is copied to `config.yaml.bak`;
- a simulated temp-write failure leaves the primary byte-identical;
- `readConfigView` returns the SHA-256 content revision.

- [ ] **Step 2: Run tests and verify missing-symbol failures**

Run:

```bash
cd engine
npx vitest run tests/store/config-mutation.test.ts tests/web/read.test.ts
```

Expected: FAIL because `mutateConfig`, `ConfigPatchSchema`, `configRevision`, and `writeTextAtomic` do not exist.

- [ ] **Step 3: Implement atomic text writing**

Add `writeTextAtomic` beside `writeJsonAtomic`, using the same UUID temporary-name and backup sequence. It must write the provided text verbatim and rename only after the write closes successfully.

- [ ] **Step 4: Implement the closed mutation schema**

Use a discriminated union:

```ts
type ConfigChange =
  | { kind: 'root'; key: 'autonomous' | 'verify_cache'; value: boolean }
  | { kind: 'limit'; key: 'max_parallel_agents' | 'no_progress_strikes'; value: number }
  | { kind: 'verify.command'; key: 'test' | 'lint' | 'build'; value: string | null }
  | { kind: 'verify.number'; key: 'timeout_ms' | 'lock_timeout_ms'; value: number }
  | { kind: 'verify.patterns'; key: 'test' | 'lint' | 'build'; value: string[] }
  | { kind: 'gate'; key: 'plan_approval' | 'commit' | 'preflight'; value: 'human' | 'auto' }
  | { kind: 'specialist'; agent: string; value: 'auto' | 'always' | 'never' | null }
  | { kind: 'track'; track: string; value: z.infer<typeof TrackSchema> | null }
```

Use the engine's `AgentNameSchema`, `IdSchema`, `TrackSchema`, and specialist schema for dynamic members.

- [ ] **Step 5: Implement conditional YAML Document mutation**

Inside `withLock(paths.lock, ...)`:

1. read raw;
2. compare `configRevision(raw)` with `patch.revision`;
3. `YAML.parseDocument(raw, { keepSourceTokens: true })`;
4. apply each typed change with `document.setIn`/`deleteIn`;
5. convert the document to plain data;
6. strip only `LEGACY_CONFIG_KEYS` for validation, not from the document;
7. validate with `ConfigSchema`;
8. call `writeTextAtomic(paths.config, String(document))`;
9. re-read and validate;
10. return the new content revision.

Map syntax/schema errors to `ConfigMutationError('invalid', zodIssue.path)` without putting the original prose on the wire.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
cd engine
npx vitest run tests/store/config-mutation.test.ts tests/store/config-store.test.ts tests/web/read.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add engine/src/store/config-mutation.ts engine/src/store/atomic.ts engine/src/web/read.ts engine/tests/store/config-mutation.test.ts engine/tests/web/read.test.ts
git commit -m "feat(config): add conditional comment-preserving mutations"
```

---

### Task 4: Expose config mutation through the guarded web write door

**Files:**
- Modify: `engine/src/web/writes.ts`
- Modify: `engine/src/web/codes.ts`
- Modify: `engine/src/web/protocol.ts`
- Modify: `engine/tests/web/writes.test.ts`
- Modify: `engine/tests/web/boundary.test.ts`
- Modify: `engine/tests/web/locales.test.ts`

**Interfaces:**
- Consumes: `ConfigPatchSchema`, `mutateConfig(projectDir, patch)`.
- Produces:

```ts
type ConfigWrite = {
  kind: 'config.patch'
  revision: string
  changes: ConfigChange[]
}

type WriteResult =
  | { ok: true }
  | { ok: false; code: WebCode; field?: string }
```

- [ ] **Step 1: Write failing guarded-write tests**

Add an integration test that writes a comment-bearing config through `applyWrite`, then reads it back and verifies both the semantic value and comment. Add stale and invalid cases that leave the whole `.mjloop` tree byte-identical.

Extend the schema test to reject:

```ts
{ kind: 'config.patch', revision, changes: [{ kind: 'raw', path: '../state.json', value: 'x' }] }
```

Update the boundary test so `mutateConfig` is imported by `writes.ts` only while `writeConfig`, raw atomic writers, and evidence-producing operations remain forbidden.

- [ ] **Step 2: Run tests and verify the expected failures**

Run:

```bash
cd engine
npx vitest run tests/web/writes.test.ts tests/web/boundary.test.ts
```

Expected: FAIL because `WriteSchema` has no `config.patch` branch and the boundary has no dedicated allowlist.

- [ ] **Step 3: Add the fourth typed handler**

Add:

```ts
z.strictObject({
  kind: z.literal('config.patch'),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  changes: ConfigChangeSchema.array().min(1).max(100),
})
```

Map `ConfigMutationError.kind` to:

- stale → `write.stale.config`;
- invalid → `write.invalid.config` plus a bounded dotted `field`;
- missing/other → `write.failed`.

Do not return parser messages.

- [ ] **Step 4: Add closed codes and translations**

Add `write.stale.config`, `write.invalid.config`, and `write.ok.config` to `WEB_CODES` and both locale files. Keep `locales.test.ts` exhaustive.

- [ ] **Step 5: Run guarded-write, boundary, locale, and type tests**

Run:

```bash
cd engine
npx vitest run tests/web/writes.test.ts tests/web/boundary.test.ts tests/web/locales.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add engine/src/web/writes.ts engine/src/web/codes.ts engine/src/web/protocol.ts engine/tests/web/writes.test.ts engine/tests/web/boundary.test.ts engine/src/web/public/locales/en.json engine/src/web/public/locales/ar.json
git commit -m "feat(web): expose safe project config writes"
```

---

### Task 5: Build the project configuration editor

**Files:**
- Modify: `engine/src/web/public/index.html`
- Modify: `engine/src/web/public/panels/config.js`
- Modify: `engine/src/web/public/ui/writes.js`
- Modify: `engine/src/web/public/css/50-controls.css`
- Modify: `engine/src/web/public/css/60-panels.css`
- Modify: `engine/src/web/public/locales/en.json`
- Modify: `engine/src/web/public/locales/ar.json`
- Modify: `engine/tests/web/panels.test.ts`
- Modify: `engine/tests/web/discipline.test.ts`
- Modify: `engine/tests/web/locales.test.ts`

**Interfaces:**
- Consumes: `/api/config` response `{ raw, parsed, invalid, revision }`, `submit({ kind: 'config.patch', ... })`.
- Produces: uncontrolled forms whose submit action emits the minimal typed changes relative to the fetched parsed config.

- [ ] **Step 1: Write failing UI behavior tests**

Use the real shipped HTML and `mountConfig()`:

```ts
it('submits only changed config fields against the displayed revision', async () => {
  serve({ '/api/config': { ...configView(), revision: 'a'.repeat(64) } })
  reveal('panel-config')
  const editor = mountConfig()
  draw(emptySnapshot())
  await vi.waitFor(() => expect(editor.revision()).toBe('a'.repeat(64)))

  const autonomous = document.getElementById('config-edit-autonomous') as HTMLInputElement
  autonomous.checked = true
  expect(editor.patch()).toEqual({
    revision: 'a'.repeat(64),
    changes: [{ kind: 'root', key: 'autonomous', value: true }],
  })
})
```

Add tests for:

- unchanged form refuses submission;
- verify commands map blank text to `null`;
- specialist rows support auto/always/never/remove;
- a track editor emits a whole `TrackSchema`-shaped value;
- after a config receipt the form waits for the next revision before reporting saved;
- controls are disabled when config is invalid or a write is pending;
- every control has an accessible label.

- [ ] **Step 2: Run UI tests and verify missing controls/API failures**

Run:

```bash
cd engine
npx vitest run tests/web/panels.test.ts tests/web/discipline.test.ts
```

Expected: FAIL because Config is read-only and `mountConfig` exposes no patch API.

- [ ] **Step 3: Add sectioned editor markup**

Add forms for:

- behavior and limits;
- verify commands and policy;
- gates;
- specialists;
- tracks.

Keep raw YAML inside the existing read-only `<details>`. Add a persistent callout that changes apply to the next run because the active run uses its pinned config.

Inputs remain uncontrolled: set their initial values only when a newly fetched revision replaces the editor model. Do not assign `.value` or `.checked` on every snapshot draw.

- [ ] **Step 4: Derive minimal typed changes**

In `mountConfig`, keep:

```js
let model = null
let revision = null
let mountedRevision = null
```

When a new revision arrives and no write is pending, seed the form once. `patch()` compares each current control against `model` and returns only differences. Validate integers before sending and show localized inline errors without server prose.

Register a `config-save` form action in `app.js` that calls `config.save()`. `save()` calls `submit` and marks the revision pending; the receipt clears pending, and the next config feed revision reseeds the form.

- [ ] **Step 5: Render specialists and tracks with retained templates**

Use keyed templates:

- specialist key: agent name;
- track key: track name.

Lists are comma-separated text controls parsed by trimming, dropping empty items, and preserving order. A removed track emits `{ kind: 'track', track, value: null }`; built-in tracks require an explicit confirmation and the whole resulting config must still pass `ConfigSchema`.

- [ ] **Step 6: Run panel, discipline, locale, write, and type tests**

Run:

```bash
cd engine
npx vitest run tests/web/panels.test.ts tests/web/discipline.test.ts tests/web/locales.test.ts tests/web/writes.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add engine/src/web/public/index.html engine/src/web/public/app.js engine/src/web/public/panels/config.js engine/src/web/public/ui/writes.js engine/src/web/public/css/50-controls.css engine/src/web/public/css/60-panels.css engine/src/web/public/locales/en.json engine/src/web/public/locales/ar.json engine/tests/web/panels.test.ts engine/tests/web/discipline.test.ts engine/tests/web/locales.test.ts
git commit -m "feat(web): edit project loop settings safely"
```

---

### Task 6: Full Slice A verification and documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/usage.md`
- Modify: `docs/usage.ar.md`
- Modify: `docs/superpowers/specs/2026-07-29-mjloop-control-center-design.md` only if implementation evidence requires an “As built” clarification.

**Interfaces:**
- Consumes: completed Tasks 1–5.
- Produces: verified Slice A behavior and user documentation that distinguishes current support from later hub/platform slices.

- [ ] **Step 1: Update user documentation**

Document:

- Current run and Plans navigation behavior.
- Which project settings can be edited.
- Conditional save and stale-write refusal.
- Changes applying to the next run.
- Raw YAML remaining read-only.
- Multi-project terminals and Codex/Gemini adapters being designed but not shipped by Slice A.

- [ ] **Step 2: Run the complete engine suite**

Run:

```bash
cd engine
npm test
npm run typecheck
npm run build
```

Expected: every command exits 0.

- [ ] **Step 3: Run shipment verification**

Run:

```bash
cd engine
npm run verify:ship
```

Expected: all shipment checks pass.

- [ ] **Step 4: Inspect the final diff and worktree**

Run:

```bash
git diff --check
git status --short
git diff --stat HEAD~5..HEAD
```

Confirm only Slice A source, tests, locales, and documentation changed.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md docs/usage.md docs/usage.ar.md docs/superpowers/specs/2026-07-29-mjloop-control-center-design.md
git commit -m "docs: explain the editable mjloop cockpit"
```

- [ ] **Step 6: Record the next implementation boundary**

Create a separate Slice B plan before implementing linked projects, per-project runtimes, multi-terminal layout, or platform adapters. Do not extend this plan with those subsystems.
