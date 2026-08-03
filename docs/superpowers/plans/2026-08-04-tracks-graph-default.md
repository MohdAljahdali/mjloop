# Tracks Graph Default Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the track graph the view the Tracks tab opens in, and turn its two toggle buttons into a real, keyboard-drivable tablist with the graph first.

**Architecture:** Three files change and nothing else: `Tracks.vue` (default view, tablist markup, keydown handler), `70-graph.css` (the selector the toggle is styled by), and `panel-tracks.test.ts` (its readiness probe now has to survive a panel that no longer opens on the list). `TrackGraph.vue`, `lib/trackgraph.ts`, `lib/config.ts` and every write gate are untouched.

**Tech Stack:** Vue 3 `<script setup>` + TypeScript, `@vue-flow/core@1.48.2`, Vitest + `@vue/test-utils` + happy-dom, plain CSS with logical properties.

**Spec:** `docs/superpowers/specs/2026-08-04-tracks-graph-default-design.md`

## Global Constraints

- **Working directory is `engine/`** for every `npm` command in this plan.
- **The ids `#tracks-view-graph` and `#tracks-view-list` never change.** Existing tests reach the toggle by them.
- **No new translation keys.** The three the toggle needs already exist in both `locales/en.json` and `locales/ar.json`: `config.trackView`, `config.viewGraph`, `config.viewList`. Adding a key to only one locale fails `tests/web/i18n.test.ts`.
- **Stylesheets use logical properties only.** `discipline.test.ts`'s `describe('rtl')` walks every file in `src/web/app/styles/` and rejects `margin/padding/border-left|right` and bare `left:`/`right:`. Write `border-block-end`, `margin-inline-end` — never `border-bottom` alone where a physical side is meant, and never `left`/`right`.
- **The page keeps exactly two live regions** (`Toasts.vue`, `Banners.vue`). Do not add `aria-live` or `role="status"` anywhere in this plan — `discipline.test.ts` fails on a third.
- **`engine/dist/` is tracked in git.** The last task rebuilds it and commits it. A change that never reaches `dist/web/` is invisible to the installed plugin, which is the whole defect this plan closes.
- **Arabic is a shipped locale**, so every direction-sensitive behaviour reads `document.documentElement.dir` rather than assuming `ltr`.

---

## File Structure

| File | Responsibility after this plan |
|---|---|
| `src/web/app/panels/Tracks.vue` | Modify. Owns which view is showing, the tablist and its keyboard contract. |
| `src/web/app/styles/70-graph.css` | Modify. `.track-view-toggle` reads as tabs; selector keys off `aria-selected`. |
| `tests/web/panel-tracks.test.ts` | Modify. Readiness helper + two new assertions. |
| `src/web/app/components/TrackGraph.vue` | **Unchanged.** |
| `src/web/app/lib/trackgraph.ts` | **Unchanged.** |

---

### Task 1: The graph is what the panel opens in

Flipping the default breaks 21 tests at once, because every one of them waits for `.track-editor` — an element that only exists inside the list view — as its "the config finished loading" probe. The flip and the probe therefore move together: split apart, the first half leaves the suite red for a whole task, which is not a state a reviewer can gate on.

