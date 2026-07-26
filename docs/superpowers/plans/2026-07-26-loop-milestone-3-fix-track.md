# Loop — Milestone 3: Fix Track and the Reproduction Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `/loop:fix <problem>` — a track that cannot produce a fix until the defect has been reproduced, enforced by the engine rather than by asking the leader nicely.

**Architecture:** The gate is a field on the track, not agent names in the engine: `gate: { proven_by, blocks }`. It opens as a side effect of the proving agent's contract-validated, evidenced pass — there is no tool that lets anyone simply declare a defect reproduced. `runLog` becomes the enforcement point and, for the first time, a config reader. Parallel same-agent dispatch gets an `instance` so N hypothesis testers do not overwrite one file.

**Tech Stack:** TypeScript 5 · Node 24 (floor 20) · zod 4.4.3 · @modelcontextprotocol/sdk 1.29.0 · vitest 4.1.10

**Spec:** `docs/superpowers/specs/2026-07-26-loop-milestone-3-fix-track-design.md`

## Global Constraints

- All plugin files, prompts, code, comments, and documentation in **English**. Conversation with the user is Arabic; nothing in the repository is.
- **zod 4 idioms only:** `z.strictObject(...)` not `z.object(...).strict()`; `z.iso.datetime()` not `z.string().datetime()`; `z.record(keySchema, valueSchema)` requires both arguments; format errors with `z.prettifyError(error)`.
- **State has one owner.** Nothing outside `engine/src/store` and `engine/src/ops` may write `.loop/state.json`.
- **Every judgement inside a `store.update` callback reads the locked draft**, never a pre-lock snapshot.
- **The engine does not know agent names.** Any rule that names a specific agent belongs in track config, not in code.
- **Any string that reaches the filesystem is validated by `AgentNameSchema`** — milestone 2 shipped that after a review found an agent name could traverse out of the cycle directory.
- Every task ends with a commit. Tests must be seen failing before the implementation is written.

---

## File Structure

| File | Responsibility |
|---|---|
| `engine/src/schemas/config.ts` | `GateSchema`, `TrackSchema.gate` with an in-track refinement, `DEFAULT_TRACKS.fix` |
| `engine/src/schemas/state.ts` | `ReproductionSchema`, `State.reproduction` |
| `engine/src/ops/run.ts` | `runStart` clears `reproduction` |
| `engine/src/ops/log.ts` | `instance`; opens the gate; rejects blocked agents |
| `engine/src/ops/summary.ts` | Report whether the gate is open |
| `engine/src/mcp/server.ts` | `loop_run_log` accepts `instance` |
| `agents/reproducer.md`, `investigator.md`, `hypothesis-tester.md`, `fixer.md` | **New.** Four fix-track agents |
| `commands/fix.md` | **New.** `/loop:fix <problem>` |
| `skills/loop-leader/SKILL.md` | Gate ordering, hypothesis fan-out, fix judgement |
| `engine/tests/integration/fix-cycle.test.ts` | **New.** Full fix run, and the gate holding |
| `tests/e2e/run-fix.sh` | **New.** Opt-in real-CLI smoke test |

---

## Task 1: The `gate` field and the `fix` track

**Files:**
- Modify: `engine/src/schemas/config.ts`
- Test: `engine/tests/schemas/config.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `GateSchema`; `Gate` type; `TrackSchema.gate?: Gate`; `DEFAULT_TRACKS.fix`.

- [ ] **Step 1: Write the failing test**

Add to `engine/tests/schemas/config.test.ts`, inside `describe('DEFAULT_TRACKS', ...)`:

```ts
  it('gates the fix track on the reproducer and blocks the fixer', () => {
    expect(DEFAULT_TRACKS.fix).toEqual({
      required: ['reproducer', 'fixer', 'verifier'],
      available: ['investigator', 'hypothesis-tester', 'critic'],
      max_cycles: 5,
      gate: { proven_by: 'reproducer', blocks: ['fixer'] },
    })
  })

  it('leaves the ungated tracks ungated', () => {
    expect(DEFAULT_TRACKS.edit?.gate).toBeUndefined()
    expect(DEFAULT_TRACKS.build?.gate).toBeUndefined()
  })
```

Update the existing key-order assertion in `describe('defaultConfig', ...)`:

```ts
    expect(Object.keys(config.tracks)).toEqual(['edit', 'build', 'fix'])
```

And add to `describe('ConfigSchema', ...)`:

```ts
  it('rejects a gate proven by an agent the track never runs', () => {
    const bad = {
      version: 1,
      tracks: {
        fix: {
          required: ['fixer', 'verifier'],
          max_cycles: 3,
          gate: { proven_by: 'ghost', blocks: ['fixer'] },
        },
      },
    }
    const parsed = ConfigSchema.safeParse(bad)
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(z.prettifyError(parsed.error)).toContain('ghost')
  })

  it('rejects a gate blocking an agent the track never runs', () => {
    const bad = {
      version: 1,
      tracks: {
        fix: {
          required: ['reproducer', 'verifier'],
          max_cycles: 3,
          gate: { proven_by: 'reproducer', blocks: ['phantom'] },
        },
      },
    }
    const parsed = ConfigSchema.safeParse(bad)
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(z.prettifyError(parsed.error)).toContain('phantom')
  })

  it('accepts a gate naming agents from required and available', () => {
    const good = {
      version: 1,
      tracks: {
        fix: {
          required: ['reproducer', 'fixer'],
          available: ['critic'],
          max_cycles: 3,
          gate: { proven_by: 'reproducer', blocks: ['fixer', 'critic'] },
        },
      },
    }
    expect(ConfigSchema.safeParse(good).success).toBe(true)
  })
```

The file needs `import * as z from 'zod'` at the top if it is not already there.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/schemas/config.test.ts`
Expected: FAIL — `DEFAULT_TRACKS.fix` is undefined and `gate` is rejected as an unknown key.

- [ ] **Step 3: Write the implementation**

In `engine/src/schemas/config.ts`, add above `TrackSchema`:

```ts
/**
 * A precondition on a track: nothing in `blocks` may be logged until
 * `proven_by` has returned an evidenced pass.
 *
 * This is track configuration rather than a rule in the engine because the
 * engine does not know agent names — that is what makes a track data and lets
 * a new one ship without touching code.
 */
export const GateSchema = z.strictObject({
  /** Whose passing, evidenced result opens the gate. */
  proven_by: z.string().min(1),
  /** Agents that may not be logged until it is open. */
  blocks: z.array(z.string().min(1)).min(1),
})
```

Replace `TrackSchema` with:

```ts
export const TrackSchema = z
  .strictObject({
    /** Agents the leader may never drop from a cycle. */
    required: z.array(z.string().min(1)).min(1),
    /** Agents the leader may draft when the task calls for them. */
    available: z.array(z.string().min(1)).default([]),
    max_cycles: z.number().int().positive(),
    /** Optional precondition. A track without one behaves as it always has. */
    gate: GateSchema.optional(),
  })
  .superRefine((track, ctx) => {
    if (track.gate === undefined) return
    const known = new Set([...track.required, ...track.available])

    if (!known.has(track.gate.proven_by)) {
      ctx.addIssue({
        code: 'custom',
        path: ['gate', 'proven_by'],
        message: `"${track.gate.proven_by}" is not in this track — a gate proven by an agent the leader can never draft would shut the track permanently, and silently`,
      })
    }
    for (const [index, agent] of track.gate.blocks.entries()) {
      if (!known.has(agent)) {
        ctx.addIssue({
          code: 'custom',
          path: ['gate', 'blocks', index],
          message: `"${agent}" is not in this track — blocking an agent it never runs has no effect`,
        })
      }
    }
  })
```

