# MjLoop Quality Cycle Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add project-selectable `economy`, `adaptive`, and `strict` quality modes that minimize tokens first, cost second, and time third without weakening evidence-backed completion or the human gate for destructive decisions.

**Architecture:** Normalize legacy quality booleans into one typed mode, then pin a run-scoped quality policy beside the existing verify and skill pins. Pure analyzers derive risk, context budgets, and required dispatch descriptors; engine-owned stores maintain an immutable policy, mutable evidence ledger, and append-only amendments. Existing run, roster, log, verify, CLI guard, web read/write, and Vue Cockpit seams enforce and display the policy without creating a second execution engine.

**Tech Stack:** Node.js 20+, TypeScript 5.9, Zod 4, Vitest 4, YAML 2, Vue 3, Vite 7, the existing MCP SDK and WebSocket Cockpit, plus focused Stryker mutation testing for the three critical pure gates.

## Global Constraints

- Treat `docs/superpowers/specs/2026-08-04-mjloop-quality-cycle-modes-design.md` as the source of truth.
- Keep the priority order exact: tokens, monetary cost, then elapsed time.
- Keep the fixed agent roles. Use existing roles, `runLog` instances, and dynamically selected skills; do not add a new agent role.
- Every mode must close correctness, security, request alignment, and regression. UI may be `not_applicable` only with a recorded deterministic reason.
- Never let `economy` or `adaptive` lower the close condition; they reduce duplicate work, not required evidence.
- Context-packet ceilings are 8,000 estimated input tokens for `economy`, 12,000 for `adaptive`, and 16,000 for `strict`.
- Use a host tokenizer when supplied; otherwise estimate with `Math.ceil(Buffer.byteLength(text, 'utf8') / 2)` and label the result `estimated`.
- Never invent token counts, model prices, or monetary cost. Use `unavailable`/`null` when the host supplies no measurement and versioned pricing metadata.
- Old `false/false`, one-true, and `true/true` quality booleans normalize to `economy`, `adaptive`, and `strict`. A legacy document with no quality block normalizes to `economy`.
- `/mjloop:init` must write `orchestration.quality.mode: adaptive` explicitly for a new project.
- Reject a config document that mixes `mode` with either legacy boolean. A protected mode write removes both legacy leaves atomically.
- Pin mode, supervision, risk, initial quality plan, and budget at run start. Live config changes must not alter an active run.
- `supervision` is per-run and defaults to `supervised`; `unattended` is explicit and never becomes a project default.
- `quality-policy.json` is immutable. Budget changes append to `quality-amendments.jsonl`; the ledger is engine-owned mutable state.
- A marked current run with a missing or invalid pin halts for integrity; it never falls back to live config.
- `waiting_for_user` and `budget_exhausted` are resumable statuses. They must consume no agent, polling, or summarization tokens while suspended.
- Human approval is mandatory for deleting a feature, dropping/truncating a table, bulk data deletion, irreversible migration, or an irreversible project-wide hazard.
- Do not expose destructive approval or budget amendment as MCP tools. They are operator writes through the existing local control plane.
- The browser never accepts raw YAML or a filesystem path. Config changes continue through revision/CAS, lock, full validation, backup, and atomic rename.
- Keep all server-authored web copy behind closed `WebCode` or locale keys. Update English and Arabic locales together.
- Preserve RTL, keyboard access, screen-reader names, non-color status cues, and the 390px layout.
- Do not automate merge or deploy.
- Work test-first, preserve unrelated dirty changes, and make one atomic commit per task only after its focused tests pass.
- Do not merge any slice until its independent review and focused/full verification gates pass.
- Keep active dispatch/closure behavior behind the internal closed `qualityRuntimeEnabled()` rollout gate through Tasks 1-16. Tests may inject an enabled gate; Task 17 opens the production constant only after the full engine, suspension, and Cockpit paths exist.

## Implementation File Map

### New engine units

- `engine/src/schemas/quality.ts` — closed runtime contracts for modes, risk, policy, ledger, amendments, destructive requests, and operator decisions.
- `engine/src/ops/quality-risk.ts` — pure deterministic scope/risk classifier; never calls a model or writes state.
- `engine/src/ops/quality-budget.ts` — pure budget derivation, token metering, context-packet fitting, and dispatch accounting.
- `engine/src/ops/quality-policy.ts` — build, pin, read, and bootstrap a run policy; owns no UI code.
- `engine/src/ops/quality-capability.ts` — internal rollout gate; closed through Tasks 1-16 and opened only by Task 17.
- `engine/src/ops/quality-ledger.ts` — initialize/update/invalidate the five dimensions and reject incomplete closure.
- `engine/src/ops/quality-roster.ts` — map policy requirements onto existing track agents and run instances.
- `engine/src/ops/destructive-risk.ts` — pure classification of protected commands and feature-removal diffs.
- `engine/src/ops/quality-control.ts` — suspend, decide, amend, and resume under the state lock.
- `engine/src/store/quality-store.ts` — all filesystem I/O for the three engine-owned quality records.
- `engine/src/web/app/components/QualityModeCard.vue` — accessible project-mode option.
- `engine/src/web/app/components/QualityLedgerRow.vue` — one dimension and its evidence/freshness.
- `engine/src/web/app/components/QualityDecisionDialog.vue` — operator approval/refusal for a pinned destructive request.
- `engine/src/web/app/components/QualityBudgetDialog.vue` — explicit per-run budget amendment.

### Existing integration seams

- `engine/src/schemas/config.ts`, `engine/src/store/config-store.ts`, `engine/src/store/config-mutation.ts`, `engine/src/ops/init.ts`, `engine/src/cli/index.ts` — config normalization, migration, explicit new-project default, and CLI setting.
- `engine/src/schemas/state.ts`, `engine/src/ops/run.ts`, `engine/src/ops/roster.ts`, `engine/src/ops/log.ts`, `engine/src/ops/verify.ts`, `engine/src/ops/preflight.ts`, `engine/src/ops/summary.ts` — pinning, enforcement, suspension, closure, and compact status.
- `engine/src/store/paths.ts`, `engine/src/cli/index.ts` — protect policy, ledger, and amendment files and preflight destructive shell input.
- `engine/src/web/read.ts`, `engine/src/web/api.ts`, `engine/src/web/writes.ts`, `engine/src/web/codes.ts`, `engine/src/web/protocol.ts`, `engine/src/web/completion.ts` — bounded read models and the two operator-only write doors.
- `engine/src/web/app/lib/config.ts`, `engine/src/web/app/composables/useRun.ts`, `engine/src/web/app/panels/Config.vue`, `engine/src/web/app/panels/Run.vue`, `engine/src/web/app/panels/Evidence.vue`, locale and style files — Cockpit display and decisions.
- `skills/mjloop-leader/SKILL.md`, `skills/mjloop-state/SKILL.md`, `commands/config.md`, `commands/run.md`, `commands/resume.md`, `commands/status.md` — leader/operator protocol; no new runtime role.

## Dependency Order

```text
T1 -> T2 -> T3 -> T4
                |-> T5 -> T6 -> T7
                            |-> T8 -> T9 -> T10
                                      |-> T11 -> T12 -> T13
T7 + T10 + T13 ---------------------->|-> T14 -> T15 -> T16
T1..T16 -------------------------------------------> T17 -> T18
```

---

## Slice 1 — Policy Foundation

### Task 1: Normalize the quality configuration contract

**Files:**
- Modify: `engine/src/schemas/config.ts:388-492,666-675,913-915`
- Modify: `engine/src/store/config-store.ts:1-48`
- Test: `engine/tests/schemas/config.test.ts`
- Test: `engine/tests/store/config-store.test.ts`

**Interfaces:**
- Consumes: the existing `OrchestrationSchema`, `ConfigSchema`, and `loadConfig(projectDir)`.
- Produces:
  - `QualityModeSchema`, `QualityMode = 'economy' | 'adaptive' | 'strict'`
  - `QualityConfigSource = 'explicit' | 'legacy' | 'default-existing'`
  - `loadConfigRecord(projectDir): Promise<{ config: Config; qualitySource: QualityConfigSource }>`
  - `Config['orchestration']['quality']` normalized to `{ mode: QualityMode }`

- [ ] **Step 1: Write failing schema and loader tests**

```ts
it.each([
  [{ independent_plan_review: false, independent_verification: false }, 'economy'],
  [{ independent_plan_review: true, independent_verification: false }, 'adaptive'],
  [{ independent_plan_review: false, independent_verification: true }, 'adaptive'],
  [{ independent_plan_review: true, independent_verification: true }, 'strict'],
] as const)('normalizes legacy quality %j to %s', (quality, mode) => {
  const parsed = ConfigSchema.parse({ version: 1, tracks: MINIMAL_TRACKS, orchestration: { quality } })
  expect(parsed.orchestration.quality).toEqual({ mode })
})

it('rejects mode mixed with a legacy quality boolean', () => {
  const quality = { mode: 'adaptive', independent_plan_review: true }
  expect(ConfigSchema.safeParse({ version: 1, tracks: MINIMAL_TRACKS, orchestration: { quality } }).success).toBe(false)
})

it('reports whether a loaded mode was explicit, legacy, or absent', async () => {
  await writeRaw(project.dir, 'orchestration:\n  quality:\n    mode: strict\n')
  expect((await loadConfigRecord(project.dir)).qualitySource).toBe('explicit')
})
```

- [ ] **Step 2: Run the focused tests and confirm the old shape fails**

Run: `cd engine && npx vitest run tests/schemas/config.test.ts tests/store/config-store.test.ts`

Expected: FAIL because `quality.mode`, `QualityModeSchema`, and `loadConfigRecord` do not exist.

- [ ] **Step 3: Implement the closed union and source-preserving loader**

```ts
export const QualityModeSchema = z.enum(['economy', 'adaptive', 'strict'])
const ExplicitQualitySchema = z.strictObject({ mode: QualityModeSchema })
const LegacyQualitySchema = z.strictObject({
  independent_plan_review: z.boolean().default(false),
  independent_verification: z.boolean().default(false),
})

const QualityConfigSchema = z.union([ExplicitQualitySchema, LegacyQualitySchema]).transform((quality) => {
  if ('mode' in quality) return quality
  const count = Number(quality.independent_plan_review) + Number(quality.independent_verification)
  return { mode: count === 0 ? 'economy' : count === 2 ? 'strict' : 'adaptive' }
})
```

