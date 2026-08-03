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
import { activeJob, onOutput, send } from '../stores/session.js'

const host = shallowRef<HTMLElement | null>(null)
const term = shallowRef<any>(null)
const fit = shallowRef<any>(null)
/** The job whose output is on screen, which is not always the running one. */
const shown = shallowRef<string | null>(null)

let unsubscribe = () => {}
let observer: ResizeObserver | null = null

/**
 * Follow the queue onto the job that just started, unless the reader has
 * deliberately opened a finished transcript — in which case leave them where
 * they are. Mirrors `ui/pane.js`'s `followQueue`, which `app.js:279` calls on
 * every snapshot with the job id from before and after that snapshot.
 */
watch(activeJob, (next, previous) => {
  if (next !== null && next !== previous && (shown.value === previous || shown.value === null)) {
    shown.value = next
  }
})

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
