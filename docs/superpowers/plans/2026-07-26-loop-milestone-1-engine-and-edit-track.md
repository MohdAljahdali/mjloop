# Loop — Milestone 1: Engine and Edit Track — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first `loop` cycle that turns end to end — `/loop:init` provisions `.loop/`, and `/loop:edit` runs a one-cycle `editor → verifier` track whose state is owned entirely by an MCP server.

**Architecture:** A single TypeScript package (`engine/`) holds the zod schemas, the atomic state store, the cycle operations, an MCP server, and a CLI. Hook scripts are thin bash wrappers that call the CLI, so all logic is tested in TypeScript rather than shell. The plugin surface (commands, agents, skills, hooks) is markdown and JSON on top of that engine.

**Tech Stack:** TypeScript 5 · Node 24 (floor 20) · zod 4.4.3 · @modelcontextprotocol/sdk 1.29.0 · yaml 2.9.0 · vitest 4.1.10

**Spec:** `docs/superpowers/specs/2026-07-26-loop-plugin-design.md`

## Global Constraints

- All plugin files, prompts, code, comments, and documentation in **English**. Conversation with the user is Arabic; nothing in the repository is.
- Node floor: `>=20`. Package is ESM (`"type": "module"`).
- **zod 4 idioms only:** `z.strictObject(...)` not `z.object(...).strict()`; `z.iso.datetime()` not `z.string().datetime()`; `z.record(keySchema, valueSchema)` requires both arguments; format errors with `z.prettifyError(error)`.
- **State has one owner.** Nothing outside `engine/src/store` and `engine/src/ops` may write `.loop/state.json`. No agent, command, or skill file may instruct writing it directly.
- **`verifier` is a hard invariant.** `rosterSet` must reject any roster that omits a track's `required` agents.
- Every operation that stamps a timestamp takes an injectable `now: Clock` parameter defaulting to `() => new Date()`, so tests are deterministic.
- Every task ends with a commit. Tests must be seen failing before the implementation is written.

## Deviations From The Spec (flagged for approval)

1. **Single package instead of `mcp/loop-server/` + `packages/schemas/`.** The spec's guarantee is that validation exists once and cannot drift. One package `engine/` with `src/schemas`, `src/store`, `src/ops`, `src/mcp`, `src/cli` delivers that guarantee without npm workspace machinery. Reject this and the plan splits into two packages with a `file:` dependency.
2. **Milestone 1 ships 7 of the 13 MCP tools.** Plan/story tools (`loop_plan_create`, `loop_story_add`, `loop_story_update`, `loop_task_update`, `loop_gate_set`, `loop_index_render`) belong to the plan-track milestone; there are no plans or stories to operate on yet.
3. **Stagnation detection and the `Stop` hook are deferred.** Spec §18 orders guards after the tracks. The `edit` track has `max_cycles: 1`, so the cycle cap is the only guard it can exercise. Milestone 1 implements the cycle cap; the fingerprint, repeated-error guard, and autonomous `Stop` hook land in the guards milestone.
4. **`loop-tracks` and `loop-extend` skills deferred.** With one track defined, track resolution is three lines inside `loop-leader`. They become separate skills when the second track lands.
5. **`design-system.md` not created by `/loop:init` yet.** It is produced by extraction logic that belongs to the UI milestone. Creating an empty stub now would be a placeholder in the product.

---

## File Structure

### Engine package

| File | Responsibility |
|---|---|
| `engine/package.json` | Package, deps, bins (`loop-mcp`, `loop-cli`), scripts |
| `engine/tsconfig.json` | Strict ESM TypeScript build to `dist/` |
| `engine/vitest.config.ts` | Test config |
| `engine/src/schemas/state.ts` | `StateSchema`, `FindingSchema`, `HistoryEntrySchema`, `initialState()` |
| `engine/src/schemas/config.ts` | `ConfigSchema`, `TrackSchema`, `DEFAULT_TRACKS` |
| `engine/src/schemas/contract.ts` | `AgentResultSchema`, `RosterSchema`, `EvidenceSchema` |
| `engine/src/schemas/index.ts` | Barrel re-export |
| `engine/src/store/paths.ts` | `.loop` path resolution, `PROTECTED_BASENAMES` |
| `engine/src/store/atomic.ts` | `writeJsonAtomic`, `readJsonValidated`, `.bak` recovery |
| `engine/src/store/lock.ts` | `withLock` — mkdir lock with stale reclaim |
| `engine/src/store/state-store.ts` | `StateStore.get()` / `.update()` under lock |
| `engine/src/store/config-store.ts` | `loadConfig`, `writeConfig` |
| `engine/src/ops/init.ts` | `initLoop` — idempotent provisioning + verify detection |
| `engine/src/ops/run.ts` | `runStart`, `cycleAdvance`, `halt`, `runDirName`, `runDirPath` |
| `engine/src/ops/roster.ts` | `rosterSet` — required/forced/unknown enforcement |
| `engine/src/ops/log.ts` | `runLog` — validate agent result, persist, fold findings |
| `engine/src/ops/summary.ts` | `stateSummary`, `renderSummaryLine` |
| `engine/src/mcp/server.ts` | 7 MCP tools over stdio |
| `engine/src/cli/index.ts` | `summary`, `session-start`, `state-guard` subcommands |
| `engine/tests/**` | One test file per source module, mirrored paths |
| `engine/tests/helpers/tmp-project.ts` | Temp project fixture helper |

### Plugin surface

| File | Responsibility |
|---|---|
| `.claude-plugin/plugin.json` | Plugin manifest (name `loop`) |
| `.mcp.json` | Registers the `loop` MCP server |
| `commands/init.md` | `/loop:init` |
| `commands/edit.md` | `/loop:edit` |
| `commands/status.md` | `/loop:status` |
| `agents/editor.md` | Fast edit agent with escalation rule |
| `agents/verifier.md` | Evidence-only judge, never edits |
| `skills/loop-contract/SKILL.md` | Brief format and mandatory output shape |
| `skills/loop-state/SKILL.md` | Working with `.loop/` through MCP tools |
| `skills/loop-leader/SKILL.md` | Cycle composition, roster declaration, judgement |
| `hooks/hooks.json` | `SessionStart` + `PreToolUse` registration |
| `hooks/scripts/session-start.sh` | Wrapper → `loop-cli session-start` |
| `hooks/scripts/state-guard.sh` | Wrapper → `loop-cli state-guard` |
| `tests/fixtures/tiny-app/` | Fixture project for integration + E2E |
| `tests/e2e/run-edit.sh` | Opt-in real-CLI smoke test |

---

## Task 1: Engine scaffolding and state schema

**Files:**
- Create: `engine/package.json`, `engine/tsconfig.json`, `engine/vitest.config.ts`, `.gitignore`
- Create: `engine/src/schemas/state.ts`
- Test: `engine/tests/schemas/state.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Status`, `Stage`, `Finding`, `HistoryEntry`, `State` types; `StateSchema: z.ZodType<State>`; `initialState(now: Date): State`.

- [ ] **Step 1: Create the package manifest**

`engine/package.json`:

```json
{
  "name": "@loop/engine",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "bin": {
    "loop-mcp": "./dist/mcp/server.js",
    "loop-cli": "./dist/cli/index.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.29.0",
    "yaml": "2.9.0",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@types/node": "24.3.0",
    "typescript": "5.9.2",
    "vitest": "4.1.10"
  }
}
```

- [ ] **Step 2: Create the TypeScript and test config**

`engine/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "types": ["node"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

`engine/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})
```

`.gitignore` at the repository root:

```
node_modules/
engine/dist/
*.tsbuildinfo
.DS_Store
```

- [ ] **Step 3: Install dependencies**

Run: `cd engine && npm install`
Expected: `node_modules/` created, no peer-dependency errors.

- [ ] **Step 4: Write the failing test**

`engine/tests/schemas/state.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { StateSchema, initialState } from '../../src/schemas/state.js'

const NOW = new Date('2026-07-26T10:36:00.000Z')

describe('initialState', () => {
  it('produces a schema-valid uninitialised state', () => {
    const state = initialState(NOW)
    expect(StateSchema.parse(state)).toEqual(state)
    expect(state.status).toBe('idle')
    expect(state.cycle).toBe(0)
    expect(state.run_id).toBeNull()
    expect(state.updated_at).toBe('2026-07-26T10:36:00.000Z')
  })
})

