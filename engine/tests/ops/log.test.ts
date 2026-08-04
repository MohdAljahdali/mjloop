import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ClosingAgentError,
  ContradictedEvidenceError,
  CycleClosedError,
  DuplicateQualityDispatchError,
  ForbiddenSpecialistError,
  GateClosedError,
  InvalidAgentNameError,
  InvalidAgentResultError,
  OrderViolationError,
  RunReplacedError,
  UnknownAgentError,
  UnselectedSkillError,
  runLog,
} from '../../src/ops/log.js'
import { DestructiveApprovalRequiredError } from '../../src/ops/destructive-risk.js'
import { initLoop } from '../../src/ops/init.js'
import { rosterSet } from '../../src/ops/roster.js'
import { NoActiveRunError, UnknownTrackError, cycleAdvance, cycleDirPath, runDirPath, runStart } from '../../src/ops/run.js'
import { EVIDENCE_EXCERPT_MAX } from '../../src/schemas/contract.js'
import { SkillManifestSchema } from '../../src/schemas/skill-selection.js'
import type { State } from '../../src/schemas/state.js'
import { configRevision, mutateConfig } from '../../src/store/config-mutation.js'
import { loadConfig, writeConfig } from '../../src/store/config-store.js'
import { readLedger } from '../../src/store/quality-store.js'
import { StateStore } from '../../src/store/state-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

// The rollout gate this milestone's runtime behaviour hangs off. It is `false`
// in production until Task 17, so the only way this file can exercise the one
// branch that refuses — a repeated dispatch — is to open it here.
vi.mock('../../src/ops/quality-capability.js', () => ({ qualityRuntimeEnabled: vi.fn(() => false) }))
import { qualityRuntimeEnabled } from '../../src/ops/quality-capability.js'

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

const run = promisify(execFile)

/** The directory of whichever run is open. */
async function runDir(): Promise<string> {
  return runDirPath(project.dir, await new StateStore(project.dir).get())
}

/** A ledger entry shaped as `verifyRun` writes one, with the fields a test varies. */
function ledgerEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slot: 'test',
    command: 'npm test',
    source: 'pinned',
    live_command: null,
    log: 'test.log',
    phase: 'complete',
    exit_code: 0,
    timed_out: false,
    fingerprint: null,
    cached_from_cycle: null,
    duration_ms: 1_200,
    at: NOW.toISOString(),
    ...over,
  }
}

/**
 * The ledger is written by hand rather than by `verifyRun`: these tests are
 * about what `runLog` does with a record of what the engine ran, and spawning a
 * real command to produce one would make them a test of the executor instead.
 */
async function writeLedger(cycle: string, entries: Record<string, unknown>[]): Promise<void> {
  const dir = path.join(await runDir(), cycle, 'verify')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'index.json'), `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
}

async function stateHash(): Promise<string> {
  const raw = await fs.readFile(path.join(project.dir, '.mjloop', 'state.json'))
  return crypto.createHash('sha256').update(raw).digest('hex')
}

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

describe('runLog agent names', () => {
  it('refuses a name that would write outside the cycle directory', async () => {
    // The name arrives from the leader model, and `.mjloop/state.json` is three
    // levels up from the cycle directory.
    await expect(runLog(project.dir, { agent: '../../../state', result: RESULT }, clock)).rejects.toBeInstanceOf(
      InvalidAgentNameError,
    )

    const state = await new StateStore(project.dir).get()
    expect(state.status).toBe('running')
    expect(state.findings).toEqual([])
    expect(await fs.readdir(path.join(runDirPath(project.dir, state), 'cycle-01')).catch(() => [])).toEqual([])
  })

  it('refuses a name reserved by the cycle directory', async () => {
    // `cycle-NN/findings.json` is the archive cycleAdvance writes; an agent by
    // that name would have its result overwritten at cycle close.
    await expect(runLog(project.dir, { agent: 'findings', result: RESULT }, clock)).rejects.toBeInstanceOf(
      InvalidAgentNameError,
    )
  })

  it('accepts the ordinary agent names', async () => {
    const config = await loadConfig(project.dir)
    config.tracks.edit = { required: ['editor', 'verifier'], available: ['ui-critic_2'], closing: [], max_cycles: 1, order: [] }
    await writeConfig(project.dir, config)

    await expect(runLog(project.dir, { agent: 'verifier', result: RESULT }, clock)).resolves.toBeDefined()
    await expect(runLog(project.dir, { agent: 'ui-critic_2', result: RESULT }, clock)).resolves.toBeDefined()
  })

  it('refuses a name whose "--" would collide with an instance', async () => {
    // `a` with instance `b` and the agent `a--b` would both write `a--b.json`,
    // and the second write would discard the first verdict.
    await expect(runLog(project.dir, { agent: 'editor--verifier', result: RESULT }, clock)).rejects.toBeInstanceOf(
      InvalidAgentNameError,
    )
    await expect(
      runLog(project.dir, { agent: 'editor', instance: 'a--b', result: RESULT }, clock),
    ).rejects.toBeInstanceOf(InvalidAgentNameError)
  })
})

describe('runLog against the track roster', () => {
  it('refuses an agent the track does not define', async () => {
    await expect(runLog(project.dir, { agent: 'fixer', result: RESULT }, clock)).rejects.toBeInstanceOf(
      UnknownAgentError,
    )

    const state = await new StateStore(project.dir).get()
    expect(state.findings).toEqual([])
    expect(await fs.readdir(path.join(runDirPath(project.dir, state), 'cycle-01')).catch(() => [])).toEqual([])
  })

  it('accepts a specialist the config forces into every cycle', async () => {
    const config = await loadConfig(project.dir)
    config.specialists.security = 'always'
    await writeConfig(project.dir, config)

    await expect(runLog(project.dir, { agent: 'security', result: RESULT }, clock)).resolves.toBeDefined()
  })

  it('refuses a specialist the config forbids, though the track defines it', async () => {
    const config = await loadConfig(project.dir)
    config.tracks.edit = { required: ['editor', 'verifier'], available: ['security'], closing: [], max_cycles: 3, order: [] }
    config.specialists = { security: 'never' }
    await writeConfig(project.dir, config)

    await expect(runLog(project.dir, { agent: 'security', result: RESULT }, clock)).rejects.toBeInstanceOf(
      ForbiddenSpecialistError,
    )
    await expect(runLog(project.dir, { agent: 'security', result: RESULT }, clock)).rejects.toThrow(/never/)

    // No result file, and no finding: a forbidden agent leaves nothing behind
    // for the leader's pass rule to trip over. `rosterSet` is not consulted
    // here, so this is the only thing standing between it and the cycle.
    const state = await new StateStore(project.dir).get()
    expect(state.findings).toEqual([])
    expect(await fs.readdir(path.join(runDirPath(project.dir, state), 'cycle-01')).catch(() => [])).toEqual([])
  })

  it('refuses the log when the running track has gone missing from config', async () => {
    // rosterSet and cycleAdvance both fail closed on a missing track; a gate
    // that cannot be found must refuse the log rather than vanish.
    const config = await loadConfig(project.dir)
    delete config.tracks.edit
    await writeConfig(project.dir, config)

    await expect(runLog(project.dir, { agent: 'verifier', result: RESULT }, clock)).rejects.toBeInstanceOf(
      UnknownTrackError,
    )
  })
})

describe('runLog instances', () => {
  const verdict = {
    status: 'fail' as const,
    summary: 'The hypothesis does not hold: the cache is populated before the read.',
    evidence: [{ kind: 'command' as const, ref: 'npm test -- cache', excerpt: 'ordering is correct' }],
    findings: [],
    files_touched: [],
    next_hint: null,
  }

  // Both agents belong to the `fix` track, and `runLog` accepts only agents the
  // running track defines.
  beforeEach(async () => {
    await runStart(project.dir, { track: 'fix', goal: 'Stale cache entry' }, clock)
  })

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

/**
 * The story's other stop condition: "do not let a model add a skill id absent
 * from the validated selection."
 *
 * Its sibling — "no per-technology agent" — got a mechanical test, and this one
 * has to have the same, because prose in a skill file is precisely the
 * free-form model claim the pinned manifest exists to replace. The manifest is
 * on disk, protected from edits, and names exactly which skills each role was
 * offered; a `skills_used` nobody joins against it is a claim with a witness
 * standing right there, unasked.
 */
describe('runLog against the run pinned skill manifest', () => {
  /** A manifest as `runStart` pins one, with whatever selections a case needs. */
  async function writeManifest(selections: Array<Record<string, unknown>>): Promise<void> {
    const guidance = Object.fromEntries(
      selections
        .flatMap((selection) => selection.skillIds as string[])
        .map((skillId) => [skillId, `follow ${skillId}`]),
    )
    const manifest = SkillManifestSchema.parse({
      schema: 1,
      generatedAt: NOW.toISOString(),
      sourceBrief: { id: 'F001', revision: 1 },
      profileRevision: 1,
      selections,
      guidance,
      concurrency: { mode: 'sequential', reason: 'fewer than two affected components' },
    })
    await fs.writeFile(
      path.join(await runDir(), 'skill-selection.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    )
  }

  function selection(agent: string, skillIds: string[]): Record<string, unknown> {
    return {
      component: 'web',
      agent,
      skillIds,
      reasons: skillIds.map((skillId) => `"${skillId}" matches component "web"'s skillTag "nextjs"`),
      sourceBrief: { id: 'F001', revision: 1 },
    }
  }

  it('records the skills an agent used when the manifest selected exactly those', async () => {
    await writeManifest([selection('editor', ['eslint-strict'])])
    const { path: file } = await runLog(
      project.dir,
      { agent: 'editor', result: { ...RESULT, skills_used: ['eslint-strict'] } },
      clock,
    )
    expect(JSON.parse(await fs.readFile(file, 'utf8')).skills_used).toEqual(['eslint-strict'])
  })

  it('refuses a skill id the manifest never selected for this agent', async () => {
    await writeManifest([selection('editor', ['eslint-strict'])])
    await expect(
      runLog(project.dir, { agent: 'editor', result: { ...RESULT, skills_used: ['invented-skill'] } }, clock),
    ).rejects.toBeInstanceOf(UnselectedSkillError)

    // The same property every other refusal in this function has: nothing was
    // written, so a corrective retry starts from the same state the first
    // attempt did.
    const state = await new StateStore(project.dir).get()
    expect(state.findings).toEqual([])
    expect(await fs.readdir(path.join(runDirPath(project.dir, state), 'cycle-01')).catch(() => [])).toEqual([])
  })

  it('refuses a skill the manifest selected for a different role', async () => {
    // The join is per (agent) and not merely per manifest: a skill offered to
    // `verifier` is not one `editor` was told to follow, and accepting it would
    // make "which agent was told what" unanswerable from the record.
    await writeManifest([selection('verifier', ['eslint-strict'])])
    await expect(
      runLog(project.dir, { agent: 'editor', result: { ...RESULT, skills_used: ['eslint-strict'] } }, clock),
    ).rejects.toBeInstanceOf(UnselectedSkillError)
  })

  it('refuses any claimed skill on a run that pinned no manifest at all', async () => {
    // Today's universal case, and the one where a model is most likely to
    // invent an id: nothing was selected, so nothing may be claimed.
    await expect(
      runLog(project.dir, { agent: 'editor', result: { ...RESULT, skills_used: ['security-auth-guard'] } }, clock),
    ).rejects.toBeInstanceOf(UnselectedSkillError)
  })

  it('says which ids were refused and which were on offer', async () => {
    await writeManifest([selection('editor', ['eslint-strict'])])
    await expect(
      runLog(project.dir, { agent: 'editor', result: { ...RESULT, skills_used: ['invented-skill'] } }, clock),
    ).rejects.toThrow(/invented-skill/)
    await expect(
      runLog(project.dir, { agent: 'editor', result: { ...RESULT, skills_used: ['invented-skill'] } }, clock),
    ).rejects.toThrow(/eslint-strict/)
  })

  it('leaves a result that claims nothing entirely alone', async () => {
    // The unchanged-by-default case. `skills_used` defaults to `[]`, so every
    // result written before this field existed, and every agent that was handed
    // nothing, takes no new code path at all — the manifest is not even read.
    const { path: file } = await runLog(project.dir, { agent: 'editor', result: RESULT }, clock)
    expect(JSON.parse(await fs.readFile(file, 'utf8')).skills_used).toEqual([])
  })

  it('applies the same refusal to a closing agent', async () => {
    // A closing agent writes outside every cycle directory and skips the gate,
    // the roster and the ledger contradiction check — so if the join were
    // placed inside the ordinary path it would be the one result that could
    // carry an unbacked claim, and it is the result a commit rests on.
    const config = await loadConfig(project.dir)
    config.tracks.edit = { ...config.tracks.edit!, closing: ['docs'] }
    await writeConfig(project.dir, config)
    await new StateStore(project.dir, clock).update((draft) => {
      draft.status = 'done'
    })

    await expect(
      runLog(project.dir, { agent: 'docs', result: { ...RESULT, status: 'pass', skills_used: ['invented-skill'] } }, clock),
    ).rejects.toBeInstanceOf(UnselectedSkillError)
  })
})