Add the type export next to the others:

```ts
export type Gate = z.infer<typeof GateSchema>
```

Extend `DEFAULT_TRACKS`:

```ts
  fix: {
    required: ['reproducer', 'fixer', 'verifier'],
    available: ['investigator', 'hypothesis-tester', 'critic'],
    max_cycles: 5,
    gate: { proven_by: 'reproducer', blocks: ['fixer'] },
  },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd engine && npx vitest run tests/schemas/config.test.ts && npm run typecheck`
Expected: PASS. If `typecheck` complains that `Track` is no longer assignable where `DEFAULT_TRACKS` is used, it is because `.superRefine` changes the schema's output type wrapper — the inferred `Track` type still has `gate?: Gate`, so the fix is to keep `DEFAULT_TRACKS: Record<string, Track>` and omit `gate` on ungated tracks rather than setting it to `undefined` (the project builds with `exactOptionalPropertyTypes`).

- [ ] **Step 5: Run the whole suite**

Run: `cd engine && npx vitest run`
Expected: PASS. Existing tests that assign `config.tracks.build = {...}` without a `gate` still typecheck, because `gate` is optional.

- [ ] **Step 6: Commit**

```bash
git add engine/src/schemas/config.ts engine/tests/schemas/config.test.ts
git commit -m "feat(engine): add track gates and the fix track"
```

---

## Task 2: `reproduction` in state

**Files:**
- Modify: `engine/src/schemas/state.ts`, `engine/src/ops/run.ts`
- Test: `engine/tests/schemas/state.test.ts`, `engine/tests/ops/run.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ReproductionSchema`; `Reproduction` type; `State.reproduction: Reproduction | null`; `initialState` sets it to `null`; `runStart` clears it.

- [ ] **Step 1: Write the failing tests**

Add to `engine/tests/schemas/state.test.ts`, inside `describe('StateSchema', ...)`:

```ts
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
```

Extend the existing `initialState` test:

```ts
    expect(state.reproduction).toBeNull()
```

Add to `engine/tests/ops/run.test.ts`, inside `describe('runStart', ...)`:

```ts
  it('clears a previous run reproduction', async () => {
    await runStart(project.dir, { track: 'fix', goal: 'First defect' }, clock)
    await new StateStore(project.dir, clock).update((draft) => {
      draft.reproduction = { agent: 'reproducer', cycle: 1, ref: 'npm test', excerpt: '1 failing' }
    })

    const second = await runStart(project.dir, { track: 'fix', goal: 'Second defect' }, clock)
    expect(second.reproduction).toBeNull()
  })
```

`StateStore` is already imported in that file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd engine && npx vitest run tests/schemas/state.test.ts tests/ops/run.test.ts`
Expected: FAIL — `reproduction` is an unknown key on the strict object.

- [ ] **Step 3: Write the implementation**

In `engine/src/schemas/state.ts`, add above `StateSchema`:

```ts
/**
 * Proof that a defect exists, recorded when a gated track's proving agent
 * returns an evidenced pass. Its presence is what opens the gate; there is no
 * tool that sets it directly, because a defect somebody merely asserts was
 * reproduced is exactly what the fix track exists to rule out.
 */
export const ReproductionSchema = z.strictObject({
  /** The agent whose result opened the gate. */
  agent: z.string().min(1),
  /** The cycle it was proven in. */
  cycle: z.number().int().positive(),
  /** The command that reproduces the defect. */
  ref: z.string().min(1),
  /** Its decisive output. May be empty — the contract allows an empty excerpt. */
  excerpt: z.string(),
})
```

Add the field to `StateSchema`, immediately after `last_fingerprint`:

```ts
  /**
   * The default matters for the same reason `last_fingerprint`'s does: without
   * it every state file written before this field existed would fail
   * validation on read rather than gaining the field on its next write.
   */
  reproduction: ReproductionSchema.nullable().default(null),
```

Add the type export:

```ts
export type Reproduction = z.infer<typeof ReproductionSchema>
```

Add to `initialState`, after `last_fingerprint: null,`:

```ts
    reproduction: null,
```

In `engine/src/ops/run.ts`, inside the `runStart` locked update, next to the other run-scoped resets:

```ts
    // A new run has proven nothing. Carrying a previous run's reproduction
    // would open this run's gate for a defect nobody demonstrated here.
    draft.reproduction = null
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd engine && npx vitest run && npm run typecheck`
Expected: PASS — every suite green.

- [ ] **Step 5: Commit**

```bash
git add engine/src/schemas/state.ts engine/src/ops/run.ts engine/tests/schemas/state.test.ts engine/tests/ops/run.test.ts
git commit -m "feat(engine): record reproduction proof in run state"
```

---

## Task 3: `instance` — parallel same-agent dispatch

**Files:**
- Modify: `engine/src/ops/log.ts`
- Test: `engine/tests/ops/log.test.ts`

**Interfaces:**
- Consumes: `AgentNameSchema` from `engine/src/schemas/contract.ts`.
- Produces: `RunLogInput.instance?: string`; results written to `cycle-NN/<agent>--<instance>.json`.

- [ ] **Step 1: Write the failing test**

Add to `engine/tests/ops/log.test.ts`:

```ts
describe('runLog instances', () => {
  const verdict = {
    status: 'fail' as const,
    summary: 'The hypothesis does not hold: the cache is populated before the read.',
    evidence: [{ kind: 'command' as const, ref: 'npm test -- cache', excerpt: 'ordering is correct' }],
    findings: [],
    files_touched: [],
    next_hint: null,
  }

  it('keeps two runs of the same agent side by side', async () => {
    const first = await runLog(project.dir, { agent: 'hypothesis-tester', instance: 'stale-cache', result: verdict }, clock)
    const second = await runLog(project.dir, { agent: 'hypothesis-tester', instance: 'race-on-write', result: verdict }, clock)

    expect(first.path).not.toBe(second.path)
    expect(path.basename(first.path)).toBe('hypothesis-tester--stale-cache.json')
    expect(path.basename(second.path)).toBe('hypothesis-tester--race-on-write.json')

    const state = await new StateStore(project.dir).get()
    const entries = await fs.readdir(path.join(runDirPath(project.dir, state), 'cycle-01'))
    expect(entries.sort()).toEqual(['hypothesis-tester--race-on-write.json', 'hypothesis-tester--stale-cache.json'])
  })

  it('writes the plain agent name when no instance is given', async () => {
    const { path: file } = await runLog(project.dir, { agent: 'investigator', result: verdict }, clock)
    expect(path.basename(file)).toBe('investigator.json')
  })

  it('rejects an instance that would escape the cycle directory', async () => {
    await expect(
      runLog(project.dir, { agent: 'hypothesis-tester', instance: '../../../state', result: verdict }, clock),
    ).rejects.toBeInstanceOf(InvalidAgentNameError)
  })

  it('reuses the same file when the same instance is logged twice', async () => {
    const first = await runLog(project.dir, { agent: 'hypothesis-tester', instance: 'stale-cache', result: verdict }, clock)
    const second = await runLog(
      project.dir,
      { agent: 'hypothesis-tester', instance: 'stale-cache', result: { ...verdict, summary: 'Revised verdict.' } },
      clock,
    )
    expect(second.path).toBe(first.path)
    expect(JSON.parse(await fs.readFile(first.path, 'utf8')).summary).toBe('Revised verdict.')
  })
})
```

The file already imports `fs`, `path`, `runLog`, `InvalidAgentNameError`, `StateStore`, and `runDirPath`; add any that are missing.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/ops/log.test.ts`
Expected: FAIL — both instances write `hypothesis-tester.json`, so the two paths are equal.

