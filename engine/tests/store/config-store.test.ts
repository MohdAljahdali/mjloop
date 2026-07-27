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
