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
 *
 * `<KeepAlive>` (`App.vue`) does not pause a deactivated component's own
 * effects — that is exactly what "kept alive" means. Left alone, a panel
 * behind another tab would keep re-running this `watchEffect` on every
 * broadcast (up to 1.25/s) and re-issuing its conditional GET on every
 * revision bump, for as long as the reader has ever visited it once. The
 * deleted page made the opposite call on purpose: `ui/render.js`'s header
 * (`git show 611119c:engine/src/web/public/ui/render.js` — see `App.vue`'s
 * own header for the form) said hidden panels are skipped entirely because
 * the cheapest update is the one that does not run. This composable is the
 * `<KeepAlive>`-era version of that: `onDeactivated` stops the effect
 * outright rather than merely gating what it does, and `onActivated` restarts
 * it — which also catches the panel up, since `feed()`'s own `update()`
 * refetches as soon as it sees a `dep` it has not seen before.
 */
import { computed, watchEffect, ref, onActivated, onDeactivated, type ComputedRef, type WatchHandle } from 'vue'
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

  let handle: WatchHandle | null = null

  // Idempotent, so it is safe to call both from setup (a plain mount, or the
  // component's first activation) and from `onActivated` (a later one) — a
  // running effect is never replaced with a second one.
  function start(): void {
    if (handle !== null) return
    handle = watchEffect(() => {
      const current = snapshot.value
      if (current !== null) held.update(current)
    })
  }

  start()
  // `onActivated`/`onDeactivated` are no-ops on a component with no
  // `<KeepAlive>` ancestor — see the header above — so `start()` above still
  // has to run unconditionally for that case.
  onActivated(start)
  onDeactivated(() => {
    handle?.stop()
    handle = null
  })

  return {
    value: computed(() => (tick.value, held.value())),
    error: computed(() => (tick.value, held.error())),
  }
}
