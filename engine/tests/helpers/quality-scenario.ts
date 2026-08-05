import fs from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { initLoop } from '../../src/ops/init.js'
import { runLog } from '../../src/ops/log.js'
import { planCreate, storyAdd } from '../../src/ops/plan.js'
import { rosterSet } from '../../src/ops/roster.js'
import { cycleAdvance, runStart } from '../../src/ops/run.js'
import { previewQualityPolicies } from '../../src/ops/quality-policy.js'
import { planQualityDispatches, type PlannedQualityDispatch } from '../../src/ops/quality-roster.js'
import { verifyRun } from '../../src/ops/verify.js'
import { findTrack, type Config, type QualityMode } from '../../src/schemas/config.js'
import type { QualityDimension, QualityLedger, QualityPolicy, Supervision } from '../../src/schemas/quality.js'
import type { State } from '../../src/schemas/state.js'
import { loadConfig, writeConfig } from '../../src/store/config-store.js'
import { readLedger, readPolicy } from '../../src/store/quality-store.js'
import { StateStore } from '../../src/store/state-store.js'
import { makeTmpProject, type TmpProject } from './tmp-project.js'
import type { QualityProjectScenario } from '../fixtures/quality/scenarios.js'

/** Where a project's `orchestration.quality` block puts it on the explicit/legacy split. */
export type QualitySource = 'explicit' | 'legacy' | 'default-existing'

export const DIMENSIONS: readonly QualityDimension[] = ['correctness', 'security', 'alignment', 'regression', 'ui']

/**
 * Instant, deterministic stand-ins for a project's own suite and linter. Two
 * slots rather than one because the pinned plan asks two different evidence
 * kinds of one cycle: `correctness`/`regression` want `test`, `security` wants
 * `command`, and only the `test` slot resolves to the former.
 */
const VERIFY_TEST = "printf 'tests 1, pass 1, fail 0\\n'"
const VERIFY_LINT = "printf 'lint clean\\n'"

export interface ScenarioOptions {
  /** The mode to pin. Ignored for a non-explicit source, which names no mode. */
  mode?: QualityMode
  source?: QualitySource
  supervision?: Supervision
  scenario: QualityProjectScenario
  clock?: () => Date
}

/** One opened run: the project it lives in, and the records its start pinned. */
export interface ScenarioHandle {
  project: TmpProject
  dir: string
  clock: () => Date
  state: State
  policy: QualityPolicy
  config: Config
  story: string
  requiredDimensions: QualityDimension[]
  dispatches: PlannedQualityDispatch[]
  /** Re-read the live records. */
  read: () => Promise<{ state: State; policy: QualityPolicy; ledger: QualityLedger }>
}

export interface ScenarioResult {
  project: TmpProject
  dir: string
  state: State
  policy: QualityPolicy
  ledger: QualityLedger
  requiredDimensions: QualityDimension[]
  dispatches: PlannedQualityDispatch[]
}

/** The dimensions a pinned plan marks required, in the ledger's own order. */
export function requiredDimensionsOf(policy: QualityPolicy): QualityDimension[] {
  return DIMENSIONS.filter((dimension) => policy.initial_quality_plan[dimension].value === 'required')
}

/**
 * A project with `.mjloop/` provisioned, its verify slots pinned to instant
 * commands, its `orchestration.quality` block put on the requested side of the
 * explicit/legacy split, and the scenario's story written.
 *
 * The config is settled *before* `runStart`, because a run pins both the verify
 * block and the quality policy at its boundary — a project edited afterwards is
 * the live-config-change case, not the setup path.
 */
export async function openQualityScenario(options: ScenarioOptions): Promise<ScenarioHandle> {
  const clock = options.clock ?? (() => new Date('2026-08-04T10:36:00.000Z'))
  const project = await makeTmpProject({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) })
  await initLoop(project.dir, clock)

  const config = await loadConfig(project.dir)
  config.verify.test = VERIFY_TEST
  config.verify.lint = VERIFY_LINT
  // The scenario's story stands in for a plan a person already agreed to; this
  // suite is about quality modes, not about the approval gate.
  config.gates.plan_approval = 'auto'
  await writeConfig(project.dir, config)
  await setQualityBlock(project.dir, options.source ?? 'explicit', options.mode ?? 'adaptive')

  const plan = await planCreate(project.dir, { slug: 'quality', title: 'Quality scenarios' }, clock)
  const story = await storyAdd(project.dir, {
    plan: plan.id,
    title: options.scenario.title,
    acceptance: options.scenario.acceptance,
    ui: options.scenario.ui,
  }, clock)

  const state = await runStart(project.dir, {
    track: 'build',
    goal: options.scenario.goal,
    story: story.id,
    supervision: options.supervision ?? 'supervised',
  }, clock)

  const policy = await readPolicy(project.dir, state)
  const live = await loadConfig(project.dir)
  const dispatches = await planFor(project.dir, state, live, policy)

  return {
    project,
    dir: project.dir,
    clock,
    state,
    policy,
    config: live,
    story: story.id,
    requiredDimensions: requiredDimensionsOf(policy),
    dispatches,
    read: async () => {
      const current = await new StateStore(project.dir, clock).get()
      return {
        state: current,
        policy: await readPolicy(project.dir, current),
        ledger: await readLedger(project.dir, current),
      }
    },
  }
}

