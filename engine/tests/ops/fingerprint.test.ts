import { describe, expect, it } from 'vitest'
import { cycleFingerprint } from '../../src/ops/fingerprint.js'
import type { Finding } from '../../src/schemas/state.js'

const A: Finding = { severity: 'high', file: 'src/a.ts', line: 12, claim: 'unused import' }
const B: Finding = { severity: 'low', file: 'src/b.ts', line: 3, claim: 'missing test' }

describe('cycleFingerprint', () => {
  it('is stable across calls with identical input', () => {
    expect(cycleFingerprint([A, B], 'fail')).toBe(cycleFingerprint([A, B], 'fail'))
  })

  it('ignores the order findings arrived in', () => {
    // Agents run concurrently, so arrival order varies between otherwise
    // identical cycles. If it leaked into the hash the guard would never fire.
    expect(cycleFingerprint([A, B], 'fail')).toBe(cycleFingerprint([B, A], 'fail'))
  })

  it('changes when one field of one finding changes', () => {
    expect(cycleFingerprint([{ ...A, line: 13 }, B], 'fail')).not.toBe(cycleFingerprint([A, B], 'fail'))
  })

  it('changes when the claim changes but the location does not', () => {
    expect(cycleFingerprint([{ ...A, claim: 'shadowed variable' }], 'fail')).not.toBe(cycleFingerprint([A], 'fail'))
  })

  it('changes when the result changes', () => {
    expect(cycleFingerprint([A], 'fail')).not.toBe(cycleFingerprint([A], 'blocked'))
  })

  it('distinguishes an empty cycle from one with a finding', () => {
    expect(cycleFingerprint([], 'fail')).not.toBe(cycleFingerprint([A], 'fail'))
  })

  it('does not mutate the array it is given', () => {
    const findings = [B, A]
    cycleFingerprint(findings, 'fail')
    expect(findings).toEqual([B, A])
  })

  it('returns a hex digest', () => {
    expect(cycleFingerprint([A], 'fail')).toMatch(/^[0-9a-f]{64}$/)
  })
})
