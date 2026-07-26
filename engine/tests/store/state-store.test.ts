import fs from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InvalidStateError, StateStore } from '../../src/store/state-store.js'
import { initialState } from '../../src/schemas/state.js'
import { resolveLoopPaths } from '../../src/store/paths.js'
import { writeJsonAtomic } from '../../src/store/atomic.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const CREATED = new Date('2026-07-26T10:00:00.000Z')
const UPDATED = new Date('2026-07-26T11:00:00.000Z')

let project: TmpProject
let store: StateStore

beforeEach(async () => {
  project = await makeTmpProject()
  await writeJsonAtomic(resolveLoopPaths(project.dir).state, initialState(CREATED))
  store = new StateStore(project.dir, () => UPDATED)
})
afterEach(async () => { await project.cleanup() })

describe('StateStore.get', () => {
  it('reads the persisted state', async () => {
    const state = await store.get()
    expect(state.status).toBe('idle')
    expect(state.updated_at).toBe(CREATED.toISOString())
  })
})

describe('StateStore.update', () => {
  it('applies the mutation and stamps updated_at from the clock', async () => {
    const state = await store.update((draft) => {
      draft.status = 'running'
      draft.cycle = 1
      draft.track = 'edit'
    })
    expect(state.status).toBe('running')
    expect(state.updated_at).toBe(UPDATED.toISOString())
    expect((await store.get()).cycle).toBe(1)
  })

  it('rejects a mutation that violates the schema and leaves state untouched', async () => {
    await expect(
      store.update((draft) => {
        draft.cycle = -3
      }),
    ).rejects.toBeInstanceOf(InvalidStateError)
    expect((await store.get()).cycle).toBe(0)
  })

  it('does not let a mutation observe another update mid-flight', async () => {
    await Promise.all([
      store.update((draft) => { draft.cycle += 1 }),
      store.update((draft) => { draft.cycle += 1 }),
      store.update((draft) => { draft.cycle += 1 }),
    ])
    expect((await store.get()).cycle).toBe(3)
  })

  it('repairs a corrupt primary under the lock without clobbering the good backup', async () => {
    const statePath = resolveLoopPaths(project.dir).state
    await store.update((draft) => { draft.cycle = 1 }) // seeds .bak via the write's own backup
    await fs.writeFile(statePath, 'garbage', 'utf8')

    // get() recovers from .bak but must not write anything.
    expect((await store.get()).cycle).toBe(0)
    expect(await fs.readFile(statePath, 'utf8')).toBe('garbage')

    // update() persists the recovered draft; the corrupt primary must not
    // have been promoted to the new backup.
    const state = await store.update((draft) => { draft.cycle += 1 })
    expect(state.cycle).toBe(1)
    expect(JSON.parse(await fs.readFile(statePath, 'utf8')).cycle).toBe(1)
    expect(JSON.parse(await fs.readFile(`${statePath}.bak`, 'utf8')).cycle).toBe(0)
  })
})
