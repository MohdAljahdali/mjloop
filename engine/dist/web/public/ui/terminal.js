/**
 * The only module that touches `#terminal`.
 *
 * xterm mounts once at boot and never sits inside a reconciled container — a
 * terminal that is torn down and rebuilt loses its scrollback, its selection and
 * its pty geometry, and it is the one part of this page whose contents the
 * server cannot replay in full.
 */
import { write as remember } from '../lib/local.js'

/** @typedef {'collapsed' | 'docked' | 'full'} PaneMode */

/** @type {any} */
let term = null
/** @type {any} */
let fit = null
/** @type {(cols: number, rows: number) => void} */
let onResize = () => {}

/**
 * @param {object} ports
 * @param {HTMLElement} ports.host
 * @param {(data: string) => void} ports.onData
 * @param {(cols: number, rows: number) => void} ports.onResize
 */
export function mountTerminal(ports) {
  onResize = ports.onResize
  term = new Terminal({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 10_000,
    theme: { background: '#000000', foreground: '#e6edf3' },
  })
  fit = new FitAddon.FitAddon()
  term.loadAddon(fit)
  term.open(ports.host)
  term.onData(ports.onData)

  // A `ResizeObserver` rather than `addEventListener('resize', …)`: collapsing
  // the pane, switching tabs or opening the queue view changes the terminal's
  // box *without* firing a window resize, and xterm then goes on reporting
  // stale columns to the pty — which is what makes a TUI redraw over itself.
  new ResizeObserver(() => refit()).observe(ports.host)
}

export function refit() {
  try {
    fit?.fit()
    if (term !== null) onResize(term.cols, term.rows)
  } catch {
    // Not laid out yet — the pane is collapsed or the tab is hidden. The
    // observer fires again the moment it has a box.
  }
}

/**
 * @param {string} data
 */
export function write(data) {
  term?.write(data)
}

/**
 * @param {string} data
 */
export function replace(data) {
  term?.reset()
  term?.write(data)
}

/**
 * Collapsed, docked, fullscreen. `body.dataset.pane` is the whole mechanism and
 * CSS does the rest.
 *
 * `data-pane` must never set `overflow: visible`. `.terminal { overflow: hidden }`
 * is what clips xterm's measuring span, which it parks at `left:-9999em` — in an
 * RTL document that span otherwise gives the entire page a horizontal scrollbar.
 *
 * @param {PaneMode} mode
 */
export function setPane(mode) {
  document.body.dataset['pane'] = mode
  remember({ pane: mode })
  refit()
}

/** @returns {PaneMode} */
export function pane() {
  const held = document.body.dataset['pane']
  return held === 'collapsed' || held === 'full' ? held : 'docked'
}
