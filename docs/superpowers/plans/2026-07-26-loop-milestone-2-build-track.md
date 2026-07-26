# Loop — Milestone 2: Build Track and Stagnation Guard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `/loop:build <goal>` — the first genuinely multi-cycle track — with a stagnation guard that halts a stuck run before it burns its cycle cap.

**Architecture:** The track is data: two lines in `DEFAULT_TRACKS` and three new agent markdown files, with no branching added to the leader. The guard lives in the engine, not in the leader's prompt: `cycleAdvance` computes a fingerprint from the findings the cycle closed with, so the judgement cannot be skipped or gamed by a model and is unit-testable without a project on disk. Findings become per-cycle — archived, cleared, and handed back to the leader as the next cycle's task list.

**Tech Stack:** TypeScript 5 · Node 24 (floor 20) · zod 4.4.3 · @modelcontextprotocol/sdk 1.29.0 · vitest 4.1.10

**Spec:** `docs/superpowers/specs/2026-07-26-loop-milestone-2-build-track-design.md`

## Global Constraints

- All plugin files, prompts, code, comments, and documentation in **English**. Conversation with the user is Arabic; nothing in the repository is.
- **zod 4 idioms only:** `z.strictObject(...)` not `z.object(...).strict()`; `z.iso.datetime()` not `z.string().datetime()`; `z.record(keySchema, valueSchema)` requires both arguments; format errors with `z.prettifyError(error)`.
- **State has one owner.** Nothing outside `engine/src/store` and `engine/src/ops` may write `.loop/state.json`.
- **`verifier` is a hard invariant.** `rosterSet` must keep rejecting any roster that omits a track's `required` agents.
- **Every judgement inside `cycleAdvance` reads the locked draft**, never a pre-lock snapshot. Milestone 1 fixed a race where two concurrent advances stepped a run past its cap; adding fingerprint bookkeeping must not reintroduce it.
- Every task ends with a commit. Tests must be seen failing before the implementation is written.

---

## File Structure

| File | Responsibility |
|---|---|
| `engine/src/ops/fingerprint.ts` | **New.** `cycleFingerprint` — pure, no I/O |
| `engine/src/schemas/state.ts` | Add `last_fingerprint` |
| `engine/src/schemas/config.ts` | Add the `build` track to `DEFAULT_TRACKS` |
| `engine/src/ops/run.ts` | `cycleAdvance` returns `CycleAdvanceResult`, archives findings, applies the guard |
| `engine/src/mcp/server.ts` | `loop_cycle_advance` description reflects the new output |
| `agents/scout.md`, `agents/builder.md`, `agents/critic.md` | **New.** Three build-track agents |
| `commands/build.md` | **New.** `/loop:build <goal>` |
| `skills/loop-leader/SKILL.md` | Folding findings, commit per passing cycle, halt reasons |
| `engine/tests/ops/fingerprint.test.ts` | **New.** Fingerprint unit tests |
| `engine/tests/integration/build-cycle.test.ts` | **New.** Multi-cycle and stuck-run integration tests |
| `tests/e2e/run-build.sh` | **New.** Opt-in real-CLI smoke test |

---

## Task 1: Cycle fingerprint

**Files:**
- Create: `engine/src/ops/fingerprint.ts`
- Test: `engine/tests/ops/fingerprint.test.ts`

**Interfaces:**
- Consumes: `Finding`, `Result` from `engine/src/schemas/state.ts`.
- Produces: `cycleFingerprint(findings: Finding[], result: Result): string`.

- [ ] **Step 1: Write the failing test**

`engine/tests/ops/fingerprint.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/ops/fingerprint.test.ts`
Expected: FAIL — cannot resolve `../../src/ops/fingerprint.js`.

- [ ] **Step 3: Write the implementation**

`engine/src/ops/fingerprint.ts`:

```ts
import { createHash } from 'node:crypto'
import type { Finding, Result } from '../schemas/state.js'

/**
 * A deterministic identity for the work still remaining after a cycle.
 *
 * Findings are sorted before hashing: agents are dispatched concurrently, so
 * the order findings land in `state.findings` varies between otherwise
 * identical cycles, and an unsorted hash would make every cycle look new —
 * silently disabling the stagnation guard rather than loosening it.
 *
 * Evidence is absent by design. Excerpts carry durations and counts that
 * differ between runs of the same failing command, which would produce a
 * unique fingerprint every cycle. `files_touched` is absent too: including it
 * would make the guard *more* permissive, letting a loop that flails at a
 * different file each cycle escape every strike.
 */
export function cycleFingerprint(findings: Finding[], result: Result): string {
  const sorted = [...findings].sort(compareFindings)
  const payload = JSON.stringify({
    result,
    findings: sorted.map((finding) => [finding.severity, finding.file, finding.line, finding.claim]),
  })
  return createHash('sha256').update(payload).digest('hex')
}

function compareFindings(a: Finding, b: Finding): number {
  return (
    a.severity.localeCompare(b.severity) ||
    a.file.localeCompare(b.file) ||
    a.line - b.line ||
    a.claim.localeCompare(b.claim)
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd engine && npx vitest run tests/ops/fingerprint.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add engine/src/ops/fingerprint.ts engine/tests/ops/fingerprint.test.ts
git commit -m "feat(engine): add deterministic cycle fingerprint"
```

---

## Task 2: `last_fingerprint` in state