**Files:**
- Modify: `engine/src/web/app/panels/Tracks.vue:120-132`
- Test: `engine/tests/web/panel-tracks.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `const trackView = ref<'graph' | 'list'>('graph')` and, in the test file, two helpers later tasks reuse:
  - `ready(wrapper: VueWrapper): Promise<void>` — resolves once the loaded document has drawn a track in whichever view is showing.
  - `readyList(wrapper: VueWrapper): Promise<void>` — `ready`, then switches to the list if it is not already showing.

- [ ] **Step 1: Write the failing test**

Add this `it` as the **first** entry inside the existing `describe('the graph view (TrackGraph.vue)')` block (it currently begins at `panel-tracks.test.ts:633`):

```ts
    it('opens on the graph, so the reader sees it without finding a toggle first', async () => {
      serve({ '/api/config': configView({ tracks: { build: { required: ['builder'], max_cycles: 5 } } }) })
      const { Tracks } = await boot()
      const wrapper = mount(Tracks)
      await vi.waitFor(() => expect(wrapper.find('.track-graph').exists()).toBe(true))

      // Not merely "the graph is present": the list is the thing that used to
      // be here, and its absence is what proves the default moved rather than
      // both views rendering at once.
      expect(wrapper.find('#config-track-editors').exists()).toBe(false)
    })
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd engine && npx vitest run tests/web/panel-tracks.test.ts -t 'opens on the graph'
```

Expected: FAIL — `vi.waitFor` times out because `.track-graph` never appears while the panel still opens on the list.

- [ ] **Step 3: Flip the default**

In `src/web/app/panels/Tracks.vue`, replace line 132:

```ts
const trackView = ref<'list' | 'graph'>('list')
```

with:

```ts
const trackView = ref<'graph' | 'list'>('graph')
```

Then replace the docstring above it (lines 120-131) so it no longer says the list is what the panel opens in:

```ts
/**
 * Graph or list — a second lens on the same `tracks:` half of the draft, not
 * a second editor. Switching does not touch `draft` itself, only which
 * component reads it, which is why `#config-track-editors` reappears intact
 * the moment this flips to `'list'`: nothing here ever unmounts the list's
 * own state, `Tracks.vue`'s draft it reads.
 *
 * The panel opens on the graph because a track *is* a graph — layers, order
 * edges and a gate — and a reader answering "what shape is this track" gets
 * it in one look rather than from three chip rows. The graph itself still
 * has no keyboard path; a drag canvas cannot get one the way a button or a
 * combobox can. What makes that acceptable as a default is the tablist
 * below: it is the first focusable control in this region, it carries
 * `role="tab"` so a screen reader announces both views, and one arrow key
 * from it reaches the list, which remains the complete editor. See
 * `discipline.test.ts`'s own "keyboard before pointer" describe block.
 *
 * Held in the component, not the hash: `App.vue` keeps every panel under
 * `<KeepAlive>`, so the reader's choice survives a trip through another tab
 * without a router entry that would make "which lens" as linkable as "which
 * tab", which it is not.
 */
```

- [ ] **Step 4: Add the readiness helpers to the test file**

In `tests/web/panel-tracks.test.ts`, add these two functions immediately after the existing `boot()` function (which ends around line 100 — put them after its closing brace and before the first `describe`):

```ts
/**
 * The panel is loaded once the document it fetched has drawn a track. Which
 * element that is depends on the view showing, and the view showing is a
 * product decision that has already moved once — so this probe accepts
 * either rather than pinning the suite to whichever one is currently the
 * default.
 */
async function ready(wrapper: ReturnType<typeof mount>): Promise<void> {
  await vi.waitFor(() => expect(wrapper.find('.track-editor, .track-graph').exists()).toBe(true))
}

/** Loaded, and showing the list — for every assertion about the list editor. */
async function readyList(wrapper: ReturnType<typeof mount>): Promise<void> {
  await ready(wrapper)
  if (!wrapper.find('#config-track-editors').exists()) {
    await wrapper.get('#tracks-view-list').trigger('click')
    await nextTick()
  }
  await vi.waitFor(() => expect(wrapper.find('.track-editor').exists()).toBe(true))
}
```

- [ ] **Step 5: Point every list assertion at `readyList`**

Replace every occurrence of this line in `tests/web/panel-tracks.test.ts`:

```ts
      await vi.waitFor(() => expect(wrapper.find('.track-editor').exists()).toBe(true))
```

with:

```ts
      await readyList(wrapper)
```

There are 17 of them, at lines 142, 184, 218, 268, 289, 307, 329, 368, 390, 419, 440, 479, 500, 526, 541, 727 and one inside the graph describe at 697. Line 583 is the same call on a differently-named wrapper — replace `await vi.waitFor(() => expect(tracksWrapper.find('.track-editor').exists()).toBe(true))` with `await readyList(tracksWrapper)`.

Four occurrences are **counting** assertions, not readiness probes, and must NOT be replaced — lines 243, 247, 252, 256 (`expect(wrapper.findAll('.track-editor')).toHaveLength(n)`). Leave them exactly as they are; add a single `await readyList(wrapper)` before the first of them if that `it` does not already have one.

Three occurrences sit inside the graph describe at lines 642, 660 and 680, each followed by `await wrapper.get('#tracks-view-graph').trigger('click')`. Replace both lines of each pair with:

```ts
      await ready(wrapper)
```

The click is now redundant — the panel already opens on the graph — and leaving a click on the already-selected tab in place would let the test pass even if the default silently flipped back.

- [ ] **Step 6: Retarget the "list stays reachable" test**

The existing `it('keeps the list view reachable, because the graph is not keyboard-drivable')` (line 693) asserts the old direction. Replace its body's view-switching half so it reads from the new default:

```ts
    it('keeps the list view reachable, because the graph is not keyboard-drivable', async () => {
      serve({ '/api/config': configView({ tracks: { build: { required: ['builder'], max_cycles: 5 } } }) })
      const { Tracks } = await boot()
      const wrapper = mount(Tracks)
      await ready(wrapper)

      expect(wrapper.find('#config-track-editors').exists()).toBe(false)

      await wrapper.get('#tracks-view-list').trigger('click')
      await nextTick()
      expect(wrapper.find('#config-track-editors').exists()).toBe(true)

      // And back — the graph is not a one-way door either.
      await wrapper.get('#tracks-view-graph').trigger('click')
      await nextTick()
      expect(wrapper.find('.track-graph').exists()).toBe(true)
    })
