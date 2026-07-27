# Loop — Milestone 5: The Remaining Guards — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the last two guards — a halt when the same verification failure recurs, and a `Stop` hook that carries an opted-in run from cycle to cycle without a person pressing enter.

**Architecture:** The repeated-error guard mirrors the findings lifecycle exactly: `runLog` appends normalised error signatures to state, `cycleAdvance` fingerprints them, compares, and clears. The `Stop` hook is a thin bash wrapper over a pure `evaluateStopGuard` function, so every branch is tested without a filesystem — the same shape `evaluateStateGuard` has had since milestone 1.

**Tech Stack:** TypeScript 5 · Node 24 (floor 20) · zod 4.4.3 · vitest 4.1.10

**Spec:** `docs/superpowers/specs/2026-07-27-loop-milestone-5-guards-design.md`

## Global Constraints

- All plugin files, prompts, code, comments, and documentation in **English**. Conversation with the user is Arabic; nothing in the repository is.
- **zod 4 idioms only:** `z.strictObject(...)` not `z.object(...).strict()`; `z.iso.datetime()` not `z.string().datetime()`; `z.record(keySchema, valueSchema)` requires both arguments; format errors with `z.prettifyError(error)`.
- **State has one owner.** Nothing outside `engine/src/store` and `engine/src/ops` may write `.loop/state.json` or any `manifest.json`.
- **The engine does not know agent names.** Any rule naming a specific agent belongs in track config.
- **Every judgement inside a `store.update` callback reads the locked draft**, never a pre-lock snapshot.
- **A guard that cannot read its inputs allows the action.** A hook that blocks on its own bug traps the session.
- Every operation that stamps a timestamp takes an injectable `now: Clock` defaulting to `() => new Date()`.
- Every task ends with a commit. Tests must be seen failing before the implementation is written.

---

## File Structure

| File | Responsibility |
|---|---|
| `engine/src/ops/fingerprint.ts` | `errorSignature`, `errorFingerprint` beside the existing `cycleFingerprint` |
| `engine/src/schemas/state.ts` | `cycle_errors`, `last_error_fingerprint` |
| `engine/src/ops/log.ts` | `runLog` appends signatures from a failing result |
| `engine/src/ops/run.ts` | `cycleAdvance` applies the guard and clears the signatures |
| `engine/src/cli/index.ts` | `evaluateStopGuard` and the `stop-guard` subcommand |
| `hooks/scripts/stop-guard.sh` | **New.** Wrapper, no logic |
| `hooks/hooks.json` | Register `Stop` |
| `commands/resume.md` | **New.** `/loop:resume` |
| `skills/loop-leader/SKILL.md` | The third halt reason, and what autonomy changes |
| `engine/tests/integration/autonomy.test.ts` | **New.** A run bounded by its guards, and the hook releasing when it ends |

---

## Task 1: The error signature

**Files:**
- Modify: `engine/src/ops/fingerprint.ts`
- Test: `engine/tests/ops/fingerprint.test.ts`

**Interfaces:**
- Consumes: `Evidence` from `engine/src/schemas/contract.ts`; `Result` from `engine/src/schemas/state.ts`.
- Produces: `errorSignature(evidence: Evidence[], result: Result): string[]`; `errorFingerprint(signatures: string[]): string`.

- [ ] **Step 1: Write the failing test**

Add to `engine/tests/ops/fingerprint.test.ts`:

```ts
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
```

Add `errorFingerprint` and `errorSignature` to that file's imports.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/ops/fingerprint.test.ts`
Expected: FAIL — `errorSignature` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `engine/src/ops/fingerprint.ts`:

```ts
import type { Evidence } from '../schemas/contract.js'
```

```ts
/**
 * Normalised identities for the failures a result reports.
 *
 * Milestone 2 established that raw excerpts cannot be hashed — they carry
 * durations and counts that differ between runs of the same failing command,
 * so hashing them makes every cycle look new and silently disables the guard.
 * These are normalised first: the headline only, with digit runs collapsed, so
 * `1 failing` and `2 failing` are one failure recurring rather than two.
 */
export function errorSignature(evidence: Evidence[], result: Result): string[] {
  if (result === 'pass') return []
  const signatures = evidence
    .filter((entry) => entry.kind === 'command' || entry.kind === 'test')
    .map((entry) => `${entry.ref} :: ${headline(entry.excerpt)}`)
  return [...new Set(signatures)].sort()
}

export function errorFingerprint(signatures: string[]): string {
  return createHash('sha256').update(JSON.stringify([...signatures].sort())).digest('hex')
}

/** The first line, with digit runs collapsed. Error output leads with the headline. */
function headline(excerpt: string): string {
  return (excerpt.split('\n')[0] ?? '').trim().replace(/\d+/g, 'N')
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd engine && npx vitest run tests/ops/fingerprint.test.ts && npm run typecheck`
Expected: PASS — 12 new tests plus the existing ones.

