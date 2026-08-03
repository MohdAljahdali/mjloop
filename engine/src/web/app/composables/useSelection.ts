/**
 * The reactive skin over `lib/selection.ts`'s `activePlan`.
 *
 * `lib/selection.ts` is per-browser storage, not a Vue ref, so a write to it
 * moves nothing a `watch()` can see. This module keeps one module-level ref
 * mirroring it — the same shape `useI18n.ts`'s epoch ref gives `lib/i18n.ts` —
 * so every reader (today: `Plans.vue` and `App.vue`'s own plan-document pump;
 * later: Stories) sees the same value and the same moment it moves.
 *
 * A module-level singleton, not a per-call `ref()`: two callers of
 * `useSelection()` must observe the one plan being open, not two independent
 * copies that can drift.
 *
 * The ref is seeded lazily, on the first call to `useSelection()`, rather
 * than at module scope. `main.ts`'s `import App from './App.vue'` pulls this
 * module in through App's own import graph before `main.ts`'s body ever
 * reaches `installStorage(localStorage)` — ES module imports are evaluated
 * before the importing module's own statements run. A `ref(readActivePlan())`
 * at module scope would therefore read `lib/local.ts`'s `DEFAULTS` (storage
 * not installed yet) and pin `activePlan` to `null` forever, exactly the bug
 * `usePane.ts`'s own header comment documents for `prefs().pane` and its
 * `bootPane()` fix. `App.vue`'s `<script setup>` body — which calls
 * `useSelection()` first, since App mounts before any child panel — runs
 * only once `createApp(App).mount()` is reached, strictly after
 * `installStorage()`, so seeding there instead is enough; no separate boot
 * function is needed.
 *
 * Only `activePlan` lives here today. `lib/selection.ts` also carries the
 * story filter and the open-story tabs, which have no reactive reader yet;
 * they move here the same way when Stories needs them. `setActivePlan` is
 * this module's alone to call — `lib/selection.ts`'s own export exists for
 * this file and for tests that seed/read raw storage, never for a panel to
 * write through directly, which would leave this ref stale.
 */
import { ref, type Ref } from 'vue'
import { activePlan as readActivePlan, setActivePlan as writeActivePlan } from '../lib/selection.js'

let activePlanRef: Ref<string | null> | null = null

export function useSelection() {
  // First call wins the seed. Every later call — same tick or a different
  // component entirely — reuses the one ref rather than re-reading storage,
  // which matters once a write has moved it: storage and the ref agree by
  // construction, but a second `ref(readActivePlan())` here would not.
  activePlanRef ??= ref<string | null>(readActivePlan())
  return {
    activePlan: activePlanRef,
    setActivePlan(id: string | null): void {
      writeActivePlan(id)
      activePlanRef!.value = id
    },
  }
}