describe('runLog against a cycle that closes under it', () => {
  beforeEach(async () => {
    const config = await loadConfig(project.dir)
    config.tracks.edit = { required: ['editor', 'verifier'], available: [], closing: [], max_cycles: 3, order: [] }
    await writeConfig(project.dir, config)
  })

  it('never files findings into a cycle that did not do the work', async () => {
    // The leader issues both calls in one turn. runLog reads state unlocked,
    // so the advance may land in between; whichever order they take, the
    // finding must not become cycle 2's.
    const [logged] = await Promise.allSettled([
      runLog(project.dir, { agent: 'verifier', result: RESULT }, clock),
      cycleAdvance(project.dir, { agents: ['editor', 'verifier'], result: 'fail' }, clock),
    ])

    const state = await new StateStore(project.dir).get()
    expect(state.cycle).toBe(2)
    expect(state.findings).toEqual([])
    if (logged.status === 'rejected') expect(logged.reason).toBeInstanceOf(CycleClosedError)
  })

  it('never leaves an open finding on a run that has finished', async () => {
    const [logged] = await Promise.allSettled([
      runLog(project.dir, { agent: 'verifier', result: RESULT }, clock),
      cycleAdvance(project.dir, { agents: ['editor', 'verifier'], result: 'pass' }, clock),
    ])

    const state = await new StateStore(project.dir).get()
    expect(state.status).toBe('done')
    // Either the finding was in the cycle that passed — and the leader's pass
    // rule owns that judgement — or it was rejected. It is never filed after.
    if (logged.status === 'rejected') expect(state.findings).toEqual([])
  })
})

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
      GateClosedError,
    )
  })

  it('rejects a spelling variant of a blocked agent', async () => {
    // On a case-insensitive filesystem `Fixer.json` *is* `fixer.json`, so a
    // gate keyed on an exact string would let the blocked work through under
    // the blocked agent's own path.
    const config = await loadConfig(project.dir)
    config.tracks.fix = {
      required: ['reproducer', 'fixer', 'verifier'],
      available: ['Fixer'],
      closing: [],
      max_cycles: 5,
      order: [],
      gate: { proven_by: 'reproducer', blocks: ['fixer'] },
    }
    await writeConfig(project.dir, config)

    await expect(runLog(project.dir, { agent: 'Fixer', result: fix }, clock)).rejects.toBeInstanceOf(GateClosedError)
  })

  it('rejects an agent no track defines rather than letting it record the blocked work', async () => {
    await expect(runLog(project.dir, { agent: 'fixer2', result: fix }, clock)).rejects.toBeInstanceOf(
      UnknownAgentError,
    )

    const state = await new StateStore(project.dir).get()
    await expect(fs.access(path.join(runDirPath(project.dir, state), 'cycle-01', 'fixer2.json'))).rejects.toThrow()
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
    const { path: file, gateOpened } = await runLog(project.dir, { agent: 'editor', result: fix }, clock)
    expect(path.basename(file)).toBe('editor.json')
    expect(gateOpened).toBe(false)
  })

  it('never opens the gate of a run that proved nothing', async () => {
    // The leader can issue both calls in one turn. `runStart` resets to cycle
    // 1, so cycle equality alone would read as the same run and file this
    // reproduction against a defect the new run has not demonstrated.
    const [logged] = await Promise.allSettled([
      runLog(project.dir, { agent: 'reproducer', result: proof }, clock),
      runStart(project.dir, { track: 'fix', goal: 'A different defect' }, clock),
    ])

    const state = await new StateStore(project.dir).get()
    if (logged.status === 'rejected') {
      expect(logged.reason).toBeInstanceOf(RunReplacedError)
      expect(state.reproduction).toBeNull()
    } else {
      // The log won the lock: its proof belongs to the run it was logged
      // against, and runStart cleared it on the way in.
      expect(state.goal).toBe('A different defect')
      expect(state.reproduction).toBeNull()
    }
  })
})