```

- [ ] **Step 7: Run the whole file**

```bash
cd engine && npx vitest run tests/web/panel-tracks.test.ts
```

Expected: PASS, every test in the file. If a test times out inside `readyList`, it is asserting on the list without having called it — add the call.

- [ ] **Step 8: Run the rest of the suite**

```bash
cd engine && npm test
```

Expected: PASS. `panel-config.test.ts` also mentions `.track-editor`, but only to assert `Config.vue` no longer carries it, so it is unaffected.

- [ ] **Step 9: Commit**

```bash
git add engine/src/web/app/panels/Tracks.vue engine/tests/web/panel-tracks.test.ts
git commit -m "feat(web): the tracks tab opens on the graph"
```

---

### Task 2: The toggle becomes a tablist

Two buttons carrying `aria-pressed` inside a `role="group"` announce as a pair of toggle buttons — and look like two ordinary secondary buttons, which is why the graph went unnoticed. This makes them what they actually are.

**Files:**
- Modify: `engine/src/web/app/panels/Tracks.vue` — `script` (new handler, one added import) and `template:306-335`
- Test: `engine/tests/web/panel-tracks.test.ts`

**Interfaces:**
- Consumes: `setView(next: 'graph' | 'list'): void` and `trackView` from Task 1; the `ready` helper from Task 1.
- Produces: `onViewKeydown(event: KeyboardEvent): void` on `Tracks.vue`; DOM contract `#tracks-view-graph` / `#tracks-view-list` carry `role="tab"` and `aria-selected`, their container carries `role="tablist"`, and each view's root carries `role="tabpanel"`.

- [ ] **Step 1: Write the failing test**

Add these two `it` blocks inside `describe('the graph view (TrackGraph.vue)')`, after the `opens on the graph` test from Task 1:

```ts
    it('names the two views as tabs, with the graph selected first', async () => {
      serve({ '/api/config': configView({ tracks: { build: { required: ['builder'], max_cycles: 5 } } }) })
      const { Tracks } = await boot()
      const wrapper = mount(Tracks)
      await ready(wrapper)

      const strip = wrapper.get('.track-view-toggle')
      expect(strip.attributes('role')).toBe('tablist')
      // Source order is the reading order a screen reader and a Tab press
      // both follow, so "graph first" is an assertion about the markup, not
      // only about which one is selected.
      expect(strip.findAll('[role="tab"]').map((tab) => tab.attributes('id'))).toEqual([
        'tracks-view-graph',
        'tracks-view-list',
      ])
      expect(wrapper.get('#tracks-view-graph').attributes('aria-selected')).toBe('true')
      expect(wrapper.get('#tracks-view-list').attributes('aria-selected')).toBe('false')
      // Roving tabindex: one stop in the tab order, not two.
      expect(wrapper.get('#tracks-view-graph').attributes('tabindex')).toBe('0')
      expect(wrapper.get('#tracks-view-list').attributes('tabindex')).toBe('-1')
      expect(wrapper.get('#tracks-graph-view').attributes('role')).toBe('tabpanel')
      expect(wrapper.get('#tracks-graph-view').attributes('aria-labelledby')).toBe('tracks-view-graph')
    })

    it('moves between the two tabs on an arrow key, in whichever direction the page runs', async () => {
      serve({ '/api/config': configView({ tracks: { build: { required: ['builder'], max_cycles: 5 } } }) })
      const { Tracks } = await boot()
      const wrapper = mount(Tracks, { attachTo: document.body })
      await ready(wrapper)

      // ltr: the list sits after the graph, so ArrowRight reaches it.
      document.documentElement.dir = 'ltr'
      await wrapper.get('.track-view-toggle').trigger('keydown', { key: 'ArrowRight' })
      await nextTick()
      expect(wrapper.get('#tracks-view-list').attributes('aria-selected')).toBe('true')
      expect(wrapper.find('#config-track-editors').exists()).toBe(true)
      expect(document.activeElement?.id).toBe('tracks-view-list')

      // rtl: the same physical key now walks the other way, because the strip
      // is laid out the other way. This is the whole reason the handler reads
      // `dir` instead of hard-coding a direction — the page ships in Arabic.
      document.documentElement.dir = 'rtl'
      await wrapper.get('.track-view-toggle').trigger('keydown', { key: 'ArrowRight' })
      await nextTick()
      expect(wrapper.get('#tracks-view-graph').attributes('aria-selected')).toBe('true')

      document.documentElement.dir = 'ltr'
      wrapper.unmount()
    })
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd engine && npx vitest run tests/web/panel-tracks.test.ts -t 'names the two views as tabs'
cd engine && npx vitest run tests/web/panel-tracks.test.ts -t 'moves between the two tabs'
```