In `loadConfigRecord`, inspect the parsed YAML object with own-property checks before `ConfigSchema.parse`; return `explicit` for `mode`, `legacy` for either old boolean, and `default-existing` otherwise. Keep `loadConfig` as a compatibility wrapper returning `.config`.

- [ ] **Step 4: Make new configs explicit without changing old absent configs**

```ts
export function defaultConfig(verify: Verify): Config {
  return ConfigSchema.parse({
    version: 1,
    verify,
    tracks: DEFAULT_TRACKS,
    orchestration: { quality: { mode: 'adaptive' } },
  })
}
```

- [ ] **Step 5: Run focused tests**

Run: `cd engine && npx vitest run tests/schemas/config.test.ts tests/store/config-store.test.ts tests/ops/init.test.ts`

Expected: PASS; absent old documents read as `economy`, while a newly initialized config serializes `mode: adaptive`.

- [ ] **Step 6: Commit**

```bash
git add engine/src/schemas/config.ts engine/src/store/config-store.ts engine/tests/schemas/config.test.ts engine/tests/store/config-store.test.ts engine/tests/ops/init.test.ts
git commit -m "feat(config): normalize quality modes"
```

### Task 2: Migrate quality settings through the guarded mutation and CLI

**Files:**
- Modify: `engine/src/store/config-mutation.ts:25-123,148-263`
- Modify: `engine/src/cli/index.ts:187-285`
- Modify: `commands/config.md:45-65`
- Test: `engine/tests/store/config-mutation.test.ts`
- Test: `engine/tests/cli/index.test.ts`
- Test: `engine/tests/plugin/commands.test.ts`

**Interfaces:**
- Consumes: `QualityModeSchema`, `loadConfigRecord` from Task 1.
- Produces: `ConfigChange = { kind: 'orchestration.quality.mode'; value: QualityMode }`; the mutation deletes both legacy leaves before setting `mode`.

- [ ] **Step 1: Write failing atomic-migration tests**

```ts
it('replaces both legacy quality booleans with one mode in the same CAS write', async () => {
  await seedLegacyQuality(project.dir, true, false)
  const raw = await fs.readFile(configFile(project.dir), 'utf8')
  await mutateConfig(project.dir, {
    revision: configRevision(raw),
    changes: [{ kind: 'orchestration.quality.mode', value: 'strict' }],
  })
  const next = await fs.readFile(configFile(project.dir), 'utf8')
  expect(next).toContain('mode: strict')
  expect(next).not.toContain('independent_plan_review')
  expect(next).not.toContain('independent_verification')
})
```

Add CLI assertions for `config set orchestration.quality.mode strict`, invalid `fast`, and removal of the two old dotted keys from the accepted key list.

- [ ] **Step 2: Run focused tests**

Run: `cd engine && npx vitest run tests/store/config-mutation.test.ts tests/cli/index.test.ts tests/plugin/commands.test.ts`

Expected: FAIL because the new change kind and CLI key are unknown.

- [ ] **Step 3: Implement the one typed mutation**

```ts
z.strictObject({
  kind: z.literal('orchestration.quality.mode'),
  value: QualityModeSchema,
})
```

```ts
case 'orchestration.quality.mode':
  document.deleteIn(['orchestration', 'quality', 'independent_plan_review'])
  document.deleteIn(['orchestration', 'quality', 'independent_verification'])
  document.setIn(['orchestration', 'quality', 'mode'], change.value)
  return
```

Replace the two boolean CLI settings with one `asWord` setting and document only the three allowed values.

- [ ] **Step 4: Run focused tests**

Run: `cd engine && npx vitest run tests/store/config-mutation.test.ts tests/cli/index.test.ts tests/plugin/commands.test.ts`

Expected: PASS, including comment preservation, `.bak` creation, stale revision refusal, and whole-document validation.

- [ ] **Step 5: Commit**

```bash
git add engine/src/store/config-mutation.ts engine/src/cli/index.ts commands/config.md engine/tests/store/config-mutation.test.ts engine/tests/cli/index.test.ts engine/tests/plugin/commands.test.ts
git commit -m "feat(config): migrate quality mode writes"
```

### Task 3: Define quality runtime records and resumable state

**Files:**
- Create: `engine/src/schemas/quality.ts`
- Modify: `engine/src/schemas/index.ts`
- Modify: `engine/src/schemas/state.ts:12-123,126-148`
- Create: `engine/tests/schemas/quality.test.ts`
- Test: `engine/tests/schemas/state.test.ts`

**Interfaces:**
- Consumes: `QualityModeSchema` from Task 1 and existing `EvidenceSchema`, `IdSchema`.
- Produces the exact exported schemas/types used by Tasks 4-16:

```ts
export type QualityDimension = 'correctness' | 'security' | 'alignment' | 'regression' | 'ui'
export type QualityVerdict = 'pending' | 'pass' | 'fail' | 'blocked' | 'not_applicable'
export type Supervision = 'supervised' | 'unattended'
export type QualityEnforcement = 'shadow' | 'active'
export type MeasurementKind = 'measured' | 'estimated' | 'unavailable'
export type RiskLevel = 'low' | 'medium' | 'high'
export type QualityBudget = z.infer<typeof QualityBudgetSchema>
export type QualityDispatch = z.infer<typeof QualityDispatchSchema>
export type QualityPolicy = z.infer<typeof QualityPolicySchema>
export type QualityLedger = z.infer<typeof QualityLedgerSchema>
export type QualityAmendment = z.infer<typeof QualityAmendmentSchema>
export type DestructiveRequest = z.infer<typeof DestructiveRequestSchema>
```

- [ ] **Step 1: Write failing strict-schema tests**

```ts
it('requires exactly the five quality dimensions', () => {
  const parsed = QualityLedgerSchema.safeParse(ledgerFixture({ ui: undefined }))
  expect(parsed.success).toBe(false)
})

it('accepts a one-way budget amendment and rejects a decrease', () => {
  expect(QualityAmendmentSchema.safeParse(amendment({ from: 18, to: 24 })).success).toBe(true)
  expect(QualityAmendmentSchema.safeParse(amendment({ from: 18, to: 12 })).success).toBe(false)
})

it.each(['waiting_for_user', 'budget_exhausted'] as const)('accepts resumable status %s', (status) => {
  expect(StateSchema.safeParse({ ...initialState(NOW), status }).success).toBe(true)
})
```

- [ ] **Step 2: Run schema tests**

Run: `cd engine && npx vitest run tests/schemas/quality.test.ts tests/schemas/state.test.ts`

Expected: FAIL because the quality schema and state fields do not exist.

- [ ] **Step 3: Implement strict versioned schemas**

Define `QualityPolicySchema` with `version: 1`, `mode`, `supervision`, `enforcement`, `source`, `risk`, `budget`, `initial_quality_plan`, and `dispatches`. `enforcement` is `active` only when Task 1 reports an explicit mode; legacy and absent existing documents receive `shadow` so opening an old project cannot silently introduce new closure gates. Define each dispatch as `{ agent, instance, dimensions, reason }`, with `instance` nullable. Define ledger entries exactly as the design: applicability, verdict, evidence kinds/refs, reason, input fingerprint, checked/invalidated times. Define append-only amendment and destructive request/decision records with run id and operation fingerprint.

Extend state with:

```ts
export const StatusSchema = z.enum([
  'idle', 'running', 'paused', 'waiting_for_user', 'budget_exhausted', 'halted', 'done', 'failed',
])

quality_policy_version: z.literal(1).nullable().default(null),
```

Keep `current.stage` unchanged during resumable suspension.

- [ ] **Step 4: Run schema tests**

Run: `cd engine && npx vitest run tests/schemas/quality.test.ts tests/schemas/state.test.ts`

Expected: PASS, including unknown-key rejection and backward defaults for state files predating the marker.

- [ ] **Step 5: Commit**

```bash
git add engine/src/schemas/quality.ts engine/src/schemas/index.ts engine/src/schemas/state.ts engine/tests/schemas/quality.test.ts engine/tests/schemas/state.test.ts
git commit -m "feat(engine): define quality runtime contracts"
```

### Task 4: Store and protect run-scoped quality records

**Files:**
- Create: `engine/src/store/quality-store.ts`
- Modify: `engine/src/store/paths.ts:3-22,119-155`
- Modify: `engine/src/cli/index.ts:1803-1895`
- Create: `engine/tests/store/quality-store.test.ts`
- Test: `engine/tests/cli/index.test.ts`

**Interfaces:**
- Consumes: Task 3 schemas, `runDirPath`, `writeJsonAtomic`, `readJsonValidated`, and the project lock.
- Produces:

```ts
export const QUALITY_POLICY_FILE = 'quality-policy.json'
export const QUALITY_LEDGER_FILE = 'quality-ledger.json'
export const QUALITY_AMENDMENTS_FILE = 'quality-amendments.jsonl'

export function qualityFiles(projectDir: string, state: State): QualityFiles
export async function writePolicyOnce(projectDir: string, state: State, policy: QualityPolicy): Promise<void>
export async function readPolicy(projectDir: string, state: State): Promise<QualityPolicy>
export async function writeLedger(projectDir: string, state: State, ledger: QualityLedger): Promise<void>
export async function readLedger(projectDir: string, state: State): Promise<QualityLedger>
export async function appendAmendment(projectDir: string, state: State, amendment: QualityAmendment): Promise<void>
export async function readAmendments(projectDir: string, state: State): Promise<QualityAmendment[]>
```

- [ ] **Step 1: Write failing store and guard tests**

```ts
it('writes the policy once and refuses replacement', async () => {
  await writePolicyOnce(project.dir, state, policy())
  await expect(writePolicyOnce(project.dir, state, policy({ mode: 'strict' }))).rejects.toBeInstanceOf(QualityPolicyExistsError)
})

it.each(['quality-policy.json', 'quality-ledger.json', 'quality-amendments.jsonl'])('denies agent edits to %s', (name) => {
  expect(evaluateStateGuard({ tool_name: 'Edit', tool_input: { file_path: `/repo/.mjloop/runs/r/${name}` } }).deny).toBe(true)
})
```

- [ ] **Step 2: Run focused tests**

Run: `cd engine && npx vitest run tests/store/quality-store.test.ts tests/cli/index.test.ts`