describe('runLog against order edges', () => {
  // A track with one real edge, the same cross-set shape the build track's
  // two real orderings take: `b` is required, `c` is available, and `b` may
  // not be logged until `c` has a result — when `c` was drafted at all.
  beforeEach(async () => {
    const config = await loadConfig(project.dir)
    config.tracks.mine = {
      required: ['a', 'b'],
      available: ['c'],
      closing: [],
      order: [{ agent: 'b', after: ['c'] }],
      max_cycles: 3,
    }
    await writeConfig(project.dir, config)
    await runStart(project.dir, { track: 'mine', goal: 'demo' }, clock)
  })

  it('refuses a result while its predecessor was drafted but has not logged one yet', async () => {
    await rosterSet(project.dir, { cycle: 1, selected: ['a', 'b', 'c'], skipped: {} })
    await expect(runLog(project.dir, { agent: 'b', result: RESULT }, clock)).rejects.toBeInstanceOf(
      OrderViolationError,
    )
  })

  it('names the agent, the predecessor and the track', async () => {
    await rosterSet(project.dir, { cycle: 1, selected: ['a', 'b', 'c'], skipped: {} })
    await expect(runLog(project.dir, { agent: 'b', result: RESULT }, clock)).rejects.toThrow(
      /"b" is ordered after "c" on track "mine"/,
    )
  })

  it('writes nothing and touches no state when it refuses', async () => {
    await rosterSet(project.dir, { cycle: 1, selected: ['a', 'b', 'c'], skipped: {} })
    await expect(runLog(project.dir, { agent: 'b', result: RESULT }, clock)).rejects.toThrow()

    const state = await new StateStore(project.dir).get()
    const cycleDir = path.join(runDirPath(project.dir, state), 'cycle-01')
    await expect(fs.access(path.join(cycleDir, 'b.json'))).rejects.toThrow()
    expect(state.findings).toEqual([])
  })

  it('accepts the result once the predecessor has logged its own', async () => {
    await rosterSet(project.dir, { cycle: 1, selected: ['a', 'b', 'c'], skipped: {} })
    await runLog(project.dir, { agent: 'c', result: RESULT }, clock)
    const { path: file } = await runLog(project.dir, { agent: 'b', result: RESULT }, clock)
    expect(path.basename(file)).toBe('b.json')
  })

  it("accepts the result once the predecessor has logged under an instance, not its bare name", async () => {
    // `runLog` itself writes an instanced result as `<agent>--<instance>.json`
    // (this file's `basename` construction, above), and `ops/run.ts`'s
    // `readAgentReports` resolves the agent from a basename by splitting on
    // the first `--` for exactly that reason (ops/run.ts:915-917). An order
    // edge whose predecessor only ever logs under an instance — the shipped
    // `fix` track's `hypothesis-tester`, fanned out N-wide by
    // skills/mjloop-leader/SKILL.md:193-196 — must not deadlock permanently
    // because no file is ever named exactly `<predecessor>.json`.
    await rosterSet(project.dir, { cycle: 1, selected: ['a', 'b', 'c'], skipped: {} })
    await runLog(project.dir, { agent: 'c', instance: 'stale-cache', result: RESULT }, clock)
    const { path: file } = await runLog(project.dir, { agent: 'b', result: RESULT }, clock)
    expect(path.basename(file)).toBe('b.json')
  })

  it('does not block when the predecessor was not drafted this cycle', async () => {
    // The vacuous-edge rule TrackSchema.order's comment states: `c` is not in
    // `selected`, so `b`'s edge is satisfied by the omission, not violated —
    // dispatchWaves applies the same rule when it groups the roster.
    await rosterSet(project.dir, { cycle: 1, selected: ['a', 'b'], skipped: { c: 'not needed' } })
    await expect(runLog(project.dir, { agent: 'b', result: RESULT }, clock)).resolves.toBeDefined()
  })

  it('does not block when no roster is on record for the cycle', async () => {
    // A roster this check cannot read says nothing about who was drafted, so
    // it must not refuse work over a decision it cannot see — the same
    // fail-open direction `refuseUnselectedSkills` takes for a missing
    // pinned manifest.
    await expect(runLog(project.dir, { agent: 'b', result: RESULT }, clock)).resolves.toBeDefined()
  })

  it('accepts a resumed cycle from result files already on disk, not from anything this process declared', async () => {
    // The hazard C2 names: the leader's resume path (skills/mjloop-leader/
    // SKILL.md step 2a) picks an interrupted cycle back up from exactly the
    // files already in the cycle directory, with nothing about what ran
    // before the restart surviving in memory. Neither `rosterSet` nor
    // `runLog` is called in this process for the roster or for `c` — both
    // are written straight to disk — so a check keyed on anything but the
    // cycle directory would refuse this, and `/mjloop:resume` would start
    // refusing every agent after the first on every project that uses it.
    const state = await new StateStore(project.dir).get()
    const cycleDir = path.join(runDirPath(project.dir, state), 'cycle-01')
    await fs.mkdir(cycleDir, { recursive: true })
    await fs.writeFile(
      path.join(cycleDir, 'roster.json'),
      JSON.stringify({ cycle: 1, selected: ['a', 'b', 'c'], skipped: {} }),
      'utf8',
    )
    await fs.writeFile(path.join(cycleDir, 'c.json'), JSON.stringify(RESULT), 'utf8')

    const { path: file } = await runLog(project.dir, { agent: 'b', result: RESULT }, clock)
    expect(path.basename(file)).toBe('b.json')
  })
})

