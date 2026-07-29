import fs from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultConfig, type Config } from '../../src/schemas/config.js'
import {
  ConfigMutationError,
  ConfigPatchSchema,
  configRevision,
  mutateConfig,
} from '../../src/store/config-mutation.js'
import { writeConfig } from '../../src/store/config-store.js'
import { resolveLoopPaths } from '../../src/store/paths.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

let project: TmpProject
let file: string

beforeEach(async () => {
  project = await makeTmpProject()
  file = resolveLoopPaths(project.dir).config
  await writeConfig(project.dir, defaultConfig({ test: 'npm test', lint: 'npm run lint', build: null }))
})

afterEach(async () => {
  await project.cleanup()
})

async function raw(): Promise<string> {
  return fs.readFile(file, 'utf8')
}

describe('mutateConfig', () => {
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

describe('ConfigPatchSchema', () => {
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
