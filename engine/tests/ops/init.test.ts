import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_MD_SECTION, detectVerifyCommands, initLoop } from '../../src/ops/init.js'
import { loadConfig, writeConfig } from '../../src/store/config-store.js'
import {
  listAcceptedRevisions,
  readAcceptedProfile,
  readProposedProfile,
} from '../../src/store/project-profile-store.js'
import { StateStore } from '../../src/store/state-store.js'
import { resolveLoopPaths } from '../../src/store/paths.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-26T10:36:00.000Z')
const PKG = JSON.stringify({
  name: 'tiny',
  scripts: { test: 'vitest run', lint: 'eslint .', dev: 'vite' },
})
const FLUTTER_PUBSPEC = 'name: mobile\ndependencies:\n  flutter:\n    sdk: flutter\n'

async function present(file: string): Promise<boolean> {
  try {
    await fs.stat(file)
    return true
  } catch {
    return false
  }
}

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
  it('provisions .mjloop with a valid state and config', async () => {
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

  it('writes its block into a CLAUDE.md left by the pre-rename plugin', async () => {
    // The old plugin's marker was '## Loop'. If it still gated this write, a
    // project it had touched would keep pointing at /loop: commands and .loop/.
    project = await makeTmpProject({
      'CLAUDE.md': '# Tiny\n\n## Loop\n\nThis project uses the `loop` plugin. State lives in `.loop/`.\n',
    })
    await initLoop(project.dir, () => NOW)
    const claudeMd = await fs.readFile(path.join(project.dir, 'CLAUDE.md'), 'utf8')
    expect(claudeMd).toContain(CLAUDE_MD_SECTION)
    expect(claudeMd).toContain('/mjloop:status')
  })

  it('creates CLAUDE.md when the project has none', async () => {
    project = await makeTmpProject()
    await initLoop(project.dir, () => NOW)
    const claudeMd = await fs.readFile(path.join(project.dir, 'CLAUDE.md'), 'utf8')
    expect(claudeMd).toContain(CLAUDE_MD_SECTION)
  })

  it('names every shipped command, so the in-repo reference matches README', async () => {
    // This block is what a later session reads to learn the plugin. A command
    // missing from it — /mjloop:stop above all — leaves a stuck run with no
    // stated way out but editing state by hand, which the guard denies.
    project = await makeTmpProject()
    await initLoop(project.dir, () => NOW)
    const claudeMd = await fs.readFile(path.join(project.dir, 'CLAUDE.md'), 'utf8')
    for (const command of [
      '/mjloop:edit',
      '/mjloop:plan',
      '/mjloop:build',
      '/mjloop:fix',
      '/mjloop:run',
      '/mjloop:status',
      '/mjloop:stop',
      // The orchestration settings are only reachable through a command, and
      // the block is where a session learns which commands exist. Unlisted, the
      // documented way to change a setting is a file the guarded write exists
      // to keep hands off.
      '/mjloop:config',
    ]) {
      expect(claudeMd).toContain(command)
    }
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

describe('initLoop and the project profile', () => {
  it('writes a component proposal derived from the project it was pointed at', async () => {
    project = await makeTmpProject({ 'package.json': PKG })
    const result = await initLoop(project.dir, () => NOW)

    expect(result.profile.proposedComponents).toEqual(['root'])
    expect(result.profile.error).toBeNull()

    const proposed = await readProposedProfile(project.dir)
    expect(proposed?.generatedAt).toBe(NOW.toISOString())
    expect(proposed?.components.map((component) => component.root)).toEqual(['.'])
  })

  it('scans the tree only after the state and the config are on disk', async () => {
    // The whole ordering rule in one assertion. A scan that ran first would be
    // reading a project the engine had not finished provisioning, and — worse —
    // would put its own failure ahead of the two writes that are the point of
    // `mjloop init`.
    project = await makeTmpProject({ 'package.json': PKG })
    const paths = resolveLoopPaths(project.dir)
    const readdir = fs.readdir.bind(fs)
    let onDisk: { state: boolean; config: boolean } | null = null

    const spy = vi.spyOn(fs, 'readdir').mockImplementation((async (...args: unknown[]) => {
      onDisk ??= { state: await present(paths.state), config: await present(paths.config) }
      return (readdir as (...rest: unknown[]) => Promise<unknown>)(...args)
    }) as typeof fs.readdir)
    try {
      await initLoop(project.dir, () => NOW)
    } finally {
      spy.mockRestore()
    }

    expect(onDisk).toEqual({ state: true, config: true })
  })

  it('does not scan at all when the config could not be written', async () => {
    // A directory sitting where config.yaml belongs makes `writeConfig` throw,
    // so init fails — and the profile directory must not exist afterwards,
    // because the scan is downstream of the write that failed.
    project = await makeTmpProject({ 'package.json': PKG })
    await fs.mkdir(path.join(project.dir, '.mjloop', 'config.yaml'), { recursive: true })

    await expect(initLoop(project.dir, () => NOW)).rejects.toThrow()
    expect(await present(resolveLoopPaths(project.dir).profile)).toBe(false)
  })

  it('re-proposes on an already-initialised project, so a later scan is seen', async () => {
    project = await makeTmpProject({ 'package.json': PKG })
    await initLoop(project.dir, () => NOW)

    await fs.mkdir(path.join(project.dir, 'apps', 'mobile'), { recursive: true })
    await fs.writeFile(path.join(project.dir, 'apps', 'mobile', 'pubspec.yaml'), FLUTTER_PUBSPEC, 'utf8')

    const second = await initLoop(project.dir, () => NOW)
    expect(second.alreadyInitialised).toBe(true)
    expect(second.created).toEqual([])
    expect(second.profile.proposedComponents).toEqual(['apps-mobile', 'root'])
    expect((await readProposedProfile(project.dir))?.components.map((component) => component.id)).toEqual([
      'apps-mobile',
      'root',
    ])
  })

  it('activates no component map when nobody asked for one', async () => {
    // The default. An accepted profile routes every later run, so init proposes
    // and stops there.
    project = await makeTmpProject({ 'package.json': PKG })
    const result = await initLoop(project.dir, () => NOW)

    expect(result.profile.acceptedRevision).toBeNull()
    expect(await listAcceptedRevisions(project.dir)).toEqual([])
  })

  it('accepts the first revision when orchestration.profile.auto_accept is on', async () => {
    project = await makeTmpProject({ 'package.json': PKG })
    await initLoop(project.dir, () => NOW)
    const config = await loadConfig(project.dir)
    config.orchestration.profile.auto_accept = true
    await writeConfig(project.dir, config)

    const second = await initLoop(project.dir, () => NOW)
    expect(second.profile.acceptedRevision).toBe(1)

    const accepted = await readAcceptedProfile(project.dir)
    expect(accepted?.supersedes).toBeNull()
    expect(accepted?.acceptedBy).toContain('auto_accept')
    expect(accepted?.components.map((component) => component.id)).toEqual(['root'])
  })

  it('never replaces a component map that is already accepted', async () => {
    // `auto_accept` says an unmapped project may take the scan's word for it.
    // It does not say a later scan may overwrite a map that is already routing
    // runs — that would make the component map drift with the working tree.
    project = await makeTmpProject({ 'package.json': PKG })
    await initLoop(project.dir, () => NOW)
    const config = await loadConfig(project.dir)
    config.orchestration.profile.auto_accept = true
    await writeConfig(project.dir, config)
    await initLoop(project.dir, () => NOW)

    await fs.mkdir(path.join(project.dir, 'apps', 'mobile'), { recursive: true })
    await fs.writeFile(path.join(project.dir, 'apps', 'mobile', 'pubspec.yaml'), FLUTTER_PUBSPEC, 'utf8')
    const third = await initLoop(project.dir, () => NOW)

    expect(third.profile.proposedComponents).toEqual(['apps-mobile', 'root'])
    expect(third.profile.acceptedRevision).toBe(1)
    expect(await listAcceptedRevisions(project.dir)).toEqual([1])
    expect((await readAcceptedProfile(project.dir))?.components.map((component) => component.id)).toEqual(['root'])
  })

  it('reports the accepted revision that is already in effect without touching it', async () => {
    project = await makeTmpProject({ 'package.json': PKG })
    await initLoop(project.dir, () => NOW)
    const config = await loadConfig(project.dir)
    config.orchestration.profile.auto_accept = true
    await writeConfig(project.dir, config)
    await initLoop(project.dir, () => NOW)

    config.orchestration.profile.auto_accept = false
    await writeConfig(project.dir, config)
    const third = await initLoop(project.dir, () => NOW)

    // The field answers "what routes runs from here", not "what did this call
    // write" — turning the setting back off does not un-accept a revision.
    expect(third.profile.acceptedRevision).toBe(1)
  })

  it('still provisions the project when the scan fails, and says why', async () => {
    project = await makeTmpProject({ 'package.json': PKG })
    const spy = vi.spyOn(fs, 'readdir').mockRejectedValue(new Error('EIO: the disk gave up'))
    let result: Awaited<ReturnType<typeof initLoop>>
    try {
      result = await initLoop(project.dir, () => NOW)
    } finally {
      spy.mockRestore()
    }

    expect(result.alreadyInitialised).toBe(false)
    expect(result.created).toContain(path.join('.mjloop', 'state.json'))
    expect((await new StateStore(project.dir).get()).status).toBe('idle')
    expect((await loadConfig(project.dir)).tracks.edit?.required).toEqual(['editor', 'verifier'])

    expect(result.profile.proposedComponents).toEqual([])
    expect(result.profile.acceptedRevision).toBeNull()
    expect(result.profile.error).toContain('EIO')
    expect(await readProposedProfile(project.dir)).toBeNull()
  })
})