Expected: FAIL because quality paths/stores are missing and the guard allows them.

- [ ] **Step 3: Implement engine-owned I/O**

Use `flag: 'wx'` for the immutable policy. Use `writeJsonAtomic` with backup for the ledger. Serialize each amendment as one validated JSON line under the project lock, rejecting a malformed existing line before append. Add all three basenames to `PROTECTED_BASENAMES`; do not add a new hook.

- [ ] **Step 4: Run focused tests**

Run: `cd engine && npx vitest run tests/store/quality-store.test.ts tests/cli/index.test.ts tests/store/atomic.test.ts`

Expected: PASS; the immutable pin refuses overwrite, ledger recovers from `.bak`, amendments preserve order, and hand edits are denied.

- [ ] **Step 5: Commit**

```bash
git add engine/src/store/quality-store.ts engine/src/store/paths.ts engine/src/cli/index.ts engine/tests/store/quality-store.test.ts engine/tests/cli/index.test.ts
git commit -m "feat(engine): store protected quality records"
```

---

## Slice 2 — Quality Engine

### Task 5: Build the deterministic risk and applicability analyzer

**Files:**
- Create: `engine/src/ops/quality-risk.ts`
- Create: `engine/tests/ops/quality-risk.test.ts`
- Create: `engine/tests/fixtures/quality/scenarios.ts`

**Interfaces:**
- Consumes: Task 3 `QualityDimension`, `RiskLevel`, and the accepted project profile/feature brief shapes.
- Produces:

```ts
export interface QualityRiskInput {
  track: string
  goal: string
  acceptance: string[]
  intendedFiles: string[]
  changedFiles: string[]
  componentKinds: string[]
  priorFailures: string[]
}

export interface QualityAnalysis {
  level: RiskLevel
  signals: { code: string; level: RiskLevel; evidence: string[] }[]
  applicability: Record<QualityDimension, { value: 'required' | 'not_applicable'; reason: string }>
}

export function analyzeQualityRisk(input: QualityRiskInput): QualityAnalysis
```

- [ ] **Step 1: Write failing scenario tests**

```ts
it.each([
  ['backend-only', backendScenario(), 'not_applicable'],
  ['rtl-component', rtlScenario(), 'required'],
] as const)('%s classifies UI applicability', (_name, input, expected) => {
  expect(analyzeQualityRisk(input).applicability.ui.value).toBe(expected)
})

it('raises database deletion and authorization changes to high risk', () => {
  const result = analyzeQualityRisk(databaseDropAndAuthScenario())
  expect(result.level).toBe('high')
  expect(result.signals.map((signal) => signal.code)).toEqual(expect.arrayContaining(['data.destructive', 'security.authorization']))
})
```

Cover backend-only, auth/permissions, API boundary, RTL/UI, schema migration, feature deletion wording, build config, multiple components, ambiguous acceptance, and a repeated prior failure.

- [ ] **Step 2: Run the analyzer test**

Run: `cd engine && npx vitest run tests/ops/quality-risk.test.ts`

Expected: FAIL because `analyzeQualityRisk` does not exist.

- [ ] **Step 3: Implement pure tables and monotonic severity**

```ts
const SIGNALS: readonly SignalRule[] = [
  { code: 'security.authorization', level: 'high', path: /(^|\/)(auth|permissions?|polic(?:y|ies))(\/|\.|$)/i },
  { code: 'data.schema', level: 'medium', path: /(^|\/)(migrations?|schema|database)(\/|\.|$)/i },
  { code: 'ui.surface', level: 'medium', path: /\.(vue|tsx|jsx|css|scss|dart)$/i },
  { code: 'build.configuration', level: 'medium', path: /(^|\/)(package\.json|tsconfig.*\.json|vite\.config\.)/i },
]

const RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 }
```

Use exact normalized path/acceptance inputs, deduplicate signal codes, sort output, and derive the final level with `Math.max`. Always require correctness, security, alignment, and regression. Mark UI not applicable only when no path, component, goal, or acceptance signal points to a user-visible surface.

- [ ] **Step 4: Run focused tests**

Run: `cd engine && npx vitest run tests/ops/quality-risk.test.ts`

Expected: PASS with deterministic ordering and no filesystem/model calls.

- [ ] **Step 5: Commit**

```bash
git add engine/src/ops/quality-risk.ts engine/tests/ops/quality-risk.test.ts engine/tests/fixtures/quality/scenarios.ts
git commit -m "feat(engine): analyze quality risk deterministically"
```

### Task 6: Derive token, dispatch, repair, and cost budgets

**Files:**
- Create: `engine/src/ops/quality-budget.ts`
- Create: `engine/tests/ops/quality-budget.test.ts`

**Interfaces:**
- Consumes: mode, track `max_cycles`/closing agents, repair attempts, quality dispatch descriptors, and optional host measurements.
- Produces:

```ts
export interface TokenMeasurement { value: number | null; kind: MeasurementKind }
export interface Tokenizer { count(text: string): number }
export function measureTokens(text: string, tokenizer?: Tokenizer): TokenMeasurement
export function contextCeiling(mode: QualityMode, hostSafeInput?: number): number
export function deriveQualityBudget(input: BudgetInput): QualityBudget
export function fitContextPacket(input: ContextPacketInput): ContextPacketResult
export function effectiveBudget(policy: QualityPolicy, amendments: QualityAmendment[]): QualityBudget
export function compareQualityCandidates(a: QualityCandidate, b: QualityCandidate): number
```

- [ ] **Step 1: Write failing budget tests**

```ts
it.each([
  ['economy', 8_000], ['adaptive', 12_000], ['strict', 16_000],
] as const)('pins %s context to %d tokens', (mode, expected) => {
  expect(contextCeiling(mode)).toBe(expected)
})

it('uses the documented conservative fallback when no tokenizer exists', () => {
  const text = 'واجهة عربية'
  expect(measureTokens(text)).toEqual({ value: Math.ceil(Buffer.byteLength(text, 'utf8') / 2), kind: 'estimated' })
})

it('never drops mandatory context to fit a ceiling', () => {
  expect(fitContextPacket(packet({ mandatory: ['x'.repeat(40)], ceiling: 10 })).status).toBe('budget_exhausted')
})

it('orders valid candidates by tokens, then cost, then time', () => {
  const candidates = [slowerCheapCandidate(), fastExpensiveCandidate(), lowestTokenCandidate()]
  expect(candidates.sort(compareQualityCandidates)[0].id).toBe('lowest-token')
})
```

- [ ] **Step 2: Run the focused test**

Run: `cd engine && npx vitest run tests/ops/quality-budget.test.ts`

Expected: FAIL because the budget module is absent.

- [ ] **Step 3: Implement pure derivation**

Count `max_dispatches` as the initial dispatch descriptors plus only the targeted repair descriptors permitted by `repair_attempts`, plus closing agents once. Fit context by retaining all mandatory sections, then stable-sorting optional evidence digests by relevance and removing the lowest relevance until the packet fits. Compare only candidates that satisfy the same required dimensions: estimated/measured input-token upper bound first, known monetary cost second, and known elapsed time third, followed by a stable id tie-break. Never rank an unavailable value as zero; when price or time is unavailable, report that fact and use explicitly labeled dispatch-count or sequential-wave proxies only within that tied dimension. Return `cost_estimate: null` unless model id, measured input/output token counts, currency, unit prices, and pricing-table version are all supplied.

```ts
export function contextCeiling(mode: QualityMode, hostSafeInput?: number): number {
  const profile = { economy: 8_000, adaptive: 12_000, strict: 16_000 }[mode]
  return hostSafeInput === undefined ? profile : Math.min(profile, hostSafeInput)
}
```

- [ ] **Step 4: Run focused tests**

Run: `cd engine && npx vitest run tests/ops/quality-budget.test.ts`

Expected: PASS, including no-cost-metadata, tokenizer, fallback, required-context overflow, amendment ordering, and dispatch ceiling cases.

- [ ] **Step 5: Commit**

```bash
git add engine/src/ops/quality-budget.ts engine/tests/ops/quality-budget.test.ts
git commit -m "feat(engine): derive quality budgets"
```

### Task 7: Build, pin, preview, and bootstrap the run policy

**Files:**
- Create: `engine/src/ops/quality-policy.ts`
- Create: `engine/src/ops/quality-capability.ts`
- Modify: `engine/src/ops/run.ts:64-214`
- Modify: `engine/src/ops/preflight.ts:41-130`
- Modify: `engine/src/store/config-mutation.ts:148-190`
- Modify: `engine/src/mcp/server.ts:98-132,794-818`
- Create: `engine/tests/ops/quality-policy.test.ts`
- Test: `engine/tests/ops/run.test.ts`
- Test: `engine/tests/ops/preflight.test.ts`
- Test: `engine/tests/mcp/server.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3-6, current story/feature/profile readers, `worktreeDigest`, and `StateStore`.
- Produces:

```ts
export interface QualityPolicyInput extends QualityRiskInput {
  config: Config
  qualitySource: QualityConfigSource
  supervision: Supervision
  track: Track
}

export interface QualityPolicyPreview {
  policy: QualityPolicy
  forecast: {
    inputTokens: TokenMeasurement
    outputTokens: TokenMeasurement
    cost: { kind: MeasurementKind; currency: string | null; value: number | null }
    elapsed: { kind: MeasurementKind; valueMs: number | null }
  }
}

export async function buildQualityPolicy(input: QualityPolicyInput, now: Clock): Promise<QualityPolicy>
export async function previewQualityPolicies(projectDir: string, input: PreflightInput): Promise<Record<QualityMode, QualityPolicyPreview>>
export async function ensureRunQualityPolicy(projectDir: string, now?: Clock): Promise<QualityPolicy>
export function createInitialQualityLedger(policy: QualityPolicy, now: Clock): QualityLedger
export function classifyPolicyIntegrity(input: {
  marker: 1 | null
  policy: 'missing' | 'valid' | 'invalid'
  ledger: 'missing' | 'valid' | 'invalid'
}): 'legacy-bootstrap' | 'recover-marker' | 'ready' | 'halt'
export function qualityRuntimeEnabled(): boolean
```

- [ ] **Step 1: Write failing pinning and legacy-bootstrap tests**

```ts
it('pins an explicit adaptive run as active and ignores a later config change', async () => {
  const state = await runStart(project.dir, { track: 'build', goal: 'Add the dashboard', supervision: 'unattended' }, clock)
  await setQualityMode(project.dir, 'strict')
  const pinned = await readPolicy(project.dir, state)
  expect(pinned).toMatchObject({ mode: 'adaptive', supervision: 'unattended', enforcement: 'active' })
})

