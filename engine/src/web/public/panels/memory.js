/**
 * Memory — browse by kind, tag, time and originating run.
 *
 * Faceting is client-side because it has to be: `memorySearch` supports no
 * filter by kind, tag, time or run, so there is nothing to push to the server.
 * Its `reason` string is engine-authored English prose and deliberately never
 * crosses the wire.
 *
 * Writing a memory is **out of scope**. It would be a fourth write, and
 * `writeMemory` uses flag `wx` with no update and no delete anywhere — a UI
 * that looked editable would be lying.
 */
import { clone, flag, phrase, verbatim } from '../ui/dom.js'
import { feed } from '../lib/api.js'
import { stamp } from '../lib/fmt.js'
import { read as prefs, write as remember } from '../lib/local.js'
import { reconcile } from '../ui/list.js'
import { draw, register } from '../ui/render.js'

/** @typedef {import('../../read.js').MemoryView} MemoryView */

/**
 * @param {readonly MemoryView[]} memories
 * @param {string} query
 * @param {string} kind
 * @returns {MemoryView[]}
 */
export function facet(memories, query, kind) {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 0)
  return memories.filter((memory) => {
    if (kind !== '' && memory.kind !== kind) return false
    if (terms.length === 0) return true
    const haystack = `${memory.id} ${memory.title} ${memory.tags.join(' ')} ${memory.body}`.toLowerCase()
    return terms.every((term) => haystack.includes(term))
  })
}

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
const pick = (id) => /** @type {HTMLElement} */ (document.getElementById(id))

export function mountMemory() {
  const node = pick('panel-memory')
  const empty = pick('memory-empty')
  const host = pick('memory-list')
  const more = pick('memory-more')
  const query = /** @type {HTMLInputElement} */ (document.getElementById('memory-query'))
  const kind = /** @type {HTMLSelectElement} */ (document.getElementById('memory-kind'))

  // Written once at mount, from the remembered preference. No renderer touches
  // it again, so a snapshot arriving mid-word cannot eat what is being typed.
  query.value = prefs().memoryQuery
  let filter = prefs().memoryQuery
  let kindFilter = ''

  query.addEventListener('input', () => {
    filter = query.value
    remember({ memoryQuery: filter })
    draw()
  })
  kind.addEventListener('change', () => {
    kindFilter = kind.value
    draw()
  })

  /** @type {import('../lib/api.js').Feed<MemoryView[]>} */
  const memories = feed({
    dep: (state) => state.revisions.memory,
    path: () => '/api/memory',
    onChange: () => draw(),
  })

  /** The kinds actually present, so the picker never offers an empty filter. */
  let offered = ''

  register({
    id: 'memory',
    node,
    update(state) {
      memories.update(state)
      const all = memories.value() ?? []

      const kinds = [...new Set(all.map((memory) => memory.kind))].sort()
      if (kinds.join(',') !== offered) {
        offered = kinds.join(',')
        kind.replaceChildren(option('', 'memory.allKinds'), ...kinds.map((name) => option(name, null)))
        kind.value = kindFilter
      }

      const shown = facet(all, filter, kindFilter)
      phrase(empty, all.length === 0 ? 'memory.empty' : 'memory.noMatch')
      flag(empty, 'hidden', shown.length > 0)

      const drawn = reconcile(host, shown, (memory) => memory.id, memoryRow)
      flag(more, 'hidden', drawn.shown >= drawn.total)
      if (drawn.shown < drawn.total) phrase(more, 'memory.more', { shown: drawn.shown, total: drawn.total })
    },
  })

  function memoryRow() {
    const { root, slots } = clone('tpl-memory')
    return {
      root,
      /** @param {MemoryView} memory */
      update(memory) {
        const id = slots['id']
        if (id !== undefined) verbatim(id, memory.id)
        // A kind comes from the engine's own enum, but the page does not own a
        // word for each — the memory schema is the engine's to grow.
        const kindSlot = slots['kind']
        if (kindSlot !== undefined) verbatim(kindSlot, memory.kind)
        const title = slots['title']
        if (title !== undefined) verbatim(title, memory.title)
        const at = slots['at']
        if (at !== undefined) verbatim(at, stamp(memory.at))
        const body = slots['body']
        if (body !== undefined) verbatim(body, memory.body)

        const tags = slots['tags']
        if (tags !== undefined) {
          reconcile(tags, memory.tags, (tag) => tag, () => {
            const row = clone('tpl-chip')
            return {
              root: row.root,
              /** @param {string} tag */
              update(tag) {
                const text = row.slots['text']
                if (text !== undefined) verbatim(text, tag)
              },
            }
          })
        }
      },
    }
  }
}

/**
 * @param {string} value
 * @param {string | null} key A locale key, or null to show the value itself.
 * @returns {HTMLOptionElement}
 */
function option(value, key) {
  const node = document.createElement('option')
  node.value = value
  if (key === null) node.textContent = value
  else phrase(node, key)
  return node
}
