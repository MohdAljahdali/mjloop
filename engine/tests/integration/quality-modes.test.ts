import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * **No injected gate.** Every suite before this one mocked
 * `qualityRuntimeEnabled` open because production held it closed. This one
 * calls the real switch, which is what makes it the proof that opening it was
 * safe: if the gate is ever closed again, this file goes red rather than
 * quietly passing against a mock.
 */
import { qualityRuntimeEnabled } from '../../src/ops/quality-capability.js'
import { runLog } from '../../src/ops/log.js'
import { QualityPolicyIntegrityError, ensureRunQualityPolicy } from '../../src/ops/quality-policy.js'
import { amendQualityBudget, QualityBudgetExhaustedError } from '../../src/ops/quality-control.js'
import { cycleAdvance, runDirPath } from '../../src/ops/run.js'
import { readQualityUsage, QUALITY_USAGE_FILE } from '../../src/ops/quality-control.js'
import { rosterSet } from '../../src/ops/roster.js'
import type { QualityDimension } from '../../src/schemas/quality.js'
import { loadConfig, writeConfig } from '../../src/store/config-store.js'
import { readLedger, readPolicy, writeLedger } from '../../src/store/quality-store.js'
import { StateStore } from '../../src/store/state-store.js'
import {
  highRiskScenario,
  lowRiskBackendScenario,
  mediumBackendScenario,
  uiSurfaceScenario,
} from '../fixtures/quality/scenarios.js'
import {
  baseDispatchOf,
  builderPass,
  collectPassingEvidence,
  declareRoster,
  loggedAgents,
  openQualityScenario,
  previewQualityScenario,
  runQualityScenario,
  runVerifySlots,
  setQualityBlock,
  verifierPass,
  type ScenarioHandle,
} from '../helpers/quality-scenario.js'
import type { TmpProject } from '../helpers/tmp-project.js'

const MODES = ['economy', 'adaptive', 'strict'] as const
const BASELINE: QualityDimension[] = ['alignment', 'correctness', 'regression', 'security']

const opened: TmpProject[] = []
afterEach(async () => {
  for (const project of opened.splice(0)) await project.cleanup()
})

function track<T extends { project: TmpProject }>(value: T): T {
  opened.push(value.project)
  return value
}

/* ── the two assertions that decide whether the gate may stay open ────────── */

describe('the production runtime gate', () => {
  it('is open', () => {
    expect(qualityRuntimeEnabled()).toBe(true)
  })

  it('makes an explicit project enforce its own pinned policy', async () => {
    const handle = track(await openQualityScenario({ mode: 'strict', scenario: mediumBackendScenario() }))
    expect(handle.policy.source).toBe('explicit')
    expect(handle.policy.enforcement).toBe('active')

    await declareRoster(handle)
    // The whole difference the open gate makes: a caller's `pass` is no longer
    // the last word when the pinned plan's evidence is not there.
    await expect(cycleAdvance(handle.dir, { agents: ['builder'], result: 'pass' }, handle.clock))
      .rejects.toThrow(/quality evidence is incomplete/)
  })

  it.each(['legacy', 'default-existing'] as const)('leaves a %s project in shadow', async (source) => {
    const handle = track(await openQualityScenario({ source, scenario: mediumBackendScenario() }))
    expect(handle.policy.enforcement).toBe('shadow')

    await declareRoster(handle)
    // Byte-for-byte the behaviour a project that opted into nothing had before
    // the gate opened: no evidence, and the caller's pass still closes the run.
    const closed = await cycleAdvance(handle.dir, { agents: ['builder'], result: 'pass' }, handle.clock)
    expect(closed.state.status).toBe('done')
  })
})

/* ── the close condition is the same in every mode ────────────────────────── */

describe('the closure contract across modes', () => {
  it.each(MODES)('%s closes the same required dimensions for a medium-risk backend change', async (mode) => {
    const result = track(await runQualityScenario({ mode, scenario: mediumBackendScenario() }))

    expect([...result.requiredDimensions].sort()).toEqual(BASELINE)
    expect(result.state.status).toBe('done')
    for (const dimension of BASELINE) {
      expect(result.ledger.dimensions[dimension].status).toBe('pass')
    }
  })

  it.each(MODES)('%s marks ui not applicable only with a recorded deterministic reason', async (mode) => {
    const result = track(await runQualityScenario({ mode, scenario: mediumBackendScenario() }))

    expect(result.policy.initial_quality_plan.ui.value).toBe('not_applicable')
    expect(result.policy.initial_quality_plan.ui.reason).toBe(
      'No path, component, goal, or acceptance signal indicates a user-visible surface.',
    )
    expect(result.ledger.dimensions.ui.status).toBe('not_applicable')
  })

  it.each(MODES)('%s requires ui as a fifth dimension for a user-visible change', async (mode) => {
    const result = track(await runQualityScenario({ mode, scenario: uiSurfaceScenario() }))

    expect([...result.requiredDimensions].sort()).toEqual([...BASELINE, 'ui'].sort())
    expect(result.policy.initial_quality_plan.ui.reason).toMatch(/User-visible surface indicated by/)
  })

  it.each([
    ['low', lowRiskBackendScenario(), 'low'],
    ['medium', mediumBackendScenario(), 'medium'],
    ['high', highRiskScenario(), 'high'],
  ] as const)('reads %s-risk work at that level without lowering the close condition', async (_name, scenario, level) => {
    for (const mode of MODES) {
      const handle = track(await openQualityScenario({ mode, scenario }))
      expect(handle.policy.risk.level).toBe(level)
      expect([...handle.requiredDimensions].sort()).toEqual(BASELINE)
    }
  })
})

