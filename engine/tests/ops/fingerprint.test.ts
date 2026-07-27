import { describe, expect, it } from 'vitest'
import { cycleFingerprint, errorFingerprint, errorSignature } from '../../src/ops/fingerprint.js'
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

describe('errorSignature', () => {
  const failing = [
    { kind: 'command' as const, ref: 'npm test', excerpt: '1 failing: expected Send got Submit\n  at Button.tsx:14' },
    { kind: 'file' as const, ref: 'src/Button.tsx', excerpt: "return 'Submit'" },
  ]

  it('takes only command and test evidence', () => {
    expect(errorSignature(failing, 'fail')).toEqual(['npm test :: N failing: expected Send got Submit'])
  })

  it('keeps only the first line of the excerpt', () => {
    const [signature] = errorSignature(failing, 'fail')
    expect(signature).not.toContain('at Button.tsx')
  })

  it('normalises digit runs, so the same failure with a different count matches', () => {
    const two = [{ ...failing[0]!, excerpt: '2 failing: expected Send got Submit' }]
    expect(errorSignature(two, 'fail')).toEqual(errorSignature(failing, 'fail'))
  })

  it('distinguishes a different command', () => {
    const other = [{ ...failing[0]!, ref: 'npm run lint' }]
    expect(errorSignature(other, 'fail')).not.toEqual(errorSignature(failing, 'fail'))
  })

  it('distinguishes a different headline', () => {
    const other = [{ ...failing[0]!, excerpt: '1 failing: cannot resolve module' }]
    expect(errorSignature(other, 'fail')).not.toEqual(errorSignature(failing, 'fail'))
  })

  it('returns nothing for a passing result', () => {
    expect(errorSignature(failing, 'pass')).toEqual([])
  })

  it('returns nothing when no evidence is a command or a test', () => {
    expect(errorSignature([failing[1]!], 'fail')).toEqual([])
  })

  it('sorts and deduplicates, so agent order and repetition do not matter', () => {
    const a = { kind: 'command' as const, ref: 'a', excerpt: 'boom' }
    const b = { kind: 'test' as const, ref: 'b', excerpt: 'bang' }
    expect(errorSignature([b, a, a], 'fail')).toEqual(errorSignature([a, b], 'fail'))
  })

  it('tolerates an empty excerpt', () => {
    expect(errorSignature([{ kind: 'command', ref: 'npm test', excerpt: '' }], 'fail')).toEqual(['npm test :: '])
  })
})

describe('errorFingerprint', () => {
  it('is stable and order-independent', () => {
    expect(errorFingerprint(['a', 'b'])).toBe(errorFingerprint(['b', 'a']))
  })

  it('changes when a signature changes', () => {
    expect(errorFingerprint(['a'])).not.toBe(errorFingerprint(['b']))
  })

  it('returns a hex digest', () => {
    expect(errorFingerprint(['a'])).toMatch(/^[0-9a-f]{64}$/)
  })
})