Expected: FAIL — the first because `role` is `group` and not `tablist`; the second because no `keydown` handler exists on the strip.

- [ ] **Step 3: Add the keyboard handler**

In `src/web/app/panels/Tracks.vue`, change the Vue import on line 33 to pull in `nextTick`:

```ts
import { computed, nextTick, ref, watch } from 'vue'
```

Then add this directly below `setView` (which ends at line 136):

```ts
const VIEWS = ['graph', 'list'] as const

/**
 * Arrow, Home and End across the two view tabs — the pattern `Stories.vue`'s
 * own `onStripKeydown` already uses for the work-tab strip, on a fixed pair
 * instead of a live list.
 *
 * The arrows are read through `dir` rather than mapped to fixed views: the
 * strip is laid out by the document's direction, so in Arabic the tab that
 * is physically to the right of the graph is the one *before* it. A handler
 * that hard-coded `ArrowRight -> list` would move the selection away from
 * the key the reader pressed on half the locales this page ships in.
 *
 * Activation follows focus, as it does in `Stories.vue`: with two panels and
 * no fetch behind either, there is nothing for a deferred activation to
 * save.
 */
function onViewKeydown(event: KeyboardEvent): void {
  const rtl = document.documentElement.dir === 'rtl'
  const forward = rtl ? 'ArrowLeft' : 'ArrowRight'
  const back = rtl ? 'ArrowRight' : 'ArrowLeft'
  const at = VIEWS.indexOf(trackView.value)

  let next: (typeof VIEWS)[number] | undefined
  if (event.key === forward) next = VIEWS[(at + 1) % VIEWS.length]
  else if (event.key === back) next = VIEWS[(at - 1 + VIEWS.length) % VIEWS.length]
  else if (event.key === 'Home') next = VIEWS[0]
  else if (event.key === 'End') next = VIEWS[VIEWS.length - 1]
  else return

  event.preventDefault()
  if (next === undefined) return
  const target = next
  setView(target)
  void nextTick(() => {
    const node = document.getElementById(`tracks-view-${target}`)
    if (node instanceof HTMLElement) node.focus()
  })
}
```

- [ ] **Step 4: Rewrite the toggle markup**

In the same file's template, replace lines 306-309 — the whole `.track-view-toggle` div — with:

```html
      <!-- A tablist, not two toggle buttons: these switch which of two
           panels is rendered, which is what `role="tab"` means and what
           `aria-pressed` does not. Graph first, because it is the view the
           panel opens in and source order is what both a Tab press and a
           screen reader follow. -->
      <div class="track-view-toggle" role="tablist" :aria-label="t('config.trackView')" @keydown="onViewKeydown">
        <button
          type="button"
          id="tracks-view-graph"
          role="tab"
          :aria-selected="trackView === 'graph'"
          aria-controls="tracks-graph-view"
          :tabindex="trackView === 'graph' ? 0 : -1"
          @click="setView('graph')"
        >
          {{ t('config.viewGraph') }}
        </button>
        <button
          type="button"
          id="tracks-view-list"
          role="tab"
          :aria-selected="trackView === 'list'"
          aria-controls="config-track-editors"
          :tabindex="trackView === 'list' ? 0 : -1"
          @click="setView('list')"
        >
          {{ t('config.viewList') }}
        </button>
      </div>
```

- [ ] **Step 5: Make the two views panels**

Still in the template, change the graph section's opening tag (line 313 before this task's edits) to add the tabpanel contract, keeping every existing attribute:

```html
      <section
        v-else
        id="tracks-graph-view"
        class="track-graphs"
        role="tabpanel"
        tabindex="0"
        aria-labelledby="tracks-view-graph"
      >
```

The `:aria-label="t('config.viewGraph')"` that was on this element is **removed** — `aria-labelledby` now names it from the tab itself, and keeping both would leave two competing names on one node.

The list view is rendered by a child component, so its panel role goes on the wrapper the child owns. In `src/web/app/components/TrackEditors.vue:46`, change:

