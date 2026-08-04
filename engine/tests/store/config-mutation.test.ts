import fs from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as YAML from 'yaml'
import { runStart } from '../../src/ops/run.js'
import { defaultConfig, type Config } from '../../src/schemas/config.js'
import { initialState } from '../../src/schemas/state.js'
import { writeJsonAtomic } from '../../src/store/atomic.js'
import {
  ConfigMutationError,
  ConfigPatchSchema,
  configRevision,
  mutateConfig,
  type ConfigChange,
} from '../../src/store/config-mutation.js'
import { writeConfig } from '../../src/store/config-store.js'
import { readPolicy } from '../../src/store/quality-store.js'
import { resolveLoopPaths } from '../../src/store/paths.js'
import { StateStore } from '../../src/store/state-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

let project: TmpProject
let file: string

beforeEach(async () => {
  project = await makeTmpProject()
  file = resolveLoopPaths(project.dir).config
  await writeConfig(project.dir, defaultConfig({ test: 'npm test', lint: 'npm run lint', build: null }))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await project.cleanup()
})

const NOW = new Date('2026-08-04T10:36:00.000Z')
const clock = (): Date => NOW

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function seedIdleState(): Promise<void> {
  await writeJsonAtomic(resolveLoopPaths(project.dir).state, initialState(NOW))
}

async function raw(): Promise<string> {
  return fs.readFile(file, 'utf8')
}

async function seedLegacyQuality(projectDir: string, independentPlanReview: boolean, independentVerification: boolean): Promise<void> {
  const config = resolveLoopPaths(projectDir).config
  const source = await fs.readFile(config, 'utf8')
  const legacy = source.replace(
    'quality:\n    mode: adaptive',
    `quality:\n    independent_plan_review: ${independentPlanReview}\n    independent_verification: ${independentVerification}`,
  )
  await fs.writeFile(config, legacy, 'utf8')
}

