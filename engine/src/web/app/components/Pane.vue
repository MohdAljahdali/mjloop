<script setup lang="ts">
/**
 * The terminal pane: its two views, its three modes, and the job it shows.
 *
 * Ported from `ui/pane.js`. Owns `.pane` and the elements that are never
 * hidden by a view switch (`PaneHead`), the two views (the session view,
 * built here around the unchanged `Terminal`, and `QueueView`), and the
 * command bar (`Launcher`).
 *
 * `Terminal` moves in from `App.vue` **unchanged** — same component, same
 * mount timing, no `v-if` above it and no `:key` on it: its scrollback,
 * selection and pty geometry are the one thing the server cannot replay.
 * `App.vue`'s `onMounted` still calls `bootPane()` after every descendant has
 * mounted (Vue mounts children before their parent's own `onMounted`, however
 * deep the nesting), so the ordering `40-terminal.css`'s boot state depends on
 * — the terminal opening into an already laid-out box — is unchanged by this
 * component sitting between them.
 */
import { computed, watch } from 'vue'
import { useI18n } from '../composables/useI18n.js'
import { usePane } from '../composables/usePane.js'
import { activeJob, send } from '../stores/session.js'
import Launcher from './Launcher.vue'
import PaneHead from './PaneHead.vue'
import QueueView from './QueueView.vue'
import Terminal from './Terminal.vue'

const { t } = useI18n()
const pane = usePane()

// Work opens the pane it needs. `app.js:279-281`: called once per job, only
// when the session was idle just before — never on every snapshot, or a
// still-running job would re-trigger it on each broadcast.
watch(activeJob, (next, previous) => {
  if (previous === null && next !== null) pane.follow()
})

/**
 * `Terminal`'s own box must stay the exact flex child `.view` expects
 * (`app.css`'s `.terminal { flex: 1; min-height: 0 }`) — `40-terminal.css`
 * has no rule for a wrapper, so one that generated a box would collapse to
 * zero and take the terminal's box down with it. `display: contents` makes
 * this wrapper transparent to that layout — `.terminal` becomes `.view`'s
 * flex item exactly as it did as a direct child in `index.html`. `hidden`
 * (native, no inline style) is what removes it instead, the same as
 * `flag(terminal, 'hidden', shown === null)` used to.
 */
const wrapStyle = computed(() => (pane.shown.value === null ? undefined : { display: 'contents' }))

function onAttach(jobId: string): void {
  // `app.js`'s `job-attach` handler, in the same order: the write first, then
  // the two hiding places `reveal()`'s own comment names — `setView` for the
  // queue view covering `#view-session-body`, `reveal()` for a collapsed pane.
  send({ type: 'attach', jobId })
  pane.setView('session')
  pane.reveal()
}
</script>

<template>
  <section class="pane">
    <PaneHead />

    <div class="pane-body">
      <div class="view" id="view-session-body" :hidden="pane.view.value !== 'session'">
        <p class="empty" id="terminal-empty" :hidden="pane.shown.value !== null">{{ t('terminal.idle') }}</p>
        <!-- Pinned ltr whatever the ui language is: claude's output is box
             drawing and aligned columns, and mirroring it destroys both. The
             pin itself lives on `.terminal` in `Terminal.vue` and in
             `app.css`; nothing here repeats it. -->
        <div class="terminal-wrap" :hidden="pane.shown.value === null" :style="wrapStyle">
          <Terminal />
        </div>
      </div>

      <QueueView :hidden="pane.view.value !== 'queue'" @attach="onAttach" />
    </div>

    <Launcher />
    <small class="hint">{{ t('command.hint') }}</small>
  </section>
</template>