**Files:**
- Modify: `engine/src/schemas/state.ts`
- Test: `engine/tests/schemas/state.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `State.last_fingerprint: string | null`; `initialState` sets it to `null`.

- [ ] **Step 1: Write the failing tests**

Add these two tests to `engine/tests/schemas/state.test.ts`, inside the existing `describe('StateSchema', ...)` block:

```ts
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
```

And extend the existing `initialState` test with one assertion:

```ts
    expect(state.last_fingerprint).toBeNull()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/schemas/state.test.ts`
Expected: FAIL — `last_fingerprint` is an unknown key, rejected by the strict object.

- [ ] **Step 3: Write the implementation**

In `engine/src/schemas/state.ts`, add this field to `StateSchema` immediately after `no_progress_count`:

```ts
  /**
   * Fingerprint of the previous cycle, compared by the stagnation guard.
   *
   * The default is load-bearing: `StateSchema` is a strict object, so without
   * it every `state.json` written before this field existed would fail
   * validation on read rather than gaining the field on its next write.
   */
  last_fingerprint: z.string().min(1).nullable().default(null),
```

And add the field to `initialState`, after `no_progress_count: 0,`:

```ts
    last_fingerprint: null,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd engine && npx vitest run tests/schemas/state.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add engine/src/schemas/state.ts engine/tests/schemas/state.test.ts
git commit -m "feat(engine): record the previous cycle fingerprint in state"
```

---

## Task 3: The `build` track

**Files:**
- Modify: `engine/src/schemas/config.ts`
- Test: `engine/tests/schemas/config.test.ts`

**Interfaces:**
- Consumes: `Track` from the same file.
- Produces: `DEFAULT_TRACKS.build`.

- [ ] **Step 1: Write the failing test**

Add to `engine/tests/schemas/config.test.ts`, inside the existing `describe('DEFAULT_TRACKS', ...)`:

```ts
  it('makes builder and verifier required for build, with scout and critic available', () => {
    expect(DEFAULT_TRACKS.build).toEqual({
      required: ['builder', 'verifier'],
      available: ['scout', 'critic'],
      max_cycles: 5,
    })
  })
