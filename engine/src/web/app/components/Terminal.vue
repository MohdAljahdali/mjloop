<script setup lang="ts">
/**
 * The only component that touches xterm, and the only one that opts out of
 * reactivity on purpose.
 *
 * xterm mounts once and is never inside a re-rendered container: a terminal
 * that is torn down and rebuilt loses its scrollback, its selection and its pty
 * geometry, and it is the one part of this page whose contents the server
 * cannot replay in full.
 */
import { onBeforeUnmount, onMounted, shallowRef, watch } from 'vue'
import { usePane } from '../composables/usePane.js'
import { activeJob, onOutput, send } from '../stores/session.js'

const host = shallowRef<HTMLElement | null>(null)
const term = shallowRef<any>(null)
const fit = shallowRef<any>(null)
/**
 * The job whose output is on screen, which is not always the running one.
 *
 * Owned by `usePane.ts`, not a private copy: this component must be free to
 * sit under a `v-if` or `KeepAlive` in a later panel without a remount
 * silently resetting what the pane head still names as on screen. `shown`'s
 * own doc comment there carries `followQueue`'s reasoning — `ui/pane.js`'s
 * rule, which used to live here as well as in `ui/pane.js` itself.
 */
const { shown } = usePane()

let unsubscribe = () => {}
let observer: ResizeObserver | null = null

function refit(): void {
  try {
    fit.value?.fit()
    if (term.value !== null) send({ type: 'resize', cols: term.value.cols, rows: term.value.rows })
  } catch {
    // Not laid out yet — the pane is collapsed or the tab is hidden. The
    // observer fires again the moment it has a box.
  }
}

onMounted(() => {
  const instance = new Terminal({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 10_000,
    theme: { background: '#000000', foreground: '#e6edf3' },
  })
  const addon = new FitAddon.FitAddon()
  instance.loadAddon(addon)
  if (host.value !== null) instance.open(host.value)
  // Typing reaches the pty only while the live job is the one on screen.
  instance.onData((data: string) => {
    if (shown.value !== null && shown.value === activeJob.value) send({ type: 'input', data })
  })
  term.value = instance
  fit.value = addon

  /**
   * `Pane.vue` binds `:hidden="pane.shown.value === null"` on this
   * component's root, which is `true` at boot — nothing is shown yet, so
   * `instance.open(host)` above just ran against a `display: none` box, and
   * xterm caches its character metrics from nothing (measured:
   * `.xterm-screen` 0x0). The foundation's own browser check measured
   * 1440x240 over 16 rows at boot, because the old page opens `#terminal`
   * un-hidden and only applies `hidden` in a pass that runs after
   * `mountPane()` — ordering, not markup, is what kept it laid out. This
   * restores `ui/pane.js:76`'s explicit `refit()` (also `follow()`'s and
   * `reveal()`'s own calls) the deterministic way: `shown` transitioning
   * away from `null` is what `followQueue` and a `'replace'` frame both
   * funnel every one of those call sites through, so watching it here
   * covers `setView`, `follow` and `reveal` at once, without this component
   * reaching back into any of them.
   *
   * `flush: 'post'` so this runs after Vue has already patched `.terminal`'s
   * `hidden` attribute off — `fit()` measuring a still-`display: none` box
   * would be the exact bug this exists to fix, just moved one line down.
   *
   * `immediate: true`, and declared here rather than at the top of `<script
   * setup>`: unreachable today, since `Terminal` only ever mounts once with
   * `shown` still `null` — but the moment this component sits under a
   * `v-if`, a remount with a job already on screen must refit too, or the
   * newly-opened xterm instance repeats the exact boot-time bug this
   * watcher exists to fix. Declaring the watch before `term`/`fit` are
   * assigned would fire that immediate call against nothing to fit; here it
   * runs after `open()` and after `term.value`/`fit.value` are set, so a
   * remount with `shown` already non-null refits the newly-opened instance
   * correctly. With `shown === null` the callback is a no-op, so this costs
   * nothing in the common (first-mount) case.
   *
   * The `ResizeObserver` below stays as the backstop it already was for the
   * cases this does not name explicitly (a view switch that does not change
   * `shown`, a pane mode change) — confirmed in a browser to repair the box
   * on its own, just not deterministically enough to assert in a test.
   */
  watch(
    shown,
    (next) => {
      if (next !== null) refit()
    },
    { flush: 'post', immediate: true },
  )

  // A ResizeObserver rather than a window resize listener: collapsing the pane,
  // switching tabs or opening the queue view changes the terminal's box without
  // firing a window resize, and xterm then reports stale columns to the pty —
  // which is what makes a TUI redraw over itself.
  if (host.value !== null && typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => refit())
    observer.observe(host.value)
  }

  unsubscribe = onOutput((frame) => {
    if (frame.kind === 'replace') {
      // `usePane.ts` has its own `onOutput` subscriber that also sets `shown`
      // on a `'replace'` frame, registered earlier (its module body runs at
      // import time, before this `onMounted`), so this write is redundant in
      // practice today. It is repeated here anyway rather than left implicit:
      // idempotent, writes the same value, and leaves nothing here depending
      // on subscriber registration order to stay correct.
      shown.value = frame.jobId
      instance.reset()
      instance.write(frame.data)
      return
    }
    // A chunk from any job but the one on screen is dropped, not adopted —
    // `app.js:285`'s `if (message.jobId === shownJob()) write(...)` applies
    // even while nothing is shown yet (`shown === null` matches no jobId).
    if (frame.jobId !== shown.value) return
    instance.write(frame.data)
  })
})

onBeforeUnmount(() => {
  unsubscribe()
  observer?.disconnect()
})
</script>

<template>
  <!--
    No `data-pane` here. The old page's whole mechanism is `body[data-pane]` —
    `40-terminal.css` keys every mode off that attribute on `<body>`, not off
    anything on `.terminal` itself — and `usePane.ts` already sets it. An
    attribute on this div would be dead weight the sheet never reads.
  -->
  <div class="terminal" ref="host" dir="ltr"></div>
</template>
