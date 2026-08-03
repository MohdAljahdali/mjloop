import { describe, expect, it } from 'vitest'
import { copyName, hasContract, usage } from '../../src/web/app/lib/agents.js'
import type { Config } from '../../src/schemas/config.js'

const CONFIG = {
  tracks: {
    build: { required: ['builder', 'verifier'], available: ['critic'], closing: ['docs'], max_cycles: 5 },
    fix: {
      required: ['reproducer', 'fixer'],
      available: [],
      closing: [],
      max_cycles: 5,
      gate: { proven_by: 'reproducer', blocks: ['fixer'] },
      map: { drafted_by: 'fixer' },
    },
  },
} as unknown as Config

describe('where an agent is used', () => {
  it('finds every list that names it, including the gate and the map', () => {
    expect(usage(CONFIG, 'fixer')).toEqual([
      { track: 'fix', list: 'required' },
      { track: 'fix', list: 'blocks' },
      { track: 'fix', list: 'map' },
    ])
    expect(usage(CONFIG, 'reproducer')).toEqual([
      { track: 'fix', list: 'required' },
      { track: 'fix', list: 'gate' },
    ])
  })

  it('is empty for an agent no track names, and for a null config', () => {
    expect(usage(CONFIG, 'scribe')).toEqual([])
    expect(usage(null, 'builder')).toEqual([])
  })
})

describe('the output contract', () => {
  it('accepts a fenced json block carrying the status field, rejects a fenced block that is not the contract, and rejects prose about the contract', () => {
    expect(hasContract('text\n\n```json\n{\n  "status": "pass",\n  "summary": "x"\n}\n```\n')).toBe(true)
    expect(hasContract('```json\n{ "foo": 1 }\n```')).toBe(false)
    expect(hasContract('Return the standard contract with a status field.')).toBe(false)
  })
})

describe('naming a derived copy', () => {
  it('appends -copy, then a counter, walking past every taken name', () => {
    expect(copyName([], 'builder')).toBe('builder-copy')
    expect(copyName(['builder-copy'], 'builder')).toBe('builder-copy-2')
    expect(copyName(['builder-copy', 'builder-copy-2'], 'builder')).toBe('builder-copy-3')
  })
})