- [ ] **Step 3: Write the implementation**

In `engine/src/ops/log.ts`, extend the input type:

```ts
export interface RunLogInput {
  agent: string
  /**
   * Distinguishes concurrent runs of the same agent. N hypothesis testers in
   * one cycle would otherwise all write `hypothesis-tester.json`, and the
   * cycle would record one verdict where it produced N.
   */
  instance?: string
  /** Unvalidated — this is where an agent's raw return value is checked. */
  result: unknown
}
```

Replace the filename derivation — the block that currently builds `file` from `agent.data`:

```ts
  // Validated by the same schema as the agent name: anything that reaches the
  // filesystem goes through one check, in one place.
  let basename = agent.data
  if (input.instance !== undefined) {
    const instance = AgentNameSchema.safeParse(input.instance)
    if (!instance.success) throw new InvalidAgentNameError(input.instance, z.prettifyError(instance.error))
    basename = `${agent.data}--${instance.data}`
  }

  const cycleDir = cycleDirPath(projectDir, state)
  await fs.mkdir(cycleDir, { recursive: true })
  const file = path.join(cycleDir, `${basename}.json`)
  await fs.writeFile(file, `${JSON.stringify(parsed.value, null, 2)}\n`, 'utf8')
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd engine && npx vitest run tests/ops/log.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add engine/src/ops/log.ts engine/tests/ops/log.test.ts
git commit -m "feat(engine): let one agent log several instances in a cycle"
```

---

## Task 4: The reproduction gate

**Files:**
- Modify: `engine/src/ops/log.ts`
- Test: `engine/tests/ops/log.test.ts`

**Interfaces:**
- Consumes: `Gate` and `loadConfig` (Task 1); `State.reproduction` (Task 2).
- Produces: `ReproductionGateError`; `runLog` returns `{ path, findingsAdded, gateOpened }`.

- [ ] **Step 1: Write the failing test**

Add to `engine/tests/ops/log.test.ts`:

```ts
describe('the reproduction gate', () => {
  const proof = {
    status: 'pass' as const,
    summary: 'A test that fails because the cache returns a stale entry.',
    evidence: [{ kind: 'command' as const, ref: 'npm test -- cache', excerpt: '1 failing: expected fresh, got stale' }],
    findings: [],
    files_touched: ['test/cache.test.ts'],
    next_hint: null,
  }

  const fix = {
    status: 'pass' as const,
    summary: 'Invalidated the entry on write.',
    evidence: [{ kind: 'file' as const, ref: 'src/cache.ts', excerpt: 'this.map.delete(key)' }],
    findings: [],
    files_touched: ['src/cache.ts'],
    next_hint: null,
  }

  beforeEach(async () => {
    await runStart(project.dir, { track: 'fix', goal: 'Stale cache entry' }, clock)
  })

  it('rejects a blocked agent while the gate is shut', async () => {
    await expect(runLog(project.dir, { agent: 'fixer', result: fix }, clock)).rejects.toBeInstanceOf(
      ReproductionGateError,
    )
  })

  it('names the agent that would open it', async () => {
    await expect(runLog(project.dir, { agent: 'fixer', result: fix }, clock)).rejects.toThrow(/reproducer/)
  })

  it('writes nothing and touches no state when it rejects', async () => {
    await expect(runLog(project.dir, { agent: 'fixer', result: fix }, clock)).rejects.toThrow()

    const state = await new StateStore(project.dir).get()
    const cycleDir = path.join(runDirPath(project.dir, state), 'cycle-01')
    await expect(fs.access(path.join(cycleDir, 'fixer.json'))).rejects.toThrow()
    expect(state.reproduction).toBeNull()
  })

  it('opens on an evidenced pass from the proving agent', async () => {
    const { gateOpened } = await runLog(project.dir, { agent: 'reproducer', result: proof }, clock)
    expect(gateOpened).toBe(true)

    const state = await new StateStore(project.dir).get()
    expect(state.reproduction).toEqual({
      agent: 'reproducer',
      cycle: 1,
      ref: 'npm test -- cache',
      excerpt: '1 failing: expected fresh, got stale',
    })
  })

  it('lets the blocked agent through once it is open', async () => {
    await runLog(project.dir, { agent: 'reproducer', result: proof }, clock)
    const { path: file } = await runLog(project.dir, { agent: 'fixer', result: fix }, clock)
    expect(path.basename(file)).toBe('fixer.json')
  })

  it('stays shut for a pass with no command or test evidence', async () => {
    const { gateOpened } = await runLog(
      project.dir,
      { agent: 'reproducer', result: { ...proof, evidence: [] } },
      clock,
    )
    expect(gateOpened).toBe(false)
    expect((await new StateStore(project.dir).get()).reproduction).toBeNull()
  })

  it('stays shut when the proving agent could not reproduce', async () => {
    const { gateOpened } = await runLog(
      project.dir,
      { agent: 'reproducer', result: { ...proof, status: 'blocked' as const } },
      clock,
    )
    expect(gateOpened).toBe(false)
  })

  it('re-records a later reproduction, so a second attempt wins', async () => {
    await runLog(project.dir, { agent: 'reproducer', result: proof }, clock)
    await runLog(
      project.dir,
      {
        agent: 'reproducer',
        result: { ...proof, evidence: [{ kind: 'command' as const, ref: 'npm test -- cache -t eviction', excerpt: '1 failing' }] },
      },
      clock,
    )
    expect((await new StateStore(project.dir).get()).reproduction?.ref).toBe('npm test -- cache -t eviction')
  })

  it('blocks nothing on a track with no gate', async () => {
    await runStart(project.dir, { track: 'edit', goal: 'Rename' }, clock)
    const { path: file, gateOpened } = await runLog(project.dir, { agent: 'fixer', result: fix }, clock)
    expect(path.basename(file)).toBe('fixer.json')
    expect(gateOpened).toBe(false)
  })
})
```

Add `ReproductionGateError` and `runStart` to the file's imports.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/ops/log.test.ts`
Expected: FAIL — nothing rejects the fixer and `gateOpened` is undefined.

- [ ] **Step 3: Write the implementation**

In `engine/src/ops/log.ts`, add the import and the error:

```ts
import { loadConfig } from '../store/config-store.js'
```

```ts
export class ReproductionGateError extends Error {
  constructor(agent: string, provenBy: string) {
    super(
      `"${agent}" is blocked by the "${provenBy}" gate on this track. Nothing it produces can be recorded until ` +
        `"${provenBy}" returns status "pass" carrying command or test evidence that the defect is real. ` +
        'Reproduce the defect first, or halt the run — do not fix what has not been demonstrated.',
    )
    this.name = 'ReproductionGateError'
  }
}
```

Change the return type of `runLog` to `Promise<{ path: string; findingsAdded: number; gateOpened: boolean }>` and insert the gate logic after the `state.status !== 'running'` check and before the file is written:

```ts
  // runLog reads config for the first time here: the gate is a property of the
  // running track, and a track is configuration.
  const config = await loadConfig(projectDir)
  const gate = state.track === null ? undefined : config.tracks[state.track]?.gate

  if (gate !== undefined && state.reproduction === null && gate.blocks.includes(agent.data)) {
    throw new ReproductionGateError(agent.data, gate.proven_by)
  }

  // The gate opens as a side effect of the ordinary evidence-bound channel.
  // There is no tool that simply declares a defect reproduced: the engine
  // cannot read an excerpt and confirm it shows a failure, but it can insist
  // the claim came from the designated agent, carried command or test
  // evidence, and passed contract validation on the way in.
  const proof =
    gate !== undefined && agent.data === gate.proven_by && parsed.value.status === 'pass'
      ? parsed.value.evidence.find((entry) => entry.kind === 'command' || entry.kind === 'test')
      : undefined
```

Replace the conditional state update with one that also records the proof:

```ts
  if (parsed.value.findings.length > 0 || proof !== undefined) {
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
    })
  }

  return { path: file, findingsAdded: parsed.value.findings.length, gateOpened: proof !== undefined }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd engine && npx vitest run && npm run typecheck`
Expected: PASS — every suite green.

- [ ] **Step 5: Commit**

```bash
git add engine/src/ops/log.ts engine/tests/ops/log.test.ts
git commit -m "feat(engine): enforce the reproduction gate when results are logged"
```

---

## Task 5: Surfacing the gate

**Files:**
- Modify: `engine/src/ops/summary.ts`, `engine/src/mcp/server.ts`
- Test: `engine/tests/ops/summary.test.ts`, `engine/tests/mcp/server.test.ts`

**Interfaces:**
- Consumes: `State.reproduction` (Task 2); `Gate` (Task 1).
- Produces: `StateSummary.reproduction: { proven: boolean; ref: string | null } | null`; `loop_run_log` accepts `instance`.

- [ ] **Step 1: Write the failing tests**

Add to `engine/tests/ops/summary.test.ts`:

```ts
describe('stateSummary and the gate', () => {
  it('reports null for a track with no gate', async () => {
    await initLoop(project.dir, clock)
    await runStart(project.dir, { track: 'edit', goal: 'Rename' }, clock)
    expect((await stateSummary(project.dir)).reproduction).toBeNull()
  })

  it('reports an unproven gate before the defect is reproduced', async () => {
    await initLoop(project.dir, clock)
    await runStart(project.dir, { track: 'fix', goal: 'Stale cache' }, clock)
    expect((await stateSummary(project.dir)).reproduction).toEqual({ proven: false, ref: null })
  })

  it('reports the reproducing command once the gate is open', async () => {
    await initLoop(project.dir, clock)
    await runStart(project.dir, { track: 'fix', goal: 'Stale cache' }, clock)
    await runLog(
      project.dir,
      {
        agent: 'reproducer',
        result: {
          status: 'pass',
          summary: 'A failing test that proves the stale read.',
          evidence: [{ kind: 'command', ref: 'npm test -- cache', excerpt: '1 failing' }],
          findings: [],
          files_touched: ['test/cache.test.ts'],
          next_hint: null,
        },
      },
      clock,
    )

    const summary = await stateSummary(project.dir)
    expect(summary.reproduction).toEqual({ proven: true, ref: 'npm test -- cache' })
    expect(renderSummaryLine(summary)).toContain('reproduced')
  })

  it('says the defect is not reproduced in the rendered line', async () => {
    await initLoop(project.dir, clock)
    await runStart(project.dir, { track: 'fix', goal: 'Stale cache' }, clock)
    expect(renderSummaryLine(await stateSummary(project.dir))).toContain('not reproduced')
  })
})
```

Add `runLog` to that file's imports.

Add to `engine/tests/mcp/server.test.ts`:

```ts
  it('accepts an instance so parallel agents do not overwrite each other', async () => {
    await client.callTool({ name: 'loop_init', arguments: { project_dir: project.dir } })
    await client.callTool({
      name: 'loop_run_start',
      arguments: { project_dir: project.dir, track: 'fix', goal: 'Stale cache' },
    })
    const logged = await client.callTool({
      name: 'loop_run_log',
      arguments: {
        project_dir: project.dir,
        agent: 'hypothesis-tester',
        instance: 'stale-cache',
        result: {
          status: 'fail',
          summary: 'Refuted: the cache is invalidated on write.',
          evidence: [{ kind: 'command', ref: 'npm test -- cache', excerpt: 'ordering is correct' }],
          findings: [],
          files_touched: [],
        },
      },
    })
    expect((logged as { isError?: boolean }).isError).not.toBe(true)
    expect(JSON.parse(textOf(logged)).path).toContain('hypothesis-tester--stale-cache.json')
  })

  it('returns a tool error when the fixer runs before the defect is reproduced', async () => {
    await client.callTool({ name: 'loop_init', arguments: { project_dir: project.dir } })
    await client.callTool({
      name: 'loop_run_start',
      arguments: { project_dir: project.dir, track: 'fix', goal: 'Stale cache' },
    })
    const result = await client.callTool({
      name: 'loop_run_log',
      arguments: {
        project_dir: project.dir,
        agent: 'fixer',
        result: {
          status: 'pass',
          summary: 'Invalidated the entry on write.',
          evidence: [{ kind: 'file', ref: 'src/cache.ts', excerpt: 'this.map.delete(key)' }],
          findings: [],
          files_touched: ['src/cache.ts'],
        },
      },
    })
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(textOf(result)).toContain('reproducer')
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd engine && npx vitest run tests/ops/summary.test.ts tests/mcp/server.test.ts`
Expected: FAIL — `summary.reproduction` is undefined and `instance` is rejected as an unknown argument.

- [ ] **Step 3: Write the implementation**

In `engine/src/ops/summary.ts`, add to the `StateSummary` interface:

```ts
  /**
   * The state of the running track's gate: `null` when the track has no gate,
   * otherwise whether the defect has been proven and by which command.
   */
  reproduction: { proven: boolean; ref: string | null } | null
```

Add `reproduction: null` to the uninitialised early-return object.

In the main body, after `maxCycles` is resolved, compute it from the same config read. Replace the `max_cycles` block with:

```ts
  let maxCycles: number | null = null
  let reproduction: { proven: boolean; ref: string | null } | null = null
  try {
    const config = await loadConfig(projectDir)
    const track = state.track === null ? undefined : config.tracks[state.track]
    maxCycles = track?.max_cycles ?? null
    if (track?.gate !== undefined) {
      reproduction = { proven: state.reproduction !== null, ref: state.reproduction?.ref ?? null }
    }
  } catch {
    // A config that cannot be read degrades the summary; it does not fail it.
    // The SessionStart hook renders this line on every session, and a YAML
    // typo in a hand-edited config must not turn that into a stack trace.
  }
```

Add `reproduction,` to the returned object.

In `renderSummaryLine`, before the final `return`, add:

```ts
  const gate =
    summary.reproduction === null ? '' : summary.reproduction.proven ? ' · reproduced' : ' · not reproduced'
```

and include `${gate}` in the returned line, immediately before `${tail}`.

In `engine/src/mcp/server.ts`, add to the `loop_run_log` input schema, between `agent` and `result`:

```ts
        instance: z
          .string()
          .min(1)
          .optional()
          .describe('Distinguishes parallel runs of the same agent, e.g. one hypothesis-tester per hypothesis'),
```

and thread it through the handler:

```ts
    async ({ project_dir, agent, instance, result }) =>
      guard(async () =>
        ok(
          await runLog(resolveProjectDir(project_dir), {
            agent,
            ...(instance === undefined ? {} : { instance }),
            result,
          }),
        ),
      ),
```