/**
 * Open a run, declare the roster its own mode plans, collect real verify
 * receipts, log the base quality dispatch against them, and close the cycle.
 *
 * Every step goes through the production seam rather than a seeded record: the
 * ledger this closes on is the one `runLog` folded from receipts `verifyRun`
 * actually produced.
 */
export async function runQualityScenario(options: ScenarioOptions): Promise<ScenarioResult> {
  const handle = await openQualityScenario(options)
  await declareRoster(handle)
  await collectPassingEvidence(handle)
  const closed = await cycleAdvance(handle.dir, { agents: loggedAgents(handle), result: 'pass' }, handle.clock)
  const ledger = await readLedger(handle.dir, closed.state)

  return {
    project: handle.project,
    dir: handle.dir,
    state: closed.state,
    policy: handle.policy,
    ledger,
    requiredDimensions: handle.requiredDimensions,
    dispatches: handle.dispatches,
  }
}

/** The three modes' pinned plans for one scenario, without opening a run for each. */
export async function previewQualityScenario(
  scenario: QualityProjectScenario,
): Promise<{ project: TmpProject; modes: Record<QualityMode, { requiredDimensions: QualityDimension[]; dispatches: PlannedQualityDispatch[] }> }> {
  const clock = (): Date => new Date('2026-08-04T10:36:00.000Z')
  const project = await makeTmpProject({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) })
  await initLoop(project.dir, clock)
  const seeded = await loadConfig(project.dir)
  seeded.gates.plan_approval = 'auto'
  await writeConfig(project.dir, seeded)
  const plan = await planCreate(project.dir, { slug: 'quality', title: 'Quality scenarios' }, clock)
  const story = await storyAdd(project.dir, {
    plan: plan.id,
    title: scenario.title,
    acceptance: scenario.acceptance,
    ui: scenario.ui,
  }, clock)

  const config = await loadConfig(project.dir)
  const track = findTrack(config, 'build')
  if (track === undefined) throw new Error('the build track is missing from a freshly initialised project')

  const previews = await previewQualityPolicies(project.dir, { track: 'build', goal: scenario.goal, story: story.id })
  const modes = {} as Record<QualityMode, { requiredDimensions: QualityDimension[]; dispatches: PlannedQualityDispatch[] }>
  for (const mode of ['economy', 'adaptive', 'strict'] as const) {
    const policy = previews[mode].policy
    modes[mode] = {
      requiredDimensions: requiredDimensionsOf(policy),
      dispatches: planQualityDispatches({
        trackName: 'build',
        track,
        config,
        policy,
        goal: scenario.goal,
        acceptance: scenario.acceptance,
        intendedFiles: [],
        componentKinds: [],
      }),
    }
  }
  return { project, modes }
}

/**
 * Declare the cycle roster this run's own plan needs.
 *
 * Built from the plan rather than hardcoded because it varies by mode: economy
 * needs one agent, strict needs the specialists its plan routes each dimension
 * to. Every remaining available agent is given a reason, which is what the
 * roster rules demand of an optional agent that is not drafted.
 */
export async function declareRoster(handle: ScenarioHandle, cycle = 1): Promise<void> {
  const track = findTrack(handle.config, 'build')
  if (track === undefined) throw new Error('the build track is missing')
  const selected = [...new Set([...track.required, ...handle.dispatches.map((dispatch) => dispatch.agent)])]
  const skipped = Object.fromEntries(
    track.available
      .filter((agent) => !selected.includes(agent) && !track.closing.includes(agent))
      .map((agent) => [agent, 'not needed for this scenario']),
  )
  await rosterSet(handle.dir, { cycle, selected, skipped })
}

/**
 * The plan's own base dispatch — the one carrying every required dimension.
 *
 * Not `dispatches[0]`: `planQualityDispatches` orders by dispatch wave, and in
 * strict mode the specialists it adds (`security`, `critic`) run in earlier
 * waves than `verifier`, so the base dispatch is not first. It is identified
 * the one way that cannot drift — by the policy's own first pinned dispatch.
 */
