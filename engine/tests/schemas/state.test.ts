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
    expect(state.reproduction).toBeNull()
    expect(state.cycle_errors).toEqual([])
    expect(state.last_error_fingerprint).toBeNull()
    expect(state.started_at).toBeNull()
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

  it('rejects a track name that could steer a path', () => {
    // The run directory is `<run_id>--<story>--<track>`: the track shares that
    // template with the story id and is bound by the same schema.
    const bad = { ...initialState(NOW), track: '../../../tmp/victim' }
    expect(StateSchema.safeParse(bad).success).toBe(false)
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

  it('defaults reproduction to null on a document written before the field existed', () => {
    const { reproduction, ...withoutField } = initialState(NOW)
    expect(StateSchema.parse(withoutField).reproduction).toBeNull()
  })

  it('accepts a recorded reproduction', () => {
    const state = {
      ...initialState(NOW),
      reproduction: { agent: 'reproducer', cycle: 1, ref: 'npm test -- cache', excerpt: '1 failing' },
    }
    expect(StateSchema.safeParse(state).success).toBe(true)
  })

  it('rejects a reproduction proven in cycle 0', () => {
    const bad = {
      ...initialState(NOW),
      reproduction: { agent: 'reproducer', cycle: 0, ref: 'npm test', excerpt: '' },
    }
    expect(StateSchema.safeParse(bad).success).toBe(false)
  })

  it('defaults the error fields on a document written before they existed', () => {
    const { cycle_errors, last_error_fingerprint, ...withoutFields } = initialState(NOW)
    const parsed = StateSchema.parse(withoutFields)
    expect(parsed.cycle_errors).toEqual([])
    expect(parsed.last_error_fingerprint).toBeNull()
  })

  it('accepts recorded error signatures', () => {
    const state = { ...initialState(NOW), cycle_errors: ['npm test :: N failing'], last_error_fingerprint: 'a'.repeat(64) }
    expect(StateSchema.safeParse(state).success).toBe(true)
  })

  it('rejects an empty signature', () => {
    expect(StateSchema.safeParse({ ...initialState(NOW), cycle_errors: [''] }).success).toBe(false)
  })

  it('defaults started_at to null on a document written before the field existed', () => {
    const { started_at, ...withoutField } = initialState(NOW)
    expect(StateSchema.parse(withoutField).started_at).toBeNull()
  })

  it('accepts a stamped start time', () => {
    const state = { ...initialState(NOW), started_at: '2026-07-28T10:31:00.000Z' }
    expect(StateSchema.safeParse(state).success).toBe(true)
  })

  it('rejects a start time that is not a timestamp', () => {
    expect(StateSchema.safeParse({ ...initialState(NOW), started_at: 'this morning' }).success).toBe(false)
  })

  it('tells a run that predates the pin apart from one whose pin was deleted', () => {
    // The second job started_at does: runStart is its only writer, so
    // `null` means the run began before the verify pin existed and verifyRun
    // may fall back to the live config. On any newer run a missing pin is a
    // deletion, and falling back there would make `rm` the downgrade attack
    // the pin exists to prevent. The two states have to be distinguishable
    // from state.json alone, which is what this asserts.
    const legacy = StateSchema.parse({ ...initialState(NOW), run_id: '2026-07-01-001', track: 'build', status: 'running' })
    const current = StateSchema.parse({ ...legacy, started_at: '2026-07-28T10:31:00.000Z' })
    expect(legacy.started_at).toBeNull()
    expect(current.started_at).not.toBeNull()
  })

  it('defaults a history entry written before it was timed', () => {
    const entry = { cycle: 1, agents: ['editor'], result: 'pass' as const, ref: 'runs/r' }
    const parsed = StateSchema.parse({ ...initialState(NOW), history: [entry] })
    expect(parsed.history[0]?.at).toBeNull()
  })

  it('accepts a timed history entry', () => {
    const entry = { cycle: 1, agents: ['editor'], result: 'pass' as const, ref: 'runs/r', at: '2026-07-28T10:36:00.000Z' }
    const parsed = StateSchema.parse({ ...initialState(NOW), history: [entry] })
    expect(parsed.history[0]?.at).toBe('2026-07-28T10:36:00.000Z')
  })

  it('rejects a history entry whose close time is not a timestamp', () => {
    const entry = { cycle: 1, agents: ['editor'], result: 'pass' as const, ref: 'runs/r', at: 'later' }
    expect(StateSchema.safeParse({ ...initialState(NOW), history: [entry] }).success).toBe(false)
  })
})
