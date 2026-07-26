import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StateCorruptedError, readJsonValidated, writeJsonAtomic } from '../../src/store/atomic.js'
import { StateSchema, initialState } from '../../src/schemas/state.js'
import { resolveLoopPaths } from '../../src/store/paths.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-26T10:36:00.000Z')
let project: TmpProject

beforeEach(async () => { project = await makeTmpProject() })
afterEach(async () => { await project.cleanup() })

describe('resolveLoopPaths', () => {
  it('places every artefact under .loop', () => {
    const paths = resolveLoopPaths('/tmp/demo')
    expect(paths.root).toBe('/tmp/demo/.loop')
    expect(paths.state).toBe('/tmp/demo/.loop/state.json')
    expect(paths.config).toBe('/tmp/demo/.loop/config.yaml')
    expect(paths.runs).toBe('/tmp/demo/.loop/runs')
    expect(paths.lock).toBe('/tmp/demo/.loop/.lock')
  })
})

describe('writeJsonAtomic', () => {
  it('creates missing parent directories', async () => {
    const file = path.join(project.dir, 'a/b/c.json')
    await writeJsonAtomic(file, { ok: true })
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ ok: true })
  })

  it('leaves no temp files behind', async () => {
    const file = path.join(project.dir, 'x.json')
    await writeJsonAtomic(file, { n: 1 })
    const entries = await fs.readdir(project.dir)
    expect(entries.filter((e) => e.includes('.tmp'))).toEqual([])
  })

  it('backs up the previous contents before overwriting', async () => {
    const file = path.join(project.dir, 'x.json')
    await writeJsonAtomic(file, { n: 1 })
    await writeJsonAtomic(file, { n: 2 })
    expect(JSON.parse(await fs.readFile(`${file}.bak`, 'utf8'))).toEqual({ n: 1 })
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ n: 2 })
  })

  it('skips the backup when asked', async () => {
    const file = path.join(project.dir, 'x.json')
    await writeJsonAtomic(file, { n: 1 })
    await writeJsonAtomic(file, { n: 2 }, { backup: false })
    await expect(fs.access(`${file}.bak`)).rejects.toThrow()
  })
})

describe('readJsonValidated', () => {
  it('returns the parsed value when the file is sound', async () => {
    const paths = resolveLoopPaths(project.dir)
    const state = initialState(NOW)
    await writeJsonAtomic(paths.state, state)
    const result = await readJsonValidated(paths.state, StateSchema)
    expect(result.value).toEqual(state)
    expect(result.recovered).toBe(false)
  })

  it('recovers from .bak when the primary file is unparseable', async () => {
    const paths = resolveLoopPaths(project.dir)
    const good = initialState(NOW)
    await writeJsonAtomic(paths.state, good)
    await writeJsonAtomic(paths.state, { ...good, cycle: 5 })
    await fs.writeFile(paths.state, '{ this is not json', 'utf8')

    const result = await readJsonValidated(paths.state, StateSchema)
    expect(result.recovered).toBe(true)
    expect(result.value.cycle).toBe(0)
    // recovery must not overwrite the good backup with the corrupt file
    expect(JSON.parse(await fs.readFile(`${paths.state}.bak`, 'utf8')).cycle).toBe(0)
    // the primary file is repaired in place
    expect(JSON.parse(await fs.readFile(paths.state, 'utf8')).cycle).toBe(0)
  })

  it('recovers from .bak when the primary file fails schema validation', async () => {
    const paths = resolveLoopPaths(project.dir)
    const good = initialState(NOW)
    // Two atomic writes so a real `.bak` exists via writeJsonAtomic's own
    // backup mechanism (a single write cannot seed `.bak` — see the "skips
    // the backup when asked" test, which requires exactly that).
    await writeJsonAtomic(paths.state, good)
    await writeJsonAtomic(paths.state, { ...good, cycle: 5 })
    await fs.writeFile(paths.state, JSON.stringify({ schema: 1 }), 'utf8')
    const result = await readJsonValidated(paths.state, StateSchema)
    expect(result.recovered).toBe(true)
  })

  it('throws StateCorruptedError when neither file is usable', async () => {
    const paths = resolveLoopPaths(project.dir)
    await fs.mkdir(paths.root, { recursive: true })
    await fs.writeFile(paths.state, 'garbage', 'utf8')
    await expect(readJsonValidated(paths.state, StateSchema)).rejects.toBeInstanceOf(StateCorruptedError)
  })
})