it('bootstraps a pre-feature active run once before a quality config mutation', async () => {
  await seedLegacyRunningState(project.dir)
  await setQualityMode(project.dir, 'strict')
  expect((await new StateStore(project.dir).get()).quality_policy_version).toBe(1)
  expect((await readCurrentPolicy(project.dir)).source).toBe('legacy')
})
```

Add tests for marker-with-missing-pin integrity halt, pin-with-null-marker recovery, `supervision` defaulting to `supervised`, and all three preflight previews.

- [ ] **Step 2: Run focused tests**

Run: `cd engine && npx vitest run tests/ops/quality-policy.test.ts tests/ops/run.test.ts tests/ops/preflight.test.ts tests/mcp/server.test.ts`

Expected: FAIL because policies are neither built nor pinned and `runStart` has no supervision input.

- [ ] **Step 3: Implement policy construction and rollout source**

Set `enforcement: 'active'` only when `qualitySource === 'explicit'`; use `shadow` for legacy/default-existing projects so an upgrade cannot alter their dispatch behavior. New projects are active because Task 1 makes init write an explicit adaptive mode.

Keep `qualityRuntimeEnabled()` returning `false` in production during Tasks 7-16. Treat `policy.enforcement` as the pinned opt-in intent and the capability as release readiness; both must be active before behavior changes. Unit/integration seams may inject `true` to build and test the complete path before release.

```ts
const enforcement = input.qualitySource === 'explicit' ? 'active' : 'shadow'
return QualityPolicySchema.parse({
  version: 1,
  pinned_at: now().toISOString(),
  mode: input.config.orchestration.quality.mode,
  supervision: input.supervision,
  source: input.qualitySource === 'explicit' ? 'explicit' : 'legacy',
  enforcement,
  risk: analysis,
  budget,
  initial_quality_plan: analysis.applicability,
  dispatches,
})
```

- [ ] **Step 4: Pin safely in `runStart` and bootstrap safely on resume**

Set `quality_policy_version = 1` in the initial state update, create the run directory, then write the policy and a schema-validated initial ledger before returning. `createInitialQualityLedger` maps the five pinned applicability decisions to `pending` or `not_applicable`; Task 8 adds later transition logic rather than duplicating initialization. Centralize the marker/policy/ledger truth table in the pure `classifyPolicyIntegrity` function and cover every combination. If either new-run write fails, mark the run halted with an integrity reason. For a legacy active state with a null marker, `ensureRunQualityPolicy` writes a shadow policy and its initial ledger while the state lock is held, then sets the marker. If both records already exist, validate them and only set the marker. A policy without its ledger is an integrity halt. Call this bootstrap before a guarded mode mutation.

Extend the MCP input with:

```ts
supervision: z.enum(['supervised', 'unattended']).optional().default('supervised')
```

- [ ] **Step 5: Extend preflight without starting a run**

Add `quality: { selected: QualityPolicyPreview; comparisons: Record<QualityMode, QualityPolicyPreview> }` to `Preflight`. Preview uses the same pure analyzer/budget/candidate-order path, labels every token/cost/time value measured, estimated, or unavailable, never writes a pin, and keeps historical comparable ranges unchanged.

- [ ] **Step 6: Run focused tests**

Run: `cd engine && npx vitest run tests/ops/quality-policy.test.ts tests/ops/run.test.ts tests/ops/preflight.test.ts tests/mcp/server.test.ts tests/store/config-mutation.test.ts`

Expected: PASS; policy and ledger exist before the first dispatch, active runs ignore config drift, and legacy runs bootstrap once.

- [ ] **Step 7: Commit**

```bash
git add engine/src/ops/quality-policy.ts engine/src/ops/quality-capability.ts engine/src/ops/run.ts engine/src/ops/preflight.ts engine/src/store/config-mutation.ts engine/src/mcp/server.ts engine/tests/ops/quality-policy.test.ts engine/tests/ops/run.test.ts engine/tests/ops/preflight.test.ts engine/tests/mcp/server.test.ts engine/tests/store/config-mutation.test.ts
git commit -m "feat(engine): pin run quality policy"
```

### Task 8: Maintain and invalidate the five-dimension evidence ledger

**Files:**
- Create: `engine/src/ops/quality-ledger.ts`
- Modify: `engine/src/store/quality-store.ts`
- Create: `engine/tests/ops/quality-ledger.test.ts`
- Test: `engine/tests/store/quality-store.test.ts`

**Interfaces:**
- Consumes: Task 3 ledger schema, Task 4 store, Task 7 policy/initial ledger, and `worktreeDigest`.
- Produces:

```ts
export interface QualityEvidenceInput {
  dimension: QualityDimension
  verdict: Exclude<QualityVerdict, 'not_applicable'>
  evidenceKinds: ('command' | 'test' | 'agent' | 'human')[]
  evidenceRefs: string[]
  reason: string
  criteria: string[]
  changedFiles: string[]
  worktree: string | null
}

export interface QualityChange {
  files: string[]
  criteriaChanged: boolean
  goalChanged?: boolean
  commandsChanged?: boolean
}

export async function recordQualityEvidence(projectDir: string, state: State, input: QualityEvidenceInput, now?: Clock): Promise<QualityLedger>
export async function invalidateQualityEvidence(projectDir: string, state: State, change: QualityChange, now?: Clock): Promise<QualityLedger>
export function closingViolations(policy: QualityPolicy, ledger: QualityLedger): string[]
export function assertQualityCloseable(policy: QualityPolicy, ledger: QualityLedger): void
```

- [ ] **Step 1: Write failing close and invalidation tests**

```ts
it.each(['correctness', 'security', 'alignment', 'regression'] as const)('refuses close when %s is not passing', (dimension) => {
  const ledger = passingLedger()
  ledger.dimensions[dimension].status = 'pending'
  expect(() => assertQualityCloseable(policy(), ledger)).toThrow(dimension)
})

it('keeps unrelated database evidence when only a UI file changes', async () => {
  const next = await invalidateQualityEvidence(project.dir, state, { files: ['src/Button.vue'], criteriaChanged: false })
  expect(next.dimensions.security.status).toBe('pass')
  expect(next.dimensions.ui.status).toBe('pending')
})
```

Also test blocked tools, stale fingerprints, contradicted evidence, UI not-applicable becoming required, and no reuse when `worktreeDigest` is null.

- [ ] **Step 2: Run the focused tests**

Run: `cd engine && npx vitest run tests/ops/quality-ledger.test.ts tests/store/quality-store.test.ts`

Expected: FAIL because the ledger operations do not exist.

- [ ] **Step 3: Implement engine-owned transitions**

Compute `inputs_fingerprint` from canonical JSON containing dimension, criteria, sorted changed files, evidence refs, and worktree digest. When git cannot supply a digest, include a run/cycle nonce so the evidence cannot be reused in a later cycle. Never let agent input write `not_applicable`; only the analyzer initializes or raises applicability.

```ts
export function assertQualityCloseable(policy: QualityPolicy, ledger: QualityLedger): void {
  const violations = closingViolations(policy, ledger)
  if (violations.length > 0) throw new QualityIncompleteError(violations)
}
```

- [ ] **Step 4: Run focused tests**

Run: `cd engine && npx vitest run tests/ops/quality-ledger.test.ts tests/store/quality-store.test.ts`

Expected: PASS with stable fingerprints, selective invalidation, and explicit reason/evidence references for every verdict.

- [ ] **Step 5: Commit**

```bash
git add engine/src/ops/quality-ledger.ts engine/src/store/quality-store.ts engine/tests/ops/quality-ledger.test.ts engine/tests/store/quality-store.test.ts
git commit -m "feat(engine): enforce quality evidence ledger"
```

### Task 9: Translate mode policy into existing agents and dispatch instances

**Files:**
- Create: `engine/src/ops/quality-roster.ts`
- Modify: `engine/src/ops/roster.ts:155-330`
- Modify: `engine/src/schemas/contract.ts:65-91`
- Modify: `engine/src/web/codes.ts`
- Create: `engine/tests/ops/quality-roster.test.ts`
- Test: `engine/tests/ops/roster.test.ts`

**Interfaces:**
- Consumes: `QualityPolicy.dispatches`, current `Track`, permitted/forbidden specialists, and `runLog`'s existing `instance` support.
- Produces:

```ts
export interface PlannedQualityDispatch extends QualityDispatch {
  inputFingerprint: string
  context: ContextPacketResult
}

export function planQualityDispatches(input: QualityRosterInput): PlannedQualityDispatch[]
export function qualityRosterViolations(dispatches: PlannedQualityDispatch[], selected: readonly string[]): RosterViolation[]
// Add to rosterSet result:
quality_dispatches: PlannedQualityDispatch[]
```

- [ ] **Step 1: Write failing mode-behavior tests**

```ts
it('economy uses one verifier when deterministic evidence is sufficient', () => {
  expect(planQualityDispatches(input({ mode: 'economy', risk: 'low' })).filter((d) => d.agent === 'verifier')).toHaveLength(1)
})

it('strict adds an independent verifier instance without adding an agent role', () => {
  expect(planQualityDispatches(input({ mode: 'strict' }))).toContainEqual(expect.objectContaining({
    agent: 'verifier', instance: 'independent',
  }))
})

