import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RosterViolationError, RunNotClosedError, rosterSet } from '../../src/ops/roster.js'
import { initLoop } from '../../src/ops/init.js'
import { runLog } from '../../src/ops/log.js'
import { cycleAdvance, cycleDirPath, runDirPath, runStart } from '../../src/ops/run.js'
import { RosterSchema } from '../../src/schemas/contract.js'
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

describe('the dispatch waves rosterSet returns', () => {
  // A track with a real cross-set edge — the same shape the build track's two
  // real orderings take — so `dispatchWaves` has something to layer. `c` is
  // `available`, `b` is `required`, and `b` waits on `c`.
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

  it('groups a cycle roster into the layers its order edges require', async () => {
    const { waves } = await rosterSet(project.dir, { cycle: 1, selected: ['a', 'b', 'c'], skipped: {} })
    // `b` waits on `c`, so the two of them cannot share a wave with `b` first.
    expect(waves).toEqual([
      ['a', 'c'],
      ['b'],
    ])
  })

  it('puts everything in one wave when the predecessor was not drafted', async () => {
    // The vacuous-edge rule TrackSchema.order's comment states: `c` is not in
    // `selected`, so `b`'s edge is satisfied by the omission, not violated.
    const { waves } = await rosterSet(project.dir, { cycle: 1, selected: ['a', 'b'], skipped: { c: 'not needed' } })
    expect(waves).toEqual([['a', 'b']])
  })

  it('returns one wave for a closing pass, since order edges can never name a closing agent', async () => {
    const config = await loadConfig(project.dir)
    config.tracks.mine = { ...config.tracks.mine!, closing: ['d'] }
    await writeConfig(project.dir, config)
    await cycleAdvance(project.dir, { agents: ['a', 'b'], result: 'pass' }, clock)

    const { waves } = await rosterSet(project.dir, { closing: true, selected: ['d'], skipped: {} })
    expect(waves).toEqual([['d']])
  })
})

