/**
 * Collapsed, docked, fullscreen. `body.dataset.pane` is the whole mechanism and
 * CSS does the rest.
 *
 * `data-pane` must never set `overflow: visible`. `.terminal { overflow: hidden }`
 * is what clips xterm's measuring span, which it parks at `left:-9999em` — in an
 * RTL document that span otherwise gives the entire page a horizontal scrollbar.
 */
import { ref } from 'vue'
import { read as prefs, write as remember } from '../lib/local.js'

export type PaneMode = 'collapsed' | 'docked' | 'full'
const ORDER: readonly PaneMode[] = ['collapsed', 'docked', 'full']

const mode = ref<PaneMode>(prefs().pane)
const view = ref<'session' | 'queue'>('session')
/** True once the reader has chosen a height themselves; nothing may override it after. */
let chosen = false

function apply(next: PaneMode): void {
  mode.value = next
  document.body.dataset['pane'] = next
  remember({ pane: next })
}

export function usePane() {
  return {
    mode,
    view,
    set(next: PaneMode) {
      chosen = true
      apply(next)
    },
    cycle() {
      chosen = true
      apply(ORDER[(ORDER.indexOf(mode.value) + 1) % ORDER.length] ?? 'docked')
    },
    /** Work opens the pane it needs — but never over a height the reader set. */
    follow() {
      if (!chosen && mode.value === 'collapsed') apply('docked')
    },
    /** The reader asked for this one explicitly, so it wins even over their height. */
    reveal() {
      if (mode.value === 'collapsed') apply('docked')
    },
    setView(next: 'session' | 'queue') {
      view.value = next
    },
  }
}