describe('runLog error signatures', () => {
  const failing = {
    status: 'fail' as const,
    summary: 'the suite is red',
    evidence: [{ kind: 'command' as const, ref: 'npm test', excerpt: '3 failing: cannot resolve module' }],
    findings: [],
    files_touched: [],
    next_hint: null,
  }

  // Both agents belong to the `build` track, and `runLog` accepts only agents
  // the running track defines.
  beforeEach(async () => {
    await runStart(project.dir, { track: 'build', goal: 'Add the export button' }, clock)
  })

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

describe('runLog against the engine own verify ledger', () => {
  const passing = {
    status: 'pass' as const,
    summary: 'The suite is green.',
    evidence: [{ kind: 'command' as const, ref: 'npm test', excerpt: 'tests 40, pass 40, fail 0' }],
    findings: [],
    files_touched: [],
    next_hint: null,
  }

  beforeEach(async () => {
    await runStart(project.dir, { track: 'build', goal: 'Add the export button' }, clock)
  })

  it('refuses a pass whose evidence names a command the engine recorded as failing', async () => {
    await writeLedger('cycle-01', [ledgerEntry({ exit_code: 1 })])

    await expect(runLog(project.dir, { agent: 'verifier', result: passing }, clock)).rejects.toBeInstanceOf(
      ContradictedEvidenceError,
    )

    // The negative space every other refusal in this function keeps: the check
    // runs before anything is written, so a refused pass leaves no result file,
    // no finding and no signature behind.
    const state = await new StateStore(project.dir).get()
    expect(state.findings).toEqual([])
    expect(state.cycle_errors).toEqual([])
    await expect(fs.access(path.join(await runDir(), 'cycle-01', 'verifier.json'))).rejects.toThrow()
  })

  it('refuses a pass citing a command the engine killed', async () => {
    await writeLedger('cycle-01', [ledgerEntry({ exit_code: null, timed_out: true })])
    await expect(runLog(project.dir, { agent: 'verifier', result: passing }, clock)).rejects.toBeInstanceOf(
      ContradictedEvidenceError,
    )
  })

  it('refuses a pass citing a command still running', async () => {
    await writeLedger('cycle-01', [ledgerEntry({ phase: 'running', exit_code: null, duration_ms: null })])
    await expect(runLog(project.dir, { agent: 'verifier', result: passing }, clock)).rejects.toBeInstanceOf(
      ContradictedEvidenceError,
    )
  })

  it('refuses a pass citing a command that never started', async () => {
    // `queued` beside `running`: the command was still waiting for the project
    // verify lock, so a verdict resting on it rests on nothing at all.
    await writeLedger('cycle-01', [ledgerEntry({ phase: 'queued', exit_code: null, duration_ms: null })])
    await expect(runLog(project.dir, { agent: 'verifier', result: passing }, clock)).rejects.toBeInstanceOf(
      ContradictedEvidenceError,
    )
  })

  it('names the log path so the leader can read what actually happened', async () => {
    await writeLedger('cycle-01', [ledgerEntry({ exit_code: 1 })])
    await expect(runLog(project.dir, { agent: 'verifier', result: passing }, clock)).rejects.toThrow(
      new RegExp(`${path.basename(await runDir())}.cycle-01.verify.test\\.log`),
    )
  })

  it('tells the agent to re-run through the tool rather than merely refusing', async () => {
    // A red entry left behind by a builder that then fixed the defect is the
    // ordinary case, so the refusal has to carry its own remedy — otherwise a
    // correct verdict is thrown away and the leader's single corrective retry
    // burns on an engine error the agent did not cause.
    await writeLedger('cycle-01', [ledgerEntry({ exit_code: 1 })])
    await expect(runLog(project.dir, { agent: 'verifier', result: passing }, clock)).rejects.toThrow(
      /mjloop_verify_run/,
    )
  })

  it('accepts a pass the engine recorded as green', async () => {
    await writeLedger('cycle-01', [ledgerEntry({ exit_code: 0 })])
    await expect(runLog(project.dir, { agent: 'verifier', result: passing }, clock)).resolves.toBeDefined()
  })

  it('keys on the most recent entry, so a re-run clears the refusal', async () => {
    await writeLedger('cycle-01', [ledgerEntry({ exit_code: 1 }), ledgerEntry({ exit_code: 0 })])
    await expect(runLog(project.dir, { agent: 'verifier', result: passing }, clock)).resolves.toBeDefined()
  })

  it('refuses only a pass, so a failing result citing the same command is recorded', async () => {
    await writeLedger('cycle-01', [ledgerEntry({ exit_code: 1 })])
    const { path: file } = await runLog(
      project.dir,
      { agent: 'verifier', result: { ...passing, status: 'fail' as const } },
      clock,
    )
    expect(path.basename(file)).toBe('verifier.json')
  })

  it('matches a ref exactly rather than approximately', async () => {
    // No fuzzy matching, no substring: an agent that ran its own command under
    // a different name is in exactly the position it was before this check.
    await writeLedger('cycle-01', [ledgerEntry({ exit_code: 1 })])
    const result = { ...passing, evidence: [{ kind: 'command' as const, ref: 'npm test -- cache', excerpt: 'ok' }] }
    await expect(runLog(project.dir, { agent: 'verifier', result }, clock)).resolves.toBeDefined()
  })

  it('ignores a ledger the cycle does not have', async () => {
    // Every cycle of every project that predates the engine running verify
    // commands itself. The check is inert there rather than newly strict.
    await expect(runLog(project.dir, { agent: 'verifier', result: passing }, clock)).resolves.toBeDefined()
  })

  it('lets the gate prover pass on a command that exited non-zero', async () => {
    // The fix track's whole gate depends on this: `reproducer` returns "pass"
    // meaning "I demonstrated the defect", and the command it names is expected
    // to fail. A blanket rule would shut the track permanently.
    await runStart(project.dir, { track: 'fix', goal: 'Stale cache entry' }, clock)
    await writeLedger('cycle-01', [ledgerEntry({ exit_code: 1 })])

    const { gateOpened } = await runLog(project.dir, { agent: 'reproducer', result: passing }, clock)
    expect(gateOpened).toBe(true)
  })
})

describe('runLog bounding what an agent sends', () => {
  const long = `3 failing: cannot resolve module\n${'x'.repeat(5_000)}`

  const failing = {
    status: 'fail' as const,
    summary: 'the suite is red',
    evidence: [{ kind: 'command' as const, ref: 'npm test', excerpt: long }],
    findings: [],
    files_touched: [],
    next_hint: null,
  }

  beforeEach(async () => {
    await runStart(project.dir, { track: 'build', goal: 'Add the export button' }, clock)
  })

  it('writes the spill file before the result that points at it', async () => {
    const { path: file } = await runLog(project.dir, { agent: 'verifier', result: failing }, clock)
    const stored = JSON.parse(await fs.readFile(file, 'utf8')) as { evidence: { excerpt: string }[] }
    const excerpt = stored.evidence[0]?.excerpt ?? ''

    expect(excerpt.length).toBeLessThanOrEqual(EVIDENCE_EXCERPT_MAX)
    const spill = path.join(await runDir(), 'cycle-01', 'evidence', 'verifier--0.txt')
    expect(excerpt).toContain(path.relative(project.dir, spill))
    // Lossless: the marker names a file that exists and holds every character.
    expect(await fs.readFile(spill, 'utf8')).toBe(long)
  })

  it('writes no evidence directory when nothing overflows', async () => {
    await runLog(project.dir, { agent: 'verifier', result: { ...failing, evidence: [] } }, clock)
    await expect(fs.access(path.join(await runDir(), 'cycle-01', 'evidence'))).rejects.toThrow()
  })

  it('produces the same error signature before and after truncation', async () => {
    // The signature is computed from the excerpt **as stored**, so `cycle_errors`
    // and HALT.md always cite text a forensic reader can find on disk.
    await runLog(project.dir, { agent: 'verifier', result: failing }, clock)
    expect((await new StateStore(project.dir).get()).cycle_errors).toEqual([
      'npm test :: N failing: cannot resolve module',
    ])

    await runStart(project.dir, { track: 'build', goal: 'Again' }, clock)
    await runLog(
      project.dir,
      { agent: 'verifier', result: { ...failing, evidence: [{ kind: 'command', ref: 'npm test', excerpt: '3 failing: cannot resolve module' }] } },
      clock,
    )
    expect((await new StateStore(project.dir).get()).cycle_errors).toEqual([
      'npm test :: N failing: cannot resolve module',
    ])
  })

  it('bounds the reproduction excerpt that reaches state', async () => {
    // Fails if the proof is ever derived from the uncapped result again: that
    // excerpt is copied into `state.json`, where every later `StateStore.update`
    // re-reads, re-validates and re-writes it for the rest of the run.
    await runStart(project.dir, { track: 'fix', goal: 'Stale cache entry' }, clock)
    await runLog(project.dir, { agent: 'reproducer', result: { ...failing, status: 'pass' as const } }, clock)

    const state = await new StateStore(project.dir).get()
    expect(state.reproduction?.excerpt.length ?? 0).toBeLessThanOrEqual(EVIDENCE_EXCERPT_MAX)
    expect(state.reproduction?.excerpt).toContain('truncated')
  })

  it('caps a digest-derived excerpt that exceeds the ceiling and names the verify log', async () => {
    // A ledger match changes only the destination the marker names — the log
    // the engine already wrote, rather than a second copy of the same bytes —
    // never whether the cap applies.
    await writeLedger('cycle-01', [ledgerEntry({ exit_code: 1 })])
    const { path: file } = await runLog(project.dir, { agent: 'verifier', result: failing }, clock)
    const stored = JSON.parse(await fs.readFile(file, 'utf8')) as { evidence: { excerpt: string }[] }
    const excerpt = stored.evidence[0]?.excerpt ?? ''

    expect(excerpt.length).toBeLessThanOrEqual(EVIDENCE_EXCERPT_MAX)
    expect(excerpt).toContain(path.join('cycle-01', 'verify', 'test.log'))
    await expect(fs.access(path.join(await runDir(), 'cycle-01', 'evidence'))).rejects.toThrow()
  })
})

describe('the run map', () => {
  const mapped = (summary: string, files: string[]) => ({
    status: 'pass' as const,
    summary,
    evidence: files.map((file) => ({ kind: 'file' as const, ref: file, excerpt: 'export const x = 1' })),
    findings: [],
    files_touched: [],
    next_hint: null,
  })

  beforeEach(async () => {
    await runStart(project.dir, { track: 'build', goal: 'Add a health endpoint' }, clock)
  })

  async function readMap(): Promise<string> {
    return fs.readFile(path.join(await runDir(), 'map.md'), 'utf8')
  }

  it('writes the run map from the drafting agent own result', async () => {
    await runLog(project.dir, { agent: 'scout', result: mapped('The route table is assembled in one file.', ['src/routes/index.ts']) }, clock)

    const map = await readMap()
    expect(map).toContain('# Map — ')
    expect(map).toContain('**Track:** build')
    expect(map).toContain('**Goal:** Add a health endpoint')
    expect(map).toContain('the later one wins')
    // The header and the first section are separated, as every section is.
    expect(map).toContain('the tree it mapped.\n\n## Cycle 1 — scout (HEAD ')
    expect(map).toContain('The route table is assembled in one file.')
    expect(map).toContain('- `src/routes/index.ts`')
  })

  it('writes nothing for an agent the track does not name', async () => {
    await runLog(project.dir, { agent: 'builder', result: mapped('I built it.', ['src/a.ts']) }, clock)
    await expect(readMap()).rejects.toThrow()
  })

  it('writes nothing on a blocked map', async () => {
    // A scout that returned `blocked` mapped nothing.
    await runLog(project.dir, { agent: 'scout', result: { ...mapped('I could not read the tree.', []), status: 'blocked' as const } }, clock)
    await expect(readMap()).rejects.toThrow()
  })

  it('writes no map on a track that declares none', async () => {
    await runStart(project.dir, { track: 'edit', goal: 'Rename' }, clock)
    await runLog(project.dir, { agent: 'editor', result: mapped('Renamed it.', ['src/a.ts']) }, clock)
    await expect(readMap()).rejects.toThrow()
  })

  it('stamps each section with the cycle and the commit it described', async () => {
    // No repository here, and that is a legitimate answer rather than an error:
    // the project still gets a map, it simply cannot stamp one.
    await runLog(project.dir, { agent: 'scout', result: mapped('Ground truth.', ['src/a.ts']) }, clock)
    expect(await readMap()).toContain('## Cycle 1 — scout (HEAD no git)')
  })

  it('stamps the section with the commit the tree was actually at', async () => {
    await run('git', ['init', '-q', '-b', 'main'], { cwd: project.dir })
    await fs.writeFile(path.join(project.dir, 'a.ts'), 'export const a = 1\n', 'utf8')
    await run('git', ['add', '-A'], { cwd: project.dir })
    await run(
      'git',
      ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'first'],
      { cwd: project.dir },
    )
    const { stdout } = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: project.dir })

    await runLog(project.dir, { agent: 'scout', result: mapped('Ground truth.', ['a.ts']) }, clock)
    expect(await readMap()).toContain(`## Cycle 1 — scout (HEAD ${stdout.trim()})`)
  })

  it('appends a later map rather than overwriting the first', async () => {
    await runLog(project.dir, { agent: 'scout', result: mapped('The original ground.', ['src/a.ts']) }, clock)
    await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)
    await runLog(project.dir, { agent: 'scout', result: mapped('The ground as it now stands.', ['src/b.ts']) }, clock)

    const map = await readMap()
    expect(map).toContain('The original ground.')
    expect(map).toContain('The ground as it now stands.')
    expect(map.indexOf('## Cycle 1')).toBeLessThan(map.indexOf('## Cycle 2'))
  })

  it('marks an earlier map files as superseded when a later one names them', async () => {
    await runLog(project.dir, { agent: 'scout', result: mapped('First pass.', ['src/a.ts', 'src/b.ts']) }, clock)
    await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)
    await runLog(project.dir, { agent: 'scout', result: mapped('Second pass.', ['src/b.ts']) }, clock)

    const map = await readMap()
    expect(map).toContain('*Superseding cycle 1 for:* `src/b.ts`')
    expect(map).not.toContain('`src/a.ts`, `src/b.ts`\n\nSecond')
  })

  it('keeps the first section and the two most recent, eliding the rest', async () => {
    // Four unbounded sections in a file that sits in front of every agent of
    // every later cycle is growth multiplied by the roster width.
    const config = await loadConfig(project.dir)
    config.limits.no_progress_strikes = 10
    await writeConfig(project.dir, config)

    for (const cycle of [1, 2, 3, 4]) {
      await runLog(project.dir, { agent: 'scout', result: mapped(`Pass number ${cycle}.`, [`src/${cycle}.ts`]) }, clock)
      if (cycle < 4) await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)
    }

    const map = await readMap()
    expect(map).toContain('Pass number 1.')
    expect(map).toContain('*(cycle 2 elided — see cycle-02/scout.json)*')
    expect(map).not.toContain('Pass number 2.')
    expect(map).toContain('Pass number 3.')
    expect(map).toContain('Pass number 4.')
    // The provenance survives elision: the heading is the cheapest and most
    // useful part of a section, and the marker says where the prose went.
    expect(map).toContain('## Cycle 2 — scout (HEAD ')
  })

  it('never exceeds the map ceiling', async () => {
    await runLog(project.dir, { agent: 'scout', result: mapped('a'.repeat(20_000), ['src/a.ts']) }, clock)
    const map = await readMap()
    expect(Buffer.byteLength(map)).toBeLessThanOrEqual(8_000)
    expect(map).toContain('map truncated at 8000 bytes — see cycle-01/scout.json')
  })

  it('bounds one section file list rather than spending the whole ceiling on it', async () => {
    const many = Array.from({ length: 220 }, (_, index) => `src/modules/module-${index}/index.ts`)
    await runLog(project.dir, { agent: 'scout', result: mapped('A wide first pass.', many) }, clock)

    const map = await readMap()
    // Rendered whole, this one section is larger than the ceiling — and a byte
    // cut applied to the document would then leave nothing for later cycles.
    expect(Buffer.byteLength(map)).toBeLessThanOrEqual(8_000)
    expect(map).toContain('- `src/modules/module-0/index.ts`')
    expect(map).toContain('180 more files elided — see cycle-01/scout.json')
    expect(map).not.toContain('map truncated at 8000 bytes')
  })

  it('keeps the newest section when the ceiling binds, not the oldest', async () => {
    const config = await loadConfig(project.dir)
    config.limits.no_progress_strikes = 10
    await writeConfig(project.dir, config)

    // Enough prose in every pass that the cumulative document reaches the
    // ceiling — the file list is bounded, the summary is not.
    for (const cycle of [1, 2, 3]) {
      const summary = `Pass number ${cycle}. ${'detail. '.repeat(400)}`
      await runLog(project.dir, { agent: 'scout', result: mapped(summary, [`src/${cycle}.ts`]) }, clock)
      if (cycle < 3) await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)
    }

    const map = await readMap()
    expect(Buffer.byteLength(map)).toBeLessThanOrEqual(8_000)
    // The document the run reads is about the tree as it now stands. A tail cut
    // discards the newest sections first — the inverse of both the section
    // policy and the precedence rule the header states — and because the next
    // pass re-parses what this one wrote, it freezes the map at cycle 1 forever.
    expect(map).toContain('## Cycle 3 — scout (HEAD ')
    expect(map).toContain('Pass number 3.')
    // The pressure comes off the oldest prose instead, and its provenance stays.
    expect(map).toContain('## Cycle 1 — scout (HEAD ')
    expect(map).toContain('*(cycle 1 elided — see cycle-01/scout.json)*')
    expect(map).not.toContain('Pass number 1.')
  })
})