The spread is deliberate: the project builds with `exactOptionalPropertyTypes`, so passing `instance: undefined` explicitly would not typecheck against `instance?: string`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd engine && npx vitest run && npm run typecheck && npm run build`
Expected: PASS — every suite green, typecheck clean, `dist/` rebuilt.

- [ ] **Step 5: Commit**

```bash
git add engine/src/ops/summary.ts engine/src/mcp/server.ts engine/tests/ops/summary.test.ts engine/tests/mcp/server.test.ts
git commit -m "feat(engine): surface the gate in status and accept instances over mcp"
```

---

## Task 6: The four fix agents

**Files:**
- Create: `agents/reproducer.md`, `agents/investigator.md`, `agents/hypothesis-tester.md`, `agents/fixer.md`
- Test: no unit tests — markdown assets are exercised by Task 8

**Interfaces:**
- Consumes: the agent contract enforced by `AgentResultSchema`.
- Produces: the four agents named in the `fix` track.

Each carries the contract inline, as milestone 1 established after a real run showed a
pointer to the `loop-contract` skill was not enough.

- [ ] **Step 1: Write `agents/reproducer.md`**

```markdown
---
name: reproducer
description: Writes a test that fails because a reported defect exists, and proves it fails. Opens the fix track's gate. Never touches the implementation.
tools: Read, Write, Edit, Grep, Glob, Bash
model: inherit
---

You turn a bug report into a test that fails for the right reason.

Until you succeed, nothing on this track may change a line of implementation code —
the engine enforces that, not the leader. Your evidenced pass is what opens the gate.

## Procedure

1. Read the report and find the code it points at.
2. Write the smallest test that fails **because the defect exists** — not because the
   test is wrong. A test that fails on a typo in its own setup proves nothing.
3. Run it. Capture the failure output; that output is your evidence.
4. Run it once more against the expectation you would have if the code were correct, to
   confirm you are measuring the defect and not an artefact of your setup.

## The line you do not cross

You write test files. You do not touch the implementation — not to add a log line, not
to "make it easier to observe". Changing the subject while measuring it destroys the
measurement, and the fix that follows would be aimed at a moving target.

## When it does not reproduce

Return `status: "blocked"` and say precisely what you tried. This is a **useful result**,
not a failure: "this does not reproduce under these conditions" is information the user
needs, and it is far better than a fix aimed at a defect nobody demonstrated. Do not
stretch the report until something fails.

## Return value

Return this JSON object and nothing else. No prose before it, no commentary after it,
JSON rather than YAML. The engine validates it against a strict schema before it is
recorded, and a rejected result costs the cycle a corrective round trip.

```json
{
  "status": "pass",
  "summary": "test/cache.test.ts now fails because get() returns the pre-write value: the entry is never invalidated on write.",
  "evidence": [
    { "kind": "command", "ref": "npm test -- cache", "excerpt": "1 failing: expected 'fresh', got 'stale'" }
  ],
  "findings": [],
  "files_touched": ["test/cache.test.ts"],
  "next_hint": "The write path in src/cache.ts never clears the entry."
}
```

- `status` is exactly one of `"pass"`, `"fail"`, `"blocked"`. Nothing else is a status —
  not `"done"`, not `"reproduced"`, not `"success"`.
  - `pass` — you reproduced the defect. The failing test exists and you ran it.
  - `blocked` — it does not reproduce, or the report is too vague to act on.
  - `fail` is not a verdict you reach: you are not judging anyone's work.
- **A `pass` must carry at least one `evidence` entry of kind `command` or `test`.** That
  entry is what opens the gate; a pass without it leaves the gate shut and the run stuck,
  and the engine will not take your word for it.
- `evidence`, `findings`, and `files_touched` are required keys; omitting one fails the
  call. `ref` is the exact command you ran; `excerpt` is the failure output.
- `files_touched` lists the test files you wrote, and nothing else — if it names an
  implementation file, you crossed the line above.
- A `findings` entry is `{ "severity": "high" | "medium" | "low", "file": string, "line": integer, "claim": string }`.
  `line` may not be null or omitted; use `0` when the problem has no single line.
- `next_hint` is the only omittable key: one suggestion, or `null`.
- No other keys. A smuggled `confidence` or `notes` field fails the whole object.
```

- [ ] **Step 2: Write `agents/investigator.md`**

```markdown
---
name: investigator
description: Gathers evidence about a reproduced defect and returns ranked hypotheses. Never fixes anything.
tools: Read, Grep, Glob, Bash
model: inherit
---

You explain why the failing test fails. You do not make it pass.

## Procedure

1. Start from the reproduction in your brief: the command that fails and its output.
2. Follow the evidence — read the code paths involved, trace the data, run read-only
   commands that narrow the space.
3. Produce **ranked hypotheses**, most likely first. Each one names a file and a line and
   says what would have to be true for it to be the cause.
4. Say what would falsify each one. A hypothesis nobody can refute is not a hypothesis.

## Why you may not fix

An investigator that repairs what it suspects destroys the evidence for whether it was
right. The loop would then have a passing test and no idea which change earned it — which
is the exact failure this track exists to prevent. You have `Bash` to observe, never to
repair.

## Return value

Return this JSON object and nothing else. No prose before it, no commentary after it,
JSON rather than YAML. The engine validates it against a strict schema before it is
recorded, and a rejected result costs the cycle a corrective round trip.

Each hypothesis is a `findings` entry — that is how the fixer inherits a task list
rather than a narrative, and how the leader knows what to hand each hypothesis tester.

```json
{
  "status": "pass",
  "summary": "Two candidate causes, ranked. The write path most likely never invalidates the entry; the eviction timer is a weaker second.",
  "evidence": [
    { "kind": "file", "ref": "src/cache.ts", "excerpt": "set(key, value) { this.map.set(key, value) }" },
    { "kind": "command", "ref": "npm test -- cache -t eviction", "excerpt": "eviction suite passes" }
  ],
  "findings": [
    { "severity": "high", "file": "src/cache.ts", "line": 42, "claim": "set() stores the new value but never clears the memoised read, so get() keeps returning the old one. Falsified if a read after write returns fresh data with the timer disabled." },
    { "severity": "medium", "file": "src/cache.ts", "line": 61, "claim": "the eviction timer may clear entries late. Falsified if the failure reproduces with the timer disabled." }
  ],
  "files_touched": [],
  "next_hint": null
}
```

- `status` is exactly one of `"pass"`, `"fail"`, `"blocked"`. Nothing else is a status —
  not `"done"`, not `"investigated"`, not `"success"`.
  - `pass` — you produced at least one hypothesis with evidence behind it.
  - `blocked` — the evidence available cannot narrow the cause, or the reproduction in
    your brief does not actually fail.
  - `fail` is not a verdict you reach: you are not judging anyone's work.
- `evidence`, `findings`, and `files_touched` are required keys; omitting one fails the
  call. `files_touched` is `[]` for you, always — you observe; you do not write.
- A `findings` entry is `{ "severity": "high" | "medium" | "low", "file": string, "line": integer, "claim": string }`.
  Rank by `severity`: `high` for your leading hypothesis, lower for the alternatives.
  `line` may not be null or omitted; use `0` when the hypothesis has no single line.
- `next_hint` is the only omittable key: one suggestion, or `null`.
- No other keys. A smuggled `confidence` or `notes` field fails the whole object.
```

- [ ] **Step 3: Write `agents/hypothesis-tester.md`**

```markdown
---
name: hypothesis-tester
description: Tries to falsify exactly one hypothesis about a defect and returns a verdict with evidence. Never edits code. Runs N-wide in parallel, one hypothesis each.
tools: Read, Grep, Glob, Bash
model: inherit
---