```

And update the existing assertion in `describe('defaultConfig', ...)` — it currently expects only the edit track:

```ts
    expect(Object.keys(config.tracks)).toEqual(['edit', 'build'])
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/schemas/config.test.ts`
Expected: FAIL — `DEFAULT_TRACKS.build` is undefined.

- [ ] **Step 3: Write the implementation**

In `engine/src/schemas/config.ts`, extend `DEFAULT_TRACKS`:

```ts
export const DEFAULT_TRACKS: Record<string, Track> = {
  edit: { required: ['editor', 'verifier'], available: [], max_cycles: 1 },
  // max_cycles is a ceiling, not a target: with the stagnation guard in place
  // a stuck run halts well before reaching it.
  build: { required: ['builder', 'verifier'], available: ['scout', 'critic'], max_cycles: 5 },
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd engine && npx vitest run tests/schemas/config.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add engine/src/schemas/config.ts engine/tests/schemas/config.test.ts
git commit -m "feat(engine): add the build track to the default config"
```

---

## Task 4: Per-cycle findings and the `CycleAdvanceResult` shape

**Files:**
- Modify: `engine/src/ops/run.ts`
- Modify: `engine/src/mcp/server.ts` (tool description only)
- Test: `engine/tests/ops/run.test.ts`, `engine/tests/mcp/server.test.ts`, `engine/tests/integration/edit-cycle.test.ts`

**Interfaces:**
- Consumes: `Finding` from `engine/src/schemas/state.ts`.
- Produces: `CycleAdvanceResult { state: State; carried_findings: Finding[]; fingerprint: string | null; strikes: number }`; `cycleAdvance` now returns `Promise<CycleAdvanceResult>` instead of `Promise<State>`.

- [ ] **Step 1: Write the failing tests**

Add to `engine/tests/ops/run.test.ts` a new describe block. It needs `runLog`, so add the import `import { runLog } from '../../src/ops/log.js'` at the top of the file:

```ts
describe('cycleAdvance findings lifecycle', () => {
  const failing = (claim: string) => ({
    status: 'fail' as const,
    summary: 'the suite is still red',
    evidence: [{ kind: 'command' as const, ref: 'npm test', excerpt: '1 failing' }],
    findings: [{ severity: 'high' as const, file: 'src/a.ts', line: 1, claim }],
    files_touched: [],
    next_hint: null,
  })

  it('returns the closed cycle findings and clears them from state', async () => {
    await runStart(project.dir, { track: 'edit', goal: 'Rename' }, clock)
    await runLog(project.dir, { agent: 'verifier', result: failing('assertion is stale') }, clock)

    const { state, carried_findings } = await cycleAdvance(
      project.dir,
      { agents: ['editor', 'verifier'], result: 'fail' },
      clock,
    )

    expect(carried_findings).toEqual([
      { severity: 'high', file: 'src/a.ts', line: 1, claim: 'assertion is stale' },
    ])
    expect(state.findings).toEqual([])
  })

  it('archives the closed cycle findings next to the agent results', async () => {
    const started = await runStart(project.dir, { track: 'edit', goal: 'Rename' }, clock)
    await runLog(project.dir, { agent: 'verifier', result: failing('assertion is stale') }, clock)
    const { carried_findings } = await cycleAdvance(
      project.dir,
      { agents: ['editor', 'verifier'], result: 'fail' },
      clock,
    )

    const file = path.join(runDirPath(project.dir, started), 'cycle-01', 'findings.json')
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(carried_findings)
  })

  it('carries a passing cycle findings too, with no next cycle to hand them to', async () => {
    await runStart(project.dir, { track: 'edit', goal: 'Rename' }, clock)
    await runLog(
      project.dir,
      {
        agent: 'verifier',
        result: { ...failing('minor nit'), status: 'pass', findings: [{ severity: 'low', file: 'src/a.ts', line: 2, claim: 'minor nit' }] },
      },
      clock,
    )
    const { state, carried_findings } = await cycleAdvance(
      project.dir,
      { agents: ['editor', 'verifier'], result: 'pass' },
      clock,
    )
    expect(state.status).toBe('done')
    expect(carried_findings).toHaveLength(1)
    expect(state.findings).toEqual([])
  })
})
```

Then update every existing call site that destructured the old return value:

- `engine/tests/ops/run.test.ts` lines using `const state = await cycleAdvance(...)` become `const { state } = await cycleAdvance(...)` (three occurrences, in the pass, cap-halt, and next-cycle tests).
- `engine/tests/integration/edit-cycle.test.ts` — two occurrences, same change.
- `engine/tests/mcp/server.test.ts` — the full-cycle test asserts `JSON.parse(textOf(advanced)).status`; it becomes `JSON.parse(textOf(advanced)).state.status`.
- `engine/tests/ops/summary.test.ts` awaits `cycleAdvance` without using the value; no change.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd engine && npx vitest run`
Expected: FAIL — `carried_findings` is undefined, and `state` is undefined on the destructured results.

- [ ] **Step 3: Write the implementation**

In `engine/src/ops/run.ts`, add the result type above `cycleAdvance`:

```ts
export interface CycleAdvanceResult {
  state: State
  /**
   * The closed cycle's findings. On a fail these are the next cycle's task
   * list. On a pass they are informational — the leader's pass rule forbids an
   * open high-severity finding, but a medium or low one may survive a passing
   * cycle and there is no next cycle to carry it to.
   */
  carried_findings: Finding[]
  /** `null` on a pass: the run is over, so no fingerprint is recorded. */
  fingerprint: string | null
  /** `state.no_progress_count` after this cycle. */
  strikes: number
}
```

Add `Finding` to the type import from `../schemas/state.js`, and `fs` from `node:fs/promises` if not already imported.

Replace the body of `cycleAdvance`:

```ts
export async function cycleAdvance(
  projectDir: string,
  input: CycleAdvanceInput,
  now: Clock = () => new Date(),
): Promise<CycleAdvanceResult> {
  const store = new StateStore(projectDir, now)
  const config = await loadConfig(projectDir)

  // Captured inside the locked callback so the archive written afterwards
  // describes exactly the findings the state transition consumed.
  let carried: Finding[] = []
  let closedCycle = 0

  const after = await store.update((draft) => {
    if (draft.status !== 'running' || draft.track === null) throw new NoActiveRunError()
    const track = config.tracks[draft.track]
    if (track === undefined) throw new UnknownTrackError(draft.track, Object.keys(config.tracks))

    carried = [...draft.findings]
    closedCycle = draft.cycle

    const ref = path.join('.loop', 'runs', runDirName(draft))
    draft.history.push({ cycle: draft.cycle, agents: input.agents, result: input.result, ref })

    // Findings describe one cycle's remaining work. Clearing them keeps state
    // bounded across a long run and keeps the next fingerprint meaningful; the
    // caller gets them back to fold into the next cycle's brief.
    draft.findings = []

    if (input.result === 'pass') {
      draft.status = 'done'
      draft.current.stage = 'done'
      return
    }
    if (draft.cycle >= track.max_cycles) {
      draft.status = 'halted'
      draft.current.stage = 'halted'
      draft.halt_reason = `cycle cap ${track.max_cycles} reached for track ${draft.track}`
      return
    }
    draft.cycle += 1
    draft.current.stage = 'compose'
  })

  await archiveFindings(projectDir, after, closedCycle, carried)
  if (after.status === 'halted') await writeHaltReport(projectDir, after)

  return { state: after, carried_findings: carried, fingerprint: null, strikes: after.no_progress_count }
}

/**
 * A convenience aggregate over the `cycle-NN/<agent>.json` files `runLog` has
 * already written — not a second source of truth. Losing it to an interruption
 * costs nothing: every finding is still in the per-agent files.
 */
async function archiveFindings(
  projectDir: string,
  state: State,
  cycle: number,
  findings: Finding[],
): Promise<void> {
  const dir = path.join(runDirPath(projectDir, state), `cycle-${String(cycle).padStart(2, '0')}`)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'findings.json'), `${JSON.stringify(findings, null, 2)}\n`, 'utf8')
}
```

In `engine/src/mcp/server.ts`, update the `loop_cycle_advance` description so the leader knows what it now receives:

```ts
      description:
        'Record the cycle outcome. pass finishes the run; otherwise the next cycle opens unless the cap is reached. Returns the new state plus carried_findings — the closed cycle findings, which are the next cycle task list.',
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd engine && npx vitest run && npm run typecheck`
Expected: PASS — every suite green, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add engine/src/ops/run.ts engine/src/mcp/server.ts engine/tests
git commit -m "feat(engine): make findings per-cycle and hand them back on advance"
```

---

## Task 5: The stagnation guard

**Files:**
- Modify: `engine/src/ops/run.ts`
- Test: `engine/tests/ops/run.test.ts`

**Interfaces:**
- Consumes: `cycleFingerprint` (Task 1); `State.last_fingerprint` (Task 2); the `build` track (Task 3); `CycleAdvanceResult` (Task 4).
- Produces: no new exports — `cycleAdvance` gains behaviour and starts populating `fingerprint` and `strikes`.

- [ ] **Step 1: Write the failing tests**

Add to `engine/tests/ops/run.test.ts`:

```ts
describe('stagnation guard', () => {
  const sameFailure = {
    status: 'fail' as const,
    summary: 'the suite is still red',
    evidence: [{ kind: 'command' as const, ref: 'npm test', excerpt: '1 failing' }],
    findings: [{ severity: 'high' as const, file: 'src/a.ts', line: 1, claim: 'assertion is stale' }],
    files_touched: [],
    next_hint: null,
  }

  /** Log a failing verifier result, then close the cycle. */
  async function failCycle(claim = 'assertion is stale') {
    await runLog(
      project.dir,
      { agent: 'verifier', result: { ...sameFailure, findings: [{ ...sameFailure.findings[0]!, claim }] } },
      clock,
    )
    return cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)
  }

  beforeEach(async () => {
    await runStart(project.dir, { track: 'build', goal: 'Add the endpoint' }, clock)
  })

  it('takes no strike on the first failing cycle', async () => {
    const { state, strikes, fingerprint } = await failCycle()
    expect(strikes).toBe(0)
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(state.status).toBe('running')
    expect(state.cycle).toBe(2)
  })

  it('takes a strike when a cycle closes with the same work remaining', async () => {
    await failCycle()
    const { state, strikes } = await failCycle()
    expect(strikes).toBe(1)
    expect(state.status).toBe('running')
  })

  it('halts on the second strike, naming stagnation rather than the cap', async () => {
    await failCycle()
    await failCycle()
    const { state } = await failCycle()

    expect(state.status).toBe('halted')
    expect(state.cycle).toBe(3)
    expect(state.halt_reason).toBe('no progress for 2 consecutive cycles on track build')

    const report = await fs.readFile(path.join(runDirPath(project.dir, state), 'HALT.md'), 'utf8')
    expect(report).toContain('no progress for 2 consecutive cycles')
  })

  it('resets the count when the remaining work changes', async () => {
    await failCycle()
    await failCycle()
    const { strikes } = await failCycle('a different defect')
    expect(strikes).toBe(0)
  })

  it('halts on stagnation before the cap when both would fire', async () => {
    const config = await loadConfig(project.dir)
    config.tracks.build = { required: ['builder', 'verifier'], available: [], max_cycles: 3 }
    await writeConfig(project.dir, config)

    await failCycle()
    await failCycle()
    const { state } = await failCycle()

    // Cycle 3 reaches both the second strike and the cap. Stagnation is the
    // more actionable reason, and it is checked first.
    expect(state.halt_reason).toContain('no progress')
    expect(state.halt_reason).not.toContain('cycle cap')
  })

  it('never strikes a passing cycle', async () => {
    await failCycle()
    await runLog(
      project.dir,
      {
        agent: 'verifier',
        result: { ...sameFailure, status: 'pass', findings: [] },
      },
      clock,
    )
    const { state, strikes, fingerprint } = await cycleAdvance(
      project.dir,
      { agents: ['builder', 'verifier'], result: 'pass' },
      clock,
    )
    expect(state.status).toBe('done')
    expect(fingerprint).toBeNull()
    expect(strikes).toBe(0)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd engine && npx vitest run tests/ops/run.test.ts`
Expected: FAIL — `fingerprint` is null on failing cycles and no run ever halts for stagnation.

- [ ] **Step 3: Write the implementation**

In `engine/src/ops/run.ts`, import the fingerprint:

```ts
import { cycleFingerprint } from './fingerprint.js'
```

Declare the fingerprint alongside the other captured values in `cycleAdvance`:

```ts
  let fingerprint: string | null = null
```

Replace the fail branch of the locked callback — everything after the `pass` early return — with:

```ts
    // Computed from the findings this cycle closed with, captured above
    // before they were cleared.
    fingerprint = cycleFingerprint(carried, input.result)
    draft.no_progress_count = fingerprint === draft.last_fingerprint ? draft.no_progress_count + 1 : 0
    draft.last_fingerprint = fingerprint

    // Stagnation is checked before the cap because halting earlier is its
    // entire purpose. The two reasons stay distinct: "the loop is stuck" and
    // "the loop ran out of budget" call for different responses from whoever
    // reads HALT.md.
    if (draft.no_progress_count >= config.limits.no_progress_strikes) {
      draft.status = 'halted'
      draft.current.stage = 'halted'
      draft.halt_reason = `no progress for ${draft.no_progress_count} consecutive cycles on track ${draft.track}`
      return
    }
    if (draft.cycle >= track.max_cycles) {
      draft.status = 'halted'
      draft.current.stage = 'halted'
      draft.halt_reason = `cycle cap ${track.max_cycles} reached for track ${draft.track}`
      return
    }
    draft.cycle += 1
    draft.current.stage = 'compose'
```

And return the captured fingerprint:

```ts
  return { state: after, carried_findings: carried, fingerprint, strikes: after.no_progress_count }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd engine && npx vitest run && npm run typecheck`
Expected: PASS — every suite green.

- [ ] **Step 5: Commit**

```bash
git add engine/src/ops/run.ts engine/tests/ops/run.test.ts
git commit -m "feat(engine): halt a run that stops making progress"
```

---

## Task 6: The three build agents

**Files:**
- Create: `agents/scout.md`, `agents/builder.md`, `agents/critic.md`
- Test: no unit tests — markdown assets are exercised by Task 8

**Interfaces:**
- Consumes: the agent contract enforced by `AgentResultSchema`.
- Produces: the `scout`, `builder`, and `critic` agents named in the `build` track.

Each file carries the output contract inline. Milestone 1 proved a pointer to the
`loop-contract` skill is not enough: in the first real run both agents violated the
contract on their first attempt and each cost a corrective round trip.

- [ ] **Step 1: Write `agents/scout.md`**

```markdown
---
name: scout
description: Read-only exploration of a codebase area. Returns a focused map of what the work will touch. Never edits and never runs commands.
tools: Read, Grep, Glob
model: inherit
---

You map the ground before anyone builds on it.

## What you produce

A focused map of the area the goal touches, short enough to act on:

- the entry points and the files that actually matter, with paths
- the patterns already in use there — how errors are handled, how tests are written,
  what the naming looks like — so the builder follows them instead of inventing
- the tests that already cover the area
- anything that contradicts the goal's assumptions

Depth over breadth. A list of every file in the repository is not a map.

## What you never do

You have no `Edit`, no `Write`, and no `Bash` — not as an oversight. A scout that can
run commands starts verifying, and verification belongs to `verifier`, whose whole value
is that it did not write the thing it judges. If the goal cannot be mapped without
running something, say so and return `status: "blocked"`.

## Return value

Return this JSON object and nothing else. No prose before it, no commentary after it,
JSON rather than YAML. The engine validates it against a strict schema before it is
recorded, and a rejected result costs the cycle a corrective round trip.

```json
{
  "status": "pass",
  "summary": "The submit flow lives in src/Button.tsx and is covered by test/Button.test.tsx. Labels come from a constants module, not inline strings, so the change belongs there.",
  "evidence": [
    { "kind": "file", "ref": "src/Button.tsx", "excerpt": "export function Button({ label }: Props)" },
    { "kind": "file", "ref": "src/constants.ts", "excerpt": "export const SUBMIT_LABEL = 'Submit'" }
  ],
  "findings": [],
  "files_touched": [],
  "next_hint": "Change the constant, not the component."
}
```

- `status` is exactly one of `"pass"`, `"fail"`, `"blocked"`. Nothing else is a status —
  not `"done"`, not `"success"`, not `"complete"`.
  - `pass` — you mapped the area.
  - `blocked` — the area cannot be mapped with reading alone, or the goal names something
    that does not exist. Say which in `summary`.
  - `fail` is not a verdict you reach: you are not judging anything.
- `evidence`, `findings`, and `files_touched` are required keys; omitting one fails the
  call. Your `evidence` entries are `kind: "file"`, one per file that matters, with the
  line that makes it matter as the excerpt.
- `files_touched` is `[]` for you, always. You read; you do not write.
- `findings` is `[]` unless you found something that actively contradicts the goal —
  a `findings` entry is `{ "severity": "high" | "medium" | "low", "file": string, "line": integer, "claim": string }`,
  and `line` may not be null or omitted; use `0` when the problem has no single line.
- `next_hint` is the only omittable key: one suggestion, or `null`.
- No other keys. A smuggled `confidence` or `notes` field fails the whole object.
```

- [ ] **Step 2: Write `agents/builder.md`**

```markdown
---
name: builder
description: Writes the code and the tests for one story or goal on the build track. Does not verify its own work and does not commit.
tools: Read, Edit, Write, Grep, Glob, Bash
model: inherit
---

You build the thing. You do not judge it, and you do not record it in history.

## Procedure

1. Read enough of the code to be certain of the change. If a `scout` map came with your
   brief, start there rather than re-exploring.
2. Work the task list in your brief. On a cycle after the first, that list is the open
   findings from the previous cycle — they are the work, not background reading.
3. Write the code and the test that covers it. A behaviour change with no test is
   incomplete, and the next cycle's `verifier` will say so.
4. Follow the patterns already in the file you are editing. A correct change in a foreign
   style is a finding waiting to happen.

## Two things you never do

**You do not run the verify suite.** `verifier` owns that judgement. You may run a single
test you just wrote to see it fail and then pass — that is writing the test, not grading
your work. Running the whole suite and declaring victory is grading your work.

**You do not commit.** The leader commits after `verifier` passes the cycle, so nothing
unverified enters the history and a failing cycle leaves the log clean. A commit from you
is a commit the next cycle may have to revert.

## Return value

Return this JSON object and nothing else. No prose before it, no commentary after it,
JSON rather than YAML. The engine validates it against a strict schema before it is
recorded, and a rejected result costs the cycle a corrective round trip.

```json
{
  "status": "pass",
  "summary": "Added the /health endpoint and a test asserting a 200 with the version payload. Followed the existing router registration pattern in src/routes/index.ts.",
  "evidence": [
    { "kind": "file", "ref": "src/routes/health.ts", "excerpt": "router.get('/health', ...)" },
    { "kind": "test", "ref": "test/health.test.ts", "excerpt": "expect(res.status).toBe(200)" }
  ],
  "findings": [],
  "files_touched": ["src/routes/health.ts", "src/routes/index.ts", "test/health.test.ts"],
  "next_hint": null
}
```

- `status` is exactly one of `"pass"`, `"fail"`, `"blocked"`. Nothing else is a status —
  not `"done"`, not `"success"`, not `"complete"`.
  - `pass` — you wrote the change and the test that covers it.
  - `fail` — you attempted it and could not finish: the premise was wrong, the test could
    not be written, something broke that you could not resolve. Say why in `summary` and
    record the obstacle as a `findings` entry so the next cycle inherits it.
  - `blocked` — you need a decision, a dependency, or a permission that the brief does
    not settle. Not the same as a failed attempt.
- `evidence`, `findings`, and `files_touched` are required keys; omitting one fails the
  call. `[]` is fine for `findings`, and for `evidence` only on a `blocked` result. A
  `pass` carries at least one entry quoting what you wrote — you do not run the suite, so
  the code is your evidence.
- `files_touched` lists every file you wrote, and nothing you only read.
- An `evidence` entry is `{ "kind": "command" | "file" | "test", "ref": string, "excerpt": string }`.
- A `findings` entry is `{ "severity": "high" | "medium" | "low", "file": string, "line": integer, "claim": string }`.
  `line` may not be null or omitted; use `0` when the problem has no single line.
- `next_hint` is the only omittable key: one suggestion, or `null`.
- No other keys. A smuggled `confidence` or `notes` field fails the whole object.
```

- [ ] **Step 3: Write `agents/critic.md`**

```markdown
---
name: critic
description: Reviews a cycle's work for defects the verify suite cannot catch. Never edits. Returns severity-classified findings.
tools: Read, Grep, Glob, Bash
model: inherit
---

You look for what a green test suite still misses.

`verifier` answers "do the commands pass?". You answer "is this actually right?" — the
two are not the same question, and a cycle where both pass is worth more than either
alone.

## What to look for

- correctness the tests do not cover: an edge case, an error path, an assumption that
  holds only for the happy input
- a change that works but diverges from the patterns around it
- a test that asserts the implementation rather than the behaviour, and would pass even
  if the behaviour broke
- **a roster omission that was not safe.** The cycle's `roster.json` records which agents
  the leader skipped and why. A wrongly skipped agent is a finding like any other defect:
  say which agent, and what its absence let through.

## What you never do

No `Edit`, no `Write`, no "I'll just fix this one". You have `Bash` to read the tree and
to reproduce something you suspect — not to repair it. A critic that fixes what it finds
has stopped being a second opinion.

## Return value

Return this JSON object and nothing else. No prose before it, no commentary after it,
JSON rather than YAML. The engine validates it against a strict schema before it is
recorded, and a rejected result costs the cycle a corrective round trip.

```json
{
  "status": "fail",
  "summary": "The endpoint is correct for the happy path but returns 200 with an empty body when the version file is missing, and the test asserts the call shape rather than the response.",
  "evidence": [
    { "kind": "file", "ref": "src/routes/health.ts", "excerpt": "const version = readVersion() ?? ''" }
  ],
  "findings": [
    { "severity": "high", "file": "src/routes/health.ts", "line": 12, "claim": "a missing version file yields 200 with an empty payload instead of 500" },
    { "severity": "medium", "file": "test/health.test.ts", "line": 8, "claim": "asserts readVersion was called rather than the response body" }
  ],
  "files_touched": [],
  "next_hint": "Fail loudly when the version file is absent."
}
```

- `status` is exactly one of `"pass"`, `"fail"`, `"blocked"`. Nothing else is a status —
  not `"done"`, not `"success"`, not `"reviewed"`.
  - `pass` — you reviewed it and found nothing worth the next cycle's time.
  - `fail` — you found at least one defect. Every defect is a `findings` entry.
  - `blocked` — you cannot review it: the change is unintelligible without a decision the
    brief does not settle.
- A `pass` with a populated `findings` array is a contradiction. If it is worth reporting,
  the verdict is `fail`; if it is not worth reporting, leave it out.
- `evidence`, `findings`, and `files_touched` are required keys; omitting one fails the
  call. Send `[]` when you genuinely have none.
- `files_touched` is `[]` for you, always. You review; you do not write.
- An `evidence` entry is `{ "kind": "command" | "file" | "test", "ref": string, "excerpt": string }`.
- A `findings` entry is `{ "severity": "high" | "medium" | "low", "file": string, "line": integer, "claim": string }`.
  `line` is a required integer and may not be null or omitted; use `0` when the problem
  has no single line, and put the locating detail in `claim`.
- Findings are specific. A real file and a real line. "Consider improving error handling"
  is not a finding.
- `next_hint` is the only omittable key: one suggestion, or `null`.
- No other keys. A smuggled `confidence` or `notes` field fails the whole object.
```

- [ ] **Step 4: Verify the agents are discovered**

Run: `claude plugin marketplace update loop && claude plugin details loop@loop`
Expected: the component inventory lists 5 agents — `editor`, `verifier`, `scout`, `builder`, `critic`.

- [ ] **Step 5: Commit**

```bash
git add agents/scout.md agents/builder.md agents/critic.md
git commit -m "feat(agents): add scout, builder, and critic for the build track"
```

---

## Task 7: `/loop:build` and the leader's multi-cycle judgement

**Files:**
- Create: `commands/build.md`
- Modify: `skills/loop-leader/SKILL.md`
- Modify: `README.md`
- Test: no unit tests — exercised by Task 8

**Interfaces:**
- Consumes: the `build` track (Task 3); `carried_findings` from `loop_cycle_advance` (Task 4); the three agents (Task 6).
- Produces: the `/loop:build` command and the leader behaviour that makes multi-cycle runs work.

- [ ] **Step 1: Write `commands/build.md`**

```markdown
---
description: Build something through as many verified cycles as it takes
argument-hint: <what to build>
---

Run the `build` track for: $ARGUMENTS

Use the **loop-leader** skill. It owns the cycle: composing the roster, dispatching
agents, judging the result, folding open findings into the next cycle, and committing
each cycle that passes.

Unlike `/loop:edit`, this track does not stop after one cycle. A failing cycle produces
findings that become the next cycle's work, up to the track's cap — or until the run
stops making progress, at which point the engine halts it and writes `HALT.md`.

Story ids (`/loop:build P001-S02`) arrive with the plan track. For now the argument is
the goal itself.
```

- [ ] **Step 2: Add the multi-cycle sections to `skills/loop-leader/SKILL.md`**

Replace the `### 6. Close the cycle` section with:

```markdown
### 6. Close the cycle

Call `loop_cycle_advance` with the agents that ran and the result. It returns the new
state, and `carried_findings` — the findings this cycle closed with.

- `done` — report what changed, cite the evidence, and commit when `gates.commit` is
  `auto`.
- `running` — the next cycle is open. Go to step 7.
- `halted` — read `HALT.md`, report it plainly, and recommend a next step. Two reasons
  are possible and they are not the same problem:
  - *cycle cap reached* — the work needed more cycles than the track allows.
  - *no progress for N consecutive cycles* — the loop closed N cycles in a row with the
    same work remaining. More cycles would not have helped. Say what stayed unfixed.

  Do not raise `max_cycles` and do not restart to reset the strike count. Both are the
  user's decision.

### 7. Fold the findings forward

On a multi-cycle track, a cycle after the first is not a fresh attempt at the goal — it
is work on a known list.

Put `carried_findings` in the next cycle's brief as the task list, highest severity
first. `builder` works that list; it does not re-derive the goal from scratch.

Compose the roster for the new cycle from what the findings actually call for. A cycle
whose findings are all in one file rarely needs `scout` again — say so in `skipped`
rather than drafting it out of habit.

### 8. Commit a passing cycle

When `gates.commit` is `auto`, commit after the cycle passes — never before, and never by
asking an agent to do it.

The order matters: `verifier` gives the verdict, then the commit happens. Only verified
work reaches the history, a failing cycle leaves none behind, and a run that halts at
cycle 4 still has its first three cycles saved rather than stranded in the working tree.

Stage only the files the cycle's agents reported in `files_touched`. Write a message that
says what the cycle achieved, not that a loop ran.
```

Then extend the `## What you never do` list with two entries:

```markdown
- Never let `builder` commit its own work — the verdict comes first, then the commit.
- Never restart a run to clear the strike count. A stagnation halt is information, not an
  obstacle.
```

- [ ] **Step 3: Add the command to `README.md`**

In the `## Use` block, add the build line after `/loop:edit`:

```
/loop:build <what to build>         multi-cycle build with findings carried forward
```

And update the `## Status` paragraph:

```markdown
Milestone 2 — the engine, the `edit` track, and the `build` track with its stagnation
guard. `fix` and `plan` land in following milestones. See
`docs/superpowers/specs/2026-07-26-loop-plugin-design.md`.
```

- [ ] **Step 4: Verify the command is discovered**

Run: `claude plugin marketplace update loop && claude plugin details loop@loop`
Expected: the inventory lists `build` among the commands.

- [ ] **Step 5: Commit**

```bash
git add commands/build.md skills/loop-leader/SKILL.md README.md
git commit -m "feat(plugin): add /loop:build and the leader multi-cycle judgement"
```

---

## Task 8: Integration and E2E proof

**Files:**
- Create: `engine/tests/integration/build-cycle.test.ts`
- Create: `tests/e2e/run-build.sh`
- Modify: `engine/package.json` — add the `e2e:build` script

**Interfaces:**
- Consumes: every op from Tasks 1–5 and the plugin surface from Tasks 6–7.
- Produces: proof that a multi-cycle build run carries findings forward and that a stuck run halts early.

- [ ] **Step 1: Write the failing integration test**

`engine/tests/integration/build-cycle.test.ts`:

```ts
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initLoop } from '../../src/ops/init.js'
import { runLog } from '../../src/ops/log.js'
import { rosterSet } from '../../src/ops/roster.js'
import { cycleAdvance, runDirPath, runStart } from '../../src/ops/run.js'
import { stateSummary } from '../../src/ops/summary.js'
import { loadConfig, writeConfig } from '../../src/store/config-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-26T10:36:00.000Z')
const clock = () => NOW
const FIXTURE = path.resolve(fileURLToPath(import.meta.url), '../../../../tests/fixtures/tiny-app')

let project: TmpProject

beforeEach(async () => {
  project = await makeTmpProject()
  await fs.cp(FIXTURE, project.dir, { recursive: true })
  await initLoop(project.dir, clock)
})
afterEach(async () => { await project.cleanup() })

/** A verifier result carrying exactly the given claims as high findings. */
function verifierFail(claims: string[]) {
  return {
    status: 'fail' as const,
    summary: 'the suite is still red',
    evidence: [{ kind: 'command' as const, ref: 'npm test', excerpt: `${claims.length} failing` }],
    findings: claims.map((claim, index) => ({
      severity: 'high' as const,
      file: 'src/button.js',
      line: index + 1,
      claim,
    })),
    files_touched: [],
    next_hint: null,
  }
}

const VERIFIER_PASS = {
  status: 'pass' as const,
  summary: 'Lint and the affected test both exit 0.',
  evidence: [{ kind: 'command' as const, ref: 'npm test', excerpt: 'tests 1, pass 1, fail 0' }],
  findings: [],
  files_touched: [],
  next_hint: null,
}

describe('a multi-cycle build run', () => {
  it('carries findings forward and lands on done', async () => {
    await runStart(project.dir, { track: 'build', goal: 'Add a Send button' }, clock)

    await rosterSet(project.dir, { cycle: 1, selected: ['builder', 'verifier'], skipped: { scout: 'goal names the file', critic: 'single-file change' } })
    await runLog(project.dir, { agent: 'verifier', result: verifierFail(['label is wrong', 'no test covers it']) }, clock)
    const first = await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)

    expect(first.state.status).toBe('running')
    expect(first.state.cycle).toBe(2)
    expect(first.carried_findings).toHaveLength(2)
    expect(first.strikes).toBe(0)

    // Cycle 2 works the carried list and closes one of the two findings.
    await rosterSet(project.dir, { cycle: 2, selected: ['builder', 'verifier'], skipped: { scout: 'area already mapped', critic: 'no new interface' } })
    await runLog(project.dir, { agent: 'verifier', result: verifierFail(['no test covers it']) }, clock)
    const second = await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)

    expect(second.carried_findings).toHaveLength(1)
    expect(second.strikes).toBe(0) // the remaining work changed, so no strike
    expect(second.state.cycle).toBe(3)

    await rosterSet(project.dir, { cycle: 3, selected: ['builder', 'verifier'], skipped: { scout: 'area already mapped', critic: 'no new interface' } })
    await runLog(project.dir, { agent: 'verifier', result: VERIFIER_PASS }, clock)
    const third = await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'pass' }, clock)

    expect(third.state.status).toBe('done')
    expect(third.fingerprint).toBeNull()

    const summary = await stateSummary(project.dir)
    expect(summary.status).toBe('done')
    expect(summary.max_cycles).toBe(5)
    expect(summary.findings).toEqual({ high: 0, medium: 0, low: 0 })

    // Every cycle left its own archive behind.
    const dir = runDirPath(project.dir, third.state)
    for (const cycle of ['cycle-01', 'cycle-02', 'cycle-03']) {
      const archived = JSON.parse(await fs.readFile(path.join(dir, cycle, 'findings.json'), 'utf8'))
      expect(Array.isArray(archived)).toBe(true)
    }
  })

  it('halts a stuck run before the cap and says why', async () => {
    await runStart(project.dir, { track: 'build', goal: 'Add a Send button' }, clock)

    let closed = await runCycle(1)
    closed = await runCycle(2)
    closed = await runCycle(3)

    async function runCycle(cycle: number) {
      await rosterSet(project.dir, { cycle, selected: ['builder', 'verifier'], skipped: { scout: 'area already mapped', critic: 'no new interface' } })
      await runLog(project.dir, { agent: 'verifier', result: verifierFail(['label is wrong']) }, clock)
      return cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)
    }

    // The cap is 5. The guard stopped it at 3, saving two cycles.
    expect(closed.state.status).toBe('halted')
    expect(closed.state.cycle).toBe(3)
    expect(closed.state.halt_reason).toBe('no progress for 2 consecutive cycles on track build')

    const report = await fs.readFile(path.join(runDirPath(project.dir, closed.state), 'HALT.md'), 'utf8')
    expect(report).toContain('no progress for 2 consecutive cycles')
    expect(report).toContain('label is wrong')
  })

  it('still honours the cap when the work keeps changing', async () => {
    const config = await loadConfig(project.dir)
    config.tracks.build = { required: ['builder', 'verifier'], available: [], max_cycles: 2 }
    await writeConfig(project.dir, config)

    await runStart(project.dir, { track: 'build', goal: 'Add a Send button' }, clock)
    await runLog(project.dir, { agent: 'verifier', result: verifierFail(['first defect']) }, clock)
    await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)

    await runLog(project.dir, { agent: 'verifier', result: verifierFail(['a different defect']) }, clock)
    const second = await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)

    expect(second.state.status).toBe('halted')
    expect(second.state.halt_reason).toBe('cycle cap 2 reached for track build')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/integration/build-cycle.test.ts`
Expected: FAIL if any of Tasks 1–5 is incomplete. If Tasks 1–5 landed correctly this
should pass on the first run — the ops already cover every assertion. A failure here is a
defect in the ops, not in the test; fix the op and rerun.

- [ ] **Step 3: Write the E2E script**

`tests/e2e/run-build.sh`:

```bash
#!/usr/bin/env bash
# Opt-in smoke test of the build track against the real Claude Code CLI.
# Not part of `npm test`: it needs the CLI, a network, and real tokens.
#   LOOP_E2E=1 tests/e2e/run-build.sh
set -uo pipefail

if [[ "${LOOP_E2E:-}" != "1" ]]; then
  echo "skipped: set LOOP_E2E=1 to run the end-to-end smoke test" >&2
  exit 0
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
workdir="$(mktemp -d)"

cp -R "${repo_root}/tests/fixtures/tiny-app/." "${workdir}/"
cd "${workdir}"

# The build track commits each passing cycle, so the fixture needs to be a repo.
git init -q .
git add -A
git -c user.email=e2e@loop.test -c user.name=loop-e2e commit -q -m "fixture"

# `claude -p` is non-interactive, so a tool awaiting approval has no way to get
# it and the run stalls into a refusal instead of failing loudly.
allowed=(
  "mcp__plugin_loop_loop"
  Task Read Edit Write Grep Glob Bash
)

fail() {
  echo "FAIL: $1" >&2
  echo "work directory kept for inspection: ${workdir}" >&2
  exit 1
}

claude -p "/loop:init" --permission-mode acceptEdits --allowedTools "${allowed[@]}"
claude -p "/loop:build add a cancelLabel() export to src/button.js returning 'Cancel', with a test covering it" \
  --permission-mode acceptEdits --allowedTools "${allowed[@]}"

echo "--- state ---"
node "${repo_root}/engine/dist/cli/index.js" summary --dir "${workdir}" --json

status="$(node "${repo_root}/engine/dist/cli/index.js" summary --dir "${workdir}" --json | node -e \
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).status))')"

[[ "${status}" == "done" ]] || fail "expected status done, got ${status}"
grep -q "cancelLabel" "${workdir}/src/button.js" || fail "the export was not added"
[[ "$(git -C "${workdir}" rev-list --count HEAD)" -gt 1 ]] || fail "the passing cycle was not committed"

rm -rf "${workdir}"
echo "PASS: the build cycle completed, the change landed, and it was committed"
```

Run: `chmod +x tests/e2e/run-build.sh`

Add to `engine/package.json` scripts, alongside the existing `e2e`:

```json
"e2e:build": "bash ../tests/e2e/run-build.sh"
```

- [ ] **Step 4: Run the whole suite**

Run: `cd engine && npm test && npm run typecheck && npm run build`
Expected: PASS — every test green, typecheck clean, `dist/` rebuilt.

Run: `bash tests/e2e/run-build.sh`
Expected: `skipped: set LOOP_E2E=1 ...` and exit 0 — the opt-in path works.

- [ ] **Step 5: Commit**

```bash
git add engine/tests/integration/build-cycle.test.ts tests/e2e/run-build.sh engine/package.json
git commit -m "test: prove the build track carries findings and halts when stuck"
```

---

## Milestone Complete

Verify before declaring done:

- [ ] `cd engine && npm test` — all green
- [ ] `cd engine && npm run typecheck` — clean
- [ ] `cd engine && npm run build` — `dist/` rebuilt
- [ ] `claude plugin details loop@loop` — 5 agents, 5 commands, 1 MCP server
- [ ] A stuck run halts with the stagnation reason before reaching its cap
- [ ] `.loop/runs/<run>/cycle-NN/findings.json` exists for every closed cycle
- [ ] `LOOP_E2E=1 npm run e2e` — the edit track still passes
- [ ] `LOOP_E2E=1 npm run e2e:build` — a build run finishes `done` with a commit per passing cycle

## Next Milestones

| Milestone | Delivers |
|---|---|
| 3 — Fix track | `reproducer`, `investigator`, `hypothesis-tester`, `fixer`; the reproduction gate |
| 4 — Plan track | Plans, stories, `manifest.json`, `INDEX.md`; the 6 plan/story MCP tools; `/loop:build P001-S02` |
| 5 — Remaining guards | Repeated-error guard, autonomous `Stop` hook |
| 6 — UI and specialists | `design-system.md` extraction, `ui-designer`, `ui-critic`, `security`, `docs`, `perf` |
| 7 — Memory and extension | `loop_memory_*`, `/loop:add`, `loop-tracks`, `loop-extend` |