```html
    <div id="config-track-editors" class="track-editors">
```

to:

```html
    <div id="config-track-editors" class="track-editors" role="tabpanel" tabindex="0" aria-labelledby="tracks-view-list">
```

- [ ] **Step 6: Run the two new tests**

```bash
cd engine && npx vitest run tests/web/panel-tracks.test.ts -t 'names the two views as tabs'
cd engine && npx vitest run tests/web/panel-tracks.test.ts -t 'moves between the two tabs'
```

Expected: PASS both.

- [ ] **Step 7: Run the full suite and the type check**

```bash
cd engine && npm test && npm run typecheck
```

Expected: PASS. `discipline.test.ts`'s "keyboard before pointer" is now satisfied more strongly than before — `Tracks.vue` gained a `@keydown` that reads arrow, Home and End keys.

- [ ] **Step 8: Commit**

```bash
git add engine/src/web/app/panels/Tracks.vue engine/src/web/app/components/TrackEditors.vue engine/tests/web/panel-tracks.test.ts
git commit -m "feat(web): the track view toggle becomes a real tablist"
```

---

### Task 3: The strip looks like tabs, and the built bundle carries it

**Files:**
- Modify: `engine/src/web/app/styles/70-graph.css:42-51`
- Modify: `engine/dist/web/**` (generated, committed)

**Interfaces:**
- Consumes: the `aria-selected` attribute Task 2 put on the two buttons.
- Produces: nothing later tasks read.

- [ ] **Step 1: Restyle the strip**

Replace lines 42-51 of `src/web/app/styles/70-graph.css`:

```css
.track-view-toggle {
  display: flex;
  gap: 8px;
  margin-block-end: 12px;
}

.track-view-toggle button[aria-pressed='true'] {
  border-color: var(--accent);
  color: var(--accent);
}
```

with:

```css
/* A tab strip, not two buttons that happen to sit together: a shared rule
 * under the row, and the selected tab breaking it. That shape is what a
 * reader recognises as "two views of one thing" without reading either
 * label — the previous look, two ordinary secondary buttons with a coloured
 * border on the active one, is why the graph went unfound. */
.track-view-toggle {
  display: flex;
  gap: 4px;
  margin-block-end: 12px;
  border-block-end: 1px solid var(--line);
}

.track-view-toggle button {
  border: 0;
  background: none;
  border-radius: 0;
  padding: 8px 14px;
  /* Reserves the selected tab's rule on every tab, so selecting one does not
   * shift the row by a pixel. */
  border-block-end: 2px solid transparent;
  margin-block-end: -1px;
  color: var(--dim);
}

/* Two cues, not one: the colour and the rule under the label. Colour alone
 * would be the only carrier of the selected state for a reader who cannot
 * separate it — `aria-selected` covers the assistive path, this covers the
 * visual one. */
.track-view-toggle button[aria-selected='true'] {
  border-block-end-color: var(--accent);
  color: var(--accent);
}
```

- [ ] **Step 2: Verify the stylesheet still passes the discipline checks**

```bash
cd engine && npx vitest run tests/web/discipline.test.ts
```

Expected: PASS — in particular `describe('rtl')`'s `70-graph.css uses logical properties`. Every property added above is logical (`border-block-end`, `margin-block-end`); there is no `left`, `right`, `border-left` or `border-right`.

The two tokens used above are the ones this project already defines in `app.css`: `--line` (line 24) and `--dim` (line 29). `--accent` is the same token the previous rule used.

- [ ] **Step 3: Run everything**

```bash
cd engine && npm run typecheck && npm test
```

Expected: PASS.

- [ ] **Step 4: Rebuild the shipped bundle**

```bash
cd engine && npm run build
```

Expected: `engine/dist/web/public/assets/` now holds a freshly hashed `index-*.js` and `style-*.css`. Confirm the change actually landed:

```bash
grep -c "tablist" engine/dist/web/public/assets/*.js
```

Expected: at least `1`. If it is `0`, the build did not pick up the panel — do not commit, and re-run the build.

- [ ] **Step 5: Commit**

```bash
git add engine/src/web/app/styles/70-graph.css engine/dist
git commit -m "feat(web): the track view tabs read as tabs, and rebuild"
```

---

## Verification

After Task 3, from `engine/`:

```bash
npm run typecheck && npm test && npm run build
```

Then open the dashboard (`/mjloop:web`), go to the Tracks tab, and confirm three things by eye:

1. The graph is on screen without touching anything.
2. The strip above it reads as two tabs with the graph selected.
3. Tab into the strip, press an arrow key: the list appears and focus lands on its tab.