it('falls back to a verifier instance when the track has no security role', () => {
  expect(planQualityDispatches(editSecurityInput())).toContainEqual(expect.objectContaining({
    agent: 'verifier', instance: 'security', dimensions: ['security'],
  }))
})
```

- [ ] **Step 2: Run focused tests**

Run: `cd engine && npx vitest run tests/ops/quality-roster.test.ts tests/ops/roster.test.ts`

Expected: FAIL because roster output has no quality dispatch plan.

- [ ] **Step 3: Implement role resolution and enforcement**

Prefer a permitted matching specialist (`security`, `ui-critic`, `critic`, `plan-critic`, `story-critic`). If none exists, use `verifier` with a stable instance name. In adaptive mode add independent dispatches only for medium/high signals. In strict mode add an independent verifier and every applicable specialist. Stable-sort by current track waves, then agent and instance. Build each dispatch context through Task 6's `fitContextPacket`; include only the relevant goal/criteria, role contract, component/file map, last decisive evidence/failure, reason, and output contract. Return the bounded packet plus its fingerprint in `rosterSet`; never include the conversation transcript or raw tool output.

Add a `roster.quality` violation when the selected base-agent set omits a required quality dispatch. Shadow policies, and active policies while `qualityRuntimeEnabled()` is still closed, return the existing roster behavior and include counterfactual `quality_dispatches` only in the result.

- [ ] **Step 4: Run focused tests**

Run: `cd engine && npx vitest run tests/ops/quality-roster.test.ts tests/ops/roster.test.ts tests/web/locales.test.ts`

Expected: PASS; no new agent file exists, and all dispatches resolve to a permitted base role or a verifier instance.

- [ ] **Step 5: Commit**

```bash
git add engine/src/ops/quality-roster.ts engine/src/ops/roster.ts engine/src/schemas/contract.ts engine/src/web/codes.ts engine/tests/ops/quality-roster.test.ts engine/tests/ops/roster.test.ts
git commit -m "feat(engine): plan mode-aware quality dispatches"
```

### Task 10: Record quality results and refuse unsupported closure

**Files:**
- Modify: `engine/src/ops/log.ts:219-490,645-790`
- Modify: `engine/src/ops/verify.ts:250-335,618-700`
- Modify: `engine/src/ops/run.ts:404-620`
- Test: `engine/tests/ops/log.test.ts`
- Test: `engine/tests/ops/verify.test.ts`
- Test: `engine/tests/ops/run.test.ts`

**Interfaces:**
- Consumes: Tasks 7-9 policy/ledger/dispatch APIs and the existing engine verify ledger.
- Produces:

```ts
export async function recordDispatchResult(
  projectDir: string,
  state: State,
  dispatch: { agent: string; instance: string | null },
  result: AgentResult,
  now?: Clock,
): Promise<void>

export async function assertRunCanPass(projectDir: string, state: State): Promise<void>
```

- [ ] **Step 1: Write failing integration-at-the-seam tests**

```ts
it('does not let a passing agent override a red engine verify receipt', async () => {
  await seedFailedVerifyLedger(project.dir, 'npm test')
  await expect(runLog(project.dir, passingVerifier('npm test'), clock)).rejects.toBeInstanceOf(ContradictedEvidenceError)
  expect((await readLedger(project.dir, state)).dimensions.regression.status).not.toBe('pass')
})

it('refuses cycle pass while any required dimension is pending or blocked', async () => {
  await seedLedger(project.dir, ledgerWith({ security: 'blocked' }))
  await expect(cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'pass' }, clock)).rejects.toThrow(/security/)
})

it('rejects a repeated dispatch with the same input fingerprint and no new information', async () => {
  await logDispatch(project.dir, 'verifier', 'independent')
  await expect(logDispatch(project.dir, 'verifier', 'independent')).rejects.toBeInstanceOf(DuplicateQualityDispatchError)
})
```

- [ ] **Step 2: Run focused tests**

Run: `cd engine && npx vitest run tests/ops/log.test.ts tests/ops/verify.test.ts tests/ops/run.test.ts`

Expected: FAIL because result logging does not update the quality ledger and `cycleAdvance` trusts the caller's pass.

- [ ] **Step 3: Integrate results without widening agent authority**

After existing contract, permission, gate, order, and counter-evidence checks pass, match `{agent, instance}` against the pinned dispatch plan. Record evidence only for dimensions assigned to that dispatch. A pass with only file evidence cannot satisfy a dimension requiring command/test evidence. Feed completed engine verify digests into correctness/regression/security as declared by the policy; `queued` and `running` are blocked/pending, never evidence.

- [ ] **Step 4: Guard the terminal transition**

Call `assertRunCanPass` before the locked `cycleAdvance` update accepts `input.result === 'pass'` only when policy intent and the internal rollout gate are both active; shadow runs continue the existing closure path while still recording counterfactual telemetry. Re-read policy and ledger after acquiring the state lock or protect them with matching fingerprints so a stale pre-lock read cannot close the run. On failed cycles, invalidate only dimensions affected by new files/criteria and preserve unrelated passing entries.

- [ ] **Step 5: Run focused tests**

Run: `cd engine && npx vitest run tests/ops/log.test.ts tests/ops/verify.test.ts tests/ops/run.test.ts tests/integration/build-cycle.test.ts tests/integration/fix-cycle.test.ts tests/integration/plan-track.test.ts`

Expected: PASS; `done` is impossible with missing, blocked, stale, or contradicted required evidence.

- [ ] **Step 6: Commit**

```bash
git add engine/src/ops/log.ts engine/src/ops/verify.ts engine/src/ops/run.ts engine/tests/ops/log.test.ts engine/tests/ops/verify.test.ts engine/tests/ops/run.test.ts engine/tests/integration/build-cycle.test.ts engine/tests/integration/fix-cycle.test.ts engine/tests/integration/plan-track.test.ts
git commit -m "feat(engine): gate completion on quality evidence"
```

---

## Slice 3 — Suspension and Destructive Safety

### Task 11: Enforce budgets and resume only through append-only amendments

**Files:**
- Create: `engine/src/ops/quality-control.ts`
- Modify: `engine/src/ops/quality-budget.ts`
- Modify: `engine/src/ops/roster.ts:297-462`
- Modify: `engine/src/ops/log.ts:219-490`
- Modify: `engine/src/ops/run.ts:404-620`
- Modify: `engine/src/ops/summary.ts:9-230`
- Create: `engine/tests/ops/quality-control.test.ts`
- Test: `engine/tests/ops/quality-budget.test.ts`
- Test: `engine/tests/ops/roster.test.ts`
- Test: `engine/tests/ops/log.test.ts`
- Test: `engine/tests/ops/run.test.ts`
- Test: `engine/tests/ops/summary.test.ts`

**Interfaces:**
- Consumes: Task 4 amendment store, Task 6 effective budgets, Task 9 dispatch descriptors, and `StateStore`.
- Produces:

```ts
export async function reserveQualityDispatches(
  projectDir: string,
  state: State,
  dispatches: QualityDispatch[],
  now?: Clock,
): Promise<{ used: number; remaining: number }>

export async function exhaustQualityBudget(projectDir: string, reason: string, now?: Clock): Promise<State>
export async function amendQualityBudget(projectDir: string, input: BudgetAmendmentInput, now?: Clock): Promise<State>
```

- [ ] **Step 1: Write failing budget-exhaustion tests**

```ts
it('suspends before a roster would exceed the pinned dispatch ceiling', async () => {
  await seedBudget(project.dir, { max_dispatches: 2, used: 2 })
  await expect(rosterSet(project.dir, nextRoster())).rejects.toBeInstanceOf(QualityBudgetExhaustedError)
  expect((await new StateStore(project.dir).get()).status).toBe('budget_exhausted')
  expect(await cycleFiles(project.dir, 2)).toEqual([])
})

it('applies ordered amendments without mutating the policy pin', async () => {
  const before = await fs.readFile(policyFile(project.dir), 'utf8')
  await amendQualityBudget(project.dir, amendmentInput({ from: 2, to: 4, reason: 'one targeted repair' }), clock)
  expect(await fs.readFile(policyFile(project.dir), 'utf8')).toBe(before)
  expect((await readAmendments(project.dir, state))).toHaveLength(1)
})

it.each(['max_cycles', 'max_dispatches', 'max_context_tokens_per_dispatch', 'max_repair_attempts'] as const)(
  'suspends before exceeding %s', async (field) => {
    await seedAtCeiling(project.dir, field)
    await expect(attemptNextBudgetedAction(project.dir, field)).rejects.toBeInstanceOf(QualityBudgetExhaustedError)
    expect((await new StateStore(project.dir).get()).status).toBe('budget_exhausted')
  },
)
```

- [ ] **Step 2: Run focused tests**

Run: `cd engine && npx vitest run tests/ops/quality-control.test.ts tests/ops/quality-budget.test.ts tests/ops/roster.test.ts tests/ops/log.test.ts tests/ops/run.test.ts tests/ops/summary.test.ts`

Expected: FAIL because dispatch reservation and budget suspension do not exist.

- [ ] **Step 3: Implement compare-and-suspend under the state lock**

Reserve the whole declared quality dispatch set before writing `roster.json`. Count each `{agent, instance, inputFingerprint}` once. Guard the next cycle in `cycleAdvance`, the next repair in the result/repair seam, and each fitted context packet before its dispatch is returned. If any next action exceeds its effective ceiling, set `status = 'budget_exhausted'`, preserve `current.stage`, record a bounded reason, and throw after the state write without writing the roster/result/next cycle. An amendment must match the current run id, field, current effective ceiling, and suspended status; accept increases only, append first, then set state back to `running`.

Add compact summary fields:

```ts
quality: {
  mode: QualityMode
  supervision: Supervision
  enforcement: 'shadow' | 'active'
  dispatches: { used: number; max: number }
  waiting: { kind: 'budget' | 'decision'; reason: string } | null
} | null
```

- [ ] **Step 4: Run focused tests**

Run: `cd engine && npx vitest run tests/ops/quality-control.test.ts tests/ops/quality-budget.test.ts tests/ops/roster.test.ts tests/ops/log.test.ts tests/ops/run.test.ts tests/ops/summary.test.ts`

Expected: PASS; suspension writes no roster/result, amendments are monotonic and append-only, and resume preserves cycle/stage/results.

- [ ] **Step 5: Commit**

```bash
git add engine/src/ops/quality-control.ts engine/src/ops/quality-budget.ts engine/src/ops/roster.ts engine/src/ops/log.ts engine/src/ops/run.ts engine/src/ops/summary.ts engine/tests/ops/quality-control.test.ts engine/tests/ops/quality-budget.test.ts engine/tests/ops/roster.test.ts engine/tests/ops/log.test.ts engine/tests/ops/run.test.ts engine/tests/ops/summary.test.ts
git commit -m "feat(engine): suspend on quality budget exhaustion"
```

### Task 12: Detect and block protected destructive operations before execution

**Files:**
- Create: `engine/src/ops/destructive-risk.ts`
- Modify: `engine/src/cli/index.ts:1803-1990`
- Modify: `engine/src/ops/log.ts:250-490`
- Create: `engine/tests/ops/destructive-risk.test.ts`
- Test: `engine/tests/cli/index.test.ts`
- Test: `engine/tests/ops/log.test.ts`

**Interfaces:**
- Consumes: raw PreToolUse input, policy supervision, changed files/results, and Task 11 quality control.
- Produces:

```ts
export interface DestructiveCandidate {
  kind: 'feature_delete' | 'table_drop' | 'table_truncate' | 'bulk_data_delete' | 'irreversible_migration' | 'project_wide'
  targets: string[]
  operation: string
  rollback: string | null
}

