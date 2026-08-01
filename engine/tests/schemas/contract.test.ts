import { describe, expect, it } from 'vitest'
import {
  AgentNameSchema,
  AgentResultSchema,
  EVIDENCE_EXCERPT_MAX,
  EVIDENCE_REF_MAX,
  FINDING_CLAIM_MAX,
  RESERVED_AGENT_NAMES,
  RosterSchema,
  capEvidence,
  parseAgentResult,
} from '../../src/schemas/contract.js'
import type { AgentResult } from '../../src/schemas/contract.js'

const VALID = {
  status: 'pass',
  summary: 'Renamed the submit label and updated the snapshot.',
  evidence: [{ kind: 'command', ref: 'npm test', excerpt: '12 passed' }],
  findings: [],
  files_touched: ['src/Button.tsx'],
  next_hint: null,
  skills_used: [],
}

describe('AgentResultSchema', () => {
  it('accepts a well-formed result', () => {
    expect(AgentResultSchema.parse(VALID)).toEqual(VALID)
  })

  it('defaults next_hint to null when omitted', () => {
    const { next_hint, ...withoutHint } = VALID
    expect(AgentResultSchema.parse(withoutHint).next_hint).toBeNull()
  })

  it('defaults skills_used to an empty array when omitted', () => {
    // Load-bearing for every result ever written before this field existed:
    // without the default, re-parsing an old cycle-NN/<agent>.json (a strict
    // schema) would refuse it outright rather than merely gain the field.
    const { skills_used, ...withoutSkillsUsed } = VALID
    expect(AgentResultSchema.parse(withoutSkillsUsed).skills_used).toEqual([])
  })

  it('accepts an agent naming the skills it actually followed', () => {
    const parsed = AgentResultSchema.parse({ ...VALID, skills_used: ['flutter-widgets', 'security-auth-guard'] })
    expect(parsed.skills_used).toEqual(['flutter-widgets', 'security-auth-guard'])
  })

  it('rejects a blank entry in skills_used', () => {
    expect(AgentResultSchema.safeParse({ ...VALID, skills_used: [''] }).success).toBe(false)
  })

  it('constrains a skills_used entry to the id shape the manifest selects in', () => {
    // `runLog` joins this list against the run's pinned `skill-selection.json`,
    // whose `skillIds` are `IdSchema`. A free string could never match one, so
    // an entry outside that shape is a claim that cannot be checked, dressed as
    // one that can — and `../../etc/passwd` is what that looks like in practice.
    expect(AgentResultSchema.safeParse({ ...VALID, skills_used: ['../../etc/passwd'] }).success).toBe(false)
    expect(AgentResultSchema.safeParse({ ...VALID, skills_used: ['a skill with spaces'] }).success).toBe(false)
    expect(AgentResultSchema.safeParse({ ...VALID, skills_used: ['eslint-strict'] }).success).toBe(true)
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

describe('RESERVED_AGENT_NAMES', () => {
  it('reserves the two names that would overwrite an engine artefact', () => {
    // `findings` clobbers the cycle's findings archive; `roster` clobbers
    // rosterSet's own cycle-NN/roster.json, which it has been able to do since
    // milestone 1.
    for (const name of ['findings', 'roster']) {
      expect(AgentNameSchema.safeParse(name).success, name).toBe(false)
    }
  })

  it('reserves the four directory and document names for the readers that walk them', () => {
    // These cannot in fact collide — runLog appends `.json`, so `verify.json`
    // is not `verify/`. They are reserved because a human, readCycleDetail,
    // writeHandoff and readRunHistory all walk those directories, and a
    // verify.json beside a verify/ is a trap for every one of them.
    for (const name of ['verify', 'evidence', 'handoff', 'map']) {
      expect(AgentNameSchema.safeParse(name).success, name).toBe(false)
    }
  })

  it('names every reserved word in the refusal, so the remedy is a rename', () => {
    const parsed = AgentNameSchema.safeParse('map')
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      for (const name of RESERVED_AGENT_NAMES) expect(parsed.error.issues[0]?.message).toContain(name)
    }
  })

  it('still accepts every agent the default tracks name', () => {
    for (const name of ['builder', 'verifier', 'scout', 'docs', 'ui-critic', 'hypothesis-tester']) {
      expect(AgentNameSchema.safeParse(name).success, name).toBe(true)
    }
  })
})

describe('capEvidence', () => {
  const spillPath = (index: number): string => `.mjloop/runs/r/cycle-03/evidence/verifier--${index}.txt`

  const resultWith = (evidence: AgentResult['evidence'], findings: AgentResult['findings'] = []): AgentResult => ({
    status: 'fail',
    summary: 'the suite failed',
    evidence,
    findings,
    files_touched: [],
    next_hint: null,
  })

  it('keeps an excerpt under the ceiling byte for byte', () => {
    const excerpt = 'x'.repeat(EVIDENCE_EXCERPT_MAX)
    const { result, spills } = capEvidence(resultWith([{ kind: 'command', ref: 'npm test', excerpt }]), spillPath)
    expect(result.evidence[0]?.excerpt).toBe(excerpt)
    expect(spills).toEqual([])
  })

  it('truncates at the ceiling and names where the rest went', () => {
    const excerpt = 'x'.repeat(EVIDENCE_EXCERPT_MAX + 1_000)
    const { result, spills } = capEvidence(resultWith([{ kind: 'command', ref: 'npm test', excerpt }]), spillPath)
    const stored = result.evidence[0]?.excerpt ?? ''
    expect(stored.length).toBeLessThanOrEqual(EVIDENCE_EXCERPT_MAX)
    expect(stored).toContain(spillPath(0))
    expect(spills).toEqual([{ index: 0, text: excerpt }])
  })

  it('counts characters kept and characters sent in the marker', () => {
    const excerpt = 'x'.repeat(18_431)
    const { result } = capEvidence(resultWith([{ kind: 'command', ref: 'npm test', excerpt }]), spillPath)
    const stored = result.evidence[0]?.excerpt ?? ''
    const marker = /truncated: (\d+) of (\d+) characters kept/.exec(stored)
    expect(marker).not.toBeNull()
    // The kept count is the real one — the prefix before the marker — not the
    // ceiling, because the marker is spent out of the same budget.
    expect(Number(marker?.[1])).toBe(stored.indexOf('\n… truncated:'))
    expect(Number(marker?.[2])).toBe(18_431)
  })

  it('is idempotent, so re-parsing a capped result changes nothing', () => {
    // runLog capping its own output must not spill the marker into a second
    // file and orphan the first. The capped string sits *at* the ceiling
    // rather than over it, so the second pass finds nothing to do.
    const excerpt = 'x'.repeat(EVIDENCE_EXCERPT_MAX * 3)
    const once = capEvidence(resultWith([{ kind: 'command', ref: 'npm test', excerpt }]), spillPath)
    const twice = capEvidence(once.result, spillPath)
    expect(twice.result).toEqual(once.result)
    expect(twice.spills).toEqual([])
  })

  it('caps every entry independently rather than the array as a whole', () => {
    const short = 'expected Send, got Submit'
    const long = 'y'.repeat(EVIDENCE_EXCERPT_MAX + 1)
    const { result, spills } = capEvidence(
      resultWith([
        { kind: 'command', ref: 'npm test', excerpt: short },
        { kind: 'test', ref: 'Button', excerpt: long },
        { kind: 'file', ref: 'src/a.ts', excerpt: short },
      ]),
      spillPath,
    )
    expect(result.evidence[0]?.excerpt).toBe(short)
    expect(result.evidence[2]?.excerpt).toBe(short)
    // The spill is named for the entry it came from, not for its position
    // among the overflowing entries — the marker has to point at a real file.
    expect(spills.map((spill) => spill.index)).toEqual([1])
    expect(result.evidence[1]?.excerpt).toContain(spillPath(1))
  })

  it('asks for a spill path only for the entries that overflow', () => {
    const asked: number[] = []
    capEvidence(
      resultWith([
        { kind: 'command', ref: 'a', excerpt: 'short' },
        { kind: 'command', ref: 'b', excerpt: 'z'.repeat(EVIDENCE_EXCERPT_MAX + 1) },
      ]),
      (index) => {
        asked.push(index)
        return spillPath(index)
      },
    )
    expect(asked).toEqual([1])
  })

  it('bounds a claim, a file and a ref as well as an excerpt', () => {
    // state.findings accumulates every finding every agent files for the whole
    // cycle, so an agent pasting a stack trace into `claim` reproduces the
    // whole cost through a field the excerpt cap never touched.
    const { result } = capEvidence(
      resultWith(
        [{ kind: 'command', ref: 'r'.repeat(EVIDENCE_REF_MAX + 500), excerpt: 'fine' }],
        [{ severity: 'high', file: 'f'.repeat(EVIDENCE_REF_MAX + 500), line: 12, claim: 'c'.repeat(FINDING_CLAIM_MAX + 500) }],
      ),
      spillPath,
    )
    expect(result.evidence[0]?.ref.length).toBe(EVIDENCE_REF_MAX)
    expect(result.evidence[0]?.ref).toContain('(truncated)')
    expect(result.findings[0]?.file.length).toBe(EVIDENCE_REF_MAX)
    expect(result.findings[0]?.claim.length).toBe(FINDING_CLAIM_MAX)
    expect(result.findings[0]?.claim).toContain('(truncated)')
    // No spill file for either: there is no plausible tail of a claim or a path
    // that a reader would go and fetch.
    expect(result.findings[0]?.line).toBe(12)
  })

  it('leaves the result it was given untouched', () => {
    // runLog derives `proof` and the error signatures from the *returned*
    // result. If this mutated in place the two would be indistinguishable and
    // the ordering §14 fixes would be untestable.
    const excerpt = 'x'.repeat(EVIDENCE_EXCERPT_MAX + 1)
    const input = resultWith([{ kind: 'command', ref: 'npm test', excerpt }])
    const { result } = capEvidence(input, spillPath)
    expect(input.evidence[0]?.excerpt).toBe(excerpt)
    expect(result.evidence[0]?.excerpt).not.toBe(excerpt)
  })

  it('still accepts a historical result whose excerpt is longer than the ceiling', () => {
    // The schema refuses nothing. web/read.ts re-parses old cycle files with
    // it, and a failed parse there drops that agent from the cockpit — old
    // evidence disappearing is worse than an old long string.
    const long = { ...VALID, evidence: [{ kind: 'command', ref: 'npm test', excerpt: 'x'.repeat(50_000) }] }
    expect(AgentResultSchema.safeParse(long).success).toBe(true)
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
