import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CLAUDE_MD_SECTION, detectVerifyCommands, initLoop } from '../../src/ops/init.js'
import { loadConfig } from '../../src/store/config-store.js'
import { StateStore } from '../../src/store/state-store.js'
import { resolveLoopPaths } from '../../src/store/paths.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-26T10:36:00.000Z')
const PKG = JSON.stringify({
  name: 'tiny',
  scripts: { test: 'vitest run', lint: 'eslint .', dev: 'vite' },
})

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
    for (const command of ['/mjloop:edit', '/mjloop:plan', '/mjloop:build', '/mjloop:fix', '/mjloop:status', '/mjloop:stop']) {
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