describe('an agent both drafted and skipped', () => {
  it('is rejected, so the roster cannot claim it ran and was safely omitted', async () => {
    await expect(
      rosterSet(project.dir, {
        cycle: 1,
        selected: ['editor', 'verifier', 'scout'],
        skipped: { scout: 'story references known files only', critic: 'single-file change' },
      }),
    ).rejects.toThrow(/"scout" is both drafted and skipped/)
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

describe('an agent named roster', () => {
  /** The one thing runLog needs from a result that is otherwise irrelevant here. */
  const result = { status: 'pass', summary: 'Wrote it.', evidence: [], findings: [], files_touched: [], next_hint: null }

  it('cannot overwrite the roster this function wrote', async () => {
    // `roster` joins RESERVED_AGENT_NAMES for this reason and no other: runLog
    // writes `cycle-NN/<agent>.json`, so an agent by that name has been able to
    // replace rosterSet's own file — the only record of what the cycle
    // composed and why — since milestone 1.
    const roster = { cycle: 1, selected: ['editor', 'verifier'], skipped: { scout: 'known files', critic: 'one file' } }
    const { path: file } = await rosterSet(project.dir, roster)

    await expect(runLog(project.dir, { agent: 'roster', result })).rejects.toThrow(/roster/)
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(roster)
  })

  it('is refused before runLog looks at the run at all, so closing/roster.json is covered too', async () => {
    // The name check is runLog's first step, ahead of the state read — which is
    // what puts the closing roster behind the same guard without a second rule:
    // the closing branch writes `closing/<agent>.json` beside it.
    const config = await loadConfig(project.dir)
    config.tracks.edit = { required: ['editor', 'verifier'], available: [], closing: ['docs'], max_cycles: 3 }
    await writeConfig(project.dir, config)
    await cycleAdvance(project.dir, { agents: ['editor', 'verifier'], result: 'pass' }, clock)

    const { path: file } = await rosterSet(project.dir, { closing: true, selected: ['docs'], skipped: {} })
    await expect(runLog(project.dir, { agent: 'roster', result })).rejects.toThrow(/roster/)
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toMatchObject({ selected: ['docs'] })
  })
})

/**
 * A track that closes with `docs`. Set after `runStart`, which is legitimate:
 * every rule here is read from config at the moment the roster is declared.
 */
async function closingTrack(closing: string[], available: string[] = []): Promise<void> {
  const config = await loadConfig(project.dir)
  config.tracks.edit = { required: ['editor', 'verifier'], available, closing, max_cycles: 3 }
  await writeConfig(project.dir, config)
}

/** Ends the run, which is the state a closing roster is declared against. */
async function passTheRun(): Promise<void> {
  await cycleAdvance(project.dir, { agents: ['editor', 'verifier'], result: 'pass' }, clock)
}

describe('a closing agent and a working cycle', () => {
  beforeEach(async () => { await closingTrack(['docs'], ['scout']) })

  it('demands no skip reason for a closing agent', async () => {
    // The point of the set: `docs` is not omitted from this cycle, it belongs
    // to no cycle. Four cycles of boilerplate skip reasons is what it replaces.
    const result = await rosterSet(project.dir, {
      cycle: 1,
      selected: ['editor', 'verifier'],
      skipped: { scout: 'goal names the file' },
    })
    expect(result.path).toContain('roster.json')
  })

  it('still demands one for the agents that remain available', async () => {
    await expect(rosterSet(project.dir, { cycle: 1, selected: ['editor', 'verifier'], skipped: {} })).rejects.toThrow(
      /scout/,
    )
  })

  it('refuses a closing agent drafted into a working cycle', async () => {
    await expect(
      rosterSet(project.dir, { cycle: 1, selected: ['editor', 'verifier', 'docs'], skipped: { scout: 'known files' } }),
    ).rejects.toThrow(/"docs" is a closing agent[\s\S]*after the run passes/)
  })

  it('names the remedy as a property of the track, not a misspelling', async () => {
    // `permittedAgents` includes the closing set, so without the rule above
    // this roster would have been accepted outright — and the "not in track"
    // message would have been a lie if it had been reached.
    await expect(
      rosterSet(project.dir, { cycle: 1, selected: ['editor', 'verifier', 'docs'], skipped: { scout: 'known files' } }),
    ).rejects.not.toThrow(/is not in track/)
  })

  it('does not let specialists.docs=always force it into a cycle', async () => {
    // Otherwise the track has no satisfiable roster at all: `always` would
    // demand `docs`, the closing rule would refuse it, and the leader could
    // compose nothing. preflightEstimate counts the track the same way.
    const config = await loadConfig(project.dir)
    config.specialists = { docs: 'always' }
    await writeConfig(project.dir, config)

    const result = await rosterSet(project.dir, {
      cycle: 1,
      selected: ['editor', 'verifier'],
      skipped: { scout: 'known files' },
    })
    expect(result.path).toContain('roster.json')
  })
})

describe('the closing roster', () => {
  beforeEach(async () => { await closingTrack(['docs']) })

  it('writes a closing roster outside every cycle directory', async () => {
    await passTheRun()
    const { path: file } = await rosterSet(project.dir, { closing: true, selected: ['docs'], skipped: {} })

    const state = await new StateStore(project.dir).get()
    expect(file).toBe(path.join(runDirPath(project.dir, state), 'closing', 'roster.json'))
    // The property the readers rely on: readRunDetail filters `cycle-NN` and
    // writeHandoff reads one cycle directory, so a pass that belongs to no
    // cycle must not sit inside one.
    expect(path.relative(runDirPath(project.dir, state), file).startsWith('cycle-')).toBe(false)
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ closing: true, selected: ['docs'], skipped: {} })
  })

  it('writes a file that says which kind of roster it is', async () => {
    // The marker is kept rather than stripped, so the strict cycle-roster
    // schema refuses it if it ever reaches a cycle reader by mistake.
    await passTheRun()
    const { path: file } = await rosterSet(project.dir, { closing: true, selected: ['docs'], skipped: {} })
    expect(RosterSchema.safeParse(JSON.parse(await fs.readFile(file, 'utf8'))).success).toBe(false)
  })

  it('demands a reason for a closing agent that was not dispatched', async () => {
    // The whole point of keeping a closing roster at all: without it a run
    // could pass and ship with its documentation silently never regenerated.
    await passTheRun()
    await expect(rosterSet(project.dir, { closing: true, selected: [], skipped: {} })).rejects.toThrow(
      /"docs" closes this track and was not dispatched/,
    )
  })

  it('accepts a closing pass that dispatched nothing, once the reason is stated', async () => {
    await passTheRun()
    const { path: file } = await rosterSet(project.dir, {
      closing: true,
      selected: [],
      skipped: { docs: 'the run changed no documented behaviour' },
    })
    expect(JSON.parse(await fs.readFile(file, 'utf8')).skipped.docs).toContain('no documented behaviour')
  })

  it('refuses an agent the track does not close with', async () => {
    await passTheRun()
    await expect(
      rosterSet(project.dir, { closing: true, selected: ['editor'], skipped: { docs: 'nothing to write' } }),
    ).rejects.toThrow(/"editor" does not close track "edit"/)
  })

  it('refuses an agent both dispatched and skipped', async () => {
    await passTheRun()
    await expect(
      rosterSet(project.dir, { closing: true, selected: ['docs'], skipped: { docs: 'nothing to write' } }),
    ).rejects.toThrow(/"docs" is both drafted and skipped/)
  })

  it('refuses dropping a closing agent the config marks always', async () => {
    // Where `always` lands for a closing agent, the cycle path having exempted
    // it. Inert in both places would make the setting mean nothing at all.
    const config = await loadConfig(project.dir)
    config.specialists = { docs: 'always' }
    await writeConfig(project.dir, config)
    await passTheRun()

    await expect(
      rosterSet(project.dir, { closing: true, selected: [], skipped: { docs: 'nothing to write' } }),
    ).rejects.toThrow(/specialists.docs=always/)
  })

  it('refuses a closing roster while the run is still running', async () => {
    // A closing agent dispatched before the code has settled documents a state
    // of the code the next cycle replaces. It is also what keeps a late closing
    // roster out of a run that replaced this one: a replacement is `running`.
    await expect(rosterSet(project.dir, { closing: true, selected: ['docs'], skipped: {} })).rejects.toBeInstanceOf(
      RunNotClosedError,
    )
  })

  it('refuses a closing roster after a halt', async () => {
    await closingTrack(['docs'])
    const config = await loadConfig(project.dir)
    config.tracks.edit = { required: ['editor', 'verifier'], available: [], closing: ['docs'], max_cycles: 1 }
    await writeConfig(project.dir, config)
    await cycleAdvance(project.dir, { agents: ['editor', 'verifier'], result: 'fail' }, clock)

    await expect(rosterSet(project.dir, { closing: true, selected: ['docs'], skipped: {} })).rejects.toThrow(/halted/)
  })

  it('refuses a closing roster on a track that closes with nothing', async () => {
    // An empty closing/ directory would give every later report a closing pass
    // this run never had: readRunHistory reads that directory as cycle 0.
    await closingTrack([])
    await passTheRun()
    await expect(rosterSet(project.dir, { closing: true, selected: [], skipped: {} })).rejects.toThrow(
      /declares no closing agents/,
    )
  })

  it('writes nothing when it refuses', async () => {
    await passTheRun()
    await expect(rosterSet(project.dir, { closing: true, selected: [], skipped: {} })).rejects.toBeInstanceOf(
      RosterViolationError,
    )
    const state = await new StateStore(project.dir).get()
    await expect(fs.readdir(path.join(runDirPath(project.dir, state), 'closing'))).rejects.toThrow(/ENOENT/)
  })
})
