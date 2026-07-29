import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  cycleFingerprint,
  distinctFindings,
  errorFingerprint,
  errorSignature,
  verifyFingerprint,
} from '../../src/ops/fingerprint.js'
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

  it('returns nothing for a blocked result', () => {
    // A blocked result means the check never ran — a missing command, no
    // network, a container nobody started. That is not a verification failure
    // recurring, and cycleFingerprint already treats the two statuses as
    // different states of the world.
    expect(errorSignature(failing, 'blocked')).toEqual([])
    expect(errorSignature([{ kind: 'command', ref: 'npm test', excerpt: 'no network' }], 'blocked')).toEqual([])
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

describe('distinctFindings', () => {
  it('collapses one defect reported by two agents into one entry', () => {
    expect(distinctFindings([A, A])).toEqual([A])
  })

  it('keeps two defects that differ only in claim', () => {
    const other = { ...A, claim: 'shadowed variable' }
    expect(distinctFindings([A, other])).toHaveLength(2)
  })

  it('treats ./src/a.ts and src\\a.ts as one file', () => {
    // An agent is free to write either spelling, and two spellings of one file
    // are one piece of work.
    expect(distinctFindings([A, { ...A, file: './src/a.ts' }, { ...A, file: 'src\\a.ts' }])).toHaveLength(1)
  })

  it('keeps every distinct line of one claim', () => {
    const twelve = A
    const eightyEight = { ...A, line: 88 }
    expect(distinctFindings([eightyEight, twelve])).toEqual([twelve, eightyEight])
  })

  it('does not drop a second defect that differs only in line', () => {
    // The regression test for a false halt. Under cycleFingerprint's coarser,
    // line-blind identity these two collapse; the builder fixes line 12, line
    // 88 survives and is re-reported, the next cycle derives the same identity
    // set, and the run halts with "no progress" over work the loop was never
    // shown.
    const carried = distinctFindings([A, { ...A, line: 88 }])
    expect(carried.map((finding) => finding.line)).toEqual([12, 88])
  })

  it('orders identically whatever order the findings arrived in', () => {
    // Agents are dispatched concurrently, so `state.findings` lands in whatever
    // order they finished. carried_findings, findings.json and HALT.md all read
    // this list, and none of them should differ between two identical cycles.
    const c = { ...A, line: 88 }
    expect(distinctFindings([A, B, c])).toEqual(distinctFindings([c, B, A]))
    expect(distinctFindings([B, A])).toEqual(distinctFindings([A, B]))
  })

  it('returns the same fingerprint before and after deduplication', () => {
    // The guard's identity is strictly coarser, so feeding it a list this
    // function has already thinned cannot move the hash. If it ever could,
    // deduplicating at the cycle boundary would silently re-time every strike.
    const raw = [A, A, B, { ...A, file: './src/a.ts' }]
    expect(cycleFingerprint(distinctFindings(raw), 'fail')).toBe(cycleFingerprint(raw, 'fail'))
  })

  it('keeps the finding objects intact rather than the identity it sorted on', () => {
    expect(distinctFindings([A])[0]).toEqual(A)
  })

  it('does not mutate the array it is given', () => {
    const findings = [B, A]
    distinctFindings(findings)
    expect(findings).toEqual([B, A])
  })

  it('handles an empty cycle', () => {
    expect(distinctFindings([])).toEqual([])
  })
})

describe('verifyFingerprint', () => {
  it('is stable across calls with identical input', () => {
    expect(verifyFingerprint('npm test', 'abc')).toBe(verifyFingerprint('npm test', 'abc'))
  })

  it('changes when the command changes', () => {
    expect(verifyFingerprint('npm test', 'abc')).not.toBe(verifyFingerprint('npm run lint', 'abc'))
  })

  it('changes when the worktree changes', () => {
    expect(verifyFingerprint('npm test', 'abc')).not.toBe(verifyFingerprint('npm test', 'abd'))
  })

  it('does not confuse a command boundary with a worktree boundary', () => {
    // Concatenating the two would make ("ab", "c") and ("a", "bc") one key, and
    // a cache that collided there would reuse a green result for a command
    // nobody ran.
    expect(verifyFingerprint('ab', 'c')).not.toBe(verifyFingerprint('a', 'bc'))
  })

  it('returns a hex digest', () => {
    expect(verifyFingerprint('npm test', 'abc')).toMatch(/^[0-9a-f]{64}$/)
  })
})

/**
 * The guard, held against real output.
 *
 * `mjloop_verify_run` changes what an excerpt *contains*, which is the change
 * that could disable the repeated-error guard without any of the assertions
 * above noticing. These read the two captured failures of this repository's own
 * `cd engine && npm test` — a synthetic string would prove nothing here, since
 * the whole question is what npm and vitest actually print.
 */
const fixture = (name: string): Promise<string> =>
  fs.readFile(fileURLToPath(new URL(`../fixtures/verify/${name}`, import.meta.url)), 'utf8')

const failures = await fixture('vitest-fail.log')
const other = await fixture('vitest-fail-other.log')

describe('errorSignature over captured verify output', () => {
  /** The first line matching the documented `test` failure patterns. */
  const firstFailure = (log: string): string =>
    log.split('\n').find((line) => /^\s*(FAIL|×|✗|✕)\s/.test(line))?.trim() ?? ''

  /** The last summary-shaped line — what a digest reports as its headline. */
  const countLine = (log: string): string =>
    [...log.split('\n')].reverse().find((line) => /^\s*(Tests|Test Files|Snapshots)\s/.test(line))?.trim() ?? ''

  const excerpt = (log: string): string => `${firstFailure(log)}\n${countLine(log)}\n.mjloop/runs/r/cycle-01/verify/test.log`

  it('two different failures of one command produce two signatures', () => {
    // The assertion that keeps the repeated-error guard from halting a run that
    // was making progress. The excerpt is assembled the way agents/verifier.md
    // prescribes — the decisive line first, because errorSignature hashes the
    // excerpt's first line.
    const a = errorSignature([{ kind: 'command', ref: 'cd engine && npm test', excerpt: excerpt(failures) }], 'fail')
    const b = errorSignature([{ kind: 'command', ref: 'cd engine && npm test', excerpt: excerpt(other) }], 'fail')
    expect(a).not.toEqual(b)
    expect(a[0]).toBeDefined()
  })

  it('collapses both failures into one signature if the excerpt leads with the npm banner', () => {
    // Why `headline` may not be "the first non-empty line of output". Measured
    // here, that line is npm's script echo and it is byte-identical on every
    // run of this command — so an excerpt leading with it gives every failure
    // one constant signature, errorFingerprint matches on the second
    // consecutive failing cycle, and cycleAdvance halts a healthy run with
    // "the same verification failure recurred". A banner must never become a
    // signature.
    const banner = (log: string): string => log.split('\n').find((line) => line.trim().length > 0)?.trim() ?? ''
    expect(banner(failures)).toBe('> @mjloop/engine@0.4.1 test')
    expect(banner(other)).toBe(banner(failures))

    const led = (log: string): string[] =>
      errorSignature([{ kind: 'command', ref: 'cd engine && npm test', excerpt: `${banner(log)}\n${firstFailure(log)}` }], 'fail')
    expect(led(failures)).toEqual(led(other))
  })

  it('collapses both failures into one signature if the excerpt leads with the count line', () => {
    // The runner's own count line is the most informative line in the log and
    // it is still the wrong thing to lead with: errorSignature collapses digit
    // runs, so "Tests 2 failed | 779 passed (781)" and
    // "Tests 17 failed | 764 passed (781)" normalise to one string. That is why
    // §4 puts failures[0] first and the headline second.
    expect(countLine(failures)).not.toBe(countLine(other))
    const led = (log: string): string[] =>
      errorSignature([{ kind: 'command', ref: 'cd engine && npm test', excerpt: countLine(log) }], 'fail')
    expect(led(failures)).toEqual(led(other))
  })

  it('produces no signature at all from a green run', () => {
    // errorSignature returns [] for anything that is not a fail, so a green
    // digest cited as evidence arms nothing.
    expect(errorSignature([{ kind: 'command', ref: 'cd engine && npm test', excerpt: 'Tests  781 passed (781)' }], 'pass')).toEqual([])
  })
})