describe('mutateConfig', () => {
  it('lets a mutation that wins before the start lock define the pinned mode', async () => {
    await seedIdleState()
    const before = await raw()
    const firstLockEntered = deferred()
    const releaseFirstLock = deferred()
    const paths = resolveLoopPaths(project.dir)
    const realMkdir = fs.mkdir.bind(fs)
    let lockAttempts = 0
    const spy = vi.spyOn(fs, 'mkdir').mockImplementation(async (target: any, options: any) => {
      if (String(target) === paths.lock) {
        lockAttempts += 1
        if (lockAttempts === 1) {
          firstLockEntered.resolve()
          await releaseFirstLock.promise
        }
      }
      return realMkdir(target, options)
    })

    const started = runStart(project.dir, { track: 'edit', goal: 'Rename safely' }, clock)
    try {
      await firstLockEntered.promise
      await mutateConfig(project.dir, {
        revision: configRevision(before),
        changes: [{ kind: 'orchestration.quality.mode', value: 'strict' }],
      })
      releaseFirstLock.resolve()

      const state = await started
      expect((await readPolicy(project.dir, state)).mode).toBe('strict')
    } finally {
      releaseFirstLock.resolve()
      await started.catch(() => undefined)
      spy.mockRestore()
    }
  })

  it('does not publish the marker while a guarded mutation waits for policy initialization', async () => {
    await seedIdleState()
    const before = await raw()
    const paths = resolveLoopPaths(project.dir)
    const policyWriteEntered = deferred()
    const releasePolicyWrite = deferred()
    const secondLockAttempt = deferred()
    const realWriteFile = fs.writeFile.bind(fs)
    const realMkdir = fs.mkdir.bind(fs)
    let heldPolicyWrite = false
    let lockAttempts = 0
    const writeSpy = vi.spyOn(fs, 'writeFile').mockImplementation(async (target: any, data: any, options: any) => {
      if (!heldPolicyWrite && String(target).endsWith('quality-policy.json')) {
        heldPolicyWrite = true
        policyWriteEntered.resolve()
        await releasePolicyWrite.promise
      }
      return realWriteFile(target, data, options)
    })
    const mkdirSpy = vi.spyOn(fs, 'mkdir').mockImplementation(async (target: any, options: any) => {
      if (String(target) === paths.lock) {
        lockAttempts += 1
        if (lockAttempts === 2) secondLockAttempt.resolve()
      }
      return realMkdir(target, options)
    })

    const started = runStart(project.dir, { track: 'edit', goal: 'Rename safely' }, clock)
    let mutation: Promise<unknown> | null = null
    try {
      await policyWriteEntered.promise
      mutation = mutateConfig(project.dir, {
        revision: configRevision(before),
        changes: [{ kind: 'orchestration.quality.mode', value: 'strict' }],
      })
      await secondLockAttempt.promise

      expect(await new StateStore(project.dir).get()).toMatchObject({
        status: 'idle',
        quality_policy_version: null,
      })
      releasePolicyWrite.resolve()

      const [state] = await Promise.all([started, mutation])
      expect((await readPolicy(project.dir, state)).mode).toBe('adaptive')
      expect(YAML.parse(await raw()).orchestration.quality.mode).toBe('strict')
      expect((await new StateStore(project.dir).get()).status).toBe('running')
    } finally {
      releasePolicyWrite.resolve()
      await Promise.allSettled([started, ...(mutation === null ? [] : [mutation])])
      writeSpy.mockRestore()
      mkdirSpy.mockRestore()
    }
  })

  it('changes an allowlisted value without losing comments or inert legacy keys', async () => {
    const source = (await raw())
      .replace('version: 1', '# project policy\nversion: 1')
      .replace('autonomous: false', 'autonomous: false # supervised')
      .concat('\ncustom_dirs:\n  agents: old\n')
    await fs.writeFile(file, source, 'utf8')

    await mutateConfig(project.dir, {
      revision: configRevision(source),
      changes: [{ kind: 'root', key: 'autonomous', value: true }],
    })

    const written = await raw()
    expect(written).toContain('# project policy')
    expect(written).toContain('autonomous: true # supervised')
    expect(written).toContain('custom_dirs:')
  })

  it('refuses a stale revision without changing a byte', async () => {
    const before = await raw()
    await expect(
      mutateConfig(project.dir, {
        revision: '0'.repeat(64),
        changes: [{ kind: 'root', key: 'autonomous', value: true }],
      }),
    ).rejects.toMatchObject({ kind: 'stale' } satisfies Partial<ConfigMutationError>)
    expect(await raw()).toBe(before)
  })

  it('validates the whole resulting config and leaves an invalid patch unapplied', async () => {
    const before = await raw()
    const config = defaultConfig({ test: 'npm test', lint: 'npm run lint', build: null })
    const build = config.tracks.build as Config['tracks'][string]

    await expect(
      mutateConfig(project.dir, {
        revision: configRevision(before),
        changes: [
          { kind: 'track', track: 'build', value: { ...build, required: [...build.required, 'security'] } },
          { kind: 'specialist', agent: 'security', value: 'never' },
        ],
      }),
    ).rejects.toMatchObject({ kind: 'invalid' } satisfies Partial<ConfigMutationError>)
    expect(await raw()).toBe(before)
  })

  it('writes a track\'s order edges through the existing track kind — no new write kind', async () => {
    // C1's claim: ConfigChangeSchema's `track` variant is already
    // `TrackSchema.nullable()`, so `order` needed no schema change here at
    // all. Proven against the real CAS write path, not just a parse.
    const before = await raw()
    const config = defaultConfig({ test: 'npm test', lint: 'npm run lint', build: null })
    const build = config.tracks.build as Config['tracks'][string]

    const { revision } = await mutateConfig(project.dir, {
      revision: configRevision(before),
      changes: [
        {
          kind: 'track',
          track: 'build',
          value: { ...build, order: [{ agent: 'builder', after: ['scout'] }] },
        },
      ],
    })

    const written = await raw()
    expect(written).toContain('order:')
    expect(written).toContain('agent: builder')
    expect(written).toContain('scout')
    expect(revision).toBe(configRevision(written))
  })

  it('rejects a track order edge that inverts its own gate, through the write path', async () => {
    // ConfigChangeSchema's `track` variant is `TrackSchema.nullable()`, so
    // this is refused by `mutateConfig`'s own `ConfigPatchSchema.parse` before
    // the file is even opened — a step earlier than a rule enforced only by
    // the post-apply `ConfigSchema.safeParse` (the `'invalid'`
    // ConfigMutationError the test above exercises).
    const before = await raw()
    const config = defaultConfig({ test: 'npm test', lint: 'npm run lint', build: null })
    const fix = config.tracks.fix as Config['tracks'][string]

    await expect(
      mutateConfig(project.dir, {
        revision: configRevision(before),
        changes: [
          {
            kind: 'track',
            track: 'fix',
            value: { ...fix, order: [{ agent: 'reproducer', after: ['fixer'] }] },
          },
        ],
      }),
    ).rejects.toThrow(/deadlock/)
    expect(await raw()).toBe(before)
  })

  it('serialises two writers so only one use of a revision can land', async () => {
    const before = await raw()
    const revision = configRevision(before)
    const outcomes = await Promise.allSettled([
      mutateConfig(project.dir, {
        revision,
        changes: [{ kind: 'root', key: 'autonomous', value: true }],
      }),
      mutateConfig(project.dir, {
        revision,
        changes: [{ kind: 'root', key: 'verify_cache', value: true }],
      }),
    ])

    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.find((result) => result.status === 'rejected')
    expect(rejected).toMatchObject({ reason: { kind: 'stale' } })
  })

  it('backs up the exact previous document before replacement', async () => {
    const before = await raw()
    await mutateConfig(project.dir, {
      revision: configRevision(before),
      changes: [{ kind: 'root', key: 'autonomous', value: true }],
    })
    expect(await fs.readFile(`${file}.bak`, 'utf8')).toBe(before)
  })
})