export function baseDispatchOf(handle: ScenarioHandle): PlannedQualityDispatch {
  const pinned = handle.policy.dispatches[0]
  if (pinned === undefined) throw new Error('the pinned policy scheduled no dispatch')
  const planned = handle.dispatches.find(
    (dispatch) => dispatch.agent === pinned.agent && (dispatch.instance ?? null) === (pinned.instance ?? null),
  )
  if (planned === undefined) throw new Error('the roster plan dropped the policy\'s own base dispatch')
  return planned
}

/** The agents a closing `cycleAdvance` is told about — the ones `collectPassingEvidence` logged. */
export function loggedAgents(handle: ScenarioHandle): string[] {
  return [...new Set(['builder', baseDispatchOf(handle).agent])]
}

/**
 * Run both verify slots and log the plan's base dispatch citing both.
 *
 * The base dispatch carries every required dimension, so one honest result over
 * one test receipt and one command receipt is what closes the cycle — the
 * `agent` kind `alignment` asks for is the stored result itself.
 */
export async function collectPassingEvidence(handle: ScenarioHandle): Promise<{ test: string; lint: string }> {
  await runLog(handle.dir, { agent: 'builder', result: builderPass() }, handle.clock)
  const receipts = await runVerifySlots(handle)
  const base = baseDispatchOf(handle)
  await runLog(handle.dir, {
    agent: base.agent,
    ...(base.instance === null ? {} : { instance: base.instance }),
    result: verifierPass(receipts),
  }, handle.clock)
  return receipts
}

export async function runVerifySlots(handle: ScenarioHandle): Promise<{ test: string; lint: string }> {
  // Generous for the reason `quality-evidence.ts` states: these are `printf`
  // commands, so the budget only absorbs contention from the rest of the suite.
  const test = await verifyRun(handle.dir, { slot: 'test', wait_ms: 30_000 }, handle.clock)
  const lint = await verifyRun(handle.dir, { slot: 'lint', wait_ms: 30_000 }, handle.clock)
  if (test.exit_code !== 0 || lint.exit_code !== 0) throw new Error('a scenario verify slot did not exit 0')
  return { test: test.command as string, lint: lint.command as string }
}

export function builderPass(): unknown {
  return {
    status: 'pass',
    summary: 'Implemented the scenario change.',
    evidence: [{ kind: 'file', ref: 'package.json', excerpt: 'scripts' }],
    findings: [],
    files_touched: [],
    next_hint: null,
  }
}

export function verifierPass(receipts: { test: string; lint: string }): unknown {
  return {
    status: 'pass',
    summary: 'The suite and the linter both exit 0.',
    evidence: [
      { kind: 'test', ref: receipts.test, excerpt: 'tests 1, pass 1, fail 0' },
      { kind: 'command', ref: receipts.lint, excerpt: 'lint clean' },
    ],
    findings: [],
    files_touched: [],
    next_hint: null,
  }
}

export function verifierFail(receipts: { test: string; lint: string }): unknown {
  return {
    status: 'fail',
    summary: 'The suite is red.',
    evidence: [{ kind: 'test', ref: receipts.test, excerpt: '1 failing' }],
    findings: [{ severity: 'high', file: 'package.json', line: 1, claim: 'the scenario behaviour is missing' }],
    files_touched: [],
    next_hint: null,
  }
}

async function planFor(
  projectDir: string,
  state: State,
  config: Config,
  policy: QualityPolicy,
): Promise<PlannedQualityDispatch[]> {
  const track = findTrack(config, state.track as string)
  if (track === undefined) throw new Error(`track "${String(state.track)}" is not configured`)
  return planQualityDispatches({
    trackName: state.track as string,
    track,
    config,
    policy,
    goal: state.goal ?? '',
    acceptance: [],
    intendedFiles: [],
    componentKinds: [],
  })
}

/**
 * Put `orchestration.quality` on one side of the explicit/legacy split.
 *
 * Written through the YAML document rather than through `writeConfig`, which
 * always serialises a parsed `Config` and therefore always emits `mode` — the
 * one shape that can never produce a legacy or default-existing reading.
 */
export async function setQualityBlock(projectDir: string, source: QualitySource, mode: QualityMode): Promise<void> {
  const file = path.join(projectDir, '.mjloop', 'config.yaml')
  const document = YAML.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
  const orchestration = { ...(document.orchestration as Record<string, unknown> | undefined) }
  if (source === 'explicit') orchestration.quality = { mode }
  else if (source === 'legacy') orchestration.quality = { independent_verification: true, independent_plan_review: false }
  else delete orchestration.quality
  document.orchestration = orchestration
  await fs.writeFile(file, YAML.stringify(document, { lineWidth: 100 }), 'utf8')
}