- [ ] **Step 5: Commit**

```bash
git add engine/src/ops/fingerprint.ts engine/tests/ops/fingerprint.test.ts
git commit -m "feat(engine): add a normalised error signature for repeat detection"
```

---

## Task 2: The error state fields

**Files:**
- Modify: `engine/src/schemas/state.ts`
- Test: `engine/tests/schemas/state.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `State.cycle_errors: string[]`, `State.last_error_fingerprint: string | null`; `initialState` sets both.

- [ ] **Step 1: Write the failing test**

Add to `engine/tests/schemas/state.test.ts`, inside `describe('StateSchema', ...)`:

```ts
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
```

Extend the existing `initialState` test:

```ts
    expect(state.cycle_errors).toEqual([])
    expect(state.last_error_fingerprint).toBeNull()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/schemas/state.test.ts`
Expected: FAIL — both are unknown keys on the strict object.

- [ ] **Step 3: Write the implementation**

In `engine/src/schemas/state.ts`, add to `StateSchema` immediately after `last_fingerprint`:

```ts
  /**
   * Normalised error signatures observed this cycle, appended by `runLog` and
   * cleared when the next cycle opens — the same lifecycle findings have, for
   * the same reason: they describe one cycle's failure, not the run's.
   */
  cycle_errors: z.array(z.string().min(1)).default([]),
  /** Fingerprint of the previous cycle's errors, compared by the repeated-error guard. */
  last_error_fingerprint: z.string().min(1).nullable().default(null),