/**
 * Every orchestration leaf the cockpit and the CLI are allowed to move, with
 * the document path each one must land on. One row per discriminated variant:
 * a new `kind` that nobody adds here is a control the panel can send and no
 * test ever exercises.
 */
const ORCHESTRATION_CHANGES: { change: ConfigChange; at: string[]; expected: unknown }[] = [
  {
    change: { kind: 'orchestration.profile.auto_accept', value: true },
    at: ['orchestration', 'profile', 'auto_accept'],
    expected: true,
  },
  {
    change: { kind: 'orchestration.discovery.mode', value: 'always' },
    at: ['orchestration', 'discovery', 'mode'],
    expected: 'always',
  },
  {
    change: { kind: 'orchestration.discovery.question_budget', value: 12 },
    at: ['orchestration', 'discovery', 'question_budget'],
    expected: 12,
  },
  {
    change: { kind: 'orchestration.discovery.completion', value: 'save-only' },
    at: ['orchestration', 'discovery', 'completion'],
    expected: 'save-only',
  },
  {
    change: { kind: 'orchestration.execution.after_plan_approval', value: 'auto' },
    at: ['orchestration', 'execution', 'after_plan_approval'],
    expected: 'auto',
  },
  {
    change: { kind: 'orchestration.execution.uncertain_concurrency', value: 'ask' },
    at: ['orchestration', 'execution', 'uncertain_concurrency'],
    expected: 'ask',
  },
  {
    change: { kind: 'orchestration.execution.repair_attempts', value: 0 },
    at: ['orchestration', 'execution', 'repair_attempts'],
    expected: 0,
  },
  {
    change: { kind: 'orchestration.quality.mode', value: 'strict' },
    at: ['orchestration', 'quality', 'mode'],
    expected: 'strict',
  },
  {
    change: { kind: 'orchestration.skills.sources', value: ['web'] },
    at: ['orchestration', 'skills', 'sources'],
    expected: ['web'],
  },
  {
    change: { kind: 'orchestration.skills.trusted_registries', value: ['https://skills.example.com'] },
    at: ['orchestration', 'skills', 'trusted_registries'],
    expected: ['https://skills.example.com'],
  },
  {
    change: { kind: 'orchestration.skills.update_mode', value: 'pinned' },
    at: ['orchestration', 'skills', 'update_mode'],
    expected: 'pinned',
  },
]

function readIn(document: string, at: string[]): unknown {
  let node = YAML.parse(document) as unknown
  for (const key of at) node = (node as Record<string, unknown>)[key]
  return node
}

