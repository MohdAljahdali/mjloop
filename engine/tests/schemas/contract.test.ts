import { describe, expect, it } from 'vitest'
import { AgentResultSchema, RosterSchema, parseAgentResult } from '../../src/schemas/contract.js'

const VALID = {
  status: 'pass',
  summary: 'Renamed the submit label and updated the snapshot.',
  evidence: [{ kind: 'command', ref: 'npm test', excerpt: '12 passed' }],
  findings: [],
  files_touched: ['src/Button.tsx'],
  next_hint: null,
}

describe('AgentResultSchema', () => {
  it('accepts a well-formed result', () => {
    expect(AgentResultSchema.parse(VALID)).toEqual(VALID)
  })

  it('defaults next_hint to null when omitted', () => {
    const { next_hint, ...withoutHint } = VALID
    expect(AgentResultSchema.parse(withoutHint).next_hint).toBeNull()
  })

  it('rejects an unknown status', () => {
    expect(AgentResultSchema.safeParse({ ...VALID, status: 'maybe' }).success).toBe(false)
  })

  it('rejects an empty summary', () => {
    expect(AgentResultSchema.safeParse({ ...VALID, summary: '' }).success).toBe(false)
  })

  it('rejects an extra key so agents cannot smuggle in fields', () => {
    expect(AgentResultSchema.safeParse({ ...VALID, confidence: 0.9 }).success).toBe(false)
  })

  it('rejects evidence with an unknown kind', () => {
    const bad = { ...VALID, evidence: [{ kind: 'vibes', ref: 'x', excerpt: '' }] }
    expect(AgentResultSchema.safeParse(bad).success).toBe(false)
  })
})

describe('parseAgentResult', () => {
  it('returns ok with the parsed value', () => {
    const result = parseAgentResult(VALID)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.status).toBe('pass')
  })

  it('returns a readable error for a malformed result', () => {
    const result = parseAgentResult({ status: 'pass' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('summary')
      expect(result.error.length).toBeGreaterThan(0)
    }
  })
})

describe('RosterSchema', () => {
  it('accepts a roster with reasons for every omission', () => {
    const roster = { cycle: 1, selected: ['editor', 'verifier'], skipped: { critic: 'single-file change' } }
    expect(RosterSchema.parse(roster)).toEqual(roster)
  })

  it('defaults skipped to an empty record', () => {
    expect(RosterSchema.parse({ cycle: 1, selected: ['editor'] }).skipped).toEqual({})
  })

  it('rejects an empty selection', () => {
    expect(RosterSchema.safeParse({ cycle: 1, selected: [] }).success).toBe(false)
  })

  it('rejects a skip reason that is blank', () => {
    const bad = { cycle: 1, selected: ['editor'], skipped: { critic: '' } }
    expect(RosterSchema.safeParse(bad).success).toBe(false)
  })
})
