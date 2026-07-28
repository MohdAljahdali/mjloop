/**
 * The command bar.
 *
 * Every button on this page that starts work ends up here: it composes a loop
 * command and enqueues it. There is one execution model and not a second,
 * weaker one beside it — which is what keeps "replacing the CLI" a non-goal
 * even as the page grows tabs.
 *
 * The input is **uncontrolled**. No renderer assigns to `.value`, so a snapshot
 * arriving mid-sentence cannot eat what is being typed — by construction,
 * rather than by a focus check somebody forgets on the fortieth form.
 */
import { clone, verbatim } from '../ui/dom.js'
import { reconcile } from '../ui/list.js'
import { register } from '../ui/render.js'
import { statusIndex, unmet } from './plans.js'

/** @typedef {import('../../protocol.js').Snapshot} Snapshot */

/**
 * The build commands worth suggesting: the stories that are actually ready.
 *
 * @param {Snapshot} snapshot
 * @returns {string[]}
 */
export function suggestions(snapshot) {
  const statuses = statusIndex(snapshot.plans)
  /** @type {string[]} */
  const out = []
  for (const plan of snapshot.plans) {
    for (const story of plan.stories) {
      if (story.status === 'todo' && unmet(story, statuses).length === 0) {
        out.push(`/mjloop:build ${story.id}`)
      }
    }
  }
  return out
}

/**
 * @returns {{ read: () => string, clear: () => void }}
 */
export function mountLauncher() {
  const form = /** @type {HTMLElement} */ (document.getElementById('command-form'))
  const input = /** @type {HTMLInputElement} */ (document.getElementById('command'))
  const list = /** @type {HTMLElement} */ (document.getElementById('command-suggestions'))

  register({
    id: 'launcher',
    node: form,
    update(snapshot) {
      reconcile(
        list,
        suggestions(snapshot),
        (command) => command,
        () => {
          const { root, slots } = clone('tpl-suggestion')
          return {
            root,
            /** @param {string} command */
            update(command) {
              const option = slots['option'] ?? root
              // A command is an identifier all the way down — a slash command
              // and a story id. Never through `Intl`.
              verbatim(option, command)
              option.setAttribute('value', command)
            },
          }
        },
        50,
      )
    },
  })

  return {
    read: () => input.value.trim(),
    clear: () => {
      // A user action, not a render. This is the only assignment to `.value`
      // anywhere on the page, and it happens because the person pressed Run.
      input.value = ''
    },
  }
}
