/**
 * The open feature's document, fetched once for whoever is reading it —
 * `lib/plandoc.ts`, ported to feature briefs.
 *
 * A brief is not on the snapshot — see `protocol.ts`'s own comment for why:
 * it is read over the API and written only through `feature.approve`, so the
 * record has one surface to audit rather than two. `Features.vue` reads this
 * module for its own detail pane, and `FeatureApproveDialog.vue` reads it a
 * second time, live, at the moment a confirmed approval is about to be sent
 * — the same brief, not a copy each of them owns, so the dialog can refuse a
 * stale click the instant the document underneath it moves.
 *
 * The selection itself (`opened`) lives here rather than in
 * `composables/useSelection.ts`: the old page never persisted which feature
 * was open — it was a plain module variable, reset on every reload — and
 * giving it a door into storage now would be a behaviour this port did not
 * ask for. It is a `ref` rather than a bare variable so `App.vue`'s watcher
 * (the same shape `plandoc.ts`'s own caller uses) can track it.
 */
import { ref, type Ref } from 'vue'
import { feed } from './api.js'
import type { Feed } from './api.js'
import type { FeatureDetail, Snapshot } from '../types/protocol.js'

/** The feature whose detail is open, or null. Not persisted — see this file's own header. */
export const opened: Ref<string | null> = ref(null)

let held: Feed<FeatureDetail> | null = null
const listeners: (() => void)[] = []

/**
 * @param onChange Called when the document or its error moved.
 */
export function subscribe(onChange: () => void): void {
  listeners.push(onChange)
}

function announce(): void {
  for (const listener of listeners) listener()
}

/**
 * Open a feature's detail, or close it if it is already open — `toggle`'s
 * whole policy, moved here so both `Features.vue`'s row and its own back
 * button can share one door.
 */
export function toggleFeature(id: string): boolean {
  const closing = opened.value === id
  opened.value = closing ? null : id
  return !closing
}

export function closeFeature(): void {
  opened.value = null
}

/**
 * Called once, by whoever owns the always-visible node that ticks it —
 * `App.vue`, the same as `mountPlanDoc()`.
 */
export function mountFeatureDoc(): { update: (snapshot: Snapshot) => void } {
  // Install, so it clears: a second mount is a second page, and a listener
  // from the first one would keep drawing into DOM nobody is looking at.
  listeners.length = 0
  held = feed<FeatureDetail>({
    dep: (state) => (opened.value === null ? null : `${opened.value}:${state.revisions.features}`),
    path: () => `/api/features/${encodeURIComponent(opened.value ?? '')}`,
    onChange: announce,
  })
  return { update: (snapshot) => held?.update(snapshot) }
}

/**
 * The document, or null while nothing is open or the fetch is in flight.
 */
export function value(): FeatureDetail | null {
  return held?.value() ?? null
}
