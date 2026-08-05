import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildQualityPolicy,
  classifyPolicyIntegrity,
  createInitialQualityLedger,
  ensureRunQualityPolicy,
} from '../../src/ops/quality-policy.js'
import { qualityRuntimeEnabled } from '../../src/ops/quality-capability.js'
import { initLoop } from '../../src/ops/init.js'
import { runDirPath, runStart } from '../../src/ops/run.js'
import { defaultConfig } from '../../src/schemas/config.js'
import { initialState, type State } from '../../src/schemas/state.js'
import { writeJsonAtomic } from '../../src/store/atomic.js'
import { configRevision, mutateConfig } from '../../src/store/config-mutation.js'
import { loadConfig, writeConfig } from '../../src/store/config-store.js'
import { readLedger, readPolicy, writeLedger, writePolicyOnce } from '../../src/store/quality-store.js'
import { StateStore } from '../../src/store/state-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-08-04T10:36:00.000Z')
const clock = (): Date => NOW

let project: TmpProject
beforeEach(async () => {
  project = await makeTmpProject({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) })
  await initLoop(project.dir, clock)
})
afterEach(async () => { await project.cleanup() })

async function setQualityMode(mode: 'economy' | 'adaptive' | 'strict'): Promise<void> {
  const file = path.join(project.dir, '.mjloop', 'config.yaml')
  const raw = await fs.readFile(file, 'utf8')
  await mutateConfig(project.dir, {
    revision: configRevision(raw),
    changes: [{ kind: 'orchestration.quality.mode', value: mode }],
  })
}

async function seedLegacyRunningState(marker: 1 | null = null): Promise<State> {
  const state: State = {
    ...initialState(NOW),
    run_id: '2026-08-04-001',
    track: 'build',
    status: 'running',
    cycle: 1,
    goal: 'Continue the dashboard',
    started_at: NOW.toISOString(),
    quality_policy_version: marker,
    current: { plan: null, story: null, stage: 'compose' },
  }
  await writeJsonAtomic(path.join(project.dir, '.mjloop', 'state.json'), state)
  await fs.mkdir(runDirPath(project.dir, state), { recursive: true })
  return state
}

describe('quality policy construction', () => {
  it.each([
    ['explicit', 'explicit', 'active'],
    ['legacy', 'legacy', 'shadow'],
    ['default-existing', 'legacy', 'shadow'],
  ] as const)('maps %s configuration to %s %s intent', async (qualitySource, source, enforcement) => {
    const config = defaultConfig({ test: 'npm test', lint: null, build: null })
    const policy = await buildQualityPolicy({
      config,
      qualitySource,
      supervision: 'unattended',
      track: config.tracks.build!,
      goal: 'Add the dashboard',
      acceptance: ['The dashboard renders.'],
      intendedFiles: ['src/Dashboard.tsx'],
      changedFiles: [],
      componentKinds: ['nextjs'],
      priorFailures: [],
    }, clock)

    expect(policy).toMatchObject({
      version: 1,
      mode: 'adaptive',
      supervision: 'unattended',
      source,
      enforcement,
      initial_quality_plan: { ui: { value: 'required' } },
    })
    expect(policy.dispatches.length).toBeGreaterThan(0)
    expect(policy.budget.max_dispatches).toBeGreaterThanOrEqual(policy.dispatches.length)
  })

  it('creates pending entries only for required dimensions', async () => {
    const config = defaultConfig({ test: 'npm test', lint: null, build: null })
    const policy = await buildQualityPolicy({
      config,
      qualitySource: 'explicit',
      supervision: 'supervised',
      track: config.tracks.edit!,
      goal: 'Rename an internal symbol',
      acceptance: [],
      intendedFiles: ['src/internal.ts'],
      changedFiles: [],
      componentKinds: [],
      priorFailures: [],
    }, clock)

    const ledger = createInitialQualityLedger(policy, clock)
    expect(ledger.dimensions.correctness.status).toBe('pending')
    expect(ledger.dimensions.ui.status).toBe('not_applicable')
    for (const entry of Object.values(ledger.dimensions)) {
      expect(entry.inputs_fingerprint).toMatch(/^[a-f0-9]{64}$/)
      expect(entry.evidence_refs).toEqual([])
      expect(entry.checked_at).toBeNull()
      expect(entry.invalidated_at).toBeNull()
    }
  })

  // Inverted from "keeps the production rollout capability closed" when the
  // gate was opened. The behaviour behind it is asserted in both directions by
  // `tests/integration/quality-modes.test.ts`, which reads the same real
  // switch; this one keeps the flag itself named in the policy suite.
  it('opens the production rollout capability', () => {
    expect(qualityRuntimeEnabled()).toBe(true)
  })
})

