/**
 * A strip of tabs a person opens and closes, over things the page has many of.
 *
 * Not `ui/tabs.js`. Those are the seven panels: fixed, URL-addressable, and
 * ordinary anchors precisely so that back and forward move between them. These
 * are a working set — open a story, keep it open, close it when done — which is
 * a different control with a different contract, so it is a second module
 * rather than a generalisation of the first.
 *
 * `ui/tabs.js`'s header records why `role="tablist"` was refused there: it needs
 * arrow-key handling that has to honour text direction, "a real RTL bug for no
 * gain". Here the gain is real — a set that changes cannot be navigated by
 * anchors — so this file takes the bug on deliberately and answers it: the
 * direction is read from the document on every keystroke, so `ArrowRight` means
 * *next* under `dir="ltr"` and *previous* under `dir="rtl"`. That is the whole
 * reason this module has its own Arabic test.
 *
 * It is the page's first keyboard interaction of any kind. Everything else here
 * listens for `click`, `submit`, `input` and `change`, and nothing else authors
 * a `tabindex` except two headings that exist to be focused.
 *
 * Id-agnostic: it knows nothing about stories. It is handed a list and reports
 * what the reader did with it.
 */
import { attr, clone, cls, flag, label as ariaLabel, phrase, verbatim } from './dom.js'
import { reconcile } from './list.js'

/**
 * @typedef {object} WorkTab
 * @property {string} id
 * @property {string} label What the tab reads.
 * @property {boolean} pinned
 * @property {string} [state] An optional status word, styled and announced.
 */

/**
 * @param {object} spec
 * @param {HTMLElement} spec.strip The `role="tablist"` element.
 * @param {() => readonly WorkTab[]} spec.tabs
 * @param {() => string | null} spec.active
 * @param {(id: string) => void} spec.onSelect
 * @returns {{ update: () => void }}
 */
export function mountWorktabs(spec) {
  // One delegated listener on the strip, not one per tab: the rows are
  // reconciled, so a listener bound to a node is a listener bound to a node
  // that may be gone by the next frame.
  spec.strip.addEventListener('keydown', (event) => {
    const key = /** @type {KeyboardEvent} */ (event).key
    const ids = spec.tabs().map((tab) => tab.id)
    if (ids.length === 0) return

    const here = ids.indexOf(spec.active() ?? '')
    const at = here === -1 ? 0 : here
    // Read per keystroke rather than at mount: `app.js` sets `dir` on every
    // locale change, and a strip that decided this once would run backwards for
    // anybody who switched to Arabic without reloading.
    const rtl = document.documentElement.dir === 'rtl'
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight'
    const back = rtl ? 'ArrowRight' : 'ArrowLeft'

    /** @type {string | undefined} */
    let next
    if (key === forward) next = ids[(at + 1) % ids.length]
    else if (key === back) next = ids[(at - 1 + ids.length) % ids.length]
    else if (key === 'Home') next = ids[0]
    else if (key === 'End') next = ids[ids.length - 1]
    else return

    event.preventDefault()
    if (next !== undefined) {
      spec.onSelect(next)
      focusActive()
    }
  })

  function focusActive() {
    const id = spec.active()
    if (id === null) return
    const node = spec.strip.querySelector(`[data-tab="${CSS.escape(id)}"]`)
    if (node instanceof HTMLElement) node.focus()
  }

  return {
    update() {
      const tabs = spec.tabs()
      flag(spec.strip, 'hidden', tabs.length === 0)
      reconcile(spec.strip, tabs, (tab) => tab.id, () => tabRow(() => spec.active()))
    },
  }
}

/**
 * @param {() => string | null} active
 * @returns {{ root: HTMLElement, update: (tab: WorkTab) => void }}
 */
function tabRow(active) {
  const { root, slots } = clone('tpl-worktab')
  return {
    root,
    update(tab) {
      const open = slots['open']
      if (open !== undefined) {
        const selected = active() === tab.id
        open.dataset['tab'] = tab.id
        open.dataset['story'] = tab.id
        attr(open, 'aria-selected', selected ? 'true' : 'false')
        // Roving: exactly one tab in the page's tab order, and the arrows move
        // between them from there. A strip of twelve stories that each cost a
        // Tab press to walk past is a strip nobody keyboards through twice.
        attr(open, 'tabindex', selected ? '0' : '-1')
      }

      const text = slots['label']
      if (text !== undefined) verbatim(text, tab.label)

      const state = slots['state']
      if (state !== undefined) {
        // A word, and a class. Never the class alone: a tab whose only signal
        // is a colour says nothing to a reader who cannot see it, and the
        // project's own rule against colour-only status says so.
        const word = tab.state ?? 'none'
        phrase(state, `story.status.${word}`)
        cls(state, 'status', word)
        flag(state, 'hidden', tab.state === undefined)
      }

      const pin = slots['pin']
      if (pin !== undefined) {
        pin.dataset['story'] = tab.id
        cls(pin, 'pinned', tab.pinned ? 'yes' : 'no')
        ariaLabel(pin, 'aria-label', tab.pinned ? 'story.tab.unpin' : 'story.tab.pin', { id: tab.id })
      }

      const close = slots['close']
      if (close !== undefined) {
        close.dataset['story'] = tab.id
        // A pinned tab has no close button rather than a disabled one: the
        // point of pinning it is that closing is not the next thing you do.
        flag(close, 'hidden', tab.pinned)
        ariaLabel(close, 'aria-label', 'story.tab.close', { id: tab.id })
      }
    },
  }
}