describe('a closing agent', () => {
  const documented = {
    status: 'pass' as const,
    summary: 'Documented the export button against the code as it finally stands.',
    evidence: [{ kind: 'file' as const, ref: 'docs/export.md', excerpt: '## Exporting' }],
    findings: [{ severity: 'high' as const, file: 'docs/export.md', line: 1, claim: 'the old page is stale' }],
    files_touched: ['docs/export.md'],
    next_hint: null,
  }

  beforeEach(async () => {
    await runStart(project.dir, { track: 'build', goal: 'Add the export button' }, clock)
  })

  async function pass(): Promise<void> {
    await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'pass' }, clock)
  }

  it('records a closing agent against a run that is done', async () => {
    const dir = await runDir()
    await pass()

    const { path: file, findingsAdded, gateOpened } = await runLog(project.dir, { agent: 'docs', result: documented }, clock)
    expect(file).toBe(path.join(dir, 'closing', 'docs.json'))
    expect(findingsAdded).toBe(0)
    expect(gateOpened).toBe(false)
    expect(JSON.parse(await fs.readFile(file, 'utf8')).summary).toBe(documented.summary)
  })

  it('writes no state for a closing agent', async () => {
    await pass()
    const before = await stateHash()
    await runLog(project.dir, { agent: 'docs', result: documented }, clock)
    expect(await stateHash()).toBe(before)
  })

  it('files no findings from a closing agent', async () => {
    // A high finding filed by `docs` against a run already reported as passing
    // would contradict a verdict nobody can revisit.
    await pass()
    await runLog(project.dir, { agent: 'docs', result: documented }, clock)
    expect((await new StateStore(project.dir).get()).findings).toEqual([])
  })

  it('is invisible to everything that walks a cycle', async () => {
    const dir = await runDir()
    await pass()
    await runLog(project.dir, { agent: 'docs', result: documented }, clock)
    await expect(fs.access(path.join(dir, 'cycle-01', 'docs.json'))).rejects.toThrow()
  })

  it('still refuses an ordinary agent against a run that is done', async () => {
    await pass()
    await expect(runLog(project.dir, { agent: 'verifier', result: documented }, clock)).rejects.toBeInstanceOf(
      NoActiveRunError,
    )
  })

  it('refuses a closing agent while the run is still running', async () => {
    // Logged mid-run it would document code that had not settled, and its
    // findings would join a working cycle's task list.
    await expect(runLog(project.dir, { agent: 'docs', result: documented }, clock)).rejects.toBeInstanceOf(
      ClosingAgentError,
    )
    expect((await new StateStore(project.dir).get()).findings).toEqual([])
  })

  it('refuses a closing agent whose run has been replaced', async () => {
    await pass()
    const { run_id: dispatched } = await new StateStore(project.dir).get()

    // A person starts the next run while the closing agent is still working.
    await runStart(project.dir, { track: 'build', goal: 'A different feature' }, clock)

    await expect(
      runLog(project.dir, { agent: 'docs', run_id: dispatched, result: documented }, clock),
    ).rejects.toBeInstanceOf(RunReplacedError)
    expect((await new StateStore(project.dir).get()).findings).toEqual([])
  })

  it('records a closing agent on a gated track whose gate blocks it', async () => {
    // The gate probe must not run on the closing path: a closing agent named in
    // `gate.blocks` would otherwise be refused before the branch is reached.
    const config = await loadConfig(project.dir)
    config.tracks.fix = {
      required: ['reproducer', 'fixer', 'verifier'],
      available: ['investigator'],
      closing: ['docs'],
      max_cycles: 5,
      order: [],
      gate: { proven_by: 'reproducer', blocks: ['fixer', 'docs'] },
    }
    await writeConfig(project.dir, config)
    await runStart(project.dir, { track: 'fix', goal: 'Stale cache entry' }, clock)
    await cycleAdvance(project.dir, { agents: ['reproducer', 'fixer', 'verifier'], result: 'pass' }, clock)

    const { path: file } = await runLog(project.dir, { agent: 'docs', result: documented }, clock)
    expect(path.basename(file)).toBe('docs.json')
  })

  // A closing agent carries `mjloop_verify_run` and files its digest as its
  // evidence, and the leader is told not to fetch that digest itself and to
  // commit only on a green closing pass. So the closing result is the only
  // input to the commit decision, and the check that refuses a `pass` resting
  // on a red ledger has to hold here or it is absent from the one path a
  // permanent change rests on.
  const reverified = {
    status: 'pass' as const,
    summary: 'Documented the export button, then re-ran the suite.',
    evidence: [{ kind: 'command' as const, ref: 'npm test', excerpt: '0 failed | 781 passed' }],
    findings: [],
    files_touched: ['docs/export.md'],
    next_hint: null,
  }

  it('refuses a closing pass citing a command the closing ledger records as failing', async () => {
    const dir = await runDir()
    await pass()
    await writeLedger('closing', [ledgerEntry({ exit_code: 1 })])

    await expect(runLog(project.dir, { agent: 'docs', result: reverified }, clock)).rejects.toBeInstanceOf(
      ContradictedEvidenceError,
    )

    // The same negative space the cycle path keeps: the check runs before the
    // directory is made, so a refused closing pass leaves no result file for a
    // leader to read as a green closing pass.
    await expect(fs.access(path.join(dir, 'closing', 'docs.json'))).rejects.toThrow()
  })

  it('names the closing log in the refusal, not a cycle one', async () => {
    // The log path is resolved against `closing/`, which is where `verifyRun`
    // writes for a run that is `done`. Resolved against a cycle it would send
    // the leader to a file that does not exist.
    await pass()
    await writeLedger('closing', [ledgerEntry({ exit_code: 1 })])
    await expect(runLog(project.dir, { agent: 'docs', result: reverified }, clock)).rejects.toThrow(
      new RegExp(`${path.basename(await runDir())}.closing.verify.test\\.log`),
    )
  })

  it('accepts a closing pass the engine recorded as green', async () => {
    await pass()
    await writeLedger('closing', [ledgerEntry({ exit_code: 0 })])
    const { path: file } = await runLog(project.dir, { agent: 'docs', result: reverified }, clock)
    expect(JSON.parse(await fs.readFile(file, 'utf8')).status).toBe('pass')
  })

  it('accepts a closing pass whose evidence the closing ledger never recorded', async () => {
    // The check only ever refuses. A closing agent that made no edits runs no
    // suite, and the ledger is absent — which must stay inert rather than
    // becoming a new demand for a receipt.
    await pass()
    const { path: file } = await runLog(project.dir, { agent: 'docs', result: reverified }, clock)
    expect(JSON.parse(await fs.readFile(file, 'utf8')).status).toBe('pass')
  })

  it('exempts a closing agent that also proves the track gate', async () => {
    // `TrackSchema` counts `closing` as known when it validates
    // `gate.proven_by`, so a project may close a track with the agent that
    // proves its gate — and that agent's `pass` means "I demonstrated the
    // defect", over a command expected to exit non-zero.
    const config = await loadConfig(project.dir)
    config.tracks.fix = {
      required: ['reproducer', 'fixer', 'verifier'],
      available: ['investigator'],
      closing: ['docs'],
      max_cycles: 5,
      order: [],
      gate: { proven_by: 'docs', blocks: ['fixer'] },
    }
    await writeConfig(project.dir, config)
    await runStart(project.dir, { track: 'fix', goal: 'Stale cache entry' }, clock)
    await cycleAdvance(project.dir, { agents: ['reproducer', 'fixer', 'verifier'], result: 'pass' }, clock)
    await writeLedger('closing', [ledgerEntry({ exit_code: 1 })])

    const { path: file } = await runLog(project.dir, { agent: 'docs', result: reverified }, clock)
    expect(path.basename(file)).toBe('docs.json')
  })
})

