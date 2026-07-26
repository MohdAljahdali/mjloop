import { describe, expect, it } from 'vitest'
import { StateSchema, initialState } from '../../src/schemas/state.js'

const NOW = new Date('2026-07-26T10:36:00.000Z')

describe('initialState', () => {
  it('produces a schema-valid uninitialised state', () => {
    const state = initialState(NOW)
    expect(StateSchema.parse(state)).toEqual(state)
    expect(state.status).toBe('idle')
    expect(state.cycle).toBe(0)
    expect(state.run_id).toBeNull()
    expect(state.updated_at).toBe('2026-07-26T10:36:00.000Z')
    expect(state.last_fingerprint).toBeNull()
  })
})

describe('StateSchema', () => {
  it('rejects an unknown top-level key', () => {
    const bad = { ...initialState(NOW), surprise: true }
    expect(StateSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects a negative cycle', () => {
    const bad = { ...initialState(NOW), cycle: -1 }
    expect(StateSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects a schema version other than 1', () => {
    const bad = { ...initialState(NOW), schema: 2 }
    expect(StateSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects a non-ISO updated_at', () => {
    const bad = { ...initialState(NOW), updated_at: 'yesterday' }
    expect(StateSchema.safeParse(bad).success).toBe(false)
  })

  it('accepts a populated running state', () => {
    const state = {
      ...initialState(NOW),
      run_id: '2026-07-26-001',
      track: 'edit',
      status: 'running' as const,
      cycle: 1,
      goal: 'Rename the submit button label',
      current: { plan: null, story: null, stage: 'execute' as const },
      findings: [{ severity: 'low' as const, file: 'src/a.ts', line: 12, claim: 'unused import' }],
      history: [{ cycle: 1, agents: ['editor', 'verifier'], result: 'fail' as const, ref: 'runs/2026-07-26-001--adhoc--edit' }],
    }
    expect(StateSchema.safeParse(state).success).toBe(true)
  })

  it('defaults last_fingerprint to null on a document written before the field existed', () => {
    // StateSchema is strict, so without a default every milestone-1 state.json
    // would fail validation the first time this build reads it.
    const { last_fingerprint, ...withoutField } = initialState(NOW)
    expect(StateSchema.parse(withoutField).last_fingerprint).toBeNull()
  })

  it('accepts a stored fingerprint', () => {
    const state = { ...initialState(NOW), last_fingerprint: 'a'.repeat(64) }
    expect(StateSchema.safeParse(state).success).toBe(true)
  })
})
