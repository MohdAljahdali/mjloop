/**
 * Config — read-only, and it says so.
 *
 * `writeConfig` serialises the whole parsed document back to YAML, dropping
 * every comment and every key the schema stripped, and it takes no lock —
 * unlike every state and plan write. So this tab reads and never sets, and the
 * page says which file to open instead of pretending otherwise.
 *
 * This milestone shows the two config-shaped facts the snapshot already
 * carries. The tracks, limits, gates and verify commands are a body, and arrive
 * over the read API.
 */
import { phrase, verbatim } from '../ui/dom.js'
import { register } from '../ui/render.js'

export function mountConfig() {
  const node = /** @type {HTMLElement} */ (document.getElementById('panel-config'))
  const design = /** @type {HTMLElement} */ (document.getElementById('config-design'))
  const project = /** @type {HTMLElement} */ (document.getElementById('config-project'))

  register({
    id: 'config',
    node,
    update(snapshot) {
      phrase(design, snapshot.state.design_system ? 'config.design.present' : 'config.design.missing')
      // An absolute path: an identifier, and one that must not be mirrored.
      verbatim(project, snapshot.project)
    },
  })
}
