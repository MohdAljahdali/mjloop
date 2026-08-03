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

/**
 * Reads storage and stamps `body.dataset.pane` with the mode it holds.
 *
 * `index.html`'s static markup opens on `data-pane="docked"` (see the comment
 * there), and nothing else writes the attribute until a reader acts — so a
 * reader who left the pane collapsed reloads to a page that looks docked
 * until they touch it. `ui/pane.js`'s `mountPane()` closes the same gap by
 * opening with `setPane(prefs().pane)`.
 *
 * This must re-read storage rather than trust `mode`'s module-load value:
 * `main.ts` imports `App.vue` — and with it `usePane.ts`, whose module body
 * runs `ref(prefs().pane)` immediately — *before* `installStorage()` runs.
 * At that point `local.ts`'s `store` is still null, `safeGet()` returns null,
 * and `mode` would be pinned to the `'collapsed'` default forever. Reading
 * again here, after storage is installed and once the terminal has mounted
 * (`App.vue` calls this from `onMounted`), is what actually restores it.
 *
 * Distinct from `set()`: applying a remembered height at boot is not the
 * reader choosing one just now, so `chosen` stays false and `follow()` can
 * still open a collapsed pane once work starts.
 */
export function bootPane(): void {
  mode.value = prefs().pane
  document.body.dataset['pane'] = mode.value
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
    /**
     * The reader asked for this one explicitly, so it wins even over their
     * height. `chosen` is set here too, on the same logic `cycle()` already
     * follows: an explicit action, not a side effect for a later automatic
     * one (`follow()`) to override. `ui/pane.js`'s `reveal()` argues the case.
     */
    reveal() {
      chosen = true
      if (mode.value === 'collapsed') apply('docked')
    },
    setView(next: 'session' | 'queue') {
      view.value = next
    },
  }
}