/* ── the quality ledger a dispatch feeds ──────────────────────────────────── */

describe('quality evidence recorded from an answered dispatch', () => {
  /**
   * A second project rather than the file's own: the pinned quality plan is a
   * property of the run, and only an *explicit* mode pins
   * `enforcement: active` — the state every refusal below is gated on.
   */
  let quality: TmpProject

  beforeEach(async () => {
    quality = await makeTmpProject()
    await initLoop(quality.dir, clock)
    const raw = await fs.readFile(path.join(quality.dir, '.mjloop', 'config.yaml'), 'utf8')
    await mutateConfig(quality.dir, {
      revision: configRevision(raw),
      changes: [{ kind: 'orchestration.quality.mode', value: 'strict' }],
    })
    await runStart(quality.dir, { track: 'edit', goal: 'Rename submit label' }, clock)
  })
  afterEach(async () => {
    await quality.cleanup()
    vi.mocked(qualityRuntimeEnabled).mockReturnValue(false)
  })

  const state = async (): Promise<State> => new StateStore(quality.dir).get()

  /** The engine's own record that it ran `command` and saw it fail. */
  async function seedFailedVerifyLedger(dir: string, command: string): Promise<void> {
    const current = await state()
    const verifyDir = path.join(cycleDirPath(dir, current), 'verify')
    await fs.mkdir(verifyDir, { recursive: true })
    await fs.writeFile(path.join(verifyDir, 'test.log'), '2 failed\n', 'utf8')
    await fs.writeFile(
      path.join(verifyDir, 'index.json'),
      `${JSON.stringify([ledgerEntry({ command, exit_code: 1 })], null, 2)}\n`,
      'utf8',
    )
  }

  /** The green counterpart: one completed `test` receipt the engine stands behind. */
  async function seedGreenVerifyLedger(command = 'npm test'): Promise<void> {
    const current = await state()
    const verifyDir = path.join(cycleDirPath(quality.dir, current), 'verify')
    await fs.mkdir(verifyDir, { recursive: true })
    await fs.writeFile(path.join(verifyDir, 'test.log'), 'all green\n', 'utf8')
    await fs.writeFile(
      path.join(verifyDir, 'index.json'),
      `${JSON.stringify([ledgerEntry({ command, exit_code: 0 })], null, 2)}\n`,
      'utf8',
    )
  }

  /** One more completed entry in this cycle's verify ledger, with its log on disk. */
  async function appendVerifyReceipt(
    slot: 'test' | 'lint' | 'build',
    command: string,
    log: string,
    exitCode: number,
  ): Promise<void> {
    const current = await state()
    const verifyDir = path.join(cycleDirPath(quality.dir, current), 'verify')
    await fs.mkdir(verifyDir, { recursive: true })
    await fs.writeFile(path.join(verifyDir, log), 'receipt\n', 'utf8')
    const file = path.join(verifyDir, 'index.json')
    const entries: unknown[] = await fs.readFile(file, 'utf8').then((raw) => JSON.parse(raw) as unknown[]).catch(() => [])
    entries.push(ledgerEntry({ slot, command, log, exit_code: exitCode }))
    await fs.writeFile(file, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
  }

  function passingVerifier(command: string): { agent: string; result: unknown } {
    return {
      agent: 'verifier',
      result: {
        status: 'pass',
        summary: 'The suite is green.',
        evidence: [{ kind: 'command', ref: command, excerpt: 'tests 40, pass 40, fail 0' }],
        findings: [],
        files_touched: ['src/Button.tsx'],
        next_hint: null,
      },
    }
  }

  /** One planned dispatch, answered with a pass that cites the engine's own `test` receipt. */
  async function logCitingDispatch(instance: string, command = 'npm test'): Promise<unknown> {
    return runLog(quality.dir, {
      agent: 'verifier',
      instance,
      result: {
        status: 'pass',
        summary: 'The suite is green.',
        evidence: [{ kind: 'test', ref: command, excerpt: 'tests 40, pass 40, fail 0' }],
        findings: [],
        files_touched: ['src/Button.tsx'],
        next_hint: null,
      },
    }, clock)
  }

  /** One planned dispatch, answered with a pass carrying no command claim of its own. */
  async function logDispatch(dir: string, agent: string, instance: string): Promise<unknown> {
    return runLog(dir, {
      agent,
      instance,
      result: {
        status: 'pass',
        summary: 'Reviewed the change against the pinned plan.',
        evidence: [{ kind: 'file', ref: 'src/Button.tsx', excerpt: 'label renamed' }],
        findings: [],
        files_touched: ['src/Button.tsx'],
        next_hint: null,
      },
    }, clock)
  }

  it('does not let a passing agent override a red engine verify receipt', async () => {
    await seedFailedVerifyLedger(quality.dir, 'npm test')
    await expect(runLog(quality.dir, passingVerifier('npm test'), clock)).rejects.toBeInstanceOf(ContradictedEvidenceError)
    expect((await readLedger(quality.dir, await state())).dimensions.regression.status).not.toBe('pass')
  })

  it('rejects a repeated dispatch with the same input fingerprint and no new information', async () => {
    vi.mocked(qualityRuntimeEnabled).mockReturnValue(true)
    await seedGreenVerifyLedger()
    await logDispatch(quality.dir, 'verifier', 'independent')
    await expect(logDispatch(quality.dir, 'verifier', 'independent')).rejects.toBeInstanceOf(DuplicateQualityDispatchError)
  })

  it('records a dimension the pinned plan assigned this dispatch, from the engine\'s own receipts', async () => {
    await seedGreenVerifyLedger()
    await logCitingDispatch('independent')

    const ledger = await readLedger(quality.dir, await state())
    expect(ledger.dimensions.correctness).toMatchObject({ status: 'pass', recorded_cycle: 1 })
    expect(ledger.dimensions.correctness.evidence_refs).toContain('cycle-01/verify/test.log')
    expect(ledger.dimensions.regression.status).toBe('pass')
  })

  it('leaves a command dimension pending when a pass carries only file evidence', async () => {
    // The cycle holds a green `lint` receipt — a `command` receipt, exactly the
    // kind `security` declares — that this dispatch never asked for and never
    // cited. A verify receipt records that the engine ran something, not who
    // asked, so the dispatch's own citation list is the only attribution there
    // is: a pass carrying nothing but `file` evidence inherits neither the lint
    // receipt nor the test one.
    await seedGreenVerifyLedger()
    await appendVerifyReceipt('lint', 'npm run lint', 'lint.log', 0)
    await logDispatch(quality.dir, 'verifier', 'independent')

    const ledger = await readLedger(quality.dir, await state())
    expect(ledger.dimensions.security).toMatchObject({ status: 'pending', evidence_refs: [] })
    expect(ledger.dimensions.correctness).toMatchObject({ status: 'pending', evidence_refs: [] })
    expect(ledger.dimensions.regression).toMatchObject({ status: 'pending', evidence_refs: [] })
  })

  it('credits only the receipt the dispatch cited, never every receipt of the declared kind', async () => {
    // Both are `command` receipts and both are green; `security` declares
    // `command`. The dispatch cites the lint run, so that is the only ref the
    // ledger records — the build run belongs to whoever asked for it.
    await appendVerifyReceipt('lint', 'npm run lint', 'lint.log', 0)
    await appendVerifyReceipt('build', 'npm run build', 'build.log', 0)
    await runLog(quality.dir, {
      agent: 'verifier',
      instance: 'security',
      result: {
        status: 'pass',
        summary: 'No new untrusted input path.',
        evidence: [{ kind: 'command', ref: 'npm run lint', excerpt: '0 problems' }],
        findings: [],
        files_touched: ['src/Button.tsx'],
        next_hint: null,
      },
    }, clock)

    const ledger = await readLedger(quality.dir, await state())
    expect(ledger.dimensions.security).toMatchObject({ status: 'pass' })
    expect(ledger.dimensions.security.evidence_refs).toEqual(['cycle-01/verify/lint.log'])
  })

  it('cites the surviving invocation when a slot ran twice in one cycle', async () => {
    // The earlier of two runs of one slot is "superseded by a later
    // invocation", and a list resolved as a whole would be thrown away over it.
    // Selecting the survivor up front means nothing citable can be rejected for
    // being stale.
    await seedGreenVerifyLedger()
    await appendVerifyReceipt('test', 'npm test', 'test--rerun.log', 0)

    await logCitingDispatch('independent')

    const ledger = await readLedger(quality.dir, await state())
    expect(ledger.dimensions.correctness).toMatchObject({ status: 'pass' })
    expect(ledger.dimensions.correctness.evidence_refs).toEqual(['cycle-01/verify/test--rerun.log'])
  })

  it('records why a dimension is pending rather than leaving the plan\'s opening reason standing', async () => {
    // The diagnostic the shadow phase exists to collect: `security` declares
    // `command`, the cycle produced no command receipt, and the ledger must say
    // so rather than still reading like a dimension nobody has looked at.
    await seedGreenVerifyLedger()
    await logCitingDispatch('independent')

    const ledger = await readLedger(quality.dir, await state())
    expect(ledger.dimensions.security.status).toBe('pending')
    expect(ledger.dimensions.security.reason).toMatch(/references are missing/i)
    expect(ledger.dimensions.security.invalidated_at).toBe(NOW.toISOString())
  })

  it('never turns a queued or running verify entry into evidence', async () => {
    const current = await state()
    const verifyDir = path.join(cycleDirPath(quality.dir, current), 'verify')
    await fs.mkdir(verifyDir, { recursive: true })
    await fs.writeFile(path.join(verifyDir, 'test.log'), '', 'utf8')
    await fs.writeFile(path.join(verifyDir, 'index.json'), `${JSON.stringify([
      ledgerEntry({ phase: 'queued', exit_code: null }),
      ledgerEntry({ phase: 'running', exit_code: null, log: 'test--two.log' }),
    ], null, 2)}\n`, 'utf8')

    await logDispatch(quality.dir, 'verifier', 'independent')

    const ledger = await readLedger(quality.dir, await state())
    expect(ledger.dimensions.correctness.status).toBe('pending')
    expect(ledger.dimensions.correctness.evidence_refs).toEqual([])
  })

  it('records nothing for an agent the pinned plan never scheduled', async () => {
    await seedGreenVerifyLedger()
    const before = await readLedger(quality.dir, await state())
    await runLog(quality.dir, {
      agent: 'editor',
      result: {
        status: 'pass',
        summary: 'Renamed the label.',
        evidence: [{ kind: 'file', ref: 'src/Button.tsx', excerpt: 'label renamed' }],
        findings: [],
        files_touched: ['src/Button.tsx'],
        next_hint: null,
      },
    }, clock)
    expect(await readLedger(quality.dir, await state())).toEqual(before)
  })

  it('records nothing at all for a run pinned before quality policies existed', async () => {
    // The marker, not the file: such a run has no pinned plan, so it schedules
    // no dispatch and there is nothing for a result to be recorded against.
    // `rosterSet` is the seam that bootstraps one; a logged result never does.
    await seedGreenVerifyLedger()
    const current = await state()
    await new StateStore(quality.dir, clock).update((draft) => { draft.quality_policy_version = null })
    await fs.rm(path.join(runDirPath(quality.dir, current), 'quality-policy.json'))

    await expect(logDispatch(quality.dir, 'verifier', 'independent')).resolves.toMatchObject({
      path: expect.stringContaining('verifier--independent.json'),
    })
    expect((await readLedger(quality.dir, current)).dimensions.alignment.status).toBe('pending')
  })

  it('records the same repeat as telemetry, and refuses nothing, while the gate stays closed', async () => {
    await seedGreenVerifyLedger()
    await logCitingDispatch('independent')
    await expect(logCitingDispatch('independent')).resolves.toMatchObject({
      path: expect.stringContaining('verifier--independent.json'),
    })
    expect((await readLedger(quality.dir, await state())).dimensions.correctness.status).toBe('pass')
  })

  it('does not mistake a strict specialist for a repeat of the base dispatch', async () => {
    // Strict mode gives the base dispatch and every specialist overlapping
    // dimensions by construction. A rule keyed on "a dimension I was assigned is
    // already recorded and I moved nothing" would refuse this specialist's
    // first-ever run because the base dispatch got there first.
    vi.mocked(qualityRuntimeEnabled).mockReturnValue(true)
    await seedGreenVerifyLedger()
    await logCitingDispatch('independent')

    // The specialist cites a command the engine never ran, so nothing it says
    // resolves and it moves no dimension — while `correctness`, the dimension
    // it was assigned, is already recorded for this cycle by the base dispatch
    // above.
    await expect(runLog(quality.dir, {
      agent: 'verifier',
      instance: 'correctness',
      result: {
        status: 'pass',
        summary: 'Read the diff and re-ran the check by hand.',
        evidence: [{ kind: 'command', ref: 'npm run typecheck', excerpt: 'no errors' }],
        findings: [],
        files_touched: ['src/Button.tsx'],
        next_hint: null,
      },
    }, clock)).resolves.toMatchObject({ path: expect.stringContaining('verifier--correctness.json') })
    // And it did not withdraw the pass it could not add to.
    expect((await readLedger(quality.dir, await state())).dimensions.correctness.status).toBe('pass')
  })

  it('leaves nothing behind when it refuses a repeat', async () => {
    // Every other refusal in `runLog` writes no file and touches no state, and
    // this one is raised from the same block. Refused after step 12 instead, the
    // repeat's findings would already be merged into state — and the retry would
    // merge them again and be refused again, with no way out.
    vi.mocked(qualityRuntimeEnabled).mockReturnValue(true)
    await seedGreenVerifyLedger()
    const answer = {
      agent: 'verifier',
      instance: 'independent',
      result: {
        status: 'pass',
        summary: 'The suite is green.',
        evidence: [{ kind: 'test', ref: 'npm test', excerpt: 'tests 40, pass 40, fail 0' }],
        findings: [{ severity: 'medium', file: 'src/Button.tsx', line: 14, claim: 'the label could be clearer' }],
        files_touched: ['src/Button.tsx'],
        next_hint: null,
      },
    }
    await runLog(quality.dir, answer, clock)
    const ledgerBefore = await readLedger(quality.dir, await state())
    const findingsBefore = (await state()).findings

    await expect(runLog(quality.dir, answer, clock)).rejects.toBeInstanceOf(DuplicateQualityDispatchError)

    expect((await state()).findings).toEqual(findingsBefore)
    expect(await readLedger(quality.dir, await state())).toEqual(ledgerBefore)
  })

  it('accepts a second answer from the same dispatch when it carries something new', async () => {
    vi.mocked(qualityRuntimeEnabled).mockReturnValue(true)
    await seedGreenVerifyLedger()
    await logCitingDispatch('independent')
    await appendVerifyReceipt('lint', 'npm run lint', 'lint.log', 0)

    await expect(runLog(quality.dir, {
      agent: 'verifier',
      instance: 'independent',
      result: {
        status: 'pass',
        summary: 'Lint is green too.',
        evidence: [
          { kind: 'test', ref: 'npm test', excerpt: 'tests 40, pass 40, fail 0' },
          { kind: 'command', ref: 'npm run lint', excerpt: '0 problems' },
        ],
        findings: [],
        files_touched: ['src/Button.tsx'],
        next_hint: null,
      },
    }, clock)).resolves.toMatchObject({ path: expect.stringContaining('verifier--independent.json') })

    expect((await readLedger(quality.dir, await state())).dimensions.security.status).toBe('pass')
  })

  it('suspends before a result that deleted a feature can close its cycle', async () => {
    vi.mocked(qualityRuntimeEnabled).mockReturnValue(true)

    await expect(runLog(quality.dir, {
      agent: 'editor',
      result: {
        status: 'pass',
        summary: 'Took out the code that is no longer reachable.',
        evidence: [{ kind: 'file', ref: 'src/billing/index.ts', excerpt: 'removed' }],
        findings: [],
        files_touched: ['src/billing/index.ts', 'src/billing/invoice.ts', 'src/billing/tax.ts'],
        next_hint: null,
      },
    }, clock)).rejects.toBeInstanceOf(DestructiveApprovalRequiredError)

    expect((await state()).status).toBe('waiting_for_user')
    expect(await fs.readdir(cycleDirPath(quality.dir, await state())).catch(() => [])).toEqual([])
  })
})