describe('StateSchema', () => {
  it('rejects an unknown top-level key', () => {
    const bad = { ...initialState(NOW), surprise: true }
    expect(StateSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects a negative cycle', () => {
    const bad = { ...initialState(NOW), cycle: -1 }
    expect(StateSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects a schema version other than 1', () => {
    const bad = { ...initialState(NOW), schema: 2 }
    expect(StateSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects a non-ISO updated_at', () => {
    const bad = { ...initialState(NOW), updated_at: 'yesterday' }
    expect(StateSchema.safeParse(bad).success).toBe(false)
  })

  it('accepts a populated running state', () => {
    const state = {
      ...initialState(NOW),
      run_id: '2026-07-26-001',
      track: 'edit',
      status: 'running' as const,
      cycle: 1,
      goal: 'Rename the submit button label',
      current: { plan: null, story: null, stage: 'execute' as const },
      findings: [{ severity: 'low' as const, file: 'src/a.ts', line: 12, claim: 'unused import' }],
      history: [{ cycle: 1, agents: ['editor', 'verifier'], result: 'fail' as const, ref: 'runs/2026-07-26-001--adhoc--edit' }],
    }
    expect(StateSchema.safeParse(state).success).toBe(true)
  })
})
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/schemas/state.test.ts`
Expected: FAIL — cannot resolve `../../src/schemas/state.js`.

- [ ] **Step 6: Write the implementation**

`engine/src/schemas/state.ts`:

```ts
import * as z from 'zod'

export const StatusSchema = z.enum(['idle', 'running', 'paused', 'halted', 'done', 'failed'])
export const StageSchema = z.enum(['idle', 'compose', 'execute', 'judge', 'halted', 'done'])
export const SeveritySchema = z.enum(['high', 'medium', 'low'])
export const ResultSchema = z.enum(['pass', 'fail', 'blocked'])

export const FindingSchema = z.strictObject({
  severity: SeveritySchema,
  file: z.string().min(1),
  line: z.number().int().nonnegative(),
  claim: z.string().min(1),
})

export const HistoryEntrySchema = z.strictObject({
  cycle: z.number().int().positive(),
  agents: z.array(z.string().min(1)).min(1),
  result: ResultSchema,
  ref: z.string().min(1),
})

export const StateSchema = z.strictObject({
  schema: z.literal(1),
  run_id: z.string().min(1).nullable(),
  track: z.string().min(1).nullable(),
  status: StatusSchema,
  cycle: z.number().int().nonnegative(),
  goal: z.string().min(1).nullable(),
  current: z.strictObject({
    plan: z.string().min(1).nullable(),
    story: z.string().min(1).nullable(),
    stage: StageSchema,
  }),
  findings: z.array(FindingSchema),
  no_progress_count: z.number().int().nonnegative(),
  history: z.array(HistoryEntrySchema),
  halt_reason: z.string().min(1).nullable(),
  updated_at: z.iso.datetime(),
})

export type Status = z.infer<typeof StatusSchema>
export type Stage = z.infer<typeof StageSchema>
export type Severity = z.infer<typeof SeveritySchema>
export type Result = z.infer<typeof ResultSchema>
export type Finding = z.infer<typeof FindingSchema>
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>
export type State = z.infer<typeof StateSchema>

/** A freshly provisioned, not-yet-running state. */
export function initialState(now: Date): State {
  return {
    schema: 1,
    run_id: null,
    track: null,
    status: 'idle',
    cycle: 0,
    goal: null,
    current: { plan: null, story: null, stage: 'idle' },
    findings: [],
    no_progress_count: 0,
    history: [],
    halt_reason: null,
    updated_at: now.toISOString(),
  }
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd engine && npx vitest run tests/schemas/state.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 8: Commit**

```bash
git add .gitignore engine/package.json engine/package-lock.json engine/tsconfig.json engine/vitest.config.ts engine/src/schemas/state.ts engine/tests/schemas/state.test.ts
git commit -m "feat(engine): scaffold package and state schema"
```

---

## Task 2: Config schema and defaults

**Files:**
- Create: `engine/src/schemas/config.ts`
- Test: `engine/tests/schemas/config.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `Track`, `Config` types; `ConfigSchema`; `TrackSchema`; `DEFAULT_TRACKS: Record<string, Track>`; `defaultConfig(verify: Verify): Config`; `Verify` type.

- [ ] **Step 1: Write the failing test**

`engine/tests/schemas/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { ConfigSchema, DEFAULT_TRACKS, defaultConfig } from '../../src/schemas/config.js'

const VERIFY = { test: 'npm test', lint: 'npm run lint', build: null }

describe('defaultConfig', () => {
  it('is schema-valid and defines only the edit track', () => {
    const config = defaultConfig(VERIFY)
    expect(ConfigSchema.parse(config)).toEqual(config)
    expect(Object.keys(config.tracks)).toEqual(['edit'])
    expect(config.autonomous).toBe(false)
  })

  it('carries the detected verify commands through', () => {
    expect(defaultConfig(VERIFY).verify).toEqual(VERIFY)
  })
})

describe('DEFAULT_TRACKS', () => {
  it('makes editor and verifier required for edit, capped at one cycle', () => {
    expect(DEFAULT_TRACKS.edit).toEqual({ required: ['editor', 'verifier'], available: [], max_cycles: 1 })
  })
})

describe('ConfigSchema', () => {
  it('applies defaults to a minimal document', () => {
    const parsed = ConfigSchema.parse({
      version: 1,
      tracks: { edit: { required: ['editor', 'verifier'], max_cycles: 1 } },
    })
    expect(parsed.autonomous).toBe(false)
    expect(parsed.limits.max_parallel_agents).toBe(4)
    expect(parsed.limits.no_progress_strikes).toBe(2)
    expect(parsed.gates.plan_approval).toBe('human')
    expect(parsed.custom_dirs.agents).toBe('.loop/agents')
    expect(parsed.tracks.edit?.available).toEqual([])
  })

  it('rejects a track whose required set is empty', () => {
    const bad = { version: 1, tracks: { edit: { required: [], max_cycles: 1 } } }
    expect(ConfigSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects max_cycles below 1', () => {
    const bad = { version: 1, tracks: { edit: { required: ['editor'], max_cycles: 0 } } }
    expect(ConfigSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects an unknown specialist mode', () => {
    const bad = {
      version: 1,
      tracks: { edit: { required: ['editor'], max_cycles: 1 } },
      specialists: { security: 'sometimes' },
    }
    expect(ConfigSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects an unknown top-level key', () => {
    const bad = { version: 1, tracks: { edit: { required: ['editor'], max_cycles: 1 } }, extra: 1 }
    expect(ConfigSchema.safeParse(bad).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/schemas/config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`engine/src/schemas/config.ts`:

```ts
import * as z from 'zod'

export const SpecialistModeSchema = z.enum(['auto', 'always', 'never'])

export const TrackSchema = z.strictObject({
  /** Agents the leader may never drop from a cycle. */
  required: z.array(z.string().min(1)).min(1),
  /** Agents the leader may draft when the task calls for them. */
  available: z.array(z.string().min(1)).default([]),
  max_cycles: z.number().int().positive(),
})

export const VerifySchema = z.strictObject({
  test: z.string().min(1).nullable().default(null),
  lint: z.string().min(1).nullable().default(null),
  build: z.string().min(1).nullable().default(null),
})

export const ConfigSchema = z.strictObject({
  version: z.literal(1),
  autonomous: z.boolean().default(false),
  limits: z
    .strictObject({
      max_parallel_agents: z.number().int().positive().default(4),
      no_progress_strikes: z.number().int().positive().default(2),
    })
    .default({ max_parallel_agents: 4, no_progress_strikes: 2 }),
  verify: VerifySchema.default({ test: null, lint: null, build: null }),
  tracks: z.record(z.string().min(1), TrackSchema),
  specialists: z.record(z.string().min(1), SpecialistModeSchema).default({}),
  gates: z
    .strictObject({
      plan_approval: z.enum(['human', 'auto']).default('human'),
      commit: z.enum(['auto', 'human']).default('auto'),
    })
    .default({ plan_approval: 'human', commit: 'auto' }),
  custom_dirs: z
    .strictObject({
      agents: z.string().min(1).default('.loop/agents'),
      skills: z.string().min(1).default('.loop/skills'),
    })
    .default({ agents: '.loop/agents', skills: '.loop/skills' }),
})

export type SpecialistMode = z.infer<typeof SpecialistModeSchema>
export type Track = z.infer<typeof TrackSchema>
export type Verify = z.infer<typeof VerifySchema>
export type Config = z.infer<typeof ConfigSchema>

/**
 * Tracks shipped in milestone 1. Further tracks are appended by their own
 * milestones; a track is data, so adding one touches no code.
 */
export const DEFAULT_TRACKS: Record<string, Track> = {
  edit: { required: ['editor', 'verifier'], available: [], max_cycles: 1 },
}

export function defaultConfig(verify: Verify): Config {
  return ConfigSchema.parse({ version: 1, verify, tracks: DEFAULT_TRACKS })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd engine && npx vitest run tests/schemas/config.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add engine/src/schemas/config.ts engine/tests/schemas/config.test.ts
git commit -m "feat(engine): add config schema with track rosters"
```

---

## Task 3: Agent contract and roster schemas

**Files:**
- Create: `engine/src/schemas/contract.ts`, `engine/src/schemas/index.ts`
- Test: `engine/tests/schemas/contract.test.ts`

**Interfaces:**
- Consumes: `FindingSchema`, `ResultSchema` from `engine/src/schemas/state.ts`.
- Produces: `Evidence`, `AgentResult`, `Roster` types; `EvidenceSchema`, `AgentResultSchema`, `RosterSchema`; `parseAgentResult(input: unknown): { ok: true; value: AgentResult } | { ok: false; error: string }`.

- [ ] **Step 1: Write the failing test**

`engine/tests/schemas/contract.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/schemas/contract.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`engine/src/schemas/contract.ts`:

```ts
import * as z from 'zod'
import { FindingSchema, ResultSchema } from './state.js'

export const EvidenceSchema = z.strictObject({
  kind: z.enum(['command', 'file', 'test']),
  ref: z.string().min(1),
  excerpt: z.string(),
})

/** The single shape every loop agent must return. */
export const AgentResultSchema = z.strictObject({
  status: ResultSchema,
  summary: z.string().min(1),
  evidence: z.array(EvidenceSchema),
  findings: z.array(FindingSchema),
  files_touched: z.array(z.string().min(1)),
  next_hint: z.string().min(1).nullable().default(null),
})

/** The leader's declared cycle composition. */
export const RosterSchema = z.strictObject({
  cycle: z.number().int().positive(),
  selected: z.array(z.string().min(1)).min(1),
  /** agent name -> why omitting it was safe */
  skipped: z.record(z.string().min(1), z.string().min(1)).default({}),
})

export type Evidence = z.infer<typeof EvidenceSchema>
export type AgentResult = z.infer<typeof AgentResultSchema>
export type Roster = z.infer<typeof RosterSchema>

export type ParseOutcome<T> = { ok: true; value: T } | { ok: false; error: string }

/**
 * Parse an agent's return value. The caller gives the error text back to the
 * agent as a single corrective retry rather than failing the whole loop.
 */
export function parseAgentResult(input: unknown): ParseOutcome<AgentResult> {
  const parsed = AgentResultSchema.safeParse(input)
  if (parsed.success) return { ok: true, value: parsed.data }
  return { ok: false, error: z.prettifyError(parsed.error) }
}
```

`engine/src/schemas/index.ts`:

```ts
export * from './state.js'
export * from './config.js'
export * from './contract.js'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd engine && npx vitest run tests/schemas/contract.test.ts`
Expected: PASS — 12 tests.

- [ ] **Step 5: Commit**

```bash
git add engine/src/schemas/contract.ts engine/src/schemas/index.ts engine/tests/schemas/contract.test.ts
git commit -m "feat(engine): add agent contract and roster schemas"
```

---

## Task 4: Paths, atomic writes, and backup recovery

**Files:**
- Create: `engine/src/store/paths.ts`, `engine/src/store/atomic.ts`
- Create: `engine/tests/helpers/tmp-project.ts`
- Test: `engine/tests/store/atomic.test.ts`

**Interfaces:**
- Consumes: `StateSchema`, `initialState` from Task 1.
- Produces: `LoopPaths`, `resolveLoopPaths(projectDir)`, `PROTECTED_BASENAMES`; `writeJsonAtomic(file, data, opts?)`, `readJsonValidated(file, schema)`, `StateCorruptedError`; test helper `makeTmpProject()`.

- [ ] **Step 1: Write the test helper**

`engine/tests/helpers/tmp-project.ts`:

```ts
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export interface TmpProject {
  dir: string
  cleanup: () => Promise<void>
}

/** A throwaway directory standing in for a host project. */
export async function makeTmpProject(files: Record<string, string> = {}): Promise<TmpProject> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'loop-test-'))
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(dir, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, contents, 'utf8')
  }
  return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) }
}
```

- [ ] **Step 2: Write the failing test**

`engine/tests/store/atomic.test.ts`:

```ts
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StateCorruptedError, readJsonValidated, writeJsonAtomic } from '../../src/store/atomic.js'
import { StateSchema, initialState } from '../../src/schemas/state.js'
import { resolveLoopPaths } from '../../src/store/paths.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-26T10:36:00.000Z')
let project: TmpProject

beforeEach(async () => { project = await makeTmpProject() })
afterEach(async () => { await project.cleanup() })

describe('resolveLoopPaths', () => {
  it('places every artefact under .loop', () => {
    const paths = resolveLoopPaths('/tmp/demo')
    expect(paths.root).toBe('/tmp/demo/.loop')
    expect(paths.state).toBe('/tmp/demo/.loop/state.json')
    expect(paths.config).toBe('/tmp/demo/.loop/config.yaml')
    expect(paths.runs).toBe('/tmp/demo/.loop/runs')
    expect(paths.lock).toBe('/tmp/demo/.loop/.lock')
  })
})

describe('writeJsonAtomic', () => {
  it('creates missing parent directories', async () => {
    const file = path.join(project.dir, 'a/b/c.json')
    await writeJsonAtomic(file, { ok: true })
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ ok: true })
  })

  it('leaves no temp files behind', async () => {
    const file = path.join(project.dir, 'x.json')
    await writeJsonAtomic(file, { n: 1 })
    const entries = await fs.readdir(project.dir)
    expect(entries.filter((e) => e.includes('.tmp'))).toEqual([])
  })

  it('backs up the previous contents before overwriting', async () => {
    const file = path.join(project.dir, 'x.json')
    await writeJsonAtomic(file, { n: 1 })
    await writeJsonAtomic(file, { n: 2 })
    expect(JSON.parse(await fs.readFile(`${file}.bak`, 'utf8'))).toEqual({ n: 1 })
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ n: 2 })
  })

  it('skips the backup when asked', async () => {
    const file = path.join(project.dir, 'x.json')
    await writeJsonAtomic(file, { n: 1 })
    await writeJsonAtomic(file, { n: 2 }, { backup: false })
    await expect(fs.access(`${file}.bak`)).rejects.toThrow()
  })
})

