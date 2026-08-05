import fs from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigMissingError, loadConfig, loadConfigRecord, writeConfig } from '../../src/store/config-store.js'
import { defaultConfig } from '../../src/schemas/config.js'
import { resolveLoopPaths } from '../../src/store/paths.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

let project: TmpProject
beforeEach(async () => { project = await makeTmpProject() })
afterEach(async () => { await project.cleanup() })

async function writeRaw(projectDir: string, raw: string): Promise<void> {
  const paths = resolveLoopPaths(projectDir)
  await fs.mkdir(paths.root, { recursive: true })
  await fs.writeFile(paths.config, raw, 'utf8')
}

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

  it('round-trips discovery mode "off" as a string and not as boolean false', async () => {
    // YAML 1.1 reads a bare `off` as the boolean false; YAML 1.2's core schema
    // reads it as the string. Which one this project gets is decided by the
    // `yaml` package's default schema, not by us, and the whole orchestration
    // block ships with `mode: off` — so this is asserted rather than assumed.
    // If it ever flips, `mode` must be quoted on write, because a boolean
    // `false` fails FeatureDiscoveryModeSchema and the config stops loading.
    const config = defaultConfig({ test: 'npm test', lint: null, build: null })
    expect(config.orchestration.discovery.mode).toBe('off')
    await writeConfig(project.dir, config)

    const raw = await fs.readFile(resolveLoopPaths(project.dir).config, 'utf8')
    expect(raw).toContain('mode: off')

    const loaded = await loadConfig(project.dir)
    expect(loaded.orchestration.discovery.mode).toBe('off')
    expect(loaded.orchestration).toEqual(config.orchestration)
  })

  it.each([
    ['orchestration:\n  quality:\n    mode: strict\n', 'explicit'],
    ['orchestration:\n  quality:\n    independent_plan_review: true\n', 'legacy'],
    ['', 'default-existing'],
  ] as const)('reports %s quality configuration source', async (quality, qualitySource) => {
    await writeRaw(
      project.dir,
      `version: 1\ntracks:\n  edit:\n    required: [editor]\n    max_cycles: 1\n${quality}`,
    )

    const loaded = await loadConfigRecord(project.dir)
    expect(loaded.qualitySource).toBe(qualitySource)
  })

  it('throws ConfigMissingError when .mjloop is not provisioned', async () => {
    await expect(loadConfig(project.dir)).rejects.toBeInstanceOf(ConfigMissingError)
  })

  it('names the file when the YAML itself does not parse', async () => {
    const paths = resolveLoopPaths(project.dir)
    await fs.mkdir(paths.root, { recursive: true })
    // Duplicate keys are how a project would try to set two specialist modes
    // for one agent. YAML refuses the document, and the reader must be told
    // which file it was.
    await fs.writeFile(paths.config, 'version: 1\nspecialists:\n  security: always\n  security: never\n', 'utf8')
    await expect(loadConfig(project.dir)).rejects.toThrow(/config\.yaml is not valid YAML/)
  })

  it('throws a readable error for an invalid config', async () => {
    const paths = resolveLoopPaths(project.dir)
    await fs.mkdir(paths.root, { recursive: true })
    await fs.writeFile(paths.config, 'version: 1\ntracks: {}\nmystery: true\n', 'utf8')
    await expect(loadConfig(project.dir)).rejects.toThrow(/mystery/)
  })

  it('loads a config.yaml written before the order field existed', async () => {
    // initLoop never rewrites a config it finds, and this is the YAML shape
    // writeConfig produced before TrackSchema gained `order`: no `order:` key
    // anywhere. The compatibility rule C1 ships under is that this document
    // keeps parsing and behaves exactly as it did before the field existed.
    const paths = resolveLoopPaths(project.dir)
    await fs.mkdir(paths.root, { recursive: true })
    await fs.writeFile(
      paths.config,
      'version: 1\ntracks:\n  edit:\n    required: [editor, verifier]\n    max_cycles: 1\n' +
        '  build:\n    required: [builder, verifier]\n    available: [scout]\n    max_cycles: 5\n',
      'utf8',
    )

    const loaded = await loadConfig(project.dir)
    expect(loaded.tracks.edit?.order).toEqual([])
    expect(loaded.tracks.edit?.required).toEqual(['editor', 'verifier'])
    expect(loaded.tracks.build?.order).toEqual([])
    expect(loaded.tracks.build?.available).toEqual(['scout'])
  })
})

describe('legacy keys', () => {
  it('loads a config written before custom_dirs was removed', async () => {
    const config = defaultConfig({ test: 'npm test', lint: null, build: null })
    await writeConfig(project.dir, config)

    const raw = await fs.readFile(resolveLoopPaths(project.dir).config, 'utf8')
    await fs.writeFile(
      resolveLoopPaths(project.dir).config,
      `${raw}\ncustom_dirs:\n  agents: .mjloop/agents\n  skills: .mjloop/skills\n`,
      'utf8',
    )

    const loaded = await loadConfig(project.dir)
    expect(loaded.version).toBe(1)
    expect((loaded as unknown as Record<string, unknown>).custom_dirs).toBeUndefined()
  })

  it('still rejects an unrelated unknown key', async () => {
    const config = defaultConfig({ test: null, lint: null, build: null })
    await writeConfig(project.dir, config)

    const raw = await fs.readFile(resolveLoopPaths(project.dir).config, 'utf8')
    await fs.writeFile(resolveLoopPaths(project.dir).config, `${raw}\nmystery: true\n`, 'utf8')

    await expect(loadConfig(project.dir)).rejects.toThrow(/mystery/)
  })

  it('does not write custom_dirs on a fresh config', async () => {
    await writeConfig(project.dir, defaultConfig({ test: null, lint: null, build: null }))
    const raw = await fs.readFile(resolveLoopPaths(project.dir).config, 'utf8')
    expect(raw).not.toContain('custom_dirs')
  })
})
