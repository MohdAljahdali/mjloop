import { describe, expect, it } from 'vitest'
import { layout, wouldCycle } from '../../src/web/app/lib/trackgraph.js'

const PLAIN = { required: ['a', 'b'], available: ['c'], closing: ['d'], order: [], max_cycles: 5 }
const ORDERED = { ...PLAIN, order: [{ agent: 'b', after: ['a'] }, { agent: 'c', after: ['b'] }] }

describe('laying a track out', () => {
  it('lands an agent one layer past its latest predecessor, and an unconstrained agent on the first', () => {
    expect(layout(PLAIN).nodes.filter((node) => node.list !== 'closing').every((node) => node.layer === 0)).toBe(true)
    const byAgent = Object.fromEntries(layout(ORDERED).nodes.map((node) => [node.agent, node.layer]))
    expect(byAgent['a']).toBe(0)
    expect(byAgent['b']).toBe(1)
    expect(byAgent['c']).toBe(2)
  })

  it('places an agent named in two lists once, never twice — TrackSchema permits the overlap, but a node id must still be unique', () => {
    // `required`/`available` naming the same agent is not a shape
    // `TrackSchema.superRefine` refuses (schemas/config.ts:117-255 checks
    // set membership only), so a hand-edited or mid-draft `config.yaml` can
    // reach here with `builder` in both. A second node sharing `id: 'builder'`
    // would be a Vue Flow key collision, not merely a cosmetic duplicate.
    const overlapping = { required: ['a', 'b'], available: ['a'], closing: [], order: [], max_cycles: 5 }
    const nodes = layout(overlapping).nodes
    expect(nodes.map((node) => node.id)).toEqual(['a', 'b'])
    // The earlier listing wins — `required` is walked before `available`.
    expect(nodes.find((node) => node.id === 'a')?.list).toBe('required')
  })

  it('puts closing agents on a layer of their own, past everything else', () => {
    const nodes = layout(ORDERED).nodes
    const closing = nodes.find((node) => node.agent === 'd')
    expect(closing?.layer).toBeGreaterThan(Math.max(...nodes.filter((n) => n.agent !== 'd').map((n) => n.layer)))
  })

  it('emits one edge per predecessor, and draws a gate as its own kind', () => {
    expect(layout(ORDERED).edges.filter((edge) => edge.kind === 'order')).toEqual([
      { id: 'order:a->b', source: 'a', target: 'b', kind: 'order' },
      { id: 'order:b->c', source: 'b', target: 'c', kind: 'order' },
    ])
    const gated = { ...PLAIN, gate: { proven_by: 'a', blocks: ['b'] } }
    expect(layout(gated).edges).toContainEqual({ id: 'gate:a->b', source: 'a', target: 'b', kind: 'gate' })
  })
})

describe('refusing a connection at the moment it is drawn', () => {
  it('refuses an agent naming itself and an edge that closes a cycle, and allows one that does not', () => {
    expect(wouldCycle(ORDERED, 'a', 'a')).toBe(true)
    expect(wouldCycle(ORDERED, 'c', 'a')).toBe(true)
    expect(wouldCycle(ORDERED, 'a', 'd')).toBe(false)
    // A gate is a hidden order edge (`blocks after proven_by`): 'y after x'
    // here. Drawing 'x after y' would close a 2-cycle through that hidden
    // edge, which wouldCycle must refuse even though the edge is not in
    // `order` — see `gateEdges` in trackgraph.ts.
    const gated = { ...PLAIN, gate: { proven_by: 'x', blocks: ['y'] } }
    expect(wouldCycle(gated, 'y', 'x')).toBe(true)
  })
})