describe('readJsonValidated', () => {
  it('returns the parsed value when the file is sound', async () => {
    const paths = resolveLoopPaths(project.dir)
    const state = initialState(NOW)
    await writeJsonAtomic(paths.state, state)
    const result = await readJsonValidated(paths.state, StateSchema)
    expect(result.value).toEqual(state)
    expect(result.recovered).toBe(false)
  })

  it('recovers from .bak when the primary file is unparseable', async () => {
    const paths = resolveLoopPaths(project.dir)
    const good = initialState(NOW)
    await writeJsonAtomic(paths.state, good)
    await writeJsonAtomic(paths.state, { ...good, cycle: 5 })
    await fs.writeFile(paths.state, '{ this is not json', 'utf8')

    const result = await readJsonValidated(paths.state, StateSchema)
    expect(result.recovered).toBe(true)
    expect(result.value.cycle).toBe(0)
    // recovery must not overwrite the good backup with the corrupt file
    expect(JSON.parse(await fs.readFile(`${paths.state}.bak`, 'utf8')).cycle).toBe(0)
    // the primary file is repaired in place
    expect(JSON.parse(await fs.readFile(paths.state, 'utf8')).cycle).toBe(0)
  })

  it('recovers from .bak when the primary file fails schema validation', async () => {
    const paths = resolveLoopPaths(project.dir)
    await writeJsonAtomic(paths.state, initialState(NOW))
    await fs.writeFile(paths.state, JSON.stringify({ schema: 1 }), 'utf8')
    const result = await readJsonValidated(paths.state, StateSchema)
    expect(result.recovered).toBe(true)
  })

  it('throws StateCorruptedError when neither file is usable', async () => {
    const paths = resolveLoopPaths(project.dir)
    await fs.mkdir(paths.root, { recursive: true })
    await fs.writeFile(paths.state, 'garbage', 'utf8')
    await expect(readJsonValidated(paths.state, StateSchema)).rejects.toBeInstanceOf(StateCorruptedError)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/store/atomic.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Write the implementation**

`engine/src/store/paths.ts`:

```ts
import path from 'node:path'

export interface LoopPaths {
  root: string
  config: string
  state: string
  index: string
  designSystem: string
  plans: string
  runs: string
  memory: string
  lock: string
}

export function resolveLoopPaths(projectDir: string): LoopPaths {
  const root = path.join(projectDir, '.loop')
  return {
    root,
    config: path.join(root, 'config.yaml'),
    state: path.join(root, 'state.json'),
    index: path.join(root, 'INDEX.md'),
    designSystem: path.join(root, 'design-system.md'),
    plans: path.join(root, 'plans'),
    runs: path.join(root, 'runs'),
    memory: path.join(root, 'memory'),
    lock: path.join(root, '.lock'),
  }
}

/** Files only the engine may write. The PreToolUse hook denies edits to these. */
export const PROTECTED_BASENAMES = ['state.json', 'manifest.json'] as const
```

`engine/src/store/atomic.ts`:

```ts
import fs from 'node:fs/promises'
import path from 'node:path'
import * as z from 'zod'

export class StateCorruptedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StateCorruptedError'
  }
}

export interface WriteOptions {
  /** Copy the existing file to `<file>.bak` first. Default true. */
  backup?: boolean
}

export async function writeJsonAtomic(file: string, data: unknown, options: WriteOptions = {}): Promise<void> {
  const { backup = true } = options
  await fs.mkdir(path.dirname(file), { recursive: true })
  if (backup) {
    try {
      await fs.copyFile(file, `${file}.bak`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const temp = `${file}.${process.pid}.tmp`
  await fs.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  await fs.rename(temp, file)
}

export interface ReadResult<T> {
  value: T
  /** True when the primary file was unusable and `.bak` was restored. */
  recovered: boolean
}

export async function readJsonValidated<T>(file: string, schema: z.ZodType<T>): Promise<ReadResult<T>> {
  try {
    return { value: await parseFile(file, schema), recovered: false }
  } catch (primaryError) {
    let value: T
    try {
      value = await parseFile(`${file}.bak`, schema)
    } catch {
      throw new StateCorruptedError(
        `${file} is unusable and no valid backup exists: ${(primaryError as Error).message}`,
      )
    }
    // backup:false — the corrupt primary must never become the new backup.
    await writeJsonAtomic(file, value, { backup: false })
    return { value, recovered: true }
  }
}

async function parseFile<T>(file: string, schema: z.ZodType<T>): Promise<T> {
  const raw = await fs.readFile(file, 'utf8')
  const parsed = schema.safeParse(JSON.parse(raw) as unknown)
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error))
  return parsed.data
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd engine && npx vitest run tests/store/atomic.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 6: Commit**

```bash
git add engine/src/store/paths.ts engine/src/store/atomic.ts engine/tests/helpers/tmp-project.ts engine/tests/store/atomic.test.ts
git commit -m "feat(engine): add atomic json store with backup recovery"
```

---

## Task 5: Write lock

**Files:**
- Create: `engine/src/store/lock.ts`
- Test: `engine/tests/store/lock.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `withLock<T>(lockDir, fn, options?)`, `LockTimeoutError`, `LockOptions`.

- [ ] **Step 1: Write the failing test**

`engine/tests/store/lock.test.ts`:

```ts
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LockTimeoutError, withLock } from '../../src/store/lock.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

let project: TmpProject
let lockDir: string

beforeEach(async () => {
  project = await makeTmpProject()
  lockDir = path.join(project.dir, '.lock')
})
afterEach(async () => { await project.cleanup() })

describe('withLock', () => {
  it('returns the callback result and releases the lock', async () => {
    const result = await withLock(lockDir, async () => 42)
    expect(result).toBe(42)
    await expect(fs.access(lockDir)).rejects.toThrow()
  })

  it('releases the lock even when the callback throws', async () => {
    await expect(withLock(lockDir, async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(fs.access(lockDir)).rejects.toThrow()
  })

  it('serialises concurrent writers', async () => {
    const order: string[] = []
    const slow = withLock(lockDir, async () => {
      order.push('a-start')
      await new Promise((resolve) => setTimeout(resolve, 60))
      order.push('a-end')
    })
    const fast = withLock(lockDir, async () => { order.push('b') }, { pollMs: 5 })
    await Promise.all([slow, fast])
    expect(order).toEqual(['a-start', 'a-end', 'b'])
  })

  it('times out when the lock is held too long', async () => {
    await fs.mkdir(lockDir)
    await expect(
      withLock(lockDir, async () => 'never', { timeoutMs: 60, pollMs: 5, staleMs: 60_000 }),
    ).rejects.toBeInstanceOf(LockTimeoutError)
    await fs.rm(lockDir, { recursive: true, force: true })
  })

  it('reclaims a stale lock left by a dead process', async () => {
    await fs.mkdir(lockDir)
    const result = await withLock(lockDir, async () => 'reclaimed', { staleMs: 0, pollMs: 5, timeoutMs: 500 })
    expect(result).toBe('reclaimed')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/store/lock.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`engine/src/store/lock.ts`:

```ts
import fs from 'node:fs/promises'

export class LockTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LockTimeoutError'
  }
}

export interface LockOptions {
  /** How long to wait for the lock before giving up. Default 5000ms. */
  timeoutMs?: number
  /** A lock older than this is assumed abandoned and reclaimed. Default 30000ms. */
  staleMs?: number
  /** Retry interval. Default 25ms. */
  pollMs?: number
}

/**
 * Directory-based mutual exclusion. `mkdir` is atomic on every supported
 * filesystem, which is what keeps parallel agents from interleaving writes.
 */
export async function withLock<T>(lockDir: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const { timeoutMs = 5000, staleMs = 30_000, pollMs = 25 } = options
  const deadline = Date.now() + timeoutMs

  for (;;) {
    try {
      await fs.mkdir(lockDir, { recursive: false })
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const age = await lockAgeMs(lockDir)
      if (age !== null && age >= staleMs) {
        await fs.rm(lockDir, { recursive: true, force: true })
        continue
      }
      if (Date.now() >= deadline) {
        throw new LockTimeoutError(`could not acquire ${lockDir} within ${timeoutMs}ms`)
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  }

  try {
    return await fn()
  } finally {
    await fs.rm(lockDir, { recursive: true, force: true })
  }
}

async function lockAgeMs(lockDir: string): Promise<number | null> {
  try {
    const stats = await fs.stat(lockDir)
    return Date.now() - stats.mtimeMs
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd engine && npx vitest run tests/store/lock.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add engine/src/store/lock.ts engine/tests/store/lock.test.ts
git commit -m "feat(engine): add directory-based write lock"
```

---

## Task 6: StateStore and config store

**Files:**
- Create: `engine/src/store/state-store.ts`, `engine/src/store/config-store.ts`
- Test: `engine/tests/store/state-store.test.ts`, `engine/tests/store/config-store.test.ts`

**Interfaces:**
- Consumes: `StateSchema`, `State`, `initialState` (Task 1); `ConfigSchema`, `Config` (Task 2); `resolveLoopPaths`, `writeJsonAtomic`, `readJsonValidated` (Task 4); `withLock` (Task 5).
- Produces: `Clock = () => Date`; `class StateStore { constructor(projectDir: string, now?: Clock); get(): Promise<State>; update(mutate: (draft: State) => void): Promise<State> }`; `InvalidStateError`; `loadConfig(projectDir): Promise<Config>`; `writeConfig(projectDir, config): Promise<void>`; `ConfigMissingError`.

- [ ] **Step 1: Write the failing tests**

`engine/tests/store/state-store.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InvalidStateError, StateStore } from '../../src/store/state-store.js'
import { initialState } from '../../src/schemas/state.js'
import { resolveLoopPaths } from '../../src/store/paths.js'
import { writeJsonAtomic } from '../../src/store/atomic.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const CREATED = new Date('2026-07-26T10:00:00.000Z')
const UPDATED = new Date('2026-07-26T11:00:00.000Z')

let project: TmpProject
let store: StateStore

beforeEach(async () => {
  project = await makeTmpProject()
  await writeJsonAtomic(resolveLoopPaths(project.dir).state, initialState(CREATED))
  store = new StateStore(project.dir, () => UPDATED)
})
afterEach(async () => { await project.cleanup() })

describe('StateStore.get', () => {
  it('reads the persisted state', async () => {
    const state = await store.get()
    expect(state.status).toBe('idle')
    expect(state.updated_at).toBe(CREATED.toISOString())
  })
})

describe('StateStore.update', () => {
  it('applies the mutation and stamps updated_at from the clock', async () => {
    const state = await store.update((draft) => {
      draft.status = 'running'
      draft.cycle = 1
      draft.track = 'edit'
    })
    expect(state.status).toBe('running')
    expect(state.updated_at).toBe(UPDATED.toISOString())
    expect((await store.get()).cycle).toBe(1)
  })

  it('rejects a mutation that violates the schema and leaves state untouched', async () => {
    await expect(
      store.update((draft) => {
        draft.cycle = -3
      }),
    ).rejects.toBeInstanceOf(InvalidStateError)
    expect((await store.get()).cycle).toBe(0)
  })

  it('does not let a mutation observe another update mid-flight', async () => {
    await Promise.all([
      store.update((draft) => { draft.cycle += 1 }),
      store.update((draft) => { draft.cycle += 1 }),
      store.update((draft) => { draft.cycle += 1 }),
    ])
    expect((await store.get()).cycle).toBe(3)
  })
})
```

`engine/tests/store/config-store.test.ts`:

```ts
import fs from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigMissingError, loadConfig, writeConfig } from '../../src/store/config-store.js'
import { defaultConfig } from '../../src/schemas/config.js'
import { resolveLoopPaths } from '../../src/store/paths.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

let project: TmpProject
beforeEach(async () => { project = await makeTmpProject() })
afterEach(async () => { await project.cleanup() })

describe('writeConfig / loadConfig', () => {
  it('round-trips a config through YAML', async () => {
    const config = defaultConfig({ test: 'npm test', lint: null, build: null })
    await writeConfig(project.dir, config)
    expect(await loadConfig(project.dir)).toEqual(config)
  })

  it('writes readable YAML, not JSON', async () => {
    await writeConfig(project.dir, defaultConfig({ test: null, lint: null, build: null }))
    const raw = await fs.readFile(resolveLoopPaths(project.dir).config, 'utf8')
    expect(raw).toContain('version: 1')
    expect(raw).toContain('tracks:')
    expect(raw.trimStart().startsWith('{')).toBe(false)
  })

  it('throws ConfigMissingError when .loop is not provisioned', async () => {
    await expect(loadConfig(project.dir)).rejects.toBeInstanceOf(ConfigMissingError)
  })

  it('throws a readable error for an invalid config', async () => {
    const paths = resolveLoopPaths(project.dir)
    await fs.mkdir(paths.root, { recursive: true })
    await fs.writeFile(paths.config, 'version: 1\ntracks: {}\nmystery: true\n', 'utf8')
    await expect(loadConfig(project.dir)).rejects.toThrow(/mystery/)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd engine && npx vitest run tests/store/state-store.test.ts tests/store/config-store.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the implementation**

`engine/src/store/state-store.ts`:

```ts
import * as z from 'zod'
import { StateSchema, type State } from '../schemas/state.js'
import { readJsonValidated, writeJsonAtomic } from './atomic.js'
import { withLock } from './lock.js'
import { resolveLoopPaths, type LoopPaths } from './paths.js'

export type Clock = () => Date

export class InvalidStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidStateError'
  }
}

/**
 * The only writer of `.loop/state.json`. Every mutation runs under the write
 * lock, is validated before it lands, and is written atomically.
 */
export class StateStore {
  private readonly paths: LoopPaths

  constructor(projectDir: string, private readonly now: Clock = () => new Date()) {
    this.paths = resolveLoopPaths(projectDir)
  }

  async get(): Promise<State> {
    const { value } = await readJsonValidated(this.paths.state, StateSchema)
    return value
  }

  async update(mutate: (draft: State) => void): Promise<State> {
    return withLock(this.paths.lock, async () => {
      const { value } = await readJsonValidated(this.paths.state, StateSchema)
      const draft = structuredClone(value)
      mutate(draft)
      draft.updated_at = this.now().toISOString()

      const parsed = StateSchema.safeParse(draft)
      if (!parsed.success) throw new InvalidStateError(z.prettifyError(parsed.error))

      await writeJsonAtomic(this.paths.state, parsed.data)
      return parsed.data
    })
  }
}
```

`engine/src/store/config-store.ts`:

```ts
import fs from 'node:fs/promises'
import path from 'node:path'
import * as YAML from 'yaml'
import * as z from 'zod'
import { ConfigSchema, type Config } from '../schemas/config.js'
import { resolveLoopPaths } from './paths.js'

export class ConfigMissingError extends Error {
  constructor(file: string) {
    super(`${file} not found — run /loop:init first`)
    this.name = 'ConfigMissingError'
  }
}

export async function loadConfig(projectDir: string): Promise<Config> {
  const file = resolveLoopPaths(projectDir).config
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ConfigMissingError(file)
    throw error
  }
  const parsed = ConfigSchema.safeParse(YAML.parse(raw) as unknown)
  if (!parsed.success) throw new Error(`${file} is invalid:\n${z.prettifyError(parsed.error)}`)
  return parsed.data
}

export async function writeConfig(projectDir: string, config: Config): Promise<void> {
  const file = resolveLoopPaths(projectDir).config
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, YAML.stringify(config, { lineWidth: 100 }), 'utf8')
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd engine && npx vitest run tests/store/`
Expected: PASS — all store tests green (18 total).

- [ ] **Step 5: Commit**

```bash
git add engine/src/store/state-store.ts engine/src/store/config-store.ts engine/tests/store/state-store.test.ts engine/tests/store/config-store.test.ts
git commit -m "feat(engine): add locked state store and yaml config store"
```

---

## Task 7: `initLoop` — provisioning and verify detection

**Files:**
- Create: `engine/src/ops/init.ts`
- Test: `engine/tests/ops/init.test.ts`

**Interfaces:**
- Consumes: `initialState` (Task 1); `defaultConfig`, `Verify` (Task 2); `resolveLoopPaths`, `writeJsonAtomic` (Task 4); `writeConfig` (Task 6).
- Produces: `detectVerifyCommands(projectDir): Promise<Verify>`; `initLoop(projectDir, now?): Promise<InitResult>` where `InitResult = { created: string[]; verify: Verify; alreadyInitialised: boolean }`; `CLAUDE_MD_SECTION: string`; `ensureClaudeMdSection(projectDir): Promise<boolean>`.

- [ ] **Step 1: Write the failing test**

`engine/tests/ops/init.test.ts`:

```ts
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CLAUDE_MD_SECTION, detectVerifyCommands, initLoop } from '../../src/ops/init.js'
import { loadConfig } from '../../src/store/config-store.js'
import { StateStore } from '../../src/store/state-store.js'
import { resolveLoopPaths } from '../../src/store/paths.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-26T10:36:00.000Z')
const PKG = JSON.stringify({
  name: 'tiny',
  scripts: { test: 'vitest run', lint: 'eslint .', dev: 'vite' },
})

let project: TmpProject
afterEach(async () => { await project.cleanup() })

describe('detectVerifyCommands', () => {
  it('maps package.json scripts to npm commands', async () => {
    project = await makeTmpProject({ 'package.json': PKG })
    expect(await detectVerifyCommands(project.dir)).toEqual({
      test: 'npm test',
      lint: 'npm run lint',
      build: null,
    })
  })

  it('returns all nulls when there is no package.json', async () => {
    project = await makeTmpProject()
    expect(await detectVerifyCommands(project.dir)).toEqual({ test: null, lint: null, build: null })
  })

  it('returns all nulls when package.json is unparseable', async () => {
    project = await makeTmpProject({ 'package.json': '{ broken' })
    expect(await detectVerifyCommands(project.dir)).toEqual({ test: null, lint: null, build: null })
  })
})

describe('initLoop', () => {
  it('provisions .loop with a valid state and config', async () => {
    project = await makeTmpProject({ 'package.json': PKG })
    const result = await initLoop(project.dir, () => NOW)

    expect(result.alreadyInitialised).toBe(false)
    expect(result.verify.test).toBe('npm test')

    const paths = resolveLoopPaths(project.dir)
    for (const dir of [paths.root, paths.plans, paths.runs, paths.memory]) {
      expect((await fs.stat(dir)).isDirectory()).toBe(true)
    }

    const state = await new StateStore(project.dir).get()
    expect(state.status).toBe('idle')
    expect(state.updated_at).toBe(NOW.toISOString())

    const config = await loadConfig(project.dir)
    expect(config.tracks.edit?.required).toEqual(['editor', 'verifier'])
  })

  it('appends the loop section to an existing CLAUDE.md exactly once', async () => {
    project = await makeTmpProject({ 'CLAUDE.md': '# Tiny\n\nExisting notes.\n' })
    await initLoop(project.dir, () => NOW)
    await initLoop(project.dir, () => NOW)

    const claudeMd = await fs.readFile(path.join(project.dir, 'CLAUDE.md'), 'utf8')
    expect(claudeMd).toContain('Existing notes.')
    expect(claudeMd.split(CLAUDE_MD_SECTION).length - 1).toBe(1)
  })

  it('creates CLAUDE.md when the project has none', async () => {
    project = await makeTmpProject()
    await initLoop(project.dir, () => NOW)
    const claudeMd = await fs.readFile(path.join(project.dir, 'CLAUDE.md'), 'utf8')
    expect(claudeMd).toContain(CLAUDE_MD_SECTION)
  })

  it('is idempotent and never clobbers existing state', async () => {
    project = await makeTmpProject({ 'package.json': PKG })
    await initLoop(project.dir, () => NOW)
    await new StateStore(project.dir, () => NOW).update((draft) => {
      draft.status = 'running'
      draft.cycle = 1
      draft.track = 'edit'
    })

    const second = await initLoop(project.dir, () => NOW)
    expect(second.alreadyInitialised).toBe(true)
    expect(second.created).toEqual([])
    expect((await new StateStore(project.dir).get()).status).toBe('running')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/ops/init.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`engine/src/ops/init.ts`:

```ts
import fs from 'node:fs/promises'
import path from 'node:path'
import { defaultConfig, type Verify } from '../schemas/config.js'
import { initialState } from '../schemas/state.js'
import { writeJsonAtomic } from '../store/atomic.js'
import { writeConfig } from '../store/config-store.js'
import { resolveLoopPaths } from '../store/paths.js'
import type { Clock } from '../store/state-store.js'

export const CLAUDE_MD_SECTION = '## Loop'

const CLAUDE_MD_BLOCK = `${CLAUDE_MD_SECTION}

This project uses the \`loop\` plugin. Execution state lives in \`.loop/\`.

- \`/loop:edit <request>\` — small, well-scoped change (one cycle)
- \`/loop:status\` — current track, cycle, and latest evidence

\`.loop/state.json\` is owned by the loop MCP server. Never edit it by hand.
`

export interface InitResult {
  /** Paths created by this call, relative to the project root. */
  created: string[]
  verify: Verify
  alreadyInitialised: boolean
}

/** Read verify commands off package.json scripts. Absent script -> null. */
export async function detectVerifyCommands(projectDir: string): Promise<Verify> {
  const empty: Verify = { test: null, lint: null, build: null }
  let scripts: Record<string, unknown>
  try {
    const raw = await fs.readFile(path.join(projectDir, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> }
    scripts = parsed.scripts ?? {}
  } catch {
    return empty
  }
  return {
    test: typeof scripts.test === 'string' ? 'npm test' : null,
    lint: typeof scripts.lint === 'string' ? 'npm run lint' : null,
    build: typeof scripts.build === 'string' ? 'npm run build' : null,
  }
}

export async function initLoop(projectDir: string, now: Clock = () => new Date()): Promise<InitResult> {
  const paths = resolveLoopPaths(projectDir)
  const verify = await detectVerifyCommands(projectDir)

  if (await exists(paths.state)) {
    await ensureClaudeMdSection(projectDir)
    return { created: [], verify, alreadyInitialised: true }
  }

  const created: string[] = []
  for (const dir of [paths.root, paths.plans, paths.runs, paths.memory]) {
    await fs.mkdir(dir, { recursive: true })
    created.push(path.relative(projectDir, dir))
  }

  await writeJsonAtomic(paths.state, initialState(now()))
  created.push(path.relative(projectDir, paths.state))

  await writeConfig(projectDir, defaultConfig(verify))
  created.push(path.relative(projectDir, paths.config))

  if (await ensureClaudeMdSection(projectDir)) created.push('CLAUDE.md')

  return { created, verify, alreadyInitialised: false }
}

/** Append the loop section to CLAUDE.md unless it is already there. */
export async function ensureClaudeMdSection(projectDir: string): Promise<boolean> {
  const file = path.join(projectDir, 'CLAUDE.md')
  let existing = ''
  try {
    existing = await fs.readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (existing.includes(CLAUDE_MD_SECTION)) return false

  const separator = existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
  await fs.writeFile(file, `${existing}${separator}${CLAUDE_MD_BLOCK}`, 'utf8')
  return true
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd engine && npx vitest run tests/ops/init.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add engine/src/ops/init.ts engine/tests/ops/init.test.ts
git commit -m "feat(engine): add loop provisioning with verify detection"
```

---

## Task 8: Run lifecycle — `runStart`, `cycleAdvance`, `halt`

**Files:**
- Create: `engine/src/ops/run.ts`
- Test: `engine/tests/ops/run.test.ts`

**Interfaces:**
- Consumes: `State`, `Result` (Task 1); `loadConfig` (Task 6); `StateStore`, `Clock` (Task 6); `resolveLoopPaths` (Task 4); `initLoop` (Task 7).
- Produces:
  - `runDirName(state: State): string`
  - `runDirPath(projectDir: string, state: State): string`
  - `runStart(projectDir, input: { track: string; goal: string; story?: string | null; plan?: string | null }, now?): Promise<State>`
  - `cycleAdvance(projectDir, input: { agents: string[]; result: Result }, now?): Promise<State>`
  - `halt(projectDir, reason: string, now?): Promise<State>`
  - `UnknownTrackError`, `NoActiveRunError`

- [ ] **Step 1: Write the failing test**

`engine/tests/ops/run.test.ts`:

```ts
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NoActiveRunError, UnknownTrackError, cycleAdvance, halt, runDirName, runDirPath, runStart } from '../../src/ops/run.js'
import { initLoop } from '../../src/ops/init.js'
import { StateStore } from '../../src/store/state-store.js'
import { loadConfig, writeConfig } from '../../src/store/config-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-26T10:36:00.000Z')
const clock = () => NOW

let project: TmpProject

beforeEach(async () => {
  project = await makeTmpProject({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) })
  await initLoop(project.dir, clock)
})
afterEach(async () => { await project.cleanup() })

describe('runStart', () => {
  it('opens a run and creates its directory', async () => {
    const state = await runStart(project.dir, { track: 'edit', goal: 'Rename submit label' }, clock)

    expect(state.run_id).toBe('2026-07-26-001')
    expect(state.track).toBe('edit')
    expect(state.status).toBe('running')
    expect(state.cycle).toBe(1)
    expect(state.current.stage).toBe('compose')
    expect(state.goal).toBe('Rename submit label')
    expect(runDirName(state)).toBe('2026-07-26-001--adhoc--edit')
    expect((await fs.stat(runDirPath(project.dir, state))).isDirectory()).toBe(true)
  })

  it('names the run directory after the story when there is one', async () => {
    const state = await runStart(
      project.dir,
      { track: 'edit', goal: 'Fix label', plan: 'P001', story: 'P001-S02' },
      clock,
    )
    expect(runDirName(state)).toBe('2026-07-26-001--P001-S02--edit')
    expect(state.current.story).toBe('P001-S02')
    expect(state.current.plan).toBe('P001')
  })

  it('increments the daily sequence number', async () => {
    await runStart(project.dir, { track: 'edit', goal: 'First' }, clock)
    const second = await runStart(project.dir, { track: 'edit', goal: 'Second' }, clock)
    expect(second.run_id).toBe('2026-07-26-002')
  })

  it('clears findings and history from the previous run', async () => {
    await runStart(project.dir, { track: 'edit', goal: 'First' }, clock)
    await cycleAdvance(project.dir, { agents: ['editor', 'verifier'], result: 'pass' }, clock)
    const second = await runStart(project.dir, { track: 'edit', goal: 'Second' }, clock)
    expect(second.history).toEqual([])
    expect(second.findings).toEqual([])
    expect(second.halt_reason).toBeNull()
  })

  it('rejects a track that is not in config', async () => {
    await expect(runStart(project.dir, { track: 'ghost', goal: 'x' }, clock)).rejects.toBeInstanceOf(UnknownTrackError)
  })
})

describe('cycleAdvance', () => {
  it('records the cycle and finishes the run on pass', async () => {
    await runStart(project.dir, { track: 'edit', goal: 'Rename' }, clock)
    const state = await cycleAdvance(project.dir, { agents: ['editor', 'verifier'], result: 'pass' }, clock)

    expect(state.status).toBe('done')
    expect(state.current.stage).toBe('done')
    expect(state.cycle).toBe(1)
    expect(state.history).toEqual([
      { cycle: 1, agents: ['editor', 'verifier'], result: 'pass', ref: '.loop/runs/2026-07-26-001--adhoc--edit' },
    ])
  })

  it('halts with a cycle-cap reason when the track cap is reached', async () => {
    await runStart(project.dir, { track: 'edit', goal: 'Rename' }, clock)
    const state = await cycleAdvance(project.dir, { agents: ['editor', 'verifier'], result: 'fail' }, clock)

    expect(state.status).toBe('halted')
    expect(state.current.stage).toBe('halted')
    expect(state.halt_reason).toBe('cycle cap 1 reached for track edit')

    const haltFile = path.join(runDirPath(project.dir, state), 'HALT.md')
    const report = await fs.readFile(haltFile, 'utf8')
    expect(report).toContain('cycle cap 1 reached for track edit')
    expect(report).toContain('editor, verifier')
  })

  it('opens the next cycle when the cap allows it', async () => {
    const config = await loadConfig(project.dir)
    config.tracks.edit = { required: ['editor', 'verifier'], available: [], max_cycles: 3 }
    await writeConfig(project.dir, config)

    await runStart(project.dir, { track: 'edit', goal: 'Rename' }, clock)
    const state = await cycleAdvance(project.dir, { agents: ['editor', 'verifier'], result: 'fail' }, clock)

    expect(state.status).toBe('running')
    expect(state.cycle).toBe(2)
    expect(state.current.stage).toBe('compose')
    expect(state.history).toHaveLength(1)
  })

  it('refuses to advance when no run is active', async () => {
    await expect(cycleAdvance(project.dir, { agents: ['editor'], result: 'pass' }, clock)).rejects.toBeInstanceOf(NoActiveRunError)
  })
})

describe('halt', () => {
  it('stops the run and writes a report', async () => {
    await runStart(project.dir, { track: 'edit', goal: 'Rename' }, clock)
    const state = await halt(project.dir, 'user requested stop', clock)

    expect(state.status).toBe('halted')
    expect(state.halt_reason).toBe('user requested stop')
    const report = await fs.readFile(path.join(runDirPath(project.dir, state), 'HALT.md'), 'utf8')
    expect(report).toContain('user requested stop')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/ops/run.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`engine/src/ops/run.ts`:

```ts
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Result, State } from '../schemas/state.js'
import { loadConfig } from '../store/config-store.js'
import { resolveLoopPaths } from '../store/paths.js'
import { StateStore, type Clock } from '../store/state-store.js'

export class UnknownTrackError extends Error {
  constructor(track: string, known: string[]) {
    super(`unknown track "${track}" — config defines: ${known.join(', ')}`)
    this.name = 'UnknownTrackError'
  }
}

export class NoActiveRunError extends Error {
  constructor() {
    super('no active run — call loop_run_start first')
    this.name = 'NoActiveRunError'
  }
}

/** `<run_id>--<story|adhoc>--<track>` — traceable from the directory name alone. */
export function runDirName(state: State): string {
  if (state.run_id === null || state.track === null) throw new NoActiveRunError()
  return `${state.run_id}--${state.current.story ?? 'adhoc'}--${state.track}`
}

export function runDirPath(projectDir: string, state: State): string {
  return path.join(resolveLoopPaths(projectDir).runs, runDirName(state))
}

export interface RunStartInput {
  track: string
  goal: string
  story?: string | null
  plan?: string | null
}

export async function runStart(projectDir: string, input: RunStartInput, now: Clock = () => new Date()): Promise<State> {
  const config = await loadConfig(projectDir)
  if (!(input.track in config.tracks)) {
    throw new UnknownTrackError(input.track, Object.keys(config.tracks))
  }

  const runId = await nextRunId(projectDir, now())
  const state = await new StateStore(projectDir, now).update((draft) => {
    draft.run_id = runId
    draft.track = input.track
    draft.status = 'running'
    draft.cycle = 1
    draft.goal = input.goal
    draft.current = {
      plan: input.plan ?? null,
      story: input.story ?? null,
      stage: 'compose',
    }
    draft.findings = []
    draft.history = []
    draft.no_progress_count = 0
    draft.halt_reason = null
  })

  await fs.mkdir(runDirPath(projectDir, state), { recursive: true })
  return state
}

export interface CycleAdvanceInput {
  agents: string[]
  result: Result
}

/**
 * Close the current cycle. `pass` finishes the run; anything else opens the
 * next cycle unless the track's cap is reached, in which case the run halts.
 */
export async function cycleAdvance(
  projectDir: string,
  input: CycleAdvanceInput,
  now: Clock = () => new Date(),
): Promise<State> {
  const store = new StateStore(projectDir, now)
  const before = await store.get()
  if (before.status !== 'running' || before.track === null) throw new NoActiveRunError()

  const config = await loadConfig(projectDir)
  const track = config.tracks[before.track]
  if (track === undefined) throw new UnknownTrackError(before.track, Object.keys(config.tracks))

  const ref = path.join('.loop', 'runs', runDirName(before))
  const capReached = before.cycle >= track.max_cycles
  const haltReason = `cycle cap ${track.max_cycles} reached for track ${before.track}`

  const after = await store.update((draft) => {
    draft.history.push({ cycle: draft.cycle, agents: input.agents, result: input.result, ref })
    if (input.result === 'pass') {
      draft.status = 'done'
      draft.current.stage = 'done'
      return
    }
    if (capReached) {
      draft.status = 'halted'
      draft.current.stage = 'halted'
      draft.halt_reason = haltReason
      return
    }
    draft.cycle += 1
    draft.current.stage = 'compose'
  })

  if (after.status === 'halted') await writeHaltReport(projectDir, after)
  return after
}

export async function halt(projectDir: string, reason: string, now: Clock = () => new Date()): Promise<State> {
  const store = new StateStore(projectDir, now)
  const state = await store.update((draft) => {
    draft.status = 'halted'
    draft.current.stage = 'halted'
    draft.halt_reason = reason
  })
  await writeHaltReport(projectDir, state)
  return state
}

async function nextRunId(projectDir: string, now: Date): Promise<string> {
  const date = now.toISOString().slice(0, 10)
  const runsDir = resolveLoopPaths(projectDir).runs
  let entries: string[] = []
  try {
    entries = await fs.readdir(runsDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const used = entries
    .map((entry) => new RegExp(`^${date}-(\\d{3})--`).exec(entry)?.[1])
    .filter((seq): seq is string => seq !== undefined)
    .map(Number)
  const next = used.length === 0 ? 1 : Math.max(...used) + 1
  return `${date}-${String(next).padStart(3, '0')}`
}

async function writeHaltReport(projectDir: string, state: State): Promise<void> {
  const dir = runDirPath(projectDir, state)
  await fs.mkdir(dir, { recursive: true })

  const cycles = state.history
    .map((entry) => `| ${entry.cycle} | ${entry.agents.join(', ')} | ${entry.result} |`)
    .join('\n')
  const findings = state.findings.length === 0
    ? '_none recorded_'
    : state.findings.map((f) => `- **${f.severity}** ${f.file}:${f.line} — ${f.claim}`).join('\n')

  const report = `# Halt report — ${state.run_id}

**Track:** ${state.track}
**Goal:** ${state.goal ?? '_not set_'}
**Reason:** ${state.halt_reason ?? '_not set_'}
**Halted at cycle:** ${state.cycle}

## Cycles

| Cycle | Agents | Result |
|---|---|---|
${cycles || '| — | — | — |'}

## Open findings

${findings}

## Next step

Review the per-agent output in this directory, then either widen the track's
\`max_cycles\` in \`.loop/config.yaml\` or narrow the goal and start a new run.
`
  await fs.writeFile(path.join(dir, 'HALT.md'), report, 'utf8')
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd engine && npx vitest run tests/ops/run.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: Commit**

```bash
git add engine/src/ops/run.ts engine/tests/ops/run.test.ts
git commit -m "feat(engine): add run lifecycle with cycle cap and halt report"
```

---

## Task 9: `rosterSet` — enforce the required set

**Files:**
- Create: `engine/src/ops/roster.ts`
- Test: `engine/tests/ops/roster.test.ts`

**Interfaces:**
- Consumes: `Roster`, `RosterSchema` (Task 3); `loadConfig` (Task 6); `StateStore` (Task 6); `runDirPath`, `NoActiveRunError` (Task 8).
- Produces: `rosterSet(projectDir, roster: Roster): Promise<{ path: string }>`; `RosterViolationError`.

- [ ] **Step 1: Write the failing test**

`engine/tests/ops/roster.test.ts`:

```ts
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RosterViolationError, rosterSet } from '../../src/ops/roster.js'
import { initLoop } from '../../src/ops/init.js'
import { runDirPath, runStart } from '../../src/ops/run.js'
import { StateStore } from '../../src/store/state-store.js'
import { loadConfig, writeConfig } from '../../src/store/config-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-26T10:36:00.000Z')
const clock = () => NOW

let project: TmpProject

beforeEach(async () => {
  project = await makeTmpProject()
  await initLoop(project.dir, clock)
  const config = await loadConfig(project.dir)
  config.tracks.edit = { required: ['editor', 'verifier'], available: ['scout', 'critic'], max_cycles: 3 }
  await writeConfig(project.dir, config)
  await runStart(project.dir, { track: 'edit', goal: 'Rename submit label' }, clock)
})
afterEach(async () => { await project.cleanup() })

describe('rosterSet', () => {
  it('writes roster.json into the run directory', async () => {
    const roster = {
      cycle: 1,
      selected: ['editor', 'verifier'],
      skipped: { scout: 'story references known files only', critic: 'single-file change' },
    }
    const { path: file } = await rosterSet(project.dir, roster)

    const state = await new StateStore(project.dir).get()
    expect(file).toBe(path.join(runDirPath(project.dir, state), 'roster.json'))
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(roster)
  })

  it('rejects a roster missing a required agent', async () => {
    await expect(rosterSet(project.dir, { cycle: 1, selected: ['editor'], skipped: {} })).rejects.toBeInstanceOf(
      RosterViolationError,
    )
  })

  it('names verifier explicitly when it is the omitted agent', async () => {
    await expect(rosterSet(project.dir, { cycle: 1, selected: ['editor'], skipped: {} })).rejects.toThrow(/verifier/)
  })

  it('rejects an agent that is in neither required nor available', async () => {
    const roster = { cycle: 1, selected: ['editor', 'verifier', 'invented'], skipped: {} }
    await expect(rosterSet(project.dir, roster)).rejects.toThrow(/invented/)
  })

  it('rejects a cycle number that does not match state', async () => {
    await expect(rosterSet(project.dir, { cycle: 7, selected: ['editor', 'verifier'], skipped: {} })).rejects.toThrow(
      /cycle 7/,
    )
  })

  it('rejects a roster omitting a specialist forced to always', async () => {
    const config = await loadConfig(project.dir)
    config.tracks.edit = { required: ['editor', 'verifier'], available: ['critic'], max_cycles: 3 }
    config.specialists = { critic: 'always' }
    await writeConfig(project.dir, config)

    await expect(rosterSet(project.dir, { cycle: 1, selected: ['editor', 'verifier'], skipped: {} })).rejects.toThrow(
      /critic/,
    )
  })

  it('accepts a roster that includes the forced specialist', async () => {
    const config = await loadConfig(project.dir)
    config.tracks.edit = { required: ['editor', 'verifier'], available: ['critic'], max_cycles: 3 }
    config.specialists = { critic: 'always' }
    await writeConfig(project.dir, config)

    const result = await rosterSet(project.dir, { cycle: 1, selected: ['editor', 'verifier', 'critic'], skipped: {} })
    expect(result.path).toContain('roster.json')
  })

  it('rejects an omission that has no stated reason', async () => {
    const roster = { cycle: 1, selected: ['editor', 'verifier'], skipped: {} }
    // scout and critic are available but unexplained
    await expect(rosterSet(project.dir, roster)).rejects.toThrow(/scout/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/ops/roster.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`engine/src/ops/roster.ts`:

```ts
import fs from 'node:fs/promises'
import path from 'node:path'
import { RosterSchema, type Roster } from '../schemas/contract.js'
import { loadConfig } from '../store/config-store.js'
import { StateStore } from '../store/state-store.js'
import { NoActiveRunError, UnknownTrackError, runDirPath } from './run.js'

export class RosterViolationError extends Error {
  constructor(violations: string[]) {
    super(`roster rejected:\n${violations.map((v) => `- ${v}`).join('\n')}`)
    this.name = 'RosterViolationError'
  }
}

/**
 * Persist the leader's declared cycle composition. This is the enforcement
 * point for the system's hard invariant: a track's `required` agents —
 * `verifier` above all — cannot be dropped, and every omission must carry a
 * stated reason.
 */
export async function rosterSet(projectDir: string, roster: Roster): Promise<{ path: string }> {
  const parsed = RosterSchema.parse(roster)
  const state = await new StateStore(projectDir).get()
  if (state.status !== 'running' || state.track === null) throw new NoActiveRunError()

  const config = await loadConfig(projectDir)
  const track = config.tracks[state.track]
  if (track === undefined) throw new UnknownTrackError(state.track, Object.keys(config.tracks))

  const forced = Object.entries(config.specialists)
    .filter(([, mode]) => mode === 'always')
    .map(([name]) => name)
  const permitted = new Set([...track.required, ...track.available, ...forced])
  const selected = new Set(parsed.selected)

  const violations: string[] = []

  if (parsed.cycle !== state.cycle) {
    violations.push(`roster is for cycle ${parsed.cycle} but state is at cycle ${state.cycle}`)
  }

  for (const agent of track.required) {
    if (!selected.has(agent)) {
      violations.push(`"${agent}" is required by track "${state.track}" and cannot be dropped`)
    }
  }

  for (const agent of forced) {
    if (!selected.has(agent)) {
      violations.push(`"${agent}" is configured as specialists.${agent}=always and cannot be dropped`)
    }
  }

  for (const agent of parsed.selected) {
    if (!permitted.has(agent)) {
      violations.push(`"${agent}" is not in track "${state.track}" — add it to required or available first`)
    }
  }

  // Every optional agent is either drafted or explained. Silence is not an answer.
  for (const agent of track.available) {
    if (!selected.has(agent) && parsed.skipped[agent] === undefined) {
      violations.push(`"${agent}" was omitted without a reason — add it to skipped`)
    }
  }

  if (violations.length > 0) throw new RosterViolationError(violations)

  const file = path.join(runDirPath(projectDir, state), 'roster.json')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
  return { path: file }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd engine && npx vitest run tests/ops/roster.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add engine/src/ops/roster.ts engine/tests/ops/roster.test.ts
git commit -m "feat(engine): enforce required agents when the leader declares a roster"
```

---

## Task 10: `runLog` and `stateSummary`

**Files:**
- Create: `engine/src/ops/log.ts`, `engine/src/ops/summary.ts`
- Test: `engine/tests/ops/log.test.ts`, `engine/tests/ops/summary.test.ts`

**Interfaces:**
- Consumes: `parseAgentResult`, `AgentResult` (Task 3); `StateStore` (Task 6); `loadConfig` (Task 6); `runDirPath` (Task 8).
- Produces:
  - `runLog(projectDir, input: { agent: string; result: unknown }, now?): Promise<{ path: string; findingsAdded: number }>`
  - `InvalidAgentResultError`
  - `StateSummary` interface, `stateSummary(projectDir): Promise<StateSummary>`, `renderSummaryLine(summary): string`

- [ ] **Step 1: Write the failing tests**

`engine/tests/ops/log.test.ts`:

```ts
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InvalidAgentResultError, runLog } from '../../src/ops/log.js'
import { initLoop } from '../../src/ops/init.js'
import { runDirPath, runStart } from '../../src/ops/run.js'
import { StateStore } from '../../src/store/state-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-26T10:36:00.000Z')
const clock = () => NOW

const RESULT = {
  status: 'fail',
  summary: 'Two tests still fail after the rename.',
  evidence: [{ kind: 'command', ref: 'npm test', excerpt: '2 failed, 10 passed' }],
  findings: [{ severity: 'high', file: 'src/Button.tsx', line: 14, claim: 'label no longer matches the snapshot' }],
  files_touched: ['src/Button.tsx'],
  next_hint: 'update the snapshot',
}

let project: TmpProject

beforeEach(async () => {
  project = await makeTmpProject()
  await initLoop(project.dir, clock)
  await runStart(project.dir, { track: 'edit', goal: 'Rename submit label' }, clock)
})
afterEach(async () => { await project.cleanup() })

describe('runLog', () => {
  it('writes the agent result under the cycle directory', async () => {
    const { path: file, findingsAdded } = await runLog(project.dir, { agent: 'verifier', result: RESULT }, clock)

    const state = await new StateStore(project.dir).get()
    expect(file).toBe(path.join(runDirPath(project.dir, state), 'cycle-01', 'verifier.json'))
    expect(JSON.parse(await fs.readFile(file, 'utf8')).summary).toBe(RESULT.summary)
    expect(findingsAdded).toBe(1)
  })

  it('folds the agent findings into state', async () => {
    await runLog(project.dir, { agent: 'verifier', result: RESULT }, clock)
    const state = await new StateStore(project.dir).get()
    expect(state.findings).toEqual(RESULT.findings)
  })

  it('rejects a malformed result with a readable error', async () => {
    await expect(runLog(project.dir, { agent: 'verifier', result: { status: 'fail' } }, clock)).rejects.toBeInstanceOf(
      InvalidAgentResultError,
    )
    await expect(runLog(project.dir, { agent: 'verifier', result: { status: 'fail' } }, clock)).rejects.toThrow(/summary/)
  })

  it('does not touch state when the result is rejected', async () => {
    await expect(runLog(project.dir, { agent: 'verifier', result: {} }, clock)).rejects.toThrow()
    expect((await new StateStore(project.dir).get()).findings).toEqual([])
  })

  it('keeps results from different agents side by side', async () => {
    await runLog(project.dir, { agent: 'editor', result: { ...RESULT, findings: [] } }, clock)
    await runLog(project.dir, { agent: 'verifier', result: RESULT }, clock)

    const state = await new StateStore(project.dir).get()
    const entries = await fs.readdir(path.join(runDirPath(project.dir, state), 'cycle-01'))
    expect(entries.sort()).toEqual(['editor.json', 'verifier.json'])
  })
})
```

`engine/tests/ops/summary.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderSummaryLine, stateSummary } from '../../src/ops/summary.js'
import { initLoop } from '../../src/ops/init.js'
import { cycleAdvance, runStart } from '../../src/ops/run.js'
import { runLog } from '../../src/ops/log.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-26T10:36:00.000Z')
const clock = () => NOW

let project: TmpProject
beforeEach(async () => { project = await makeTmpProject() })
afterEach(async () => { await project.cleanup() })

describe('stateSummary', () => {
  it('reports uninitialised for a project without .loop', async () => {
    const summary = await stateSummary(project.dir)
    expect(summary.initialised).toBe(false)
    expect(summary.status).toBe('uninitialised')
    expect(renderSummaryLine(summary)).toContain('/loop:init')
  })

  it('reports an idle loop after init', async () => {
    await initLoop(project.dir, clock)
    const summary = await stateSummary(project.dir)
    expect(summary.initialised).toBe(true)
    expect(summary.status).toBe('idle')
    expect(summary.track).toBeNull()
  })

  it('reports track, cycle, cap, and findings for a running loop', async () => {
    await initLoop(project.dir, clock)
    await runStart(project.dir, { track: 'edit', goal: 'Rename submit label' }, clock)
    await runLog(
      project.dir,
      {
        agent: 'verifier',
        result: {
          status: 'fail',
          summary: 'snapshot mismatch',
          evidence: [],
          findings: [
            { severity: 'high', file: 'a.ts', line: 1, claim: 'x' },
            { severity: 'low', file: 'b.ts', line: 2, claim: 'y' },
          ],
          files_touched: [],
          next_hint: null,
        },
      },
      clock,
    )

    const summary = await stateSummary(project.dir)
    expect(summary.status).toBe('running')
    expect(summary.track).toBe('edit')
    expect(summary.cycle).toBe(1)
    expect(summary.max_cycles).toBe(1)
    expect(summary.findings).toEqual({ high: 1, medium: 0, low: 1 })
    expect(renderSummaryLine(summary)).toContain('edit')
    expect(renderSummaryLine(summary)).toContain('cycle 1/1')
  })

  it('surfaces the halt reason', async () => {
    await initLoop(project.dir, clock)
    await runStart(project.dir, { track: 'edit', goal: 'Rename' }, clock)
    await cycleAdvance(project.dir, { agents: ['editor', 'verifier'], result: 'fail' }, clock)

    const summary = await stateSummary(project.dir)
    expect(summary.status).toBe('halted')
    expect(summary.halt_reason).toContain('cycle cap 1')
    expect(summary.last_cycle).toEqual({ result: 'fail', agents: ['editor', 'verifier'] })
    expect(renderSummaryLine(summary)).toContain('halted')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd engine && npx vitest run tests/ops/log.test.ts tests/ops/summary.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the implementations**

`engine/src/ops/log.ts`:

```ts
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseAgentResult } from '../schemas/contract.js'
import { StateStore, type Clock } from '../store/state-store.js'
import { NoActiveRunError, runDirPath } from './run.js'

export class InvalidAgentResultError extends Error {
  constructor(agent: string, detail: string) {
    super(`"${agent}" returned a result that does not match the agent contract:\n${detail}`)
    this.name = 'InvalidAgentResultError'
  }
}

export interface RunLogInput {
  agent: string
  /** Unvalidated — this is where an agent's raw return value is checked. */
  result: unknown
}

export async function runLog(
  projectDir: string,
  input: RunLogInput,
  now: Clock = () => new Date(),
): Promise<{ path: string; findingsAdded: number }> {
  const parsed = parseAgentResult(input.result)
  if (!parsed.ok) throw new InvalidAgentResultError(input.agent, parsed.error)

  const store = new StateStore(projectDir, now)
  const state = await store.get()
  if (state.status !== 'running') throw new NoActiveRunError()

  const cycleDir = path.join(runDirPath(projectDir, state), `cycle-${String(state.cycle).padStart(2, '0')}`)
  await fs.mkdir(cycleDir, { recursive: true })
  const file = path.join(cycleDir, `${input.agent}.json`)
  await fs.writeFile(file, `${JSON.stringify(parsed.value, null, 2)}\n`, 'utf8')

  if (parsed.value.findings.length > 0) {
    await store.update((draft) => {
      draft.findings.push(...parsed.value.findings)
    })
  }

  return { path: file, findingsAdded: parsed.value.findings.length }
}
```

`engine/src/ops/summary.ts`:

```ts
import type { Severity, State } from '../schemas/state.js'
import { ConfigMissingError, loadConfig } from '../store/config-store.js'
import { StateStore } from '../store/state-store.js'

export interface StateSummary {
  initialised: boolean
  status: State['status'] | 'uninitialised'
  track: string | null
  run_id: string | null
  cycle: number
  max_cycles: number | null
  plan: string | null
  story: string | null
  stage: string
  goal: string | null
  findings: Record<Severity, number>
  last_cycle: { result: string; agents: string[] } | null
  halt_reason: string | null
}

const NO_FINDINGS: Record<Severity, number> = { high: 0, medium: 0, low: 0 }

/**
 * A compact view for the leader and the SessionStart hook. Deliberately not
 * the whole state file — the leader's context must not grow with cycle count.
 */
export async function stateSummary(projectDir: string): Promise<StateSummary> {
  let state: State
  try {
    state = await new StateStore(projectDir).get()
  } catch {
    return {
      initialised: false,
      status: 'uninitialised',
      track: null,
      run_id: null,
      cycle: 0,
      max_cycles: null,
      plan: null,
      story: null,
      stage: 'idle',
      goal: null,
      findings: { ...NO_FINDINGS },
      last_cycle: null,
      halt_reason: null,
    }
  }

  let maxCycles: number | null = null
  try {
    const config = await loadConfig(projectDir)
    maxCycles = state.track === null ? null : config.tracks[state.track]?.max_cycles ?? null
  } catch (error) {
    if (!(error instanceof ConfigMissingError)) throw error
  }

  const findings = { ...NO_FINDINGS }
  for (const finding of state.findings) findings[finding.severity] += 1

  const last = state.history.at(-1)

  return {
    initialised: true,
    status: state.status,
    track: state.track,
    run_id: state.run_id,
    cycle: state.cycle,
    max_cycles: maxCycles,
    plan: state.current.plan,
    story: state.current.story,
    stage: state.current.stage,
    goal: state.goal,
    findings,
    last_cycle: last === undefined ? null : { result: last.result, agents: last.agents },
    halt_reason: state.halt_reason,
  }
}

/** One line for the SessionStart hook and `/loop:status`. */
export function renderSummaryLine(summary: StateSummary): string {
  if (!summary.initialised) return 'Loop: not initialised in this project — run /loop:init to set it up.'
  if (summary.status === 'idle') return 'Loop: initialised, no active run.'

  const target = summary.story ?? 'adhoc'
  const cap = summary.max_cycles === null ? '?' : String(summary.max_cycles)
  const findings = `${summary.findings.high}H/${summary.findings.medium}M/${summary.findings.low}L`
  const tail = summary.halt_reason === null ? '' : ` — ${summary.halt_reason}`
  return `Loop: ${summary.status} · track ${summary.track} · ${target} · cycle ${summary.cycle}/${cap} · stage ${summary.stage} · findings ${findings}${tail}`
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd engine && npx vitest run tests/ops/`
Expected: PASS — all ops tests green (27 total).

- [ ] **Step 5: Commit**

```bash
git add engine/src/ops/log.ts engine/src/ops/summary.ts engine/tests/ops/log.test.ts engine/tests/ops/summary.test.ts
git commit -m "feat(engine): add agent run logging and compact state summary"
```

---

## Task 11: MCP server

**Files:**
- Create: `engine/src/mcp/server.ts`
- Create: `.mcp.json`
- Test: `engine/tests/mcp/server.test.ts`

**Interfaces:**
- Consumes: every op from Tasks 7–10.
- Produces: `buildServer(): McpServer` and a stdio entrypoint; `resolveProjectDir(input?: string): string`.

Tools exposed (7): `loop_init`, `loop_state_get`, `loop_run_start`, `loop_roster_set`, `loop_run_log`, `loop_cycle_advance`, `loop_halt`.

- [ ] **Step 1: Confirm the SDK API before writing against it**

Run: `cd engine && node -e "import('@modelcontextprotocol/sdk/server/mcp.js').then(m => console.log(Object.keys(m)))"`
Expected: output includes `McpServer`. Then confirm the tool registration method:
Run: `cd engine && node -e "import('@modelcontextprotocol/sdk/server/mcp.js').then(m => console.log(Object.getOwnPropertyNames(m.McpServer.prototype).filter(k => /tool/i.test(k))))"`
Expected: output includes `registerTool`. If it does not, use `tool` instead and note the substitution in the commit message.

- [ ] **Step 2: Write the failing test**

`engine/tests/mcp/server.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildServer, resolveProjectDir } from '../../src/mcp/server.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

let project: TmpProject
let client: Client

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = buildServer()
  const c = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), c.connect(clientTransport)])
  return c
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content
  return content.map((part) => part.text ?? '').join('')
}

beforeEach(async () => {
  project = await makeTmpProject({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) })
  client = await connect()
})
afterEach(async () => {
  await client.close()
  await project.cleanup()
})

describe('resolveProjectDir', () => {
  it('prefers the explicit argument', () => {
    expect(resolveProjectDir('/tmp/explicit')).toBe('/tmp/explicit')
  })

  it('falls back to CLAUDE_PROJECT_DIR then cwd', () => {
    const previous = process.env.CLAUDE_PROJECT_DIR
    process.env.CLAUDE_PROJECT_DIR = '/tmp/from-env'
    expect(resolveProjectDir()).toBe('/tmp/from-env')
    delete process.env.CLAUDE_PROJECT_DIR
    expect(resolveProjectDir()).toBe(process.cwd())
    if (previous !== undefined) process.env.CLAUDE_PROJECT_DIR = previous
  })
})

describe('MCP surface', () => {
  it('exposes exactly the milestone-1 tools', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'loop_cycle_advance',
      'loop_halt',
      'loop_init',
      'loop_roster_set',
      'loop_run_log',
      'loop_run_start',
      'loop_state_get',
    ])
  })
})

describe('tool behaviour', () => {
  it('runs init then reports a summary', async () => {
    const init = await client.callTool({ name: 'loop_init', arguments: { project_dir: project.dir } })
    expect(textOf(init)).toContain('.loop/state.json')

    const summary = await client.callTool({ name: 'loop_state_get', arguments: { project_dir: project.dir } })
    expect(JSON.parse(textOf(summary)).status).toBe('idle')
  })

  it('drives a full passing edit cycle', async () => {
    await client.callTool({ name: 'loop_init', arguments: { project_dir: project.dir } })
    await client.callTool({
      name: 'loop_run_start',
      arguments: { project_dir: project.dir, track: 'edit', goal: 'Rename submit label' },
    })
    await client.callTool({
      name: 'loop_roster_set',
      arguments: { project_dir: project.dir, cycle: 1, selected: ['editor', 'verifier'], skipped: {} },
    })
    await client.callTool({
      name: 'loop_run_log',
      arguments: {
        project_dir: project.dir,
        agent: 'verifier',
        result: {
          status: 'pass',
          summary: 'All tests pass after the rename.',
          evidence: [{ kind: 'command', ref: 'npm test', excerpt: '12 passed' }],
          findings: [],
          files_touched: ['src/Button.tsx'],
        },
      },
    })
    const advanced = await client.callTool({
      name: 'loop_cycle_advance',
      arguments: { project_dir: project.dir, agents: ['editor', 'verifier'], result: 'pass' },
    })
    expect(JSON.parse(textOf(advanced)).status).toBe('done')
  })

  it('returns a tool error, not a crash, when the roster drops verifier', async () => {
    await client.callTool({ name: 'loop_init', arguments: { project_dir: project.dir } })
    await client.callTool({
      name: 'loop_run_start',
      arguments: { project_dir: project.dir, track: 'edit', goal: 'Rename' },
    })
    const result = await client.callTool({
      name: 'loop_roster_set',
      arguments: { project_dir: project.dir, cycle: 1, selected: ['editor'], skipped: {} },
    })
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(textOf(result)).toContain('verifier')
  })

  it('returns a tool error when an agent result breaks the contract', async () => {
    await client.callTool({ name: 'loop_init', arguments: { project_dir: project.dir } })
    await client.callTool({
      name: 'loop_run_start',
      arguments: { project_dir: project.dir, track: 'edit', goal: 'Rename' },
    })
    const result = await client.callTool({
      name: 'loop_run_log',
      arguments: { project_dir: project.dir, agent: 'editor', result: { status: 'pass' } },
    })
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(textOf(result)).toContain('summary')
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/mcp/server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the implementation**

`engine/src/mcp/server.ts`:

```ts
#!/usr/bin/env node
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as z from 'zod'
import { AgentResultSchema } from '../schemas/contract.js'
import { ResultSchema } from '../schemas/state.js'
import { initLoop } from '../ops/init.js'
import { runLog } from '../ops/log.js'
import { rosterSet } from '../ops/roster.js'
import { cycleAdvance, halt, runStart } from '../ops/run.js'
import { stateSummary } from '../ops/summary.js'

/** MCP servers are launched with the project as cwd; the argument is an escape hatch. */
export function resolveProjectDir(projectDir?: string): string {
  if (projectDir !== undefined && projectDir.length > 0) return projectDir
  const fromEnv = process.env.CLAUDE_PROJECT_DIR
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  return process.cwd()
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

function ok(payload: unknown): ToolResult {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
  return { content: [{ type: 'text', text }] }
}

/** Operational failures are tool errors the leader can read and react to. */
async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn()
  } catch (error) {
    return { content: [{ type: 'text', text: (error as Error).message }], isError: true }
  }
}

const projectDirArg = z.string().optional().describe('Project root. Defaults to CLAUDE_PROJECT_DIR or cwd.')

export function buildServer(): McpServer {
  const server = new McpServer({ name: 'loop', version: '0.1.0' })

  server.registerTool(
    'loop_init',
    {
      title: 'Initialise loop',
      description: 'Provision .loop/ in the project, detect verify commands, and register loop in CLAUDE.md. Idempotent.',
      inputSchema: { project_dir: projectDirArg },
    },
    async ({ project_dir }) =>
      guard(async () => {
        const result = await initLoop(resolveProjectDir(project_dir))
        return ok(result)
      }),
  )

  server.registerTool(
    'loop_state_get',
    {
      title: 'Get loop state',
      description: 'Compact summary of the current run: track, cycle, cap, stage, findings, halt reason.',
      inputSchema: { project_dir: projectDirArg },
    },
    async ({ project_dir }) => guard(async () => ok(await stateSummary(resolveProjectDir(project_dir)))),
  )

  server.registerTool(
    'loop_run_start',
    {
      title: 'Start a run',
      description: 'Open a new run on a track. Resets cycle, findings, and history.',
      inputSchema: {
        project_dir: projectDirArg,
        track: z.string().min(1).describe('Track name as defined in .loop/config.yaml'),
        goal: z.string().min(1).describe('What this run must achieve'),
        plan: z.string().min(1).nullish().describe('Plan id, e.g. P001'),
        story: z.string().min(1).nullish().describe('Story id, e.g. P001-S02'),
      },
    },
    async ({ project_dir, track, goal, plan, story }) =>
      guard(async () =>
        ok(
          await runStart(resolveProjectDir(project_dir), {
            track,
            goal,
            plan: plan ?? null,
            story: story ?? null,
          }),
        ),
      ),
  )

  server.registerTool(
    'loop_roster_set',
    {
      title: 'Declare the cycle roster',
      description:
        'Record which agents this cycle runs and why each omission is safe. Rejected if a required agent — verifier above all — is missing.',
      inputSchema: {
        project_dir: projectDirArg,
        cycle: z.number().int().positive(),
        selected: z.array(z.string().min(1)).min(1),
        skipped: z.record(z.string().min(1), z.string().min(1)).default({}).describe('agent -> why omitting it is safe'),
      },
    },
    async ({ project_dir, cycle, selected, skipped }) =>
      guard(async () => ok(await rosterSet(resolveProjectDir(project_dir), { cycle, selected, skipped }))),
  )

  server.registerTool(
    'loop_run_log',
    {
      title: 'Log an agent result',
      description: 'Validate an agent result against the contract, persist it under the cycle, and fold findings into state.',
      inputSchema: {
        project_dir: projectDirArg,
        agent: z.string().min(1),
        result: AgentResultSchema,
      },
    },
    async ({ project_dir, agent, result }) =>
      guard(async () => ok(await runLog(resolveProjectDir(project_dir), { agent, result }))),
  )

  server.registerTool(
    'loop_cycle_advance',
    {
      title: 'Close the cycle',
      description: 'Record the cycle outcome. pass finishes the run; otherwise the next cycle opens unless the cap is reached.',
      inputSchema: {
        project_dir: projectDirArg,
        agents: z.array(z.string().min(1)).min(1),
        result: ResultSchema,
      },
    },
    async ({ project_dir, agents, result }) =>
      guard(async () => ok(await cycleAdvance(resolveProjectDir(project_dir), { agents, result }))),
  )

  server.registerTool(
    'loop_halt',
    {
      title: 'Halt the run',
      description: 'Stop the run and write HALT.md with the evidence gathered so far.',
      inputSchema: { project_dir: projectDirArg, reason: z.string().min(1) },
    },
    async ({ project_dir, reason }) => guard(async () => ok(await halt(resolveProjectDir(project_dir), reason))),
  )

  return server
}

const isEntrypoint = process.argv[1] !== undefined && import.meta.url === `file://${path.resolve(process.argv[1])}`
if (isEntrypoint) {
  const server = buildServer()
  await server.connect(new StdioServerTransport())
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd engine && npx vitest run tests/mcp/server.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 6: Build and register the server with the plugin**

Run: `cd engine && npm run build`
Expected: `engine/dist/mcp/server.js` exists.

`.mcp.json` at the repository root:

```json
{
  "mcpServers": {
    "loop": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/engine/dist/mcp/server.js"]
    }
  }
}
```

- [ ] **Step 7: Verify the plugin MCP registration format against the docs**

Run: `Use WebFetch on https://docs.claude.com/en/docs/claude-code/plugins-reference with the prompt "How does a plugin declare an MCP server — a root .mcp.json file, or an mcpServers key in .claude-plugin/plugin.json? What is the exact key name and is ${CLAUDE_PLUGIN_ROOT} expanded in it?"`
Expected: confirmation of the file location and key. If the docs specify `mcpServers` inside `.claude-plugin/plugin.json` instead, move the block there and delete `.mcp.json`.

- [ ] **Step 8: Commit**

```bash
git add engine/src/mcp/server.ts engine/tests/mcp/server.test.ts .mcp.json
git commit -m "feat(mcp): expose the seven milestone-1 loop tools over stdio"
```

---

## Task 12: CLI and hooks

**Files:**
- Create: `engine/src/cli/index.ts`
- Create: `hooks/hooks.json`, `hooks/scripts/session-start.sh`, `hooks/scripts/state-guard.sh`
- Test: `engine/tests/cli/index.test.ts`

**Interfaces:**
- Consumes: `stateSummary`, `renderSummaryLine` (Task 10); `PROTECTED_BASENAMES` (Task 4).
- Produces: `runCli(argv: string[], stdin: string): Promise<{ stdout: string; exitCode: number }>`; `evaluateStateGuard(input: unknown): { deny: boolean; reason: string }`.

The hook scripts hold no logic — they pipe stdin to `loop-cli`. All behaviour is tested in TypeScript.

- [ ] **Step 1: Write the failing test**

`engine/tests/cli/index.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { evaluateStateGuard, runCli } from '../../src/cli/index.js'
import { initLoop } from '../../src/ops/init.js'
import { runStart } from '../../src/ops/run.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-26T10:36:00.000Z')
const clock = () => NOW

let project: TmpProject
beforeEach(async () => { project = await makeTmpProject() })
afterEach(async () => { await project.cleanup() })

describe('runCli summary', () => {
  it('prints a one-line summary', async () => {
    await initLoop(project.dir, clock)
    await runStart(project.dir, { track: 'edit', goal: 'Rename' }, clock)
    const { stdout, exitCode } = await runCli(['summary', '--dir', project.dir], '')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('track edit')
  })

  it('prints json when asked', async () => {
    await initLoop(project.dir, clock)
    const { stdout } = await runCli(['summary', '--dir', project.dir, '--json'], '')
    expect(JSON.parse(stdout).status).toBe('idle')
  })
})

describe('runCli session-start', () => {
  it('emits additionalContext when the project has a loop', async () => {
    await initLoop(project.dir, clock)
    await runStart(project.dir, { track: 'edit', goal: 'Rename' }, clock)
    const { stdout } = await runCli(['session-start'], JSON.stringify({ cwd: project.dir }))
    const payload = JSON.parse(stdout)
    expect(payload.hookSpecificOutput.hookEventName).toBe('SessionStart')
    expect(payload.hookSpecificOutput.additionalContext).toContain('track edit')
  })

  it('emits nothing for a project without .loop', async () => {
    const { stdout, exitCode } = await runCli(['session-start'], JSON.stringify({ cwd: project.dir }))
    expect(stdout).toBe('')
    expect(exitCode).toBe(0)
  })
})

describe('evaluateStateGuard', () => {
  it('denies a write to .loop/state.json', () => {
    const verdict = evaluateStateGuard({
      tool_name: 'Write',
      tool_input: { file_path: '/repo/.loop/state.json' },
    })
    expect(verdict.deny).toBe(true)
    expect(verdict.reason).toContain('loop_')
  })

  it('denies a write to a plan manifest.json', () => {
    const verdict = evaluateStateGuard({
      tool_name: 'Edit',
      tool_input: { file_path: '/repo/.loop/plans/P001-auth/manifest.json' },
    })
    expect(verdict.deny).toBe(true)
  })

  it('allows a write to a story file', () => {
    const verdict = evaluateStateGuard({
      tool_name: 'Write',
      tool_input: { file_path: '/repo/.loop/plans/P001-auth/stories/P001-S01-login.md' },
    })
    expect(verdict.deny).toBe(false)
  })

  it('allows a state.json that is not inside .loop', () => {
    const verdict = evaluateStateGuard({
      tool_name: 'Write',
      tool_input: { file_path: '/repo/src/fixtures/state.json' },
    })
    expect(verdict.deny).toBe(false)
  })

  it('allows a call with no file_path', () => {
    expect(evaluateStateGuard({ tool_name: 'Write', tool_input: {} }).deny).toBe(false)
  })

  it('allows malformed hook input rather than blocking the user', () => {
    expect(evaluateStateGuard(null).deny).toBe(false)
    expect(evaluateStateGuard('nonsense').deny).toBe(false)
  })
})

describe('runCli state-guard', () => {
  it('emits a deny decision for a protected path', async () => {
    const stdin = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '/repo/.loop/state.json' } })
    const { stdout } = await runCli(['state-guard'], stdin)
    const payload = JSON.parse(stdout)
    expect(payload.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(payload.hookSpecificOutput.permissionDecision).toBe('deny')
  })

  it('emits nothing for an allowed path', async () => {
    const stdin = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '/repo/src/a.ts' } })
    const { stdout } = await runCli(['state-guard'], stdin)
    expect(stdout).toBe('')
  })
})

describe('runCli unknown command', () => {
  it('exits non-zero with usage', async () => {
    const { stdout, exitCode } = await runCli(['nope'], '')
    expect(exitCode).toBe(1)
    expect(stdout).toContain('usage')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/cli/index.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`engine/src/cli/index.ts`:

```ts
#!/usr/bin/env node
import path from 'node:path'
import { renderSummaryLine, stateSummary } from '../ops/summary.js'
import { PROTECTED_BASENAMES } from '../store/paths.js'

const USAGE = `usage: loop-cli <command>

  summary [--dir <path>] [--json]   print the current loop state
  session-start                     SessionStart hook (reads hook JSON on stdin)
  state-guard                       PreToolUse hook (reads hook JSON on stdin)
`

export interface CliResult {
  stdout: string
  exitCode: number
}

export async function runCli(argv: string[], stdin: string): Promise<CliResult> {
  const [command, ...rest] = argv
  switch (command) {
    case 'summary':
      return summaryCommand(rest)
    case 'session-start':
      return sessionStartCommand(stdin)
    case 'state-guard':
      return stateGuardCommand(stdin)
    default:
      return { stdout: USAGE, exitCode: 1 }
  }
}

async function summaryCommand(args: string[]): Promise<CliResult> {
  const dirIndex = args.indexOf('--dir')
  const dir = dirIndex === -1 ? process.cwd() : args[dirIndex + 1] ?? process.cwd()
  const summary = await stateSummary(dir)
  const stdout = args.includes('--json') ? `${JSON.stringify(summary, null, 2)}\n` : `${renderSummaryLine(summary)}\n`
  return { stdout, exitCode: 0 }
}

async function sessionStartCommand(stdin: string): Promise<CliResult> {
  const cwd = readCwd(stdin)
  const summary = await stateSummary(cwd)
  // Say nothing in projects that do not use loop — silence beats noise.
  if (!summary.initialised) return { stdout: '', exitCode: 0 }

  const payload = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: renderSummaryLine(summary),
    },
  }
  return { stdout: `${JSON.stringify(payload)}\n`, exitCode: 0 }
}

async function stateGuardCommand(stdin: string): Promise<CliResult> {
  let input: unknown
  try {
    input = JSON.parse(stdin) as unknown
  } catch {
    return { stdout: '', exitCode: 0 }
  }
  const verdict = evaluateStateGuard(input)
  if (!verdict.deny) return { stdout: '', exitCode: 0 }

  const payload = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: verdict.reason,
    },
  }
  return { stdout: `${JSON.stringify(payload)}\n`, exitCode: 0 }
}

export interface GuardVerdict {
  deny: boolean
  reason: string
}

/**
 * Loop state is owned by the MCP server. A model editing it by hand is the
 * fastest way to lose a run, so the write is denied outright.
 */
export function evaluateStateGuard(input: unknown): GuardVerdict {
  const filePath = extractFilePath(input)
  if (filePath === null) return { deny: false, reason: '' }

  const segments = filePath.split(path.sep)
  if (!segments.includes('.loop')) return { deny: false, reason: '' }

  const basename = path.basename(filePath)
  if (!PROTECTED_BASENAMES.includes(basename as (typeof PROTECTED_BASENAMES)[number])) {
    return { deny: false, reason: '' }
  }

  return {
    deny: true,
    reason: `${basename} is owned by the loop MCP server. Use the loop_* tools (loop_run_start, loop_cycle_advance, loop_story_update, ...) instead of editing it directly.`,
  }
}

function extractFilePath(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null
  const toolInput = (input as { tool_input?: unknown }).tool_input
  if (typeof toolInput !== 'object' || toolInput === null) return null
  const filePath = (toolInput as { file_path?: unknown }).file_path
  return typeof filePath === 'string' && filePath.length > 0 ? filePath : null
}

function readCwd(stdin: string): string {
  try {
    const parsed = JSON.parse(stdin) as { cwd?: unknown }
    return typeof parsed.cwd === 'string' && parsed.cwd.length > 0 ? parsed.cwd : process.cwd()
  } catch {
    return process.cwd()
  }
}

const isEntrypoint = process.argv[1] !== undefined && import.meta.url === `file://${path.resolve(process.argv[1])}`
if (isEntrypoint) {
  const stdin = process.stdin.isTTY === true ? '' : await readAll()
  const result = await runCli(process.argv.slice(2), stdin)
  if (result.stdout.length > 0) process.stdout.write(result.stdout)
  process.exitCode = result.exitCode
}

async function readAll(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd engine && npx vitest run tests/cli/index.test.ts`
Expected: PASS — 12 tests.

- [ ] **Step 5: Write the hook scripts and registration**

`hooks/scripts/session-start.sh`:

```bash
#!/usr/bin/env bash
# Inject the current loop state into every session that has a .loop directory.
# All logic lives in loop-cli; this wrapper only moves bytes.
set -euo pipefail
exec node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli/index.js" session-start
```

`hooks/scripts/state-guard.sh`:

```bash
#!/usr/bin/env bash
# Deny hand edits to loop-owned state files.
set -euo pipefail
exec node "${CLAUDE_PLUGIN_ROOT}/engine/dist/cli/index.js" state-guard
```

Run: `chmod +x hooks/scripts/session-start.sh hooks/scripts/state-guard.sh`

`hooks/hooks.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/session-start.sh" }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/state-guard.sh" }
        ]
      }
    ]
  }
}
```

- [ ] **Step 6: Verify the hook wiring end to end from the shell**

Run: `cd engine && npm run build && echo '{"tool_name":"Write","tool_input":{"file_path":"/repo/.loop/state.json"}}' | node dist/cli/index.js state-guard`
Expected: a single line of JSON containing `"permissionDecision":"deny"`.

Run: `echo '{"tool_name":"Write","tool_input":{"file_path":"/repo/src/a.ts"}}' | node engine/dist/cli/index.js state-guard; echo "exit=$?"`
Expected: no output, `exit=0`.

- [ ] **Step 7: Commit**

```bash
git add engine/src/cli/index.ts engine/tests/cli/index.test.ts hooks/hooks.json hooks/scripts/session-start.sh hooks/scripts/state-guard.sh
git commit -m "feat(hooks): add session-start context injection and state write guard"
```

---

## Task 13: Plugin surface — manifest, commands, agents, skills

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `commands/init.md`, `commands/edit.md`, `commands/status.md`, `commands/stop.md`
- Create: `agents/editor.md`, `agents/verifier.md`
- Create: `skills/loop-contract/SKILL.md`, `skills/loop-state/SKILL.md`, `skills/loop-leader/SKILL.md`
- Create: `README.md`
- Test: manual verification steps below (markdown assets have no unit tests; Task 14 exercises them)

**Interfaces:**
- Consumes: the MCP tool names from Task 11.
- Produces: the `/loop:init`, `/loop:edit`, `/loop:status`, `/loop:stop` commands; the `editor` and `verifier` agents; the three skills.

- [ ] **Step 1: Write the plugin manifest**

`.claude-plugin/plugin.json`:

```json
{
  "name": "loop",
  "version": "0.1.0",
  "description": "Cycle engine for Claude Code. A leader composes each cycle from a track roster of contract-bound agents; state lives in .loop/ and is owned by an MCP server.",
  "keywords": ["loop", "agents", "orchestration", "mcp"]
}
```

- [ ] **Step 2: Write the commands**

`commands/init.md`:

```markdown
---
description: Provision .loop/ in this project and detect its verify commands
---

Set up the loop for this project.

1. Call `loop_init`.
2. Report what was created, and the verify commands that were detected.
3. If any of `test`, `lint`, or `build` came back null, ask the user **once** for the
   correct command and write it into `.loop/config.yaml`. Never invent a command —
   a fabricated verify command produces false passes.
4. Tell the user the loop is ready and that `/loop:edit <request>` is available.

If `loop_init` reports `alreadyInitialised: true`, say so and stop. Do not reset state.
```

`commands/edit.md`:

```markdown
---
description: Make a small, well-scoped change through one loop cycle
argument-hint: <what to change>
---

Run the `edit` track for: $ARGUMENTS

Use the **loop-leader** skill. It owns the cycle: composing the roster, dispatching
agents, judging the result, and closing the cycle.

The `edit` track is capped at one cycle. If `editor` reports that the change is larger
than it appears, stop and recommend a wider track rather than pushing through.
```

`commands/status.md`:

```markdown
---
description: Show the current loop track, cycle, and latest evidence
---

Call `loop_state_get` and report it in a compact form:

- track, run id, cycle out of the cap, stage
- goal, and plan/story when set
- finding counts by severity
- the halt reason when the run is halted

If the run is halted, also read `HALT.md` from the run directory and summarise the
recommended next step. If the project has no `.loop/`, say so and offer `/loop:init`.
```

`commands/stop.md`:

```markdown
---
description: Halt the current loop run and write a report
argument-hint: [reason]
---

Stop the current run cleanly.

1. Call `loop_state_get`. If nothing is `running`, say so and stop — there is nothing to halt.
2. Call `loop_halt` with the reason. Use $ARGUMENTS when given; otherwise
   `"stopped by the user"`.
3. Read the generated `HALT.md` and report: what was attempted, what the evidence shows,
   and what the open findings are.

Do not tidy up, revert, or commit anything. Halting records the state; it does not
undo work.
```

- [ ] **Step 3: Write the agents**

`agents/editor.md`:

```markdown
---
name: editor
description: Makes a small, well-scoped code change. Use for the loop edit track. Stops and escalates rather than expanding scope.
tools: Read, Edit, Write, Grep, Glob, Bash
model: inherit
---

You make one small change, correctly, and stop.

## Escalation rule — check this before you edit

Stop and return `status: "blocked"` if the change would:

- touch more than 3 files, or
- alter a public interface (an exported signature, a route, a schema, a CLI flag), or
- require a new dependency, or
- require a design decision that the request does not settle.

In `summary`, say which condition tripped and recommend `/loop:build`. Escalating is
success for this agent. Expanding scope is failure.

## Otherwise

1. Read enough of the code to be certain of the change. Follow the patterns already there.
2. Make the change.
3. Update or add the test that covers it. A behaviour change with no test is incomplete.
4. Do not run the verify suite — `verifier` owns that judgement, and an agent that
   grades its own work is not evidence.

## Return value

Return exactly the shape in the **loop-contract** skill. `files_touched` must list every
file you wrote. Put the reasoning that a reviewer needs in `summary`, not in prose
outside the object.
```

`agents/verifier.md`:

```markdown
---
name: verifier
description: Judges whether work actually passes, using command output as evidence. Never edits code. Use whenever a loop cycle needs a verdict.
tools: Read, Bash, Grep, Glob
model: inherit
---

You decide whether the work passes. Your verdict is only as good as the evidence
attached to it.

## You may not edit anything

No `Edit`, no `Write`, no fixes, no "while I was here". If the code is broken, you say
so with evidence and stop. A verifier that repairs its own subject cannot judge it.

## Procedure

1. Read `.loop/config.yaml` for the `verify` commands.
2. Run them. If a command is missing from config, return `status: "blocked"` and say
   which one — never substitute a command you guessed.
3. For an `edit` cycle, prefer the lint command plus the tests affected by
   `files_touched`. Run the full suite when you cannot determine the affected set.
4. `status: "pass"` requires every command you ran to have exited 0. Nothing else
   qualifies. When in doubt, fail.

## Evidence is mandatory

Every command you ran becomes an `evidence` entry: `kind: "command"`, `ref` is the exact
command, `excerpt` is the decisive output — the failure lines, or the pass count. Never
report a pass with an empty `evidence` array; the engine treats that as an unproven claim.

## Return value

Return exactly the shape in the **loop-contract** skill. Each concrete defect becomes a
`findings` entry with a real file and line.
```

- [ ] **Step 4: Write the contract and state skills**

`skills/loop-contract/SKILL.md`:

```markdown
---
name: loop-contract
description: Use when writing, invoking, or debugging a loop agent - defines the brief every agent receives and the single output shape every agent must return
---

# Loop Agent Contract

Every loop agent takes a uniform brief and returns one shape. The leader does not know
what an agent does internally, which is why a new agent can be added without touching
the leader.

## The brief the leader sends

```
Track:      edit
Cycle:      1 of 1
Goal:       <what this run must achieve>
Story:      P001-S02 | none
Files:      <known-relevant paths, when any>
Findings:   <open findings from earlier cycles, when any>
Verify:     test="npm test" lint="npm run lint" build=null
Return:     the loop agent contract, and nothing else
```

## The shape every agent returns

```json
{
  "status": "pass | fail | blocked",
  "summary": "One paragraph a reviewer can act on.",
  "evidence": [{ "kind": "command | file | test", "ref": "npm test", "excerpt": "12 passed" }],
  "findings": [{ "severity": "high | medium | low", "file": "src/a.ts", "line": 14, "claim": "..." }],
  "files_touched": ["src/a.ts"],
  "next_hint": "optional single suggestion, or null"
}
```

## Rules

- **Exact shape.** No extra keys. `loop_run_log` rejects unknown fields, so a smuggled
  `confidence` field fails the whole call.
- **`status: "pass"` needs evidence.** An empty `evidence` array with a pass is an
  unproven claim.
- **`blocked` is a real answer.** Use it when you are missing a command, a decision, or
  a permission. It is not failure — it is the loop working.
- **Findings are specific.** A real file and a real line. "Consider improving error
  handling" is not a finding.
- **The object is the return value.** Do not wrap it in commentary; the leader parses it.

## When an agent returns the wrong shape

The leader gets a readable error from `loop_run_log`, gives it back to the agent as a
single corrective retry, and on a second failure counts the cycle as failed. One bad
agent does not kill the run.
```

`skills/loop-state/SKILL.md`:

```markdown
---
name: loop-state
description: Use when reading or changing loop state - explains the .loop directory and which MCP tool owns each write
---

# Loop State

## Layout

```
.loop/
├── config.yaml      tracks, limits, verify commands — hand-editable
├── state.json       current run — MCP-owned, never hand-edited
├── runs/<run>/      roster.json, cycle-NN/<agent>.json, HALT.md
├── plans/           one directory per plan (later milestones)
└── memory/          decisions and lessons (later milestones)
```

## One owner

`state.json` and every `manifest.json` are written **only** by the loop MCP server. A
`PreToolUse` hook denies `Write` and `Edit` on them. This is not ceremony: a model
corrupting that JSON loses the entire run, and it is the most common way agent loops
fail in practice.

`config.yaml` is the opposite — it is yours. Edit it freely to change a track's cap,
force a specialist, or set verify commands.

## Tools

| Need | Tool |
|---|---|
| Provision `.loop/` | `loop_init` |
| Read the current run | `loop_state_get` |
| Open a run | `loop_run_start` |
| Declare the cycle's agents | `loop_roster_set` |
| Persist an agent result | `loop_run_log` |
| Close a cycle | `loop_cycle_advance` |
| Stop with a report | `loop_halt` |

`loop_state_get` returns a compact summary rather than the whole file, so the leader's
context does not grow with the cycle count. Read the run directory when you need detail.

## Reading a halted run

`.loop/runs/<run>/HALT.md` carries the reason, the cycles attempted, the open findings,
and the recommended next step. Read it before restarting anything.
```

- [ ] **Step 5: Write the leader skill**

`skills/loop-leader/SKILL.md`:

```markdown
---
name: loop-leader
description: Use when running any loop track - owns the cycle, composes the roster from the track, dispatches agents, and judges the result with evidence
---

# Loop Leader

You are the leader. You do not implement; you compose the cycle, dispatch agents, and
judge what comes back.

Read the **loop-contract** skill before dispatching anything, and **loop-state** before
touching state.

## Cycle

### 1. Read the ground truth

Call `loop_state_get`. If the project has no loop, stop and tell the user to run
`/loop:init`. If a run is already `running`, ask whether to resume it or halt it — do
not silently start a second run.

### 2. Open the run

Call `loop_run_start` with the track and the goal. Restate the goal in one sentence and
name the acceptance condition you will judge against. A goal you cannot state as a
checkable condition is not ready to run.

### 3. Compose the roster

Read `.loop/config.yaml` for the track's `required` and `available` sets.

- Every `required` agent is in the cycle. There is no argument to be had.
- Draft from `available` only what this task actually needs.
- Every agent you leave out needs a stated reason — an omission with no reason is
  rejected.
- A specialist set to `always` is in the cycle regardless of what you think.

Call `loop_roster_set`. **If it rejects your roster, fix the roster.** Do not work around
it — the rejection is the invariant doing its job.

### 4. Dispatch

Send each agent the brief from **loop-contract**. Independent agents may run in
parallel up to `limits.max_parallel_agents`; an agent that consumes another's output
waits for it. `verifier` always runs last, after every agent that touches code.

Call `loop_run_log` for each result. If it rejects the result, hand the error text back
to that agent as a **single** corrective retry. On a second failure, treat the cycle as
failed and move on — one bad agent does not end the run.

### 5. Judge

`pass` requires all of:

- `verifier` returned `status: "pass"`, and
- its `evidence` contains real command output, and
- no `high` severity finding is open.

Anything short of that is a fail. Never declare success on your own reading of the
code — the verdict belongs to `verifier`'s evidence, not to your impression.

### 6. Close the cycle

Call `loop_cycle_advance` with the agents that ran and the result.

- `done` — report what changed, cite the evidence, and commit when `gates.commit` is `auto`.
- `running` — the next cycle opens; fold the open findings into it as the work to do.
- `halted` — the cap was reached. Read `HALT.md`, report it plainly, and recommend a
  next step. Do not raise the cap on your own.

## What you never do

- Never write `.loop/state.json` or a `manifest.json` by hand.
- Never skip `verifier`, and never overrule its verdict.
- Never raise a track's `max_cycles` to get past a halt — that is the user's decision.
- Never invent a verify command. A missing command is a `blocked`, and you ask once.
- Never implement the change yourself. If no agent fits, say so; that is a missing agent,
  not your job.
```

- [ ] **Step 6: Write the README**

`README.md`:

```markdown
# loop

A Claude Code plugin. Install once, invoke from any project.

`loop` runs work as a **cycle**: a leader composes the cycle from a track's agent
roster, dispatches contract-bound agents in isolated contexts, and judges the result on
evidence. Execution state lives in `.loop/` in the host project and is owned by an MCP
server, so no agent can corrupt it by hand.

## Status

Milestone 1 — the engine and the `edit` track. `plan`, `build`, and `fix` land in
following milestones. See `docs/superpowers/specs/2026-07-26-loop-plugin-design.md`.

## Install

```bash
cd engine && npm install && npm run build
```

Then add this repository as a plugin marketplace or local plugin in Claude Code.

## Use

```
/loop:init                          provision .loop/ and detect verify commands
/loop:edit <what to change>         one-cycle scoped change
/loop:status                        where the current run stands
/loop:stop [reason]                 halt the run and write a report
```

## How a cycle is composed

Each track declares a `required` set the leader cannot drop and an `available` set it
draws from as the task warrants. Before running, the leader writes `roster.json` naming
what it chose and why each omission was safe. `verifier` is the one hard invariant: no
success is declared without its evidence.

Change a track, cap, or forced specialist in `.loop/config.yaml`. Tracks are data — a
new one needs no code.

## Development

```bash
cd engine
npm test           # unit and integration tests
npm run typecheck
```

`LOOP_E2E=1 tests/e2e/run-edit.sh` runs the opt-in smoke test against the real CLI.
```

- [ ] **Step 7: Verify the plugin loads**

Run: `cd engine && npm run build && npm run typecheck`
Expected: clean build, no type errors.

Then, in an interactive Claude Code session with this directory installed as a plugin,
confirm: `/loop:init` appears in the command list, and the `loop` MCP server reports
7 tools.

- [ ] **Step 8: Commit**

```bash
git add .claude-plugin commands agents skills README.md
git commit -m "feat(plugin): add manifest, commands, editor/verifier agents, and leader skill"
```

---

## Task 14: Integration test and opt-in E2E

**Files:**
- Create: `tests/fixtures/tiny-app/package.json`, `tests/fixtures/tiny-app/src/button.js`, `tests/fixtures/tiny-app/test/button.test.js`
- Create: `engine/tests/integration/edit-cycle.test.ts`
- Create: `tests/e2e/run-edit.sh`
- Modify: `engine/package.json` — add the `e2e` script

**Interfaces:**
- Consumes: every op and the fixture project.
- Produces: proof that a full `edit` cycle turns end to end, and a manual smoke test against the real CLI.

- [ ] **Step 1: Create the fixture project**

`tests/fixtures/tiny-app/package.json`:

```json
{
  "name": "tiny-app",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test test/",
    "lint": "node --check src/button.js"
  }
}
```

`tests/fixtures/tiny-app/src/button.js`:

```js
export function submitLabel() {
  return 'Submit'
}
```

`tests/fixtures/tiny-app/test/button.test.js`:

```js
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { submitLabel } from '../src/button.js'

test('submitLabel returns the button text', () => {
  assert.equal(submitLabel(), 'Submit')
})
```

- [ ] **Step 2: Write the failing integration test**

`engine/tests/integration/edit-cycle.test.ts`:

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
import { StateStore } from '../../src/store/state-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-26T10:36:00.000Z')
const clock = () => NOW
const FIXTURE = path.resolve(fileURLToPath(import.meta.url), '../../../../tests/fixtures/tiny-app')

let project: TmpProject

beforeEach(async () => {
  project = await makeTmpProject()
  await fs.cp(FIXTURE, project.dir, { recursive: true })
})
afterEach(async () => { await project.cleanup() })

const PASSING_VERIFIER = {
  status: 'pass' as const,
  summary: 'Lint and the affected test both pass after the rename.',
  evidence: [
    { kind: 'command' as const, ref: 'npm run lint', excerpt: 'ok' },
    { kind: 'command' as const, ref: 'npm test', excerpt: '1 passing' },
  ],
  findings: [],
  files_touched: [],
  next_hint: null,
}

describe('a full edit cycle', () => {
  it('detects the fixture verify commands at init', async () => {
    const result = await initLoop(project.dir, clock)
    expect(result.verify).toEqual({ test: 'npm test', lint: 'npm run lint', build: null })
  })

  it('runs init -> start -> roster -> log -> advance and lands on done', async () => {
    await initLoop(project.dir, clock)
    await runStart(project.dir, { track: 'edit', goal: 'Rename the submit label to Send' }, clock)
    await rosterSet(project.dir, { cycle: 1, selected: ['editor', 'verifier'], skipped: {} })

    await runLog(
      project.dir,
      {
        agent: 'editor',
        result: {
          status: 'pass',
          summary: 'Renamed the label and updated the assertion.',
          evidence: [{ kind: 'file', ref: 'src/button.js', excerpt: "return 'Send'" }],
          findings: [],
          files_touched: ['src/button.js', 'test/button.test.js'],
          next_hint: null,
        },
      },
      clock,
    )
    await runLog(project.dir, { agent: 'verifier', result: PASSING_VERIFIER }, clock)

    const state = await cycleAdvance(project.dir, { agents: ['editor', 'verifier'], result: 'pass' }, clock)
    expect(state.status).toBe('done')

    // every artefact of the cycle is on disk and traceable to the run
    const dir = runDirPath(project.dir, state)
    expect(await fs.readdir(dir)).toEqual(expect.arrayContaining(['roster.json', 'cycle-01']))
    expect((await fs.readdir(path.join(dir, 'cycle-01'))).sort()).toEqual(['editor.json', 'verifier.json'])

    const summary = await stateSummary(project.dir)
    expect(summary.status).toBe('done')
    expect(summary.findings).toEqual({ high: 0, medium: 0, low: 0 })
  })

  it('halts with a report when the single cycle fails', async () => {
    await initLoop(project.dir, clock)
    await runStart(project.dir, { track: 'edit', goal: 'Rename the submit label to Send' }, clock)
    await rosterSet(project.dir, { cycle: 1, selected: ['editor', 'verifier'], skipped: {} })
    await runLog(
      project.dir,
      {
        agent: 'verifier',
        result: {
          status: 'fail',
          summary: 'The assertion still expects the old label.',
          evidence: [{ kind: 'command', ref: 'npm test', excerpt: '1 failing' }],
          findings: [{ severity: 'high', file: 'test/button.test.js', line: 6, claim: 'asserts the old label' }],
          files_touched: [],
          next_hint: 'update the assertion',
        },
      },
      clock,
    )

    const state = await cycleAdvance(project.dir, { agents: ['editor', 'verifier'], result: 'fail' }, clock)
    expect(state.status).toBe('halted')

    const report = await fs.readFile(path.join(runDirPath(project.dir, state), 'HALT.md'), 'utf8')
    expect(report).toContain('cycle cap 1 reached for track edit')
    expect(report).toContain('asserts the old label')
  })

  it('blocks the escalation case without corrupting the run', async () => {
    await initLoop(project.dir, clock)
    await runStart(project.dir, { track: 'edit', goal: 'Restructure the whole component tree' }, clock)
    await rosterSet(project.dir, { cycle: 1, selected: ['editor', 'verifier'], skipped: {} })
    await runLog(
      project.dir,
      {
        agent: 'editor',
        result: {
          status: 'blocked',
          summary: 'This touches 9 files and changes two exported signatures. Recommend /loop:build.',
          evidence: [],
          findings: [],
          files_touched: [],
          next_hint: 'run /loop:build',
        },
      },
      clock,
    )

    const state = await new StateStore(project.dir).get()
    expect(state.status).toBe('running')
    expect(state.cycle).toBe(1)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/integration/edit-cycle.test.ts`
Expected: FAIL — the fixture path does not resolve yet (before Step 1 lands) or assertions fail.

- [ ] **Step 4: Make it pass**

No new production code should be needed — Tasks 7–10 cover every operation. If a test
fails, the defect is in the ops, not the test. Fix the op and rerun.

Run: `cd engine && npx vitest run tests/integration/edit-cycle.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Write the opt-in E2E script**

`tests/e2e/run-edit.sh`:

```bash
#!/usr/bin/env bash
# Opt-in smoke test against the real Claude Code CLI.
# Not part of `npm test`: it needs the CLI, a network, and real tokens.
#   LOOP_E2E=1 tests/e2e/run-edit.sh
set -euo pipefail

if [[ "${LOOP_E2E:-}" != "1" ]]; then
  echo "skipped: set LOOP_E2E=1 to run the end-to-end smoke test" >&2
  exit 0
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
workdir="$(mktemp -d)"
trap 'rm -rf "${workdir}"' EXIT

cp -R "${repo_root}/tests/fixtures/tiny-app/." "${workdir}/"
cd "${workdir}"

claude -p "/loop:init" --permission-mode acceptEdits
claude -p "/loop:edit change the submit button label to Send" --permission-mode acceptEdits

echo "--- state ---"
node "${repo_root}/engine/dist/cli/index.js" summary --dir "${workdir}" --json

status="$(node "${repo_root}/engine/dist/cli/index.js" summary --dir "${workdir}" --json | node -e \
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).status))')"

if [[ "${status}" != "done" ]]; then
  echo "FAIL: expected status done, got ${status}" >&2
  echo "--- run artefacts ---" >&2
  find "${workdir}/.loop/runs" -type f -print >&2
  exit 1
fi

if ! grep -q "Send" "${workdir}/src/button.js"; then
  echo "FAIL: the label was not changed" >&2
  exit 1
fi

echo "PASS: the edit cycle completed and the change landed"
```

Run: `chmod +x tests/e2e/run-edit.sh`

Add to `engine/package.json` scripts:

```json
"e2e": "bash ../tests/e2e/run-edit.sh"
```

- [ ] **Step 6: Run the whole suite**

Run: `cd engine && npm test && npm run typecheck`
Expected: PASS — every test green, no type errors.

Run: `cd engine && LOOP_E2E=1 npm run e2e`
Expected: `PASS: the edit cycle completed and the change landed`. If the leader loops,
skips `verifier`, or halts, that is a real defect in `skills/loop-leader/SKILL.md` or the
agent files — fix the prompt and rerun before committing.

- [ ] **Step 7: Commit**

```bash
git add tests/fixtures tests/e2e engine/tests/integration engine/package.json
git commit -m "test: prove the edit cycle end to end with fixture and opt-in e2e"
```

---

## Milestone Complete

Verify before declaring done:

- [ ] `cd engine && npm test` — all green
- [ ] `cd engine && npm run typecheck` — clean
- [ ] `cd engine && npm run build` — `dist/mcp/server.js` and `dist/cli/index.js` exist
- [ ] `LOOP_E2E=1 npm run e2e` — passes against the real CLI
- [ ] In a scratch project: `/loop:init` then `/loop:edit <small change>` finishes with `status: done`
- [ ] `.loop/runs/<run>/roster.json` exists and names the agents that ran
- [ ] A hand `Write` to `.loop/state.json` is denied by the hook
- [ ] A new session in that project shows the loop line from `SessionStart`

## Next Milestones

| Milestone | Delivers |
|---|---|
| 2 — Build track | `scout`, `builder`, `critic`; multi-cycle judgement; findings folded forward |
| 3 — Fix track | `reproducer`, `investigator`, `hypothesis-tester`, `fixer`; the reproduction gate |
| 4 — Plan track | Plans, stories, `manifest.json`, `INDEX.md`; the 6 plan/story MCP tools |
| 5 — Guards | Stagnation fingerprint, repeated-error guard, autonomous `Stop` hook |
| 6 — UI and specialists | `design-system.md` extraction, `ui-designer`, `ui-critic`, `security`, `docs`, `perf` |
| 7 — Memory and extension | `loop_memory_*`, `/loop:add`, `loop-tracks`, `loop-extend` |