/* ── what a mode may and may not change ───────────────────────────────────── */

describe('what a mode is allowed to move', () => {
  it('uses fewer planned dispatches in economy than strict when evidence can be combined', async () => {
    const { project, modes } = await previewQualityScenario(mediumBackendScenario())
    opened.push(project)

    expect(modes.economy.dispatches.length).toBeLessThan(modes.strict.dispatches.length)
    expect(modes.economy.requiredDimensions).toEqual(modes.strict.requiredDimensions)
    expect(modes.adaptive.requiredDimensions).toEqual(modes.strict.requiredDimensions)
  })

  it('never lets economy skip a dimension strict requires, on any risk level', async () => {
    for (const scenario of [lowRiskBackendScenario(), mediumBackendScenario(), highRiskScenario(), uiSurfaceScenario()]) {
      const { project, modes } = await previewQualityScenario(scenario)
      opened.push(project)
      expect(modes.economy.requiredDimensions).toEqual(modes.strict.requiredDimensions)
      expect(modes.adaptive.requiredDimensions).toEqual(modes.strict.requiredDimensions)
    }
  })

  it('refuses a pass in every mode while a required dimension has failed', async () => {
    for (const mode of MODES) {
      const handle = track(await openQualityScenario({ mode, scenario: mediumBackendScenario() }))
      await declareRoster(handle)
      await collectPassingEvidence(handle)

      const ledger = await readLedger(handle.dir, handle.state)
      ledger.dimensions.security.status = 'fail'
      await writeLedger(handle.dir, handle.state, ledger)

      await expect(cycleAdvance(handle.dir, { agents: loggedAgents(handle), result: 'pass' }, handle.clock))
        .rejects.toThrow(/security/)
    }
  })

  it('refuses a pass in every mode while a required dimension is stale', async () => {
    for (const mode of MODES) {
      const handle = track(await openQualityScenario({ mode, scenario: mediumBackendScenario() }))
      await declareRoster(handle)
      await collectPassingEvidence(handle)

      const ledger = await readLedger(handle.dir, handle.state)
      ledger.dimensions.correctness.invalidated_at = handle.clock().toISOString()
      await writeLedger(handle.dir, handle.state, ledger)

      await expect(cycleAdvance(handle.dir, { agents: loggedAgents(handle), result: 'pass' }, handle.clock))
        .rejects.toThrow(/correctness: evidence is stale/)
    }
  })
})

/* ── the projects that never opted in ─────────────────────────────────────── */

describe('legacy and default-existing projects', () => {
  it.each(['legacy', 'default-existing'] as const)('pins %s configuration as shadow and closes on the caller\'s pass', async (source) => {
    const handle = track(await openQualityScenario({ source, scenario: mediumBackendScenario() }))
    expect(handle.policy.source).toBe('legacy')
    expect(handle.policy.enforcement).toBe('shadow')

    await declareRoster(handle)
    // No evidence at all: every required dimension is still pending, and a
    // shadow run closes anyway. That is the whole of the shadow contract.
    const closed = await cycleAdvance(handle.dir, { agents: ['builder'], result: 'pass' }, handle.clock)
    expect(closed.state.status).toBe('done')

    const ledger = await readLedger(handle.dir, closed.state)
    expect(ledger.dimensions.correctness.status).toBe('pending')
  })

  it('keeps a shadow run shadow when the project opts in mid-run', async () => {
    const handle = track(await openQualityScenario({ source: 'legacy', scenario: mediumBackendScenario() }))
    await setQualityBlock(handle.dir, 'explicit', 'strict')

    const { policy } = await handle.read()
    expect(policy.enforcement).toBe('shadow')
    expect(policy.mode).toBe('adaptive')

    await declareRoster(handle)
    const closed = await cycleAdvance(handle.dir, { agents: ['builder'], result: 'pass' }, handle.clock)
    expect(closed.state.status).toBe('done')
  })

  it('keeps an enforcing run on its pinned mode when the project switches mode mid-run', async () => {
    const handle = track(await openQualityScenario({ mode: 'economy', scenario: mediumBackendScenario() }))
    await setQualityBlock(handle.dir, 'explicit', 'strict')

    const { policy } = await handle.read()
    expect(policy.mode).toBe('economy')
    expect(policy.enforcement).toBe('active')

    // The pin still decides, so the cycle still cannot close without evidence.
    await declareRoster(handle)
    await expect(cycleAdvance(handle.dir, { agents: ['builder'], result: 'pass' }, handle.clock))
      .rejects.toThrow(/correctness/)
  })
})

