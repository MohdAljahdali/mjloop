/**
 * The mechanism a comment cannot be: `layersOf` (`lib/trackgraph.ts`) is
 * meant to assign the same wave index `dispatchWaves` (`schemas/config.ts`)
 * would dispatch a track's `required ∪ available` in. A comment saying so
 * does not run; this file does — it imports both and asserts they agree,
 * including on a gated track, where the review that asked for this test
 * found `wouldCycle` and `layersOf` had each drifted from the engine once
 * already (the gate-blind-spot and the silent-cycle findings this test
 * guards against returning).
 */
import { describe, expect, it } from 'vitest'
import { dispatchWaves } from '../../src/schemas/config.js'
import { layout } from '../../src/web/app/lib/trackgraph.js'
import type { Track } from '../../src/schemas/config.js'

const PLAIN: Track = { required: ['a', 'b'], available: ['c'], closing: ['d'], order: [], max_cycles: 5 }
const ORDERED: Track = {
  ...PLAIN,
  order: [
    { agent: 'b', after: ['a'] },
    { agent: 'c', after: ['b'] },
  ],
}
const GATED: Track = { required: ['x', 'y'], available: [], closing: [], order: [], max_cycles: 5, gate: { proven_by: 'x', blocks: ['y'] } }

/** `dispatchWaves`'s wave array, turned into the same {agent -> layer} shape `layout`'s nodes carry. */
function waveLayers(track: Track): Record<string, number> {
  const selected = [...track.required, ...track.available]
  const waves = dispatchWaves(track, selected)
  const byAgent: Record<string, number> = {}
  waves.forEach((wave, index) => {
    for (const agent of wave) byAgent[agent] = index
  })
  return byAgent
}

describe('layout agrees with the engine it draws', () => {
  it('matches dispatchWaves layer-for-layer on an unconstrained, an ordered, and a gated track', () => {
    for (const track of [PLAIN, ORDERED, GATED]) {
      const expected = waveLayers(track)
      const actual = Object.fromEntries(
        layout(track)
          .nodes.filter((node) => node.list !== 'closing')
          .map((node) => [node.agent, node.layer]),
      )
      expect(actual).toEqual(expected)
    }
  })
})