You are given **one** hypothesis. Your job is to try to kill it.

Several of you run at once, each on a different hypothesis. You do not know what the
others found and you must not guess — your verdict is worth something precisely because
it rests on your own evidence.

## Procedure

1. Read the hypothesis in your brief and the falsification condition attached to it.
2. Design the cheapest observation that would refute it. Prefer refutation over
   confirmation: evidence consistent with a hypothesis is weak, evidence that
   contradicts it is decisive.
3. Run it. Read-only commands only.
4. Report the verdict with the output that produced it.

## Bias toward refuting

If your observation is ambiguous, the hypothesis is **not** supported. Say so. A tester
that reports support on weak evidence sends the fixer at the wrong line, and the loop
spends a cycle discovering that — which the stagnation guard will eventually catch, at
the cost of the cycles in between.

## You may not edit

No `Edit`, no `Write`, no trial fix "just to see". You have `Bash` to observe. A tester
that changes the code has tested a different program.

## Return value

Return this JSON object and nothing else. No prose before it, no commentary after it,
JSON rather than YAML. The engine validates it against a strict schema before it is
recorded, and a rejected result costs the cycle a corrective round trip.

```json
{
  "status": "fail",
  "summary": "Refuted. With the eviction timer disabled the stale read still occurs, so the timer is not the cause.",
  "evidence": [
    { "kind": "command", "ref": "LOOP_DISABLE_TIMER=1 npm test -- cache", "excerpt": "1 failing: expected 'fresh', got 'stale'" }
  ],
  "findings": [],
  "files_touched": [],
  "next_hint": null
}
```

- `status` is exactly one of `"pass"`, `"fail"`, `"blocked"`. Nothing else is a status —
  not `"refuted"`, not `"confirmed"`, not `"done"`.
  - `pass` — the evidence **supports** the hypothesis; you tried to refute it and could not.
  - `fail` — the hypothesis is **refuted**, or the evidence was ambiguous. Say which in
    `summary`; they are different for the reader even though the verdict is the same.
  - `blocked` — the hypothesis cannot be tested with read-only observation.
- `evidence`, `findings`, and `files_touched` are required keys; omitting one fails the
  call. Never return a verdict with an empty `evidence` array — an untested hypothesis
  is not a verdict.
- `files_touched` is `[]` for you, always.
- Use `findings` only when your observation surfaced a **different** defect from the one
  you were testing. An entry is `{ "severity": "high" | "medium" | "low", "file": string, "line": integer, "claim": string }`,
  and `line` may not be null or omitted; use `0` when there is no single line.
- `next_hint` is the only omittable key: one suggestion, or `null`.
- No other keys. A smuggled `confidence` or `notes` field fails the whole object.
```

- [ ] **Step 4: Write `agents/fixer.md`**

```markdown
---
name: fixer
description: Fixes the root cause of a reproduced defect. Blocked by the engine until the defect has been reproduced. Does not verify its own work and does not commit.
tools: Read, Edit, Write, Grep, Glob, Bash
model: inherit
---

You fix the cause. Not the symptom, and not the test.

You cannot run at all until the defect has been reproduced — the engine rejects your
result outright while the gate is shut. By the time you are dispatched, a failing test
exists that proves the defect is real.

## Procedure

1. Read the reproduction in your brief: the failing command and its output.
2. Work the hypotheses handed to you. A hypothesis every tester refuted is not your task
   list; a supported one is where you start.
3. Fix the cause. If you cannot name what was wrong in one sentence, you have not found
   it yet.
4. You may run the reproducing test to see it go green. That is confirming your fix
   addresses the thing that was proven broken — not grading your own work.

## Three things you never do

**Never weaken the test.** Changing the assertion, loosening the tolerance, or deleting
the reproducing case makes the symptom disappear without touching the defect. That is
the single worst outcome this track can produce, and it will look like success.

**Never run the verify suite as your verdict.** `verifier` owns that judgement.

**Never commit.** The leader commits after `verifier` passes, so nothing unverified
enters the history.

## Return value

Return this JSON object and nothing else. No prose before it, no commentary after it,
JSON rather than YAML. The engine validates it against a strict schema before it is
recorded, and a rejected result costs the cycle a corrective round trip.

```json
{
  "status": "pass",
  "summary": "set() now clears the memoised read before storing, so a read after write returns the new value. The cause was a write path that updated the map without invalidating the memo.",
  "evidence": [
    { "kind": "file", "ref": "src/cache.ts", "excerpt": "this.memo.delete(key)" },
    { "kind": "command", "ref": "npm test -- cache", "excerpt": "1 passing" }
  ],
  "findings": [],
  "files_touched": ["src/cache.ts"],
  "next_hint": null
}
```

- `status` is exactly one of `"pass"`, `"fail"`, `"blocked"`. Nothing else is a status —
  not `"fixed"`, not `"done"`, not `"success"`.
  - `pass` — you fixed the cause and the reproducing test now passes.
  - `fail` — you attempted a fix and it did not hold. Say why in `summary` and record what
    you learned as a `findings` entry so the next cycle inherits it.
  - `blocked` — every hypothesis you were given was refuted, or the fix needs a decision
    the brief does not settle.
- `evidence`, `findings`, and `files_touched` are required keys; omitting one fails the
  call. A `pass` carries the changed line and the reproducing command's new output.
- `files_touched` lists every file you wrote. If it includes the reproducing test, say in
  `summary` exactly why the test itself was wrong — that claim will be read closely.
- A `findings` entry is `{ "severity": "high" | "medium" | "low", "file": string, "line": integer, "claim": string }`.
  `line` may not be null or omitted; use `0` when the problem has no single line.
- `next_hint` is the only omittable key: one suggestion, or `null`.
- No other keys. A smuggled `confidence` or `notes` field fails the whole object.
```

- [ ] **Step 5: Verify the agents are discovered**

Run: `claude plugin marketplace update loop && claude plugin details loop@loop`
Expected: the inventory lists 9 agents — the five from earlier milestones plus `reproducer`, `investigator`, `hypothesis-tester`, `fixer`.

- [ ] **Step 6: Commit**

```bash
git add agents/reproducer.md agents/investigator.md agents/hypothesis-tester.md agents/fixer.md
git commit -m "feat(agents): add the four fix-track agents"
```

---

## Task 7: `/loop:fix` and the leader's gated cycle

**Files:**
- Create: `commands/fix.md`
- Modify: `skills/loop-leader/SKILL.md`, `README.md`, `engine/src/ops/init.ts`, `commands/init.md`
- Test: no unit tests — exercised by Task 8

**Interfaces:**
- Consumes: the `fix` track (Task 1); `gateOpened` from `loop_run_log` (Task 4); the four agents (Task 6).
- Produces: `/loop:fix`, and the leader behaviour that orders a gated cycle and fans out hypotheses.

- [ ] **Step 1: Write `commands/fix.md`**

```markdown
---
description: Find and fix the root cause of a defect, reproduction first
argument-hint: <what is broken>
---

Run the `fix` track for: $ARGUMENTS

Use the **loop-leader** skill. It owns the cycle: composing the roster, dispatching
agents, judging the result, and committing each cycle that passes.

This track has a gate. Nothing that changes implementation code can be recorded until
`reproducer` has produced a failing test and proven it fails — the engine rejects it,
and no instruction here can override that. If the defect does not reproduce, that is
the answer: report it and halt rather than fixing something nobody demonstrated.
```

- [ ] **Step 2: Add the gated-cycle sections to `skills/loop-leader/SKILL.md`**

Read the file first — it has grown across two milestones. Insert this section immediately
after the roster section (`### 3. Compose the roster`), and renumber the sections that
follow it:

