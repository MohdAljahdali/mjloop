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
 * Only `activePlan` lives here today. `lib/selection.ts` also carries the
 * story filter and the open-story tabs, which have no reactive reader yet;
 * they move here the same way when Stories needs them.
 */
import { ref } from 'vue'
import { activePlan as readActivePlan, setActivePlan as writeActivePlan } from '../lib/selection.js'

const activePlanRef = ref<string | null>(readActivePlan())

export function useSelection() {
  return {
    activePlan: activePlanRef,
    setActivePlan(id: string | null): void {
      writeActivePlan(id)
      activePlanRef.value = id
    },
  }
}