export function classifyDestructiveTool(input: unknown): DestructiveCandidate | null
export function classifyDestructiveResult(input: { goal: string; deletedFiles: string[]; summary: string }): DestructiveCandidate | null
export function operationFingerprint(runId: string, candidate: DestructiveCandidate): string
```

- [ ] **Step 1: Write failing classifier and hook tests**

```ts
it.each([
  ['DROP TABLE users', 'table_drop'],
  ['TRUNCATE audit_log', 'table_truncate'],
  ['DELETE FROM guests', 'bulk_data_delete'],
  ['rm -rf src/billing', 'feature_delete'],
] as const)('classifies %s as %s', (command, kind) => {
  expect(classifyDestructiveTool(bashInput(command))?.kind).toBe(kind)
})

it.each(['DELETE FROM guests WHERE id = 7', 'rm src/unused.test.ts'])('does not stop bounded ordinary change %s', (command) => {
  expect(classifyDestructiveTool(bashInput(command))).toBeNull()
})

it('moves an unattended run to waiting before the destructive shell command', async () => {
  const result = await stateGuardCommandForTest(project.dir, bashInput('DROP TABLE users'))
  expect(result.stdout).toContain('permissionDecision')
  expect((await new StateStore(project.dir).get()).status).toBe('waiting_for_user')
})
```

- [ ] **Step 2: Run focused tests**

Run: `cd engine && npx vitest run tests/ops/destructive-risk.test.ts tests/cli/index.test.ts tests/ops/log.test.ts`

Expected: FAIL because state guard only inspects protected file paths.

- [ ] **Step 3: Implement narrow, fail-safe classification**

Parse the hook's `tool_name` and declared `tool_input`; do not execute or shell-parse the command. Match SQL statements after stripping quoted strings/comments, recursive removal of a feature directory, project-wide git clean/reset, explicit irreversible migration flags, and ApplyPatch delete-file directives. Do not classify bounded row deletion with a nontrivial `WHERE`, ordinary file deletion, or reversible schema additions.

When an active policy exists and no exact unused approval is recorded, call `requestDestructiveDecision`, move state to `waiting_for_user`, and return the normal PreToolUse denial payload. If the operation is already approved, atomically mark that exact fingerprint used before allowing it once. Agent results that delete a feature through edits are caught in `runLog` and suspend before the cycle can pass/commit.

- [ ] **Step 4: Run focused tests**

Run: `cd engine && npx vitest run tests/ops/destructive-risk.test.ts tests/cli/index.test.ts tests/ops/log.test.ts`

Expected: PASS with false-positive fixtures, normalized target ordering, one-time authorization, and changed-operation invalidation.

- [ ] **Step 5: Commit**

```bash
git add engine/src/ops/destructive-risk.ts engine/src/cli/index.ts engine/src/ops/log.ts engine/tests/ops/destructive-risk.test.ts engine/tests/cli/index.test.ts engine/tests/ops/log.test.ts
git commit -m "feat(engine): gate destructive operations"
```

### Task 13: Add operator-only decision, amendment, and resume doors

**Files:**
- Modify: `engine/src/ops/quality-control.ts`
- Modify: `engine/src/web/writes.ts:177-470`
- Modify: `engine/src/web/codes.ts`
- Modify: `engine/src/web/completion.ts:14-76`
- Modify: `engine/src/cli/index.ts:1910-1985`
- Test: `engine/tests/ops/quality-control.test.ts`
- Test: `engine/tests/web/writes.test.ts`
- Test: `engine/tests/web/boundary.test.ts`
- Test: `engine/tests/web/completion.test.ts`
- Test: `engine/tests/cli/index.test.ts`

**Interfaces:**
- Consumes: Task 11 budget amendment, Task 12 pending destructive request, existing `decidedBy()`, and the closed web write union.
- Produces two operator-only writes:

```ts
{ kind: 'quality.decision'; run: string; fingerprint: string; decision: 'approve' | 'reject'; note: string | null }
{ kind: 'quality.budget'; run: string; field: 'max_cycles' | 'max_dispatches' | 'max_context_tokens_per_dispatch' | 'max_repair_attempts'; from: number; to: number; reason: string }
```

- [ ] **Step 1: Write failing operator-boundary tests**

```ts
it('approves only the request and fingerprint currently shown', async () => {
  const result = await applyWrite(project.dir, {
    kind: 'quality.decision', run: runId, fingerprint: shownFingerprint, decision: 'approve', note: null,
  })
  expect(result).toEqual({ ok: true })
  expect((await new StateStore(project.dir).get()).status).toBe('running')
})

it('refuses a stale decision and does not expose either operator action through MCP', async () => {
  expect(await applyWrite(project.dir, staleDecision())).toEqual({ ok: false, code: 'write.stale.qualityDecision' })
  expect(mcpSource).not.toMatch(/quality\.decision|quality\.budget/)
})
```

- [ ] **Step 2: Run focused tests**

Run: `cd engine && npx vitest run tests/ops/quality-control.test.ts tests/web/writes.test.ts tests/web/boundary.test.ts tests/web/completion.test.ts tests/cli/index.test.ts`

Expected: FAIL because the write kinds and resume transitions do not exist.

- [ ] **Step 3: Implement CAS-like operator transitions**

Approval/rejection must match run id, current `waiting_for_user` state, and operation fingerprint. Store only the token hash in the run record; the server-side capability is consumed once. Approval sets state to `running`. Rejection records the refusal and invalidates that exact proposal. A command blocked by PreToolUse has no effect to undo and may return to `running` for a declared non-destructive alternative. If code deletion was detected after edits in an isolated worktree, keep the run suspended until the executor reports a reverted diff with a new worktree fingerprint; the engine must not claim it reverted files itself. If no safe alternative/revert proof exists, halt with an explicit reason. Budget writes call Task 11 and cannot change mode.

Extend the web write handler mapped type and translate stale/invalid/ok outcomes with closed codes. Update `tests/web/boundary.test.ts` so only `writes.ts` may import `decideDestructiveRequest` and `amendQualityBudget`; keep `runStart`, `runLog`, `cycleAdvance`, and `rosterSet` forbidden.

- [ ] **Step 4: Make suspension quiet but resumable**

Keep suspended statuses nonterminal in `observe`; an open Cockpit job stays attached to the same terminal. Make `isStalled` and the Stop hook ignore `waiting_for_user` and `budget_exhausted`, so neither emits repeated prompts or blocks a turn. After a successful operator write, the UI will send `/mjloop:resume` into the existing terminal in Task 16; a disconnected session can resume through the ordinary command without rerunning logged agents.

- [ ] **Step 5: Run focused tests**

Run: `cd engine && npx vitest run tests/ops/quality-control.test.ts tests/web/writes.test.ts tests/web/boundary.test.ts tests/web/completion.test.ts tests/cli/index.test.ts`

Expected: PASS; stale decisions change nothing, suspended runs do not trigger stop/stall loops, and no MCP tool can approve or amend.

- [ ] **Step 6: Commit**

```bash
git add engine/src/ops/quality-control.ts engine/src/web/writes.ts engine/src/web/codes.ts engine/src/web/completion.ts engine/src/cli/index.ts engine/tests/ops/quality-control.test.ts engine/tests/web/writes.test.ts engine/tests/web/boundary.test.ts engine/tests/web/completion.test.ts engine/tests/cli/index.test.ts
git commit -m "feat(engine): add operator quality controls"
```

---

## Slice 4 — Cockpit, Observability, and Release Gates

### Task 14: Expose bounded quality reads and honest telemetry

**Files:**
- Modify: `engine/src/web/read.ts`
- Modify: `engine/src/web/api.ts`
- Modify: `engine/src/web/protocol.ts`
- Modify: `engine/src/web/revision.ts`
- Modify: `engine/src/ops/telemetry.ts`
- Modify: `engine/src/ops/preflight.ts`
- Test: `engine/tests/web/read.test.ts`
- Test: `engine/tests/web/api.test.ts`
- Test: `engine/tests/web/snapshot.test.ts`
- Test: `engine/tests/ops/telemetry.test.ts`
- Test: `engine/tests/ops/preflight.test.ts`

**Interfaces:**
- Consumes: the protected records from Task 4, selected/comparison policies from Task 7, effective amendments from Task 11, and the existing conditional-GET/revision pattern.
- Produces:

```ts
export type PublicQualityDispatch = Pick<QualityDispatch, 'agent' | 'instance' | 'dimensions' | 'reason'>
export type PublicQualityAmendment = Pick<
  QualityAmendment,
  'run' | 'field' | 'from' | 'to' | 'reason' | 'decided_at' | 'decided_by'
>

export interface QualityRunView {
  policy: Omit<QualityPolicy, 'dispatches'> & { dispatches: PublicQualityDispatch[] }
  ledger: QualityLedger
  amendments: PublicQualityAmendment[]
  effectiveBudget: QualityBudget
  pendingRequest: Omit<DestructiveRequest, 'capability_hash'> | null
}

export interface QualityTelemetry {
  mode: QualityMode
  inputTokens: { kind: MeasurementKind; value: number | null }
  outputTokens: { kind: MeasurementKind; value: number | null }
  estimatedCost: { kind: MeasurementKind; currency: string | null; value: number | null }
  activeElapsed: { kind: MeasurementKind; valueMs: number | null }
  waitingElapsed: { kind: MeasurementKind; valueMs: number | null }
  dispatches: { used: number; max: number }
}

export async function readQualityRun(projectDir: string, runId: string): Promise<QualityRunView>
```

- [ ] **Step 1: Write failing bounded-read and telemetry tests**

```ts
it('returns the pinned policy, ledger, and effective amended budget', async () => {
  const view = await readQualityRun(project.dir, runId)
  expect(view.policy.mode).toBe('adaptive')
  expect(view.effectiveBudget.max_dispatches).toBe(24)
  expect(view.ledger.dimensions.correctness.status).toBe('pass')
})

