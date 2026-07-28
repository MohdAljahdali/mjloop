// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { reconcile } from '../../src/web/public/ui/list.js'

/**
 * The reconciler's contract is not "the right rows end up on screen" — that is
 * easy and `innerHTML` did it. It is "the right rows end up on screen *and the
 * nodes that were already right were not touched*", because everything the
 * cockpit keeps in the DOM — focus, caret, scroll, selection, an open
 * `<details>` — dies with the node that holds it.
 */

interface Item {
  id: string
  label: string
}

const item = (id: string, label = id): Item => ({ id, label })

let host: HTMLElement

beforeEach(() => {
  document.body.innerHTML = '<ul id="host"></ul>'
  host = document.getElementById('host') as HTMLElement
})

function row(): { root: HTMLElement; update: (value: Item) => void } {
  const root = document.createElement('li')
  return {
    root,
    update(value) {
      const next = value.label
      const first = root.firstChild
      if (first !== null && first.nodeType === 3) {
        if (first.nodeValue !== next) first.nodeValue = next
        return
      }
      root.textContent = next
    },
  }
}

const draw = (items: Item[], limit?: number): { shown: number; total: number } =>
  reconcile(host, items, (value) => value.id, row, limit)

const ids = (): string[] => [...host.children].map((node) => node.textContent ?? '')

describe('reconcile', () => {
  it('appends', () => {
    draw([item('a')])
    draw([item('a'), item('b')])
    expect(ids()).toEqual(['a', 'b'])
  })

  it('prepends', () => {
    draw([item('b')])
    draw([item('a'), item('b')])
    expect(ids()).toEqual(['a', 'b'])
  })

  it('removes from the middle', () => {
    draw([item('a'), item('b'), item('c')])
    draw([item('a'), item('c')])
    expect(ids()).toEqual(['a', 'c'])
  })

  it('reverses', () => {
    draw([item('a'), item('b'), item('c')])
    draw([item('c'), item('b'), item('a')])
    expect(ids()).toEqual(['c', 'b', 'a'])
  })

  it('empties', () => {
    draw([item('a'), item('b')])
    draw([])
    expect(host.children).toHaveLength(0)
  })

  it("keeps a row's node across a reorder", () => {
    draw([item('a'), item('b'), item('c')])
    const b = host.children[1]
    draw([item('c'), item('b'), item('a')])
    expect(host.children[1]).toBe(b)
  })

  it('caps at the limit and reports the total', () => {
    const result = draw([item('a'), item('b'), item('c')], 2)
    expect(result).toEqual({ shown: 2, total: 3 })
    expect(ids()).toEqual(['a', 'b'])
  })

  it('mutates nothing when the input is identical twice', async () => {
    const items = [item('a'), item('b'), item('c')]
    draw(items)

    // The assertion that matters. An `insertBefore` on a node already in
    // position still moves it, and a move is still a mutation record — which is
    // how a caret ends up somewhere the user did not put it.
    const records: MutationRecord[] = []
    const observer = new MutationObserver((list) => records.push(...list))
    observer.observe(host, { childList: true, subtree: true, characterData: true, attributes: true })

    draw(items)
    await Promise.resolve()
    observer.disconnect()

    expect(records).toEqual([])
  })
})
