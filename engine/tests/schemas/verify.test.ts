import { describe, expect, it } from 'vitest'
import { LedgerEntrySchema, LedgerSchema, PinnedVerifySchema } from '../../src/schemas/verify.js'

const ENTRY = {
  slot: 'test',
  command: 'cd engine && npm test',
  source: 'pinned',
  live_command: null,
  log: 'test.log',
  phase: 'complete',
  exit_code: 1,
  timed_out: false,
  fingerprint: '9f2c',
  cached_from_cycle: null,
  duration_ms: 1_780,
  at: '2026-07-28T10:36:00.000Z',
}

describe('LedgerEntrySchema', () => {
  it('accepts a completed invocation', () => {
    expect(LedgerEntrySchema.parse(ENTRY)).toEqual(ENTRY)
  })

  it('accepts all three phases, including the one that ran nothing', () => {
    // `queued` is the member it is easy to omit, and omitting it is what would
    // let a verifier log a pass citing a command that never started: the
    // contradiction check has to be able to read that state back.
    for (const phase of ['queued', 'running', 'complete']) {
      expect(LedgerEntrySchema.safeParse({ ...ENTRY, phase }).success, phase).toBe(true)
    }
    expect(LedgerEntrySchema.safeParse({ ...ENTRY, phase: 'pass' }).success).toBe(false)
  })

  it('accepts an entry written before its command finished', () => {
    // The entry is written immediately and amended in place when the child
    // exits. Leaving the row out until then would make the ledger silent for
    // exactly as long as "did this actually run?" is a live question.
    const pending = { ...ENTRY, phase: 'running', exit_code: null, duration_ms: null }
    expect(LedgerEntrySchema.parse(pending).exit_code).toBeNull()
  })

  it('accepts a queued entry that wrote no log', () => {
    const queued = { ...ENTRY, phase: 'queued', log: '', exit_code: null, fingerprint: null, duration_ms: null }
    expect(LedgerEntrySchema.parse(queued).log).toBe('')
  })

  it('records which copy of the verify block it executed', () => {
    expect(LedgerEntrySchema.parse({ ...ENTRY, source: 'live' }).source).toBe('live')
    expect(LedgerEntrySchema.safeParse({ ...ENTRY, source: 'guessed' }).success).toBe(false)
  })

  it('carries the live command beside the pinned one when they disagree', () => {
    const drifted = { ...ENTRY, live_command: 'rm -rf /' }
    expect(LedgerEntrySchema.parse(drifted).live_command).toBe('rm -rf /')
  })

  it('defaults the fields an older writer would not have set', () => {
    const { live_command, timed_out, fingerprint, cached_from_cycle, duration_ms, ...bare } = ENTRY
    const parsed = LedgerEntrySchema.parse(bare)
    expect(parsed.live_command).toBeNull()
    expect(parsed.timed_out).toBe(false)
    expect(parsed.fingerprint).toBeNull()
    expect(parsed.cached_from_cycle).toBeNull()
    expect(parsed.duration_ms).toBeNull()
  })

  it('rejects an unknown slot', () => {
    expect(LedgerEntrySchema.safeParse({ ...ENTRY, slot: 'e2e' }).success).toBe(false)
  })

  it('rejects an unknown key so a writer cannot smuggle a verdict in', () => {
    // `VerifyDigest` has no status field and neither does its record. A ledger
    // that accepted one would put the word beside `phase` in every reader's
    // context, which is exactly what the naming avoids.
    expect(LedgerEntrySchema.safeParse({ ...ENTRY, status: 'pass' }).success).toBe(false)
  })

  it('rejects a cached_from_cycle of zero', () => {
    expect(LedgerEntrySchema.safeParse({ ...ENTRY, cached_from_cycle: 0 }).success).toBe(false)
    expect(LedgerEntrySchema.safeParse({ ...ENTRY, cached_from_cycle: 2 }).success).toBe(true)
  })

  it('reads a whole ledger file', () => {
    expect(LedgerSchema.parse([ENTRY, { ...ENTRY, slot: 'lint' }])).toHaveLength(2)
  })
})

describe('PinnedVerifySchema', () => {
  const PIN = {
    version: 1,
    pinned_at: '2026-07-28T10:31:00.000Z',
    verify: {
      test: 'cd engine && npm test',
      lint: 'cd engine && npm run typecheck',
      build: 'cd engine && npm run build',
      timeout_ms: 900_000,
      lock_timeout_ms: 1_800_000,
      failure_patterns: { test: [], lint: [], build: [] },
    },
  }

  it('accepts a pin written by this version', () => {
    expect(PinnedVerifySchema.parse(PIN)).toEqual(PIN)
  })

  it('parses a pin written before a verify key existed', () => {
    // The property that makes VerifySchema the right thing to wrap: the block
    // inside carries no version of its own, so a pin written when only the
    // three commands existed gains every later key's default on read instead
    // of failing to parse and refusing the run.
    const old = { version: 1, pinned_at: PIN.pinned_at, verify: { test: 'npm test', lint: null, build: null } }
    const parsed = PinnedVerifySchema.parse(old)
    expect(parsed.verify.test).toBe('npm test')
    expect(parsed.verify.timeout_ms).toBe(900_000)
    expect(parsed.verify.lock_timeout_ms).toBe(1_800_000)
    expect(parsed.verify.failure_patterns).toEqual({ test: [], lint: [], build: [] })
  })

  it('pins the ceiling and the failure patterns, not only the commands', () => {
    // timeout_ms and failure_patterns are executed policy too: a ceiling
    // rewritten to 1 kills every suite the engine starts, and a pattern is a
    // regular expression this engine compiles and runs.
    const pinned = PinnedVerifySchema.parse({
      ...PIN,
      verify: { ...PIN.verify, timeout_ms: 60_000, failure_patterns: { test: ['^BOOM'], lint: [], build: [] } },
    })
    expect(pinned.verify.timeout_ms).toBe(60_000)
    expect(pinned.verify.failure_patterns.test).toEqual(['^BOOM'])
  })

  it('refuses a pin whose version it does not know', () => {
    // A wrapper shape this build cannot read is not something to guess at:
    // verifyRun refuses rather than falling back to the live config, because
    // falling back is the downgrade the pin exists to prevent.
    expect(PinnedVerifySchema.safeParse({ ...PIN, version: 2 }).success).toBe(false)
  })

  it('refuses a pin with no verify block', () => {
    expect(PinnedVerifySchema.safeParse({ version: 1, pinned_at: PIN.pinned_at }).success).toBe(false)
  })

  it('refuses an unknown key rather than ignoring it', () => {
    expect(PinnedVerifySchema.safeParse({ ...PIN, verify_cache: true }).success).toBe(false)
  })

  it('refuses a verify block with a key VerifySchema does not define', () => {
    // The block is strict, so a tampered pin carrying an extra field is a
    // parse failure rather than a silently ignored instruction.
    const bad = { ...PIN, verify: { ...PIN.verify, shell: '/bin/evil' } }
    expect(PinnedVerifySchema.safeParse(bad).success).toBe(false)
  })
})