it('reports unavailable cost instead of inventing a price', () => {
  expect(qualityTelemetry(runWithoutUsageOrPricing()).estimatedCost).toEqual({
    kind: 'unavailable', currency: null, value: null,
  })
})
```

Assert that the public view omits absolute paths, raw approval capability, token hashes, raw prompts, and amendment internals. Add API tests for `GET /api/runs/:id/quality`, traversal rejection, malformed records, ETag reuse, and bounded response size.

- [ ] **Step 2: Run focused tests**

Run: `cd engine && npx vitest run tests/web/read.test.ts tests/web/api.test.ts tests/web/snapshot.test.ts tests/ops/telemetry.test.ts tests/ops/preflight.test.ts`

Expected: FAIL because there is no quality read model, route, revision, or telemetry projection.

- [ ] **Step 3: Implement the read-only projection**

Add a `quality` revision built from the active run's three fixed filenames; do not recursively walk arbitrary paths. Add `GET /api/runs/:id/quality` through the existing id validation, `no-store`, ETag, and coded-error machinery. Parse every record with Task 3 schemas, cap amendments/evidence returned per response, and convert internal paths to run-relative references.

Compute telemetry from recorded host usage when present. Otherwise use Task 6's documented byte estimate only for input tokens and label it `estimated`; output tokens remain `unavailable` without host usage. Cost remains `unavailable` unless a versioned provider/model/currency price record and measured input/output usage are both present. Active and human-wait elapsed values come from persisted state-transition timestamps, never from a UI timer, and must be reported separately.

- [ ] **Step 4: Keep preflight comparisons side-effect free**

Expose all three policy previews in preflight with the same risk input and clearly distinguish selected, measured, estimated, and unavailable fields. Preview must not create a run, policy, ledger, amendment, roster, or terminal job.

- [ ] **Step 5: Run focused tests**

Run: `cd engine && npx vitest run tests/web/read.test.ts tests/web/api.test.ts tests/web/snapshot.test.ts tests/ops/telemetry.test.ts tests/ops/preflight.test.ts`

Expected: PASS; reads are bounded, redacted, conditional, and free of subprocess/state changes.

- [ ] **Step 6: Commit**

```bash
git add engine/src/web/read.ts engine/src/web/api.ts engine/src/web/protocol.ts engine/src/web/revision.ts engine/src/ops/telemetry.ts engine/src/ops/preflight.ts engine/tests/web/read.test.ts engine/tests/web/api.test.ts engine/tests/web/snapshot.test.ts engine/tests/ops/telemetry.test.ts engine/tests/ops/preflight.test.ts
git commit -m "feat(web): expose quality policy and telemetry"
```

### Task 15: Replace legacy quality toggles with accessible mode cards

**Files:**
- Create: `engine/src/web/app/components/QualityModeCard.vue`
- Modify: `engine/src/web/app/lib/config.ts`
- Modify: `engine/src/web/app/panels/Config.vue`
- Modify: `engine/src/web/app/locales/en.json`
- Modify: `engine/src/web/app/locales/ar.json`
- Modify: `engine/src/web/app/styles/50-controls.css`
- Modify: `engine/src/web/app/styles/60-panels.css`
- Test: `engine/tests/web/lib.test.ts`
- Test: `engine/tests/web/panel-config.test.ts`
- Test: `engine/tests/web/locales.test.ts`
- Test: `engine/tests/web/layout.test.ts`

**Interfaces:**
- Consumes: Task 2's closed `orchestration.quality.mode` write, existing config revision/CAS workflow, and the Config panel's draft-only-until-Save behavior.
- Produces one radio-card group for `economy`, `adaptive`, and `strict`; `adaptive` is visually and textually identified as recommended without silently selecting it for an existing project.

- [ ] **Step 1: Write failing component and diff tests**

```ts
it('emits exactly one typed mode change only after Save', async () => {
  const wrapper = await mountConfig({ mode: 'economy' })
  await wrapper.get('[data-quality-mode="strict"]').trigger('click')
  expect(sentWrites()).toEqual([])
  await wrapper.get('[data-save]').trigger('click')
  expect(sentWrites()[0].write.changes).toEqual([
    { kind: 'orchestration.quality.mode', value: 'strict' },
  ])
})
```

Cover keyboard arrow selection, focus visibility, radio names/checked state, explicit recommended text, stale revision refusal, undo, dirty-state reset, Arabic labels, and the absence of both legacy boolean controls.

- [ ] **Step 2: Run focused tests**

Run: `cd engine && npx vitest run tests/web/lib.test.ts tests/web/panel-config.test.ts tests/web/locales.test.ts tests/web/layout.test.ts`

Expected: FAIL because the UI still models two independent booleans.

- [ ] **Step 3: Implement the single-choice draft**

Use a native radio input inside each card. Keep the draft local, compare the normalized whole quality object, and submit only Task 2's closed change kind with the currently displayed config revision. Explain the operational trade-off in plain language: same completion bar, different planned duplication and review depth. Do not claim exact savings before a preflight exists.

- [ ] **Step 4: Preserve responsive RTL behavior**

At wide widths render three equal cards. At 390px stack cards, keep the radio/control order logical in both directions, avoid horizontal scrolling, and retain a minimum 44px target. Status/recommendation must use text or an icon with a screen-reader label, not color alone.

- [ ] **Step 5: Run focused tests**

Run: `cd engine && npx vitest run tests/web/lib.test.ts tests/web/panel-config.test.ts tests/web/locales.test.ts tests/web/layout.test.ts`

Expected: PASS in English and Arabic, including 390px layout assertions and unchanged guarded-save behavior.

- [ ] **Step 6: Commit**

```bash
git add engine/src/web/app/components/QualityModeCard.vue engine/src/web/app/lib/config.ts engine/src/web/app/panels/Config.vue engine/src/web/app/locales/en.json engine/src/web/app/locales/ar.json engine/src/web/app/styles/50-controls.css engine/src/web/app/styles/60-panels.css engine/tests/web/lib.test.ts engine/tests/web/panel-config.test.ts engine/tests/web/locales.test.ts engine/tests/web/layout.test.ts
git commit -m "feat(cockpit): add quality mode selector"
```

### Task 16: Show pinned quality evidence and operator suspension dialogs

**Files:**
- Create: `engine/src/web/app/components/QualityLedgerRow.vue`
- Create: `engine/src/web/app/components/QualityDecisionDialog.vue`
- Create: `engine/src/web/app/components/QualityBudgetDialog.vue`
- Modify: `engine/src/web/app/composables/useRun.ts`
- Modify: `engine/src/web/app/panels/Run.vue`
- Modify: `engine/src/web/app/panels/Evidence.vue`
- Modify: `engine/src/web/app/App.vue`
- Modify: `engine/src/web/app/stores/session.ts`
- Modify: `engine/src/web/app/locales/en.json`
- Modify: `engine/src/web/app/locales/ar.json`
- Modify: `engine/src/web/app/styles/50-controls.css`
- Modify: `engine/src/web/app/styles/60-panels.css`
- Test: `engine/tests/web/panel-run.test.ts`
- Test: `engine/tests/web/panel-evidence.test.ts`
- Test: `engine/tests/web/shell.test.ts`
- Test: `engine/tests/web/store.test.ts`
- Test: `engine/tests/web/locales.test.ts`
- Test: `engine/tests/web/layout.test.ts`

**Interfaces:**
- Consumes: Task 14's quality route/revision, Task 13's two guarded writes, and the existing `submit(write, { settled })` plus `send(ClientMessage)` session APIs.
- Produces preflight mode comparisons, a pinned-mode run summary, priority-ordered token/cost/time telemetry, five evidence rows, and modal operator actions.

- [ ] **Step 1: Write failing run/evidence rendering tests**

```ts
it('renders the pinned mode and never substitutes a newly saved project mode', async () => {
  const wrapper = await mountRun({ projectMode: 'economy', pinnedMode: 'strict' })
  expect(wrapper.get('[data-quality-mode]').text()).toContain('Strict')
  expect(wrapper.get('[data-quality-mode]').text()).toContain('Pinned for this run')
})

