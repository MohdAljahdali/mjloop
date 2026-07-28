/**
 * The halt dialog.
 *
 * The one control on this page that gets a confirmation, and it gets one for a
 * reason the others do not have: a halt's inverse is not another permitted
 * write. Everything reversible — an approval, a requeue — goes through without
 * a dialog, because a stale click is refused rather than obeyed and an undo is
 * one press away.
 *
 * A native `<dialog>` opened with `showModal()`, so focus trapping, the
 * backdrop, `Escape` and inertness of the rest of the page are the browser's
 * job. A hand-rolled overlay gets exactly those wrong.
 */
/** The run this dialog is about, captured when it opened. */
let subject = /** @type {string | null} */ (null)

export function mountHaltDialog() {
  const dialog = /** @type {HTMLDialogElement} */ (document.getElementById('halt-dialog'))
  const reason = /** @type {HTMLInputElement} */ (document.getElementById('halt-reason'))

  // The button's own visibility is the rail's job, not a panel registered
  // against the button. `render` skips hidden panels, so a control that starts
  // hidden and is asked to unhide *itself* never gets the chance.

  return {
    /** @param {string | null} runId */
    open(runId) {
      subject = runId
      // Written once, on open, by a user action — never by a renderer. The
      // field is uncontrolled for the rest of its life.
      reason.value = ''
      dialog.showModal()
      reason.focus()
    },
    close() {
      dialog.close()
    },
    /** @returns {{ run: string, reason: string } | null} */
    take() {
      const text = reason.value.trim()
      dialog.close()
      if (subject === null || text.length === 0) return null
      return { run: subject, reason: text }
    },
  }
}
