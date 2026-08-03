/**
 * The reactive skin over `lib/api.ts`'s `feed()`.
 *
 * `feed()` is a plain `update(snapshot)`/`onChange()` pair, DOM-free and
 * store-free on purpose — the old page drove it from `panels/run.js`'s own
 * `register().update`. A component has no such tick; this wires the same
 * feed to the session store's `snapshot` instead, through a `watchEffect` so
 * it re-runs on every broadcast, and a counter ref so `value()`/`error()`
 * becoming reactive costs nothing more than the epoch trick `useI18n` already
 * uses for locale switches.
 */
import { computed, watchEffect, ref, type ComputedRef } from 'vue'
import { feed as createFeed } from '../lib/api.js'
import { snapshot } from '../stores/session.js'
import type { Snapshot } from '../types/protocol.js'

export interface FeedSpec<T> {
  /** The revision this feed follows, or null when there is nothing to fetch. */
  dep: (snapshot: Snapshot) => string | null
  path: (snapshot: Snapshot) => string
}

export interface UseFeed<T> {
  value: ComputedRef<T | null>
  error: ComputedRef<string | null>
}

export function useFeed<T>(spec: FeedSpec<T>): UseFeed<T> {
  const tick = ref(0)
  const held = createFeed<T>({
    dep: spec.dep,
    path: spec.path,
    onChange: () => void tick.value++,
  })

  watchEffect(() => {
    const current = snapshot.value
    if (current !== null) held.update(current)
  })

  return {
    value: computed(() => (tick.value, held.value())),
    error: computed(() => (tick.value, held.error())),
  }
}