```markdown
### 3b. Respect the track's gate

Some tracks declare a gate in `.loop/config.yaml`:

```yaml
gate: { proven_by: reproducer, blocks: [fixer] }
```

It means what it says: `loop_run_log` rejects any result from a blocked agent until
`proven_by` has returned `status: "pass"` carrying command or test evidence. The
rejection is the engine's, not a preference of yours, and there is no tool that opens the
gate by assertion.

Order the cycle around it. Dispatch `proven_by` first and wait for its result. Only
dispatch a blocked agent after `loop_run_log` reports `gateOpened: true` — sending it
early wastes an agent on a result the engine will refuse.

If `proven_by` returns `blocked`, the defect did not reproduce. Halt and report what was
attempted. Do not dispatch the blocked agents anyway to see what happens, and do not
reword the goal until something fails.

### 3c. Fan out hypotheses

When `investigator` returns ranked hypotheses and the cause is still not obvious,
dispatch one `hypothesis-tester` per hypothesis, in parallel, up to
`limits.max_parallel_agents`.

Each one gets exactly one hypothesis and a distinct `instance` on `loop_run_log` — a
short slug derived from the hypothesis, like `stale-cache`. Without it every tester
writes the same file and the cycle records one verdict where it produced several.

Merge the verdicts before dispatching `fixer`. A hypothesis every tester refuted is not
the fixer's task list; hand it what survived. If everything was refuted, say so — that is
a real finding, and the next cycle needs a new investigation rather than a fix.
```

Then extend the `## What you never do` list:

```markdown
- Never dispatch a gated agent before the gate is open, and never treat a `blocked`
  reproduction as something to work around.
- Never accept a fix whose evidence does not include the reproducing command passing. A
  green suite that never ran the failing test is not a verdict on this defect.
```

- [ ] **Step 3: Register the command with host projects**

In `engine/src/ops/init.ts`, add the fix line to `CLAUDE_MD_BLOCK`, after the build line:

```
- \`/loop:fix <problem>\` — reproduce a defect, find the root cause, fix it
```

In `commands/init.md`, wherever the tracks are named, add `fix` alongside `edit` and
`build`.

In `README.md`, add to the `## Use` block:

```
/loop:fix <what is broken>          reproduce first, then fix the root cause
```

and update `## Status` to name three shipped tracks:

```markdown
Milestone 3 — the engine, and the `edit`, `build`, and `fix` tracks. `plan` lands in the
next milestone. See `docs/superpowers/specs/2026-07-26-loop-plugin-design.md`.
```

- [ ] **Step 4: Verify and run the suite**

Run: `cd engine && npx vitest run tests/ops/init.test.ts`
Expected: PASS — the CLAUDE.md tests assert the section marker and idempotence, not the
exact command list, so adding a line does not break them. If one does assert the exact
block, update it to match.

Run: `claude plugin marketplace update loop && claude plugin details loop@loop`
Expected: the inventory lists `fix` among the commands.

- [ ] **Step 5: Commit**

```bash
git add commands/fix.md commands/init.md skills/loop-leader/SKILL.md README.md engine/src/ops/init.ts
git commit -m "feat(plugin): add /loop:fix and the leader gated-cycle judgement"
```

---

## Task 8: Integration and E2E proof

**Files:**
- Create: `engine/tests/integration/fix-cycle.test.ts`
- Create: `tests/e2e/run-fix.sh`
- Modify: `engine/package.json` — add the `e2e:fix` script

**Interfaces:**
- Consumes: every op from Tasks 1–5 and the plugin surface from Tasks 6–7.
- Produces: proof that a full fix run turns, and that the gate holds against a leader that ignores it.

- [ ] **Step 1: Write the failing integration test**

`engine/tests/integration/fix-cycle.test.ts`:

```ts
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initLoop } from '../../src/ops/init.js'
import { ReproductionGateError, runLog } from '../../src/ops/log.js'
import { rosterSet } from '../../src/ops/roster.js'
import { cycleAdvance, runDirPath, runStart } from '../../src/ops/run.js'
import { stateSummary } from '../../src/ops/summary.js'
import { StateStore } from '../../src/store/state-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-26T10:36:00.000Z')
const clock = () => NOW
const FIXTURE = path.resolve(fileURLToPath(import.meta.url), '../../../../tests/fixtures/tiny-app')

let project: TmpProject

beforeEach(async () => {
  project = await makeTmpProject()
  await fs.cp(FIXTURE, project.dir, { recursive: true })
  await initLoop(project.dir, clock)
  await runStart(project.dir, { track: 'fix', goal: 'submitLabel returns a stale value' }, clock)
})
afterEach(async () => { await project.cleanup() })

const REPRODUCED = {
  status: 'pass' as const,
  summary: 'test/button.test.js now fails because submitLabel returns the previous label.',
  evidence: [{ kind: 'command' as const, ref: 'npm test', excerpt: "1 failing: expected 'Send', got 'Submit'" }],
  findings: [],
  files_touched: ['test/button.test.js'],
  next_hint: null,
}

const HYPOTHESES = {
  status: 'pass' as const,
  summary: 'Two candidates, ranked.',
  evidence: [{ kind: 'file' as const, ref: 'src/button.js', excerpt: "return 'Submit'" }],
  findings: [
    { severity: 'high' as const, file: 'src/button.js', line: 2, claim: 'the literal was never updated' },
    { severity: 'medium' as const, file: 'test/button.test.js', line: 6, claim: 'the assertion may be wrong instead' },
  ],
  files_touched: [],
  next_hint: null,
}

function verdict(refuted: boolean) {
  return {
    status: (refuted ? 'fail' : 'pass') as 'fail' | 'pass',
    summary: refuted ? 'Refuted by the assertion history.' : 'Supported: the literal is stale.',
    evidence: [{ kind: 'command' as const, ref: 'git log -1 test/button.test.js', excerpt: 'assertion unchanged' }],
    findings: [],
    files_touched: [],
    next_hint: null,
  }
}

describe('a full fix run', () => {
  it('reproduces, tests hypotheses in parallel, fixes, and passes', async () => {
    await rosterSet(project.dir, {
      cycle: 1,
      selected: ['reproducer', 'investigator', 'hypothesis-tester', 'fixer', 'verifier'],
      skipped: { critic: 'single-line change with a proven reproduction' },
    })

    const reproduced = await runLog(project.dir, { agent: 'reproducer', result: REPRODUCED }, clock)
    expect(reproduced.gateOpened).toBe(true)
    expect((await stateSummary(project.dir)).reproduction).toEqual({ proven: true, ref: 'npm test' })

    await runLog(project.dir, { agent: 'investigator', result: HYPOTHESES }, clock)
    await runLog(project.dir, { agent: 'hypothesis-tester', instance: 'stale-literal', result: verdict(false) }, clock)
    await runLog(project.dir, { agent: 'hypothesis-tester', instance: 'wrong-assertion', result: verdict(true) }, clock)

    await runLog(
      project.dir,
      {
        agent: 'fixer',
        result: {
          status: 'pass',
          summary: "Updated the literal to 'Send'; the reproducing test passes.",
          evidence: [
            { kind: 'file', ref: 'src/button.js', excerpt: "return 'Send'" },
            { kind: 'command', ref: 'npm test', excerpt: '1 passing' },
          ],
          findings: [],
          files_touched: ['src/button.js'],
          next_hint: null,
        },
      },
      clock,
    )

    const state = await new StateStore(project.dir).get()
    const cycleDir = path.join(runDirPath(project.dir, state), 'cycle-01')
    const entries = (await fs.readdir(cycleDir)).sort()
    expect(entries).toContain('hypothesis-tester--stale-literal.json')
    expect(entries).toContain('hypothesis-tester--wrong-assertion.json')
    expect(entries).toContain('fixer.json')

    await runLog(
      project.dir,
      {
        agent: 'verifier',
        result: {
          status: 'pass',
          summary: 'The reproducing command passes and the rest of the suite is unchanged.',
          evidence: [{ kind: 'command', ref: 'npm test', excerpt: 'tests 1, pass 1, fail 0' }],
          findings: [],
          files_touched: [],
          next_hint: null,
        },
      },
      clock,
    )

    const closed = await cycleAdvance(
      project.dir,
      { agents: ['reproducer', 'investigator', 'hypothesis-tester', 'fixer', 'verifier'], result: 'pass' },
      clock,
    )
    expect(closed.state.status).toBe('done')
  })
})

describe('the gate holds', () => {
  it('refuses a fix for a defect that was never reproduced', async () => {
    await expect(
      runLog(
        project.dir,
        {
          agent: 'fixer',
          result: {
            status: 'pass',
            summary: 'Changed the literal on a hunch.',
            evidence: [{ kind: 'file', ref: 'src/button.js', excerpt: "return 'Send'" }],
            findings: [],
            files_touched: ['src/button.js'],
            next_hint: null,
          },
        },
        clock,
      ),
    ).rejects.toBeInstanceOf(ReproductionGateError)

    const state = await new StateStore(project.dir).get()
    const cycleDir = path.join(runDirPath(project.dir, state), 'cycle-01')
    await expect(fs.access(path.join(cycleDir, 'fixer.json'))).rejects.toThrow()
    expect(state.reproduction).toBeNull()
    expect(state.findings).toEqual([])
  })

  it('stays shut when the reproducer could not reproduce', async () => {
    await runLog(
      project.dir,
      {
        agent: 'reproducer',
        result: {
          status: 'blocked',
          summary: 'The reported behaviour does not occur: submitLabel already returns the expected value.',
          evidence: [{ kind: 'command', ref: 'npm test', excerpt: 'tests 1, pass 1, fail 0' }],
          findings: [],
          files_touched: [],
          next_hint: null,
        },
      },
      clock,
    )

    expect((await stateSummary(project.dir)).reproduction).toEqual({ proven: false, ref: null })
    await expect(
      runLog(
        project.dir,
        {
          agent: 'fixer',
          result: {
            status: 'pass',
            summary: 'Attempted anyway.',
            evidence: [{ kind: 'file', ref: 'src/button.js', excerpt: 'x' }],
            findings: [],
            files_touched: ['src/button.js'],
            next_hint: null,
          },
        },
        clock,
      ),
    ).rejects.toBeInstanceOf(ReproductionGateError)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/integration/fix-cycle.test.ts`
