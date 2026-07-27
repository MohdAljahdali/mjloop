import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RosterViolationError, rosterSet } from '../../src/ops/roster.js'
import { initLoop } from '../../src/ops/init.js'
import { cycleAdvance, cycleDirPath, runStart } from '../../src/ops/run.js'
import { StateStore } from '../../src/store/state-store.js'
import { loadConfig, writeConfig } from '../../src/store/config-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-26T10:36:00.000Z')
const clock = () => NOW

let project: TmpProject

beforeEach(async () => {
  project = await makeTmpProject()
  await initLoop(project.dir, clock)
  const config = await loadConfig(project.dir)
  config.tracks.edit = { required: ['editor', 'verifier'], available: ['scout', 'critic'], max_cycles: 3 }
  await writeConfig(project.dir, config)
  await runStart(project.dir, { track: 'edit', goal: 'Rename submit label' }, clock)
})
afterEach(async () => { await project.cleanup() })

describe('rosterSet', () => {
  it('writes roster.json into the cycle directory', async () => {
    const roster = {
      cycle: 1,
      selected: ['editor', 'verifier'],
      skipped: { scout: 'story references known files only', critic: 'single-file change' },
    }
    const { path: file } = await rosterSet(project.dir, roster)

    const state = await new StateStore(project.dir).get()
    expect(file).toBe(path.join(cycleDirPath(project.dir, state), 'roster.json'))
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(roster)
  })

  it('keeps every cycle roster, so no omission and its reason is lost', async () => {
    const first = { cycle: 1, selected: ['editor', 'verifier'], skipped: { scout: 'goal names the file', critic: 'single-file change' } }
    await rosterSet(project.dir, first)
    const started = await new StateStore(project.dir).get()
    await cycleAdvance(project.dir, { agents: ['editor', 'verifier'], result: 'fail' }, clock)

    const second = { cycle: 2, selected: ['editor', 'verifier', 'scout'], skipped: { critic: 'no new interface' } }
    await rosterSet(project.dir, second)

    for (const [cycle, roster] of [[1, first], [2, second]] as const) {
      const file = path.join(cycleDirPath(project.dir, started, cycle), 'roster.json')
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(roster)
    }
  })

  it('rejects a roster missing a required agent', async () => {
    await expect(rosterSet(project.dir, { cycle: 1, selected: ['editor'], skipped: {} })).rejects.toBeInstanceOf(
      RosterViolationError,
    )
  })

  it('names verifier explicitly when it is the omitted agent', async () => {
    await expect(rosterSet(project.dir, { cycle: 1, selected: ['editor'], skipped: {} })).rejects.toThrow(/verifier/)
  })

  it('rejects an agent that is in neither required nor available', async () => {
    const roster = { cycle: 1, selected: ['editor', 'verifier', 'invented'], skipped: {} }
    await expect(rosterSet(project.dir, roster)).rejects.toThrow(/invented/)
  })

  it('rejects a cycle number that does not match state', async () => {
    await expect(rosterSet(project.dir, { cycle: 7, selected: ['editor', 'verifier'], skipped: {} })).rejects.toThrow(
      /cycle 7/,
    )
  })

  it('rejects a roster omitting a specialist forced to always', async () => {
    const config = await loadConfig(project.dir)
    config.tracks.edit = { required: ['editor', 'verifier'], available: ['critic'], max_cycles: 3 }
    config.specialists = { critic: 'always' }
    await writeConfig(project.dir, config)

    await expect(rosterSet(project.dir, { cycle: 1, selected: ['editor', 'verifier'], skipped: {} })).rejects.toThrow(
      /critic/,
    )
  })

  it('accepts a roster that includes the forced specialist', async () => {
    const config = await loadConfig(project.dir)
    config.tracks.edit = { required: ['editor', 'verifier'], available: ['critic'], max_cycles: 3 }
    config.specialists = { critic: 'always' }
    await writeConfig(project.dir, config)

    const result = await rosterSet(project.dir, { cycle: 1, selected: ['editor', 'verifier', 'critic'], skipped: {} })
    expect(result.path).toContain('roster.json')
  })

  it('rejects an omission that has no stated reason', async () => {
    const roster = { cycle: 1, selected: ['editor', 'verifier'], skipped: {} }
    // scout and critic are available but unexplained
    await expect(rosterSet(project.dir, roster)).rejects.toThrow(/scout/)
  })
})

describe('specialists configured never', () => {
  beforeEach(async () => {
    const config = await loadConfig(project.dir)
    config.tracks.edit = { required: ['editor', 'verifier'], available: ['critic', 'scout'], max_cycles: 3 }
    config.specialists = { critic: 'never' }
    await writeConfig(project.dir, config)
  })

  it('rejects a roster that selects one', async () => {
    await expect(
      rosterSet(project.dir, { cycle: 1, selected: ['editor', 'verifier', 'critic'], skipped: { scout: 'known files' } }),
    ).rejects.toBeInstanceOf(RosterViolationError)
  })

  it('names the agent and the setting', async () => {
    await expect(
      rosterSet(project.dir, { cycle: 1, selected: ['editor', 'verifier', 'critic'], skipped: { scout: 'known files' } }),
    ).rejects.toThrow(/critic[\s\S]*never/)
  })

  it('accepts a roster that omits it, with no reason required', async () => {
    const result = await rosterSet(project.dir, {
      cycle: 1,
      selected: ['editor', 'verifier'],
      skipped: { scout: 'known files' },
    })
    expect(result.path).toContain('roster.json')
  })

  it('leaves auto and unset specialists alone', async () => {
    const config = await loadConfig(project.dir)
    config.specialists = { critic: 'auto' }
    await writeConfig(project.dir, config)

    const result = await rosterSet(project.dir, {
      cycle: 1,
      selected: ['editor', 'verifier', 'critic'],
      skipped: { scout: 'known files' },
    })
    expect(result.path).toContain('roster.json')
  })

  it('aggregates with other violations rather than short-circuiting', async () => {
    await expect(
      rosterSet(project.dir, { cycle: 1, selected: ['editor', 'critic'], skipped: {} }),
    ).rejects.toThrow(/verifier[\s\S]*critic|critic[\s\S]*verifier/)
  })
})
