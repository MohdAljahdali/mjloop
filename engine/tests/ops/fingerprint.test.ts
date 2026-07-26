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

  it('ignores a repeated finding', () => {
    // Two agents reporting one defect is the same remaining work as one agent
    // reporting it — otherwise adding critic to a stuck cycle would reset the
    // very counter that stall should be driving.
    expect(cycleFingerprint([A], 'fail')).toBe(cycleFingerprint([A, A], 'fail'))
    expect(cycleFingerprint([A, B], 'fail')).toBe(cycleFingerprint([B, A, A, B], 'fail'))
  })

  it('ignores the line a finding sits on', () => {
    // The builder writes to the file the finding points at, so the same defect
    // drifts down a line or two every cycle. Hashing the line would let a
    // flailing loop escape every strike.
    expect(cycleFingerprint([{ ...A, line: 40 }], 'fail')).toBe(cycleFingerprint([A], 'fail'))
  })

  it('ignores "./" and separator noise in the file path', () => {
    expect(cycleFingerprint([{ ...A, file: './src/a.ts' }], 'fail')).toBe(cycleFingerprint([A], 'fail'))
    expect(cycleFingerprint([{ ...A, file: 'src\\a.ts' }], 'fail')).toBe(cycleFingerprint([A], 'fail'))
  })

  it('changes when the severity changes', () => {
    expect(cycleFingerprint([{ ...A, severity: 'low' }, B], 'fail')).not.toBe(cycleFingerprint([A, B], 'fail'))
  })

  it('changes when the file changes', () => {
    expect(cycleFingerprint([{ ...A, file: 'src/c.ts' }], 'fail')).not.toBe(cycleFingerprint([A], 'fail'))
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