/* ── the guards a run meets while it works ────────────────────────────────── */

describe('dispatch accounting', () => {
  it('charges a re-declared roster once', async () => {
    const handle = track(await openQualityScenario({ mode: 'strict', scenario: mediumBackendScenario() }))
    await declareRoster(handle)
    const first = await readQualityUsage(path.join(runDirPath(handle.dir, handle.state), QUALITY_USAGE_FILE))
    await declareRoster(handle)
    const second = await readQualityUsage(path.join(runDirPath(handle.dir, handle.state), QUALITY_USAGE_FILE))

    expect(first.reservations.length).toBe(handle.dispatches.length)
    expect(second.reservations).toEqual(first.reservations)
  })

  it('refuses a dispatch that answers the same way twice in one cycle', async () => {
    const handle = track(await openQualityScenario({ mode: 'economy', scenario: mediumBackendScenario() }))
    await declareRoster(handle)
    await runLog(handle.dir, { agent: 'builder', result: builderPass() }, handle.clock)
    const receipts = await runVerifySlots(handle)
    const base = baseDispatchOf(handle)

    await runLog(handle.dir, { agent: base.agent, result: verifierPass(receipts) }, handle.clock)
    await expect(runLog(handle.dir, { agent: base.agent, result: verifierPass(receipts) }, handle.clock))
      .rejects.toThrow(/DuplicateQualityDispatch|already/i)
  })

  it('suspends a run that would exceed its dispatch ceiling and resumes it on one amendment', async () => {
    const handle = track(await openQualityScenario({ mode: 'strict', scenario: mediumBackendScenario() }))
    // A ceiling of one, written into the pin before the roster is declared:
    // the strict plan needs more than that, so the first declaration suspends.
    const policyFile = path.join(runDirPath(handle.dir, handle.state), 'quality-policy.json')
    const pinned = JSON.parse(await fs.readFile(policyFile, 'utf8')) as { budget: { max_dispatches: number } }
    pinned.budget.max_dispatches = 1
    await fs.writeFile(policyFile, `${JSON.stringify(pinned, null, 2)}\n`, 'utf8')

    await expect(declareRoster(handle)).rejects.toThrow(QualityBudgetExhaustedError)
    const suspended = await new StateStore(handle.dir, handle.clock).get()
    expect(suspended.status).toBe('budget_exhausted')
    expect(suspended.halt_reason).toMatch(/max_dispatches/)

    const resumed = await amendQualityBudget(handle.dir, {
      run: suspended.run_id as string,
      field: 'max_dispatches',
      from: 1,
      to: 20,
      reason: 'the strict plan needs its own specialists',
      decided_by: 'operator',
    }, handle.clock)
    expect(resumed.status).toBe('running')
    await expect(declareRoster(handle)).resolves.toBeUndefined()
  })
})

/* ── the run survives being put down and picked up ────────────────────────── */

describe('restart and resume', () => {
  it('reuses the pinned policy and ledger a second reader finds on disk', async () => {
    const handle = track(await openQualityScenario({ mode: 'strict', scenario: mediumBackendScenario() }))
    await declareRoster(handle)
    await collectPassingEvidence(handle)

    // A fresh process reads the same run: nothing is re-derived from live
    // config, and the ledger's earned passes survive.
    const reopened = await ensureRunQualityPolicy(handle.dir, handle.clock)
    expect(reopened.pinned_at).toBe(handle.policy.pinned_at)
    expect(reopened.mode).toBe('strict')

    const closed = await cycleAdvance(handle.dir, { agents: loggedAgents(handle), result: 'pass' }, handle.clock)
    expect(closed.state.status).toBe('done')
  })

  it('halts a run whose pinned policy is missing', async () => {
    const handle = track(await openQualityScenario({ mode: 'strict', scenario: mediumBackendScenario() }))
    await fs.rm(path.join(runDirPath(handle.dir, handle.state), 'quality-policy.json'))

    await expect(ensureRunQualityPolicy(handle.dir, handle.clock)).rejects.toThrow(QualityPolicyIntegrityError)
    const halted = await new StateStore(handle.dir, handle.clock).get()
    expect(halted.status).toBe('halted')
    expect(halted.halt_reason).toMatch(/quality policy integrity failure/)
  })

  it('halts a run whose pinned policy will not parse', async () => {
    const handle = track(await openQualityScenario({ mode: 'strict', scenario: mediumBackendScenario() }))
    const file = path.join(runDirPath(handle.dir, handle.state), 'quality-policy.json')
    await fs.writeFile(file, '{"version":1,"mode":"not-a-mode"}\n', 'utf8')

    await expect(ensureRunQualityPolicy(handle.dir, handle.clock)).rejects.toThrow(QualityPolicyIntegrityError)
    expect((await new StateStore(handle.dir, handle.clock).get()).status).toBe('halted')
  })
})