describe('policy integrity classification', () => {
  const records = ['missing', 'valid', 'invalid'] as const

  it.each(records.flatMap((policy) => records.map((ledger) => ({ policy, ledger }))))(
    'halts marker-first state with $policy policy and $ledger ledger unless both are valid',
    ({ policy, ledger }) => {
      expect(classifyPolicyIntegrity({ marker: 1, policy, ledger })).toBe(
        policy === 'valid' && ledger === 'valid' ? 'ready' : 'halt',
      )
    },
  )

  it.each(records.flatMap((policy) => records.map((ledger) => ({ policy, ledger }))))(
    'classifies legacy state with $policy policy and $ledger ledger',
    ({ policy, ledger }) => {
      const expected = policy === 'missing' && ledger === 'missing'
        ? 'legacy-bootstrap'
        : policy === 'valid' && ledger === 'valid'
          ? 'recover-marker'
          : 'halt'
      expect(classifyPolicyIntegrity({ marker: null, policy, ledger })).toBe(expected)
    },
  )
})

describe('policy pinning and bootstrap', () => {
  it('pins an explicit adaptive run as active and ignores a later config change', async () => {
    const state = await runStart(project.dir, {
      track: 'build', goal: 'Add the dashboard', supervision: 'unattended',
    }, clock)
    await setQualityMode('strict')

    expect(await readPolicy(project.dir, state)).toMatchObject({
      mode: 'adaptive', supervision: 'unattended', enforcement: 'active', source: 'explicit',
    })
    expect((await readLedger(project.dir, state)).version).toBe(1)
    expect((await new StateStore(project.dir).get()).quality_policy_version).toBe(1)
  })

  it('bootstraps a pre-policy active run once before a quality config mutation', async () => {
    const config = defaultConfig({ test: 'npm test', lint: null, build: null })
    await writeConfig(project.dir, config)
    const file = path.join(project.dir, '.mjloop', 'config.yaml')
    const raw = await fs.readFile(file, 'utf8')
    await fs.writeFile(file, raw.replace(
      /\n  quality:\n    mode: adaptive/,
      '\n  quality:\n    independent_plan_review: true\n    independent_verification: false',
    ), 'utf8')
    const state = await seedLegacyRunningState()

    await setQualityMode('strict')

    expect((await new StateStore(project.dir).get()).quality_policy_version).toBe(1)
    expect(await readPolicy(project.dir, state)).toMatchObject({ source: 'legacy', enforcement: 'shadow', mode: 'adaptive' })
    expect((await readLedger(project.dir, state)).version).toBe(1)
  })

  it('halts when the marker exists but either protected pin is missing', async () => {
    await seedLegacyRunningState(1)

    await expect(ensureRunQualityPolicy(project.dir, clock)).rejects.toThrow(/integrity/i)
    expect(await new StateStore(project.dir).get()).toMatchObject({
      status: 'halted', halt_reason: expect.stringMatching(/integrity/i),
    })
  })

  it('recovers a null marker when a valid policy and ledger already exist', async () => {
    const state = await seedLegacyRunningState()
    const config = await loadConfig(project.dir)
    const policy = await buildQualityPolicy({
      config,
      qualitySource: 'legacy',
      supervision: 'supervised',
      track: config.tracks.build!,
      goal: state.goal!,
      acceptance: [], intendedFiles: [], changedFiles: [], componentKinds: [], priorFailures: [],
    }, clock)
    await writePolicyOnce(project.dir, state, policy)
    await writeLedger(project.dir, state, createInitialQualityLedger(policy, clock))

    expect(await ensureRunQualityPolicy(project.dir, clock)).toEqual(policy)
    expect((await new StateStore(project.dir).get()).quality_policy_version).toBe(1)
  })
})