```

Add both to `initialState`, after `last_fingerprint: null,`:

```ts
    cycle_errors: [],
    last_error_fingerprint: null,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd engine && npx vitest run && npm run typecheck`
Expected: PASS — every suite green.

- [ ] **Step 5: Commit**

```bash
git add engine/src/schemas/state.ts engine/tests/schemas/state.test.ts
git commit -m "feat(engine): record per-cycle error signatures in state"
```

---

## Task 3: `runLog` records the signatures

**Files:**
- Modify: `engine/src/ops/log.ts`
- Test: `engine/tests/ops/log.test.ts`

**Interfaces:**
- Consumes: `errorSignature` (Task 1); `State.cycle_errors` (Task 2).
- Produces: `runLog` appends signatures in the same locked update that folds findings in.

- [ ] **Step 1: Write the failing test**

Add to `engine/tests/ops/log.test.ts`:

```ts
describe('runLog error signatures', () => {
  const failing = {
    status: 'fail' as const,
    summary: 'the suite is red',
    evidence: [{ kind: 'command' as const, ref: 'npm test', excerpt: '3 failing: cannot resolve module' }],
    findings: [],
    files_touched: [],
    next_hint: null,
  }

  it('records a signature from a failing result', async () => {
    await runLog(project.dir, { agent: 'verifier', result: failing }, clock)
    expect((await new StateStore(project.dir).get()).cycle_errors).toEqual([
      'npm test :: N failing: cannot resolve module',
    ])
  })

  it('records nothing from a passing result', async () => {
    await runLog(project.dir, { agent: 'verifier', result: { ...failing, status: 'pass' } }, clock)
    expect((await new StateStore(project.dir).get()).cycle_errors).toEqual([])
  })

  it('does not duplicate the same failure reported by two agents', async () => {
    await runLog(project.dir, { agent: 'verifier', result: failing }, clock)
    await runLog(project.dir, { agent: 'critic', result: failing }, clock)
    expect((await new StateStore(project.dir).get()).cycle_errors).toHaveLength(1)
  })

  it('accumulates different failures', async () => {
    await runLog(project.dir, { agent: 'verifier', result: failing }, clock)
    await runLog(
      project.dir,
      { agent: 'critic', result: { ...failing, evidence: [{ kind: 'command', ref: 'npm run lint', excerpt: 'boom' }] } },
      clock,
    )
    expect((await new StateStore(project.dir).get()).cycle_errors).toHaveLength(2)
  })

  it('records nothing when a failing result carries no command or test evidence', async () => {
    await runLog(
      project.dir,
      { agent: 'verifier', result: { ...failing, evidence: [{ kind: 'file', ref: 'a.ts', excerpt: 'x' }] } },
      clock,
    )
    expect((await new StateStore(project.dir).get()).cycle_errors).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/ops/log.test.ts`
Expected: FAIL — `cycle_errors` stays empty.

- [ ] **Step 3: Write the implementation**

In `engine/src/ops/log.ts`, add the import:

```ts
import { errorSignature } from './fingerprint.js'
```

Compute the signatures next to where `proof` is computed, before the state update:

```ts
  const signatures = errorSignature(parsed.value.evidence, parsed.value.status)
```

Widen the condition that guards the update, and append inside it. The update currently
runs when there are findings or a gate proof; it must also run when there are signatures:

```ts
  if (parsed.value.findings.length > 0 || proof !== undefined || signatures.length > 0) {
    await store.update((draft) => {
      // The read above was not locked, so a `cycleAdvance` may have landed in
      // between: it has archived the cycle these findings belong to and either
      // opened the next one or ended the run. Pushing now would file this
      // agent's work under a cycle that did not do it — or leave an open
      // finding on a run that is already `done`.
      if (draft.status !== 'running') throw new NoActiveRunError()
      if (draft.cycle !== state.cycle) throw new CycleClosedError(agent.data, state.cycle, draft.cycle)
      draft.findings.push(...parsed.value.findings)
      if (proof !== undefined) {
        draft.reproduction = { agent: agent.data, cycle: draft.cycle, ref: proof.ref, excerpt: proof.excerpt }
      }
      // Deduplicated across agents: one defect reported by two agents is one
      // failure recurring, not two, exactly as the stagnation fingerprint
      // deduplicates findings.
      for (const signature of signatures) {
        if (!draft.cycle_errors.includes(signature)) draft.cycle_errors.push(signature)
      }
    })
  }
```

Preserve whatever the existing update body already does — the block above shows the shape
after the addition, and the surrounding checks must not be dropped.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd engine && npx vitest run && npm run typecheck`
Expected: PASS — every suite green.

- [ ] **Step 5: Commit**

```bash
git add engine/src/ops/log.ts engine/tests/ops/log.test.ts
git commit -m "feat(engine): collect error signatures as results are logged"
```

---

## Task 4: The repeated-error guard

**Files:**
- Modify: `engine/src/ops/run.ts`
- Test: `engine/tests/ops/run.test.ts`

**Interfaces:**
- Consumes: `errorFingerprint` (Task 1); `State.cycle_errors`, `State.last_error_fingerprint` (Task 2).
- Produces: `cycleAdvance` halts on a repeated error, before the stagnation check, and clears `cycle_errors` when the next cycle opens.

- [ ] **Step 1: Write the failing test**

Add to `engine/tests/ops/run.test.ts`:

```ts
describe('the repeated-error guard', () => {
  function failing(headline: string, claim: string) {
    return {
      status: 'fail' as const,
      summary: 'the suite is red',
      evidence: [{ kind: 'command' as const, ref: 'npm test', excerpt: headline }],
      findings: [{ severity: 'high' as const, file: 'src/a.ts', line: 1, claim }],
      files_touched: [],
      next_hint: null,
    }
  }

  async function failCycle(headline: string, claim: string) {
    await runLog(project.dir, { agent: 'verifier', result: failing(headline, claim) }, clock)
    return cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)
  }

  beforeEach(async () => {
    await runStart(project.dir, { track: 'build', goal: 'Add the endpoint' }, clock)
  })

  it('does not halt on the first failure', async () => {
    const { state } = await failCycle('1 failing: cannot resolve module', 'first')
    expect(state.status).toBe('running')
  })

  it('halts on the first repeat, at cycle 2', async () => {
    await failCycle('1 failing: cannot resolve module', 'first')
    const { state } = await failCycle('1 failing: cannot resolve module', 'second')

    expect(state.status).toBe('halted')
    expect(state.cycle).toBe(2)
    expect(state.halt_reason).toBe('the same verification failure recurred: npm test')
  })

  it('halts even when the findings changed, which stagnation would have missed', async () => {
    await failCycle('1 failing: cannot resolve module', 'a nit')
    const { state } = await failCycle('1 failing: cannot resolve module', 'a different nit')
    expect(state.status).toBe('halted')
    expect(state.halt_reason).toContain('same verification failure')
  })

  it('matches a repeat whose only difference is a count', async () => {
    await failCycle('1 failing: cannot resolve module', 'first')
    const { state } = await failCycle('7 failing: cannot resolve module', 'second')
    expect(state.status).toBe('halted')
  })

  it('does not halt when the failure changes', async () => {
    await failCycle('1 failing: cannot resolve module', 'first')
    const { state } = await failCycle('1 failing: type error in Button', 'second')
    expect(state.status).toBe('running')
  })

  it('never fires on a cycle with no error signatures', async () => {
    await runLog(
      project.dir,
      {
        agent: 'verifier',
        result: {
          status: 'fail',
          summary: 'no commands were run',
          evidence: [],
          findings: [{ severity: 'high', file: 'src/a.ts', line: 1, claim: 'same' }],
          files_touched: [],
          next_hint: null,
        },
      },
      clock,
    )
    const first = await cycleAdvance(project.dir, { agents: ['verifier'], result: 'fail' }, clock)
    expect(first.state.status).toBe('running')
  })

  it('reports the error reason rather than stagnation when both would fire', async () => {
    // Identical findings and an identical failure: stagnation needs a third
    // cycle, so the error guard is the one that can fire here at all.
    await failCycle('1 failing: cannot resolve module', 'same')
    const { state } = await failCycle('1 failing: cannot resolve module', 'same')
    expect(state.halt_reason).toContain('same verification failure')
    expect(state.halt_reason).not.toContain('no progress')
  })

  it('clears the signatures when the next cycle opens', async () => {
    await failCycle('1 failing: cannot resolve module', 'first')
    expect((await new StateStore(project.dir).get()).cycle_errors).toEqual([])
  })

  it('never fires on a pass', async () => {
    await failCycle('1 failing: cannot resolve module', 'first')
    await runLog(
      project.dir,
      {
        agent: 'verifier',
        result: {
          status: 'pass',
          summary: 'green',
          evidence: [{ kind: 'command', ref: 'npm test', excerpt: '1 failing: cannot resolve module' }],
          findings: [],
          files_touched: [],
          next_hint: null,
        },
      },
      clock,
    )
    const { state } = await cycleAdvance(project.dir, { agents: ['verifier'], result: 'pass' }, clock)
    expect(state.status).toBe('done')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/ops/run.test.ts`
Expected: FAIL — no run halts for a repeated error.

- [ ] **Step 3: Write the implementation**

In `engine/src/ops/run.ts`, add the import:

```ts
import { cycleFingerprint, errorFingerprint } from './fingerprint.js'
```

Inside the locked update in `cycleAdvance`, capture the cycle's errors alongside the
findings — add next to `carried = [...draft.findings]`:

```ts
    const errors = [...draft.cycle_errors]
```

Then insert the guard immediately after the `pass` early return and **before** the
stagnation block:

```ts
    // Checked before stagnation because it fires a cycle earlier and names a
    // more specific cause. An identical command failing identically is
    // stronger evidence than identical findings, so one repeat is enough
    // where stagnation waits for two strikes.
    if (errors.length > 0) {
      const currentErrors = errorFingerprint(errors)
      const repeated = currentErrors === draft.last_error_fingerprint
      draft.last_error_fingerprint = currentErrors
      if (repeated) {
        draft.status = 'halted'
        draft.current.stage = 'halted'
        draft.halt_reason = `the same verification failure recurred: ${refOf(errors[0] ?? '')}`
        return
      }
    }
```

Add the helper beside the other module-level functions in the file:

```ts
/** The command from a `<ref> :: <headline>` signature. */
function refOf(signature: string): string {
  return signature.split(' :: ')[0] ?? signature
}
```

Finally, clear the signatures where the findings are cleared — in the block that opens the
next cycle, beside `draft.findings = []`:

```ts
    draft.cycle_errors = []
```

A run that ended above keeps them, for the same reason it keeps its findings: they are the
failures it ended with, and `HALT.md` has nothing else to report them from.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd engine && npx vitest run && npm run typecheck`
Expected: PASS — every suite green.

- [ ] **Step 5: Commit**

```bash
git add engine/src/ops/run.ts engine/tests/ops/run.test.ts
git commit -m "feat(engine): halt when the same verification failure recurs"
```

---

## Task 5: The autonomous `Stop` hook

**Files:**
- Modify: `engine/src/cli/index.ts`, `hooks/hooks.json`
- Create: `hooks/scripts/stop-guard.sh`
- Test: `engine/tests/cli/index.test.ts`

**Interfaces:**
- Consumes: `stateSummary` from `engine/src/ops/summary.ts`; `loadConfig` from `engine/src/store/config-store.ts`.
- Produces: `StopVerdict { block: boolean; reason: string }`; `evaluateStopGuard(input: unknown, summary: StateSummary, autonomous: boolean): StopVerdict`; the `stop-guard` CLI subcommand.

The hook contract below was taken from the official hooks reference. Two details differ
from the plugin's existing hooks and are easy to get wrong: blocking uses a **top-level**
`{"decision":"block","reason":"..."}` rather than the `hookSpecificOutput` shape that
`SessionStart` and `PreToolUse` use, and `Stop` does **not** fire when a subagent finishes
— that is a separate `SubagentStop` event, which this plugin deliberately does not register.

- [ ] **Step 1: Write the failing test**

Add to `engine/tests/cli/index.test.ts`:

```ts
describe('evaluateStopGuard', () => {
  const running = {
    initialised: true,
    status: 'running' as const,
    track: 'build',
    run_id: '2026-07-27-001',
    cycle: 2,
    max_cycles: 5,
    plan: null,
    story: null,
    stage: 'compose',
    goal: 'Add a Send button',
    findings: { high: 2, medium: 0, low: 1 },
    last_cycle: { result: 'fail', agents: ['builder', 'verifier'] },
    halt_reason: null,
    reproduction: null,
  }

  const input = { hook_event_name: 'Stop', cwd: '/repo', stop_hook_active: false }

  it('blocks a running autonomous loop', () => {
    const verdict = evaluateStopGuard(input, running, true)
    expect(verdict.block).toBe(true)
  })

  it('names the track, the cycle, and the open findings', () => {
    const { reason } = evaluateStopGuard(input, running, true)
    expect(reason).toContain('build')
    expect(reason).toContain('cycle 2 of 5')
    expect(reason).toContain('Add a Send button')
    expect(reason).toContain('3 open findings')
    expect(reason).toContain('loop-leader')
  })

  it('allows the stop when a Stop hook already continued this turn', () => {
    expect(evaluateStopGuard({ ...input, stop_hook_active: true }, running, true).block).toBe(false)
  })

  it('allows the stop when the project has not opted into autonomy', () => {
    expect(evaluateStopGuard(input, running, false).block).toBe(false)
  })

  it('allows the stop when the project has no loop', () => {
    const uninitialised = { ...running, initialised: false, status: 'uninitialised' as const }
    expect(evaluateStopGuard(input, uninitialised, true).block).toBe(false)
  })

  it('allows the stop for every status that is not running', () => {
    for (const status of ['idle', 'done', 'halted', 'paused', 'failed'] as const) {
      expect(evaluateStopGuard(input, { ...running, status }, true).block).toBe(false)
    }
  })

  it('allows the stop on malformed hook input rather than trapping the session', () => {
    expect(evaluateStopGuard(null, running, true).block).toBe(false)
    expect(evaluateStopGuard('nonsense', running, true).block).toBe(false)
  })

  it('says there are no open findings when there are none', () => {
    const clean = { ...running, findings: { high: 0, medium: 0, low: 0 } }
    expect(evaluateStopGuard(input, clean, true).reason).toContain('no open findings')
  })
})

describe('runCli stop-guard', () => {
  it('emits nothing for a project with no loop', async () => {
    const { stdout, exitCode } = await runCli(['stop-guard'], JSON.stringify({ cwd: project.dir, stop_hook_active: false }))
    expect(stdout).toBe('')
    expect(exitCode).toBe(0)
  })

  it('emits nothing for an initialised project that has not opted in', async () => {
    await initLoop(project.dir, clock)
    await runStart(project.dir, { track: 'build', goal: 'Add it' }, clock)
    const { stdout } = await runCli(['stop-guard'], JSON.stringify({ cwd: project.dir, stop_hook_active: false }))
    expect(stdout).toBe('')
  })

  it('emits a top-level block decision for a running autonomous loop', async () => {
    await initLoop(project.dir, clock)
    const config = await loadConfig(project.dir)
    config.autonomous = true
    await writeConfig(project.dir, config)
    await runStart(project.dir, { track: 'build', goal: 'Add it' }, clock)

    const { stdout } = await runCli(['stop-guard'], JSON.stringify({ cwd: project.dir, stop_hook_active: false }))
    const payload = JSON.parse(stdout)
    expect(payload.decision).toBe('block')
    expect(payload.reason).toContain('build')
    // Not the hookSpecificOutput shape the other two hooks use.
    expect(payload.hookSpecificOutput).toBeUndefined()
  })

  it('emits nothing once the run is done', async () => {
    await initLoop(project.dir, clock)
    const config = await loadConfig(project.dir)
    config.autonomous = true
    await writeConfig(project.dir, config)
    await runStart(project.dir, { track: 'build', goal: 'Add it' }, clock)
    await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'pass' }, clock)

    const { stdout } = await runCli(['stop-guard'], JSON.stringify({ cwd: project.dir, stop_hook_active: false }))
    expect(stdout).toBe('')
  })

  it('emits nothing on unparseable stdin', async () => {
    const { stdout, exitCode } = await runCli(['stop-guard'], 'not json')
    expect(stdout).toBe('')
    expect(exitCode).toBe(0)
  })
})
```

Add to that file's imports: `evaluateStopGuard` from `../../src/cli/index.js`; `initLoop`
from `../../src/ops/init.js`; `runStart`, `cycleAdvance` from `../../src/ops/run.js`;
`loadConfig`, `writeConfig` from `../../src/store/config-store.js`. The file already has a
`project` fixture and a `clock`; reuse them.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/cli/index.test.ts`
Expected: FAIL — `evaluateStopGuard` is not exported and `stop-guard` is an unknown command.

- [ ] **Step 3: Write the implementation**

In `engine/src/cli/index.ts`, add the import and extend the usage text:

```ts
import { ConfigMissingError, loadConfig } from '../store/config-store.js'
```

```
  stop-guard                        Stop hook (reads hook JSON on stdin)
```

Add the command to the `switch` in `runCli`:

```ts
    case 'stop-guard':
      return stopGuardCommand(stdin)
```

Add the verdict type, the pure evaluator, and the command:

```ts
export interface StopVerdict {
  block: boolean
  reason: string
}

/**
 * Decide whether an autonomous run should keep going when Claude Code is about
 * to end the turn.
 *
 * Every branch that is not "a running loop in a project that opted in" allows
 * the stop. That includes anything this function could not make sense of: a
 * guard that blocks on its own confusion traps the session, and there is no
 * way out from inside it.
 */
export function evaluateStopGuard(input: unknown, summary: StateSummary, autonomous: boolean): StopVerdict {
  if (typeof input !== 'object' || input === null) return { block: false, reason: '' }

  // Claude Code sets this once a Stop hook has already caused a continuation
  // this turn. Re-blocking is how a hook loops forever; its own cap on
  // consecutive blocks is a backstop, not a design.
  if ((input as { stop_hook_active?: unknown }).stop_hook_active === true) return { block: false, reason: '' }

  if (!autonomous) return { block: false, reason: '' }
  if (!summary.initialised) return { block: false, reason: '' }
  if (summary.status !== 'running') return { block: false, reason: '' }

  const cap = summary.max_cycles === null ? '?' : String(summary.max_cycles)
  const open = summary.findings.high + summary.findings.medium + summary.findings.low
  const findings =
    open === 0
      ? 'There are no open findings from the previous cycle.'
      : `${open} open findings carried from the previous cycle (${summary.findings.high} high, ${summary.findings.medium} medium, ${summary.findings.low} low).`

  return {
    block: true,
    reason: [
      `Loop is running autonomously: track ${summary.track}, cycle ${summary.cycle} of ${cap}, stage ${summary.stage}.`,
      `Goal: ${summary.goal ?? 'not set'}.`,
      findings,
      'Continue the cycle with the loop-leader skill. Do not stop until the run reaches done or halted —',
      "the engine's guards end it: the cycle cap, the stagnation guard, and the repeated-error guard.",
    ].join('\n'),
  }
}

async function stopGuardCommand(stdin: string): Promise<CliResult> {
  let input: unknown
  try {
    input = JSON.parse(stdin) as unknown
  } catch {
    return { stdout: '', exitCode: 0 }
  }

  const cwd = readCwd(stdin)
  const summary = await stateSummary(cwd)

  let autonomous = false
  try {
    autonomous = (await loadConfig(cwd)).autonomous
  } catch (error) {
    // A project with no config has not opted into autonomy, and an unreadable
    // one cannot be read as opting in either.
    if (!(error instanceof ConfigMissingError)) autonomous = false
  }

  const verdict = evaluateStopGuard(input, summary, autonomous)
  if (!verdict.block) return { stdout: '', exitCode: 0 }

  // A top-level decision object. This is NOT the hookSpecificOutput shape the
  // SessionStart and PreToolUse hooks use — the Stop event has its own.
  return { stdout: `${JSON.stringify({ decision: 'block', reason: verdict.reason })}\n`, exitCode: 0 }
}
```

`StateSummary` must be imported as a type from `../ops/summary.js` alongside the existing
`stateSummary` and `renderSummaryLine` imports.

- [ ] **Step 4: Write the hook script and register it**

`hooks/scripts/stop-guard.sh`:

```bash
#!/usr/bin/env bash
# Keep an autonomous loop going when Claude Code would otherwise end the turn.
# Silent unless the project set autonomous: true and a run is still going.
# All logic lives in loop-cli; this wrapper only moves bytes.
set -euo pipefail
exec node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli/index.js" stop-guard
```

Run: `chmod +x hooks/scripts/stop-guard.sh`

Add to `hooks/hooks.json`, alongside the existing events:

```json
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/stop-guard.sh" }
        ]
      }
    ]
```

`SubagentStop` is deliberately not registered: it is a separate event that fires when a
subagent finishes, and this plugin dispatches several per cycle.

- [ ] **Step 5: Verify the wiring from the shell**

Run: `cd engine && npm run build && echo '{"hook_event_name":"Stop","cwd":"/nonexistent","stop_hook_active":false}' | node dist/cli/index.js stop-guard; echo "exit=$?"`
Expected: no output, `exit=0` — a project with no loop is silent.

Run: `echo '{"hook_event_name":"Stop","cwd":"/nonexistent","stop_hook_active":true}' | node engine/dist/cli/index.js stop-guard; echo "exit=$?"`
Expected: no output, `exit=0`.

- [ ] **Step 6: Run the whole suite**

Run: `cd engine && npx vitest run && npm run typecheck && npm run build`
Expected: PASS — every suite green.

- [ ] **Step 7: Commit**

```bash
git add engine/src/cli/index.ts engine/tests/cli/index.test.ts hooks/hooks.json hooks/scripts/stop-guard.sh
git commit -m "feat(hooks): add the autonomous stop guard"
```

---

## Task 6: `/loop:resume`, the leader, and the autonomy proof

**Files:**
- Create: `commands/resume.md`, `engine/tests/integration/autonomy.test.ts`
- Modify: `skills/loop-leader/SKILL.md`, `README.md`, `engine/src/ops/init.ts`, `commands/init.md`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: `/loop:resume`; the leader's third halt reason; proof that an autonomous run is bounded and that the hook releases when it ends.

- [ ] **Step 1: Write `commands/resume.md`**

```markdown
---
description: Continue a loop run that was interrupted
---

Pick up a run that stopped without finishing — a closed terminal, a crashed session, a
machine that slept mid-cycle.

1. Call `loop_state_get`. If nothing is `running`, say so and stop: there is nothing to
   resume. Report what the last run ended as, and offer the command that would start a new
   one.
2. Read the run directory for the open cycle. The per-agent results already logged tell
   you which agents ran and what they returned — that is where the cycle got to.
3. Continue from that stage with the **loop-leader** skill. Do not restart the cycle from
   the beginning: an agent whose result is already logged does not need to run again, and
   re-running it would double its findings.
4. If the run is on a gated track and the gate is already open, it stays open. Reproduction
   and fit-check evidence survive an interruption.

Nothing here resets state. If the interrupted run should be abandoned rather than
continued, `/loop:stop` halts it cleanly with a report.
```

- [ ] **Step 2: Add the guard and autonomy sections to `skills/loop-leader/SKILL.md`**

Read the file first — it has grown across five milestones. Extend the section that reports
a halt so it covers three reasons rather than two, and add the autonomy note. Keep every
existing section:

```markdown
Three halt reasons are possible, and they are not the same problem:

- *cycle cap reached* — the work needed more cycles than the track allows.
- *no progress for N consecutive cycles* — the loop closed N cycles with the same work
  remaining. More cycles would not have helped.
- *the same verification failure recurred* — one command failed the same way twice
  running. Name that command in your report: it is the most specific thing the run knows
  about why it stopped.

Do not raise `max_cycles`, do not restart to clear a strike count, and do not re-run to
see whether the same failure happens a third time. All three are the user's decision.

### Running autonomously

When `autonomous: true` is set in `.loop/config.yaml`, a `Stop` hook keeps the turn going
between cycles, so a run continues without the user pressing enter.

Nothing about your judgement changes. The hook does not extend any limit — it only removes
the pause, and every guard still ends the run exactly where it would have. What does change
is that nobody is reading your intermediate reports, so make the final one complete: what
was attempted, what the evidence showed, and where it stopped.

If the run halts, say so plainly and stop. The hook releases the turn the moment the run is
no longer `running`.
```

- [ ] **Step 3: Register the command with host projects**

In `engine/src/ops/init.ts`, add to `CLAUDE_MD_BLOCK` after the stop line:

```
- \`/loop:resume\` — continue a run that was interrupted
```

In `commands/init.md`, add `/loop:resume` wherever the commands are listed.

In `README.md`, add to the `## Use` block after the stop line:

```
/loop:resume                             continue an interrupted run
```

and add a short section after the plans-and-stories section:

```markdown
## Running unattended

Set `autonomous: true` in `.loop/config.yaml` and a `Stop` hook keeps the turn going
between cycles, so a run carries itself to completion.

It extends nothing. The cycle cap, the stagnation guard, and the repeated-error guard end
the run exactly where they would have with a person pressing enter — the hook only removes
the pause, and it goes quiet the moment the run is no longer running.
```

- [ ] **Step 4: Write the failing integration test**

`engine/tests/integration/autonomy.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { evaluateStopGuard } from '../../src/cli/index.js'
import { initLoop } from '../../src/ops/init.js'
import { runLog } from '../../src/ops/log.js'
import { cycleAdvance, runStart } from '../../src/ops/run.js'
import { stateSummary } from '../../src/ops/summary.js'
import { loadConfig, writeConfig } from '../../src/store/config-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-27T09:00:00.000Z')
const clock = () => NOW
const HOOK = { hook_event_name: 'Stop', cwd: '', stop_hook_active: false }

let project: TmpProject

beforeEach(async () => {
  project = await makeTmpProject()
  await initLoop(project.dir, clock)
  const config = await loadConfig(project.dir)
  config.autonomous = true
  await writeConfig(project.dir, config)
})
afterEach(async () => { await project.cleanup() })

function failing(headline: string, claim: string) {
  return {
    status: 'fail' as const,
    summary: 'the suite is red',
    evidence: [{ kind: 'command' as const, ref: 'npm test', excerpt: headline }],
    findings: [{ severity: 'high' as const, file: 'src/a.ts', line: 1, claim }],
    files_touched: [],
    next_hint: null,
  }
}

describe('an autonomous run', () => {
  it('is kept going by the hook and released the moment its guard ends it', async () => {
    await runStart(project.dir, { track: 'build', goal: 'Add the endpoint' }, clock)

    // Cycle 1 fails. The run continues, so the hook blocks the stop.
    await runLog(project.dir, { agent: 'verifier', result: failing('1 failing: cannot resolve module', 'first') }, clock)
    const first = await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)
    expect(first.state.status).toBe('running')

    const blocked = evaluateStopGuard(HOOK, await stateSummary(project.dir), true)
    expect(blocked.block).toBe(true)
    expect(blocked.reason).toContain('cycle 2 of 5')

    // Cycle 2 fails the same way. The repeated-error guard halts the run.
    await runLog(project.dir, { agent: 'verifier', result: failing('1 failing: cannot resolve module', 'second') }, clock)
    const second = await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)
    expect(second.state.status).toBe('halted')
    expect(second.state.halt_reason).toContain('same verification failure')

    // The hook goes quiet: the run is no longer running.
    const released = evaluateStopGuard(HOOK, await stateSummary(project.dir), true)
    expect(released.block).toBe(false)
  })

  it('is released by the cycle cap when nothing repeats', async () => {
    const config = await loadConfig(project.dir)
    config.tracks.build = { required: ['builder', 'verifier'], available: [], max_cycles: 2 }
    await writeConfig(project.dir, config)

    await runStart(project.dir, { track: 'build', goal: 'Add the endpoint' }, clock)
    await runLog(project.dir, { agent: 'verifier', result: failing('error A', 'first') }, clock)
    await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)

    await runLog(project.dir, { agent: 'verifier', result: failing('error B', 'second') }, clock)
    const second = await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)

    expect(second.state.status).toBe('halted')
    expect(second.state.halt_reason).toContain('cycle cap 2')
    expect(evaluateStopGuard(HOOK, await stateSummary(project.dir), true).block).toBe(false)
  })

  it('never blocks a project that did not opt in', async () => {
    const config = await loadConfig(project.dir)
    config.autonomous = false
    await writeConfig(project.dir, config)

    await runStart(project.dir, { track: 'build', goal: 'Add the endpoint' }, clock)
    expect(evaluateStopGuard(HOOK, await stateSummary(project.dir), false).block).toBe(false)
  })
})
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd engine && npx vitest run tests/integration/autonomy.test.ts`
Expected: PASS if Tasks 1–5 landed correctly — the ops and the evaluator cover every
assertion. A failure here is a defect in them, not in the test.

- [ ] **Step 6: Run the whole suite**

Run: `cd engine && npm test && npm run typecheck && npm run build`
Expected: PASS — every test green, typecheck clean, `dist/` rebuilt.

- [ ] **Step 7: Commit**

```bash
git add commands/resume.md commands/init.md skills/loop-leader/SKILL.md README.md engine/src/ops/init.ts engine/tests/integration/autonomy.test.ts
git commit -m "feat(plugin): add /loop:resume and prove an autonomous run stays bounded"
```

---

## Milestone Complete

Verify before declaring done:

- [ ] `cd engine && npm test` — all green, three consecutive runs with the same count
- [ ] `cd engine && npm run typecheck` — clean
- [ ] `cd engine && npm run build` — `dist/` rebuilt
- [ ] `claude plugin details loop@loop` — 8 commands, 3 hooks
- [ ] The same failing command twice halts at cycle 2, naming the command
- [ ] A changed failure does not halt
- [ ] The stop guard is silent for a project with no `.loop/`, for one that did not opt in, and when `stop_hook_active` is true
- [ ] The stop guard blocks a running autonomous loop with a top-level `decision` object
- [ ] `LOOP_E2E=1 npm run e2e`, `e2e:build`, `e2e:fix`, `e2e:story`, `e2e:plan` — earlier tracks still pass

## Next Milestones

| Milestone | Delivers |
|---|---|
| 6 — UI and specialists | `design-system.md` extraction, `/loop:design-sync`, `ui-designer`, `ui-critic`, `security`, `docs`, `perf` |
| 7 — Memory and extension | `loop_memory_*`, `/loop:add`, `loop-tracks`, `loop-extend` |