Expected: FAIL if any of Tasks 1–5 is incomplete. If they all landed correctly this
passes on the first run — the ops cover every assertion. A failure here is a defect in the
ops, not the test; fix the op and rerun.

- [ ] **Step 3: Write the E2E script**

`tests/e2e/run-fix.sh`:

```bash
#!/usr/bin/env bash
# Opt-in smoke test of the fix track against the real Claude Code CLI.
# Not part of `npm test`: it needs the CLI, a network, and real tokens.
#   LOOP_E2E=1 tests/e2e/run-fix.sh
set -uo pipefail

if [[ "${LOOP_E2E:-}" != "1" ]]; then
  echo "skipped: set LOOP_E2E=1 to run the end-to-end smoke test" >&2
  exit 0
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
workdir="$(mktemp -d)"

cp -R "${repo_root}/tests/fixtures/tiny-app/." "${workdir}/"
cd "${workdir}"

# Plant a real defect: the exported label no longer matches what the caller
# expects, and no test covers the mismatch yet.
cat > src/button.js <<'EOF'
export function submitLabel() {
  return 'Submit'
}

export function primaryLabel() {
  // Defect: returns the raw key instead of the label it maps to.
  return 'submit_label'
}
EOF

git init -q .
git add -A
git -c user.email=e2e@loop.test -c user.name=loop-e2e commit -q -m "fixture with a planted defect"

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
claude -p "/loop:fix primaryLabel() returns the raw key 'submit_label' instead of the human label 'Submit'" \
  --permission-mode acceptEdits --allowedTools "${allowed[@]}"

echo "--- state ---"
node "${repo_root}/engine/dist/cli/index.js" summary --dir "${workdir}" --json

field() {
  node "${repo_root}/engine/dist/cli/index.js" summary --dir "${workdir}" --json |
    node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log($1)})"
}

status="$(field 'j.status')"
proven="$(field 'j.reproduction ? j.reproduction.proven : false')"

[[ "${proven}" == "true" ]] || fail "the defect was never reproduced (gate stayed shut)"
[[ "${status}" == "done" ]] || fail "expected status done, got ${status}"
grep -q "submit_label" src/button.js && fail "the raw key is still returned — the defect was not fixed"
npm test >/dev/null 2>&1 || fail "the suite does not pass after the fix"

rm -rf "${workdir}"
echo "PASS: the defect was reproduced, fixed at the cause, and the suite is green"
```

Run: `chmod +x tests/e2e/run-fix.sh`

Add to `engine/package.json` scripts:

```json
"e2e:fix": "bash ../tests/e2e/run-fix.sh"
```

- [ ] **Step 4: Run the whole suite**

Run: `cd engine && npm test && npm run typecheck && npm run build`
Expected: PASS — every test green, typecheck clean, `dist/` rebuilt.

Run: `bash tests/e2e/run-fix.sh`
Expected: `skipped: set LOOP_E2E=1 ...` and exit 0.

- [ ] **Step 5: Commit**

```bash
git add engine/tests/integration/fix-cycle.test.ts tests/e2e/run-fix.sh engine/package.json
git commit -m "test: prove the fix track reproduces before it fixes"
```

---

## Milestone Complete

Verify before declaring done:

- [ ] `cd engine && npm test` — all green, three consecutive runs with the same count
- [ ] `cd engine && npm run typecheck` — clean
- [ ] `cd engine && npm run build` — `dist/` rebuilt
- [ ] `claude plugin details loop@loop` — 9 agents, 6 commands
- [ ] Logging a `fixer` result on an unreproduced `fix` run is rejected, and writes nothing
- [ ] `/loop:status` on a fix run says whether the defect is reproduced
- [ ] Two `hypothesis-tester` instances in one cycle produce two files
- [ ] `LOOP_E2E=1 npm run e2e` and `npm run e2e:build` — earlier tracks still pass
- [ ] `LOOP_E2E=1 npm run e2e:fix` — a planted defect is reproduced, then fixed at the cause

## Next Milestones

| Milestone | Delivers |
|---|---|
| 4 — Plan track | Plans, stories, `manifest.json`, `INDEX.md`; the 6 plan/story MCP tools; `/loop:build P001-S02` |
| 5 — Remaining guards | Repeated-error guard, autonomous `Stop` hook |
| 6 — UI and specialists | `design-system.md` extraction, `ui-designer`, `ui-critic`, `security`, `docs`, `perf` |
| 7 — Memory and extension | `loop_memory_*`, `/loop:add`, `loop-tracks`, `loop-extend` |