describe('mutateConfig on the orchestration block', () => {
  for (const { change, at, expected } of ORCHESTRATION_CHANGES) {
    const label = 'key' in change ? `${change.kind}.${change.key}` : change.kind
    it(`lands ${label} through the guarded route`, async () => {
      const source = (await raw()).replace('version: 1', '# hand-written policy\nversion: 1')
      await fs.writeFile(file, source, 'utf8')
      const before = configRevision(source)

      const { revision } = await mutateConfig(project.dir, { revision: before, changes: [change] })

      const written = await raw()
      expect(readIn(written, at)).toEqual(expected)
      // The document belongs to the person who wrote it: a mutation moves one
      // value and nothing else.
      expect(written).toContain('# hand-written policy')
      expect(revision).not.toBe(before)
      expect(revision).toBe(configRevision(written))

      // Replaying the revision the caller started from must now be refused —
      // that is the compare-and-swap, not merely a hash we hand back.
      await expect(
        mutateConfig(project.dir, { revision: before, changes: [change] }),
      ).rejects.toMatchObject({ kind: 'stale' } satisfies Partial<ConfigMutationError>)
    })
  }

  it('creates the block in a config written before orchestration existed', async () => {
    // The upgrade path: an already-provisioned project has no `orchestration:`
    // key at all, so the very first mutation has to bring the whole path with
    // it rather than fail on a missing parent.
    const legacy = (await raw()).replace(/\norchestration:\n(?:[ \t].*\n|\n)*/, '\n')
    expect(legacy).not.toContain('orchestration:')
    await fs.writeFile(file, legacy, 'utf8')

    await mutateConfig(project.dir, {
      revision: configRevision(legacy),
      changes: [{ kind: 'orchestration.discovery.mode', value: 'ask' }],
    })

    const written = await raw()
    expect(readIn(written, ['orchestration', 'discovery', 'mode'])).toBe('ask')
    // Everything the block did not name still arrives on read through the
    // schema's prefaults, so one setting does not have to write twelve.
    expect(readIn(written, ['orchestration', 'discovery', 'question_budget'])).toBeUndefined()
  })

  it('replaces both legacy quality booleans with one mode in the same CAS write', async () => {
    await seedLegacyQuality(project.dir, true, false)
    const source = await raw()

    await mutateConfig(project.dir, {
      revision: configRevision(source),
      changes: [{ kind: 'orchestration.quality.mode', value: 'strict' }],
    })

    const written = await raw()
    expect(written).toContain('mode: strict')
    expect(written).not.toContain('independent_plan_review')
    expect(written).not.toContain('independent_verification')
  })

  it('refuses a whole-document contradiction the wire schema cannot see', async () => {
    // `completion: auto-plan` and `mode: off` are each individually legal
    // values, so only the post-apply re-parse of the whole document catches
    // that together they name a start that could never happen.
    const before = await raw()
    await expect(
      mutateConfig(project.dir, {
        revision: configRevision(before),
        changes: [{ kind: 'orchestration.discovery.completion', value: 'auto-plan' }],
      }),
    ).rejects.toMatchObject({
      kind: 'invalid',
      path: ['orchestration', 'discovery', 'completion'],
    } satisfies Partial<ConfigMutationError>)
    expect(await raw()).toBe(before)
  })

  it('refuses a registry source with nothing trusted, leaving the file byte-identical', async () => {
    const before = await raw()
    await expect(
      mutateConfig(project.dir, {
        revision: configRevision(before),
        changes: [{ kind: 'orchestration.skills.sources', value: ['github', 'registry'] }],
      }),
    ).rejects.toMatchObject({ kind: 'invalid' } satisfies Partial<ConfigMutationError>)
    expect(await raw()).toBe(before)
  })

  it('lets the two halves of that contradiction land together in one patch', async () => {
    // The patch is applied as a whole and validated once at the end, so a
    // project can enable the registry source and trust a registry in a single
    // click without ever passing through the invalid intermediate.
    const before = await raw()
    await mutateConfig(project.dir, {
      revision: configRevision(before),
      changes: [
        { kind: 'orchestration.skills.trusted_registries', value: ['https://skills.example.com'] },
        { kind: 'orchestration.skills.sources', value: ['github', 'registry'] },
      ],
    })
    const written = await raw()
    expect(readIn(written, ['orchestration', 'skills', 'sources'])).toEqual(['github', 'registry'])
  })
})

describe('ConfigPatchSchema', () => {
  it('refuses an out-of-range orchestration value at the wire, before any file is opened', async () => {
    // Wire-level validation is as strict as the schema's, so a bad number is
    // rejected by the patch schema and never reaches `applyChange` — the file
    // is not even read.
    const before = await raw()
    for (const change of [
      { kind: 'orchestration.discovery.question_budget', value: 99 },
      { kind: 'orchestration.discovery.question_budget', value: 0 },
      { kind: 'orchestration.execution.repair_attempts', value: 6 },
      { kind: 'orchestration.execution.repair_attempts', value: -1 },
      { kind: 'orchestration.skills.sources', value: ['pastebin'] },
      { kind: 'orchestration.skills.trusted_registries', value: ['http://skills.example.com'] },
      { kind: 'orchestration.discovery.mode', value: false },
      { kind: 'orchestration.quality.mode', value: 'fast' },
    ]) {
      expect(
        ConfigPatchSchema.safeParse({ revision: 'a'.repeat(64), changes: [change] }).success,
        JSON.stringify(change),
      ).toBe(false)
      await expect(
        mutateConfig(project.dir, { revision: configRevision(before), changes: [change as ConfigChange] }),
      ).rejects.toThrow()
    }
    expect(await raw()).toBe(before)
  })


  it('rejects arbitrary yaml paths and empty patches', () => {
    expect(
      ConfigPatchSchema.safeParse({
        revision: 'a'.repeat(64),
        changes: [{ kind: 'raw', path: '../state.json', value: 'x' }],
      }).success,
    ).toBe(false)
    expect(ConfigPatchSchema.safeParse({ revision: 'a'.repeat(64), changes: [] }).success).toBe(false)
  })
})
