/**
 * The reactive skin over `lib/selection.ts`: which plan is open, the story
 * work-tabs, and the story filter.
 *
 * `lib/selection.ts` is per-browser storage, not a Vue ref, so a write to it
 * moves nothing a `watch()` can see. This module keeps module-level refs
 * mirroring it — the same shape `useI18n.ts`'s epoch ref gives `lib/i18n.ts` —
 * so every reader (`Plans.vue`, `Stories.vue`, `App.vue`'s own
 * plan-document pump) sees the same value and the same moment it moves.
 *
 * Module-level singletons, not per-call `ref()`s: two callers of
 * `useSelection()` must observe the one selection, not independent copies
 * that can drift.
 *
 * Every ref here is seeded lazily, on the first call to `useSelection()`,
 * rather than at module scope. `main.ts`'s `import App from './App.vue'`
 * pulls this module in through App's own import graph before `main.ts`'s
 * body ever reaches `installStorage(localStorage)` — ES module imports are
 * evaluated before the importing module's own statements run. A
 * `ref(readActivePlan())` at module scope would therefore read
 * `lib/local.ts`'s `DEFAULTS` (storage not installed yet) and pin the ref to
 * a default forever, exactly the bug `usePane.ts`'s own header comment
 * documents for `prefs().pane` and its `bootPane()` fix. `App.vue`'s
 * `<script setup>` body — which calls `useSelection()` first, since App
 * mounts before any child panel — runs only once `createApp(App).mount()`
 * is reached, strictly after `installStorage()`, so seeding there instead is
 * enough; no separate boot function is needed.
 *
 * `setActivePlan`/`setStoryFilter`/`openStory`/`closeStory`/`pinStory`/
 * `reopenStory` are this module's alone to call — `lib/selection.ts`'s own
 * exports exist for this file and for tests that seed/read raw storage,
 * never for a panel to write through directly, which would leave these refs
 * stale. Every mutator re-reads `lib/selection.ts`'s getters afterwards
 * rather than computing the new value locally, so a ref can never disagree
 * with what `read()` would answer.
 *
 * **Not every selection lives here.** `lib/featuredoc.ts` keeps the open
 * feature's own `opened` ref outside this module, deliberately: the old page
 * never persisted which feature was open — it was a plain module variable,
 * reset on every reload — and routing it through `lib/selection.ts` would
 * give it a door into storage the spec never asked for. A selection earns a
 * home here specifically because it is persisted; one that is not stays with
 * whatever module fetches its document.
 */
import { ref, type Ref } from 'vue'
import {
  activePlan as readActivePlan,
  activeStory as readActiveStory,
  closeStory as libCloseStory,
  openStories as readOpenStories,
  openStory as libOpenStory,
  pinStory as libPinStory,
  recentlyClosed as readRecentlyClosed,
  reopenStory as libReopenStory,
  setActivePlan as writeActivePlan,
  setStoryFilter as writeStoryFilter,
  storyFilter as readStoryFilter,
} from '../lib/selection.js'
import type { OpenStory } from '../lib/local.js'

let activePlanRef: Ref<string | null> | null = null
let activeStoryRef: Ref<string | null> | null = null
let storyFilterRef: Ref<string> | null = null
let openStoriesRef: Ref<readonly OpenStory[]> | null = null
let recentlyClosedRef: Ref<readonly string[]> | null = null

export function useSelection() {
  // First call wins the seed. Every later call — same tick or a different
  // component entirely — reuses the one ref rather than re-reading storage,
  // which matters once a write has moved it: storage and the ref agree by
  // construction, but a second `ref(readX())` here would not.
  activePlanRef ??= ref<string | null>(readActivePlan())
  activeStoryRef ??= ref<string | null>(readActiveStory())
  storyFilterRef ??= ref<string>(readStoryFilter())
  openStoriesRef ??= ref<readonly OpenStory[]>(readOpenStories())
  recentlyClosedRef ??= ref<readonly string[]>(readRecentlyClosed())

  return {
    activePlan: activePlanRef,
    setActivePlan(id: string | null): void {
      writeActivePlan(id)
      activePlanRef!.value = id
    },

    activeStory: activeStoryRef,
    storyFilter: storyFilterRef,
    openStories: openStoriesRef,
    recentlyClosed: recentlyClosedRef,

    setStoryFilter(filter: string): void {
      writeStoryFilter(filter)
      storyFilterRef!.value = filter
    },
    /** Open a story tab, or select it if it is already open. */
    openStory(id: string): void {
      libOpenStory(id)
      openStoriesRef!.value = readOpenStories()
      activeStoryRef!.value = readActiveStory()
    },
    closeStory(id: string): void {
      libCloseStory(id)
      openStoriesRef!.value = readOpenStories()
      recentlyClosedRef!.value = readRecentlyClosed()
      activeStoryRef!.value = readActiveStory()
    },
    pinStory(id: string): void {
      libPinStory(id)
      openStoriesRef!.value = readOpenStories()
    },
    /** @returns the id reopened, or null if there was nothing to reopen. */
    reopenStory(): string | null {
      const id = libReopenStory()
      openStoriesRef!.value = readOpenStories()
      recentlyClosedRef!.value = readRecentlyClosed()
      activeStoryRef!.value = readActiveStory()
      return id
    },
  }
}