it('renders unavailable cost honestly and gives every verdict a text label', async () => {
  const wrapper = await mountEvidence(qualityViewWithoutPricing())
  expect(wrapper.text()).toContain('Cost unavailable')
  expect(wrapper.get('[data-dimension="security"]').text()).toContain('Passed')
})
```

Also test `pending`, `fail`, `blocked`, and `not_applicable`, invalidation reasons, amended budgets, mode comparisons, loading/error/empty states, dialog focus trap, Escape handling, destructive target disclosure, and typed reason validation.

- [ ] **Step 2: Run focused tests**

Run: `cd engine && npx vitest run tests/web/panel-run.test.ts tests/web/panel-evidence.test.ts tests/web/shell.test.ts tests/web/store.test.ts tests/web/locales.test.ts tests/web/layout.test.ts`

Expected: FAIL because the panels have no quality feed or operator controls.

- [ ] **Step 3: Implement a conditional quality feed**

Subscribe to `snapshot.revisions.quality` only while Run or Evidence is mounted. Fetch `/api/runs/:id/quality` through the existing API helper and keep the last good view during a 304 or transient refresh. Render policy source/enforcement so a legacy shadow run is never presented as actively gated.

- [ ] **Step 4: Implement operator dialogs without browser-side authority**

The destructive dialog submits the exact displayed `{run, fingerprint}` and requires the operator to choose Approve or Reject. The budget dialog permits only an increase from the displayed effective value and requires a nonempty reason. Never expose or accept a raw path, YAML document, capability token, arbitrary command, or arbitrary budget field.

On a successful receipt, call the existing session transport directly:

```ts
submit(write, {
  settled(receipt) {
    if (receipt.ok) send({ type: 'input', data: '/mjloop:resume\r' })
  },
})
```

If the socket is offline, leave the persisted state resumed and show the ordinary offline notice; the operator can enqueue or type `/mjloop:resume` later. Do not create a second browser execution path.

- [ ] **Step 5: Preserve accessibility and mobile layout**

Move the dialogs to the existing app-level dialog host so they survive panel changes consistently. Restore focus to the invoking button, label destructive targets and old/new budget values, announce write refusal, and stack comparison/ledger rows without horizontal scrolling at 390px in both LTR and RTL.

- [ ] **Step 6: Run focused tests**

Run: `cd engine && npx vitest run tests/web/panel-run.test.ts tests/web/panel-evidence.test.ts tests/web/shell.test.ts tests/web/store.test.ts tests/web/locales.test.ts tests/web/layout.test.ts`

Expected: PASS; successful decisions resume the same terminal once, stale/failed writes do not send input, and all states remain readable without color.

- [ ] **Step 7: Commit**

```bash
git add engine/src/web/app/components/QualityLedgerRow.vue engine/src/web/app/components/QualityDecisionDialog.vue engine/src/web/app/components/QualityBudgetDialog.vue engine/src/web/app/composables/useRun.ts engine/src/web/app/panels/Run.vue engine/src/web/app/panels/Evidence.vue engine/src/web/app/App.vue engine/src/web/app/stores/session.ts engine/src/web/app/locales/en.json engine/src/web/app/locales/ar.json engine/src/web/app/styles/50-controls.css engine/src/web/app/styles/60-panels.css engine/tests/web/panel-run.test.ts engine/tests/web/panel-evidence.test.ts engine/tests/web/shell.test.ts engine/tests/web/store.test.ts engine/tests/web/locales.test.ts engine/tests/web/layout.test.ts
git commit -m "feat(cockpit): add quality evidence and controls"
```

### Task 17: Prove mode behavior with shared scenarios and mutation tests

**Files:**
- Create: `engine/tests/integration/quality-modes.test.ts`
- Create: `engine/tests/integration/quality-unattended.test.ts`
- Create: `engine/stryker.config.mjs`
- Modify: `engine/src/ops/quality-capability.ts`
- Modify: `engine/package.json`
- Modify: `engine/package-lock.json`

**Interfaces:**
- Consumes: all engine behavior from Tasks 1-16 and the shared scenarios from Task 5.
- Produces one cross-mode contract suite, mutation protection for the critical gates, and the production capability switch from closed to open.

- [ ] **Step 1: Write the cross-mode scenario matrix**

```ts
it.each(['economy', 'adaptive', 'strict'] as const)(
  '%s closes the same required dimensions for a medium-risk backend change',
  async (mode) => {
    const result = await runQualityScenario({ mode, scenario: mediumBackendScenario() })
    expect(result.requiredDimensions.sort()).toEqual(['alignment', 'correctness', 'regression', 'security'])
    expect(result.state.status).toBe('done')
  },
)

it('uses fewer planned dispatches in economy than strict when evidence can be combined', async () => {
  const economy = await preview('economy', mediumBackendScenario())
  const strict = await preview('strict', mediumBackendScenario())
  expect(economy.dispatches.length).toBeLessThan(strict.dispatches.length)
  expect(economy.requiredDimensions).toEqual(strict.requiredDimensions)
})
```

Cover low/medium/high risk, UI applicability, failed and stale evidence, legacy shadow behavior, live config change during a run, duplicate dispatch suppression, budget exhaustion/amendment, supervised approval, unattended suspension, rejection, exact one-time approval, restart/resume, and missing/invalid policy integrity halt. Do not assert strict always costs more for high-risk work; modes may converge when safety requires it.

- [ ] **Step 2: Run the new integration tests**

Run: `cd engine && npx vitest run tests/integration/quality-modes.test.ts tests/integration/quality-unattended.test.ts`

Expected: PASS only after Tasks 1-16 are integrated; fix product defects in their owning task commits before proceeding.

- [ ] **Step 3: Open the internal runtime gate only after the matrix passes**

Change `qualityRuntimeEnabled()` from closed to open, then rerun the integration matrix without an injected test override. Assert that explicit projects enforce their pinned policy while legacy/default-existing projects remain shadow. If either assertion fails, close the gate again and stop.

- [ ] **Step 4: Install and configure focused mutation testing**

Run: `cd engine && npm install --save-dev @stryker-mutator/core @stryker-mutator/vitest-runner`

Add:

```json
"test:mutation:quality": "stryker run stryker.config.mjs"
```

Configure Stryker to mutate only `src/ops/quality-risk.ts`, `src/ops/quality-budget.ts`, the pure close predicate in `src/ops/quality-ledger.ts`, the pure classifier/fingerprint in `src/ops/destructive-risk.ts`, and a pure marker/pin integrity predicate exported by `src/ops/quality-policy.ts`; run only their focused Vitest tests. Exclude generated output and schema declaration noise. Require 100% mutation score for this deliberately narrow critical set; surviving mutants must receive a behavior test or a documented source exclusion with a concrete reason.

- [ ] **Step 5: Run mutation and regression tests**

Run: `cd engine && npm run test:mutation:quality`

Expected: PASS at the configured 100% threshold for the targeted gates.

Run: `cd engine && npx vitest run tests/ops/quality-risk.test.ts tests/ops/quality-budget.test.ts tests/ops/quality-ledger.test.ts tests/ops/destructive-risk.test.ts tests/ops/quality-policy.test.ts tests/integration/quality-modes.test.ts tests/integration/quality-unattended.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add engine/src/ops/quality-capability.ts engine/tests/integration/quality-modes.test.ts engine/tests/integration/quality-unattended.test.ts engine/stryker.config.mjs engine/package.json engine/package-lock.json
git commit -m "test(engine): prove quality mode invariants"
```

### Task 18: Update operator protocol and run final release verification

**Files:**
- Modify: `skills/mjloop-leader/SKILL.md`
- Modify: `skills/mjloop-state/SKILL.md`
- Modify: `commands/config.md`
- Modify: `commands/run.md`
- Modify: `commands/resume.md`
- Modify: `commands/status.md`
- Modify: `README.md`
- Modify: `README.ar.md`
- Test: `engine/tests/plugin/commands.test.ts`
- Test: `engine/tests/plugin/agents.test.ts`
- Test: `engine/tests/plugin/feature-discovery-skill.test.ts`
- Create: `engine/tests/plugin/quality-cycle-docs.test.ts`

**Interfaces:**
- Consumes: the completed runtime/UI contract and existing fixed leader/state agents.
- Produces concise operator guidance for selecting a project mode, explicitly requesting rare unattended operation, understanding a pinned run, and resuming after a human decision or budget amendment.

- [ ] **Step 1: Write failing documentation-contract tests**

Assert that shipped command/skill docs name the three closed modes, priority order, run pin, resumable statuses, no-token suspension, destructive gate, and `/mjloop:resume`. Assert they do not reintroduce legacy keys, claim automatic merge/deploy, create a new quality agent role, or promise monetary figures when pricing is unavailable.

- [ ] **Step 2: Run documentation tests**

Run: `cd engine && npx vitest run tests/plugin/commands.test.ts tests/plugin/agents.test.ts tests/plugin/feature-discovery-skill.test.ts tests/plugin/quality-cycle-docs.test.ts`

Expected: FAIL because the new protocol is not documented.

- [ ] **Step 3: Update the fixed-role protocol and public guidance**

Teach the leader to read the pinned policy, dispatch exactly the declared `{agent, instance}` set, reuse logged evidence, stop cleanly on either resumable status, and never decide a protected destructive request. Teach the state skill to report the selected mode, enforcement, budget, pending gate, and next operator action without dumping the full ledger into every prompt. Keep English and Arabic public documentation reciprocal and concise; link detailed behavior to the design/plan rather than duplicating internal schemas.

- [ ] **Step 4: Run documentation tests**

Run: `cd engine && npx vitest run tests/plugin/commands.test.ts tests/plugin/agents.test.ts tests/plugin/feature-discovery-skill.test.ts tests/plugin/quality-cycle-docs.test.ts`

Expected: PASS with no unfinished markers or stale legacy setting references.

- [ ] **Step 5: Run the complete verification ladder**

Run in this order:

```bash
cd engine
npm test
npm run typecheck
npm run build
npm run test:mutation:quality
npm run verify:ship
```

Expected: every command exits 0. Then run one deterministic local smoke fixture per mode and one unattended destructive fixture. Do not spend live model tokens merely to repeat deterministic coverage; a real provider smoke requires explicit operator approval and recorded usage.

- [ ] **Step 6: Perform an independent review before release**

Use an independent reviewer with no implementation context. Require explicit PASS evidence for:

- identical close dimensions across modes;
- token-first/cost-second/time-third ordering;
- immutable run pin and append-only amendments;
- no agent/MCP path to destructive approval;
- inactive waiting loops consuming no dispatches;
- guarded config write boundaries;
- 390px RTL and keyboard/screen-reader behavior;
- no automated merge/deploy.

Resolve every blocking finding in the owning task and rerun its focused tests plus the complete verification ladder. Do not merge without human approval.

- [ ] **Step 7: Commit**

```bash
git add skills/mjloop-leader/SKILL.md skills/mjloop-state/SKILL.md commands/config.md commands/run.md commands/resume.md commands/status.md README.md README.ar.md engine/tests/plugin/commands.test.ts engine/tests/plugin/agents.test.ts engine/tests/plugin/feature-discovery-skill.test.ts engine/tests/plugin/quality-cycle-docs.test.ts
git commit -m "docs: document quality cycle modes"
```

## Completion Evidence

Implementation is complete only when all of the following are attached to the execution report:

- focused red/green command output for every task;
- the final `npm test`, `typecheck`, `build`, mutation, and `verify:ship` outputs;
- shared-scenario comparison showing equal required dimensions and differing duplicate work where applicable;
- measured/estimated/unavailable labels for token, cost, and time telemetry;
- supervised and unattended suspension/resume evidence;
- destructive approval/refusal and stale/one-time fingerprint evidence;
- Cockpit English/Arabic accessibility evidence at desktop and 390px;
- independent review disposition;
- human merge/deploy decision.

## Stop Conditions

Stop implementation and request direction if any of these occurs:

- the design source and this plan conflict on a safety or authority boundary;
- supporting a task would require a new runtime agent role or browser execution engine;
- the host cannot provide or safely estimate the data needed for a declared hard budget;
- an existing project would become actively gated without explicit opt-in;
- a destructive operation cannot be blocked before execution or bound to an exact one-time fingerprint;
- a proposed change would weaken revision/CAS, state locking, path protection, evidence closure, human merge, or human deploy controls;
- unrelated dirty changes overlap a planned file and cannot be preserved safely.
