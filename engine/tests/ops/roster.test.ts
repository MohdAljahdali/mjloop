import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RosterViolationError, RunNotClosedError, rosterSet, rosterValidity, rosterViolations } from '../../src/ops/roster.js'
import { initLoop } from '../../src/ops/init.js'
import { runLog } from '../../src/ops/log.js'
import { cycleAdvance, cycleDirPath, runDirPath, runStart, UnknownTrackError } from '../../src/ops/run.js'
import { findTrack, type Track } from '../../src/schemas/config.js'
import { RosterSchema } from '../../src/schemas/contract.js'
import { StateStore } from '../../src/store/state-store.js'
import { configRevision, mutateConfig } from '../../src/store/config-mutation.js'
import { loadConfig, writeConfig } from '../../src/store/config-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

// `roster.quality` is the one violation this task's brief permits `rosterSet`
// to start enforcing, and only once both `qualityRuntimeEnabled` is open and
// a run's own pinned policy is `enforcement: active`. The gate stays closed
// (`false`) in production until Task 17; mocking it here is the only way this
// file can exercise the branch at all before then.
vi.mock('../../src/ops/quality-capability.js', () => ({ qualityRuntimeEnabled: vi.fn(() => false) }))
import { qualityRuntimeEnabled } from '../../src/ops/quality-capability.js'

const NOW = new Date('2026-07-26T10:36:00.000Z')
const clock = () => NOW

let project: TmpProject

beforeEach(async () => {
  project = await makeTmpProject()
  await initLoop(project.dir, clock)
  const config = await loadConfig(project.dir)
  config.tracks.edit = { required: ['editor', 'verifier'], available: ['scout', 'critic'], closing: [], max_cycles: 3, order: [] }
  await writeConfig(project.dir, config)
  await runStart(project.dir, { track: 'edit', goal: 'Rename submit label' }, clock)
})
afterEach(async () => {
  await project.cleanup()
  vi.mocked(qualityRuntimeEnabled).mockReturnValue(false)
})

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
    config.tracks.edit = { required: ['editor', 'verifier'], available: ['critic'], closing: [], max_cycles: 3, order: [] }
    config.specialists = { critic: 'always' }
    await writeConfig(project.dir, config)

    await expect(rosterSet(project.dir, { cycle: 1, selected: ['editor', 'verifier'], skipped: {} })).rejects.toThrow(
      /critic/,
    )
  })

  it('accepts a roster that includes the forced specialist', async () => {
    const config = await loadConfig(project.dir)
    config.tracks.edit = { required: ['editor', 'verifier'], available: ['critic'], closing: [], max_cycles: 3, order: [] }
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

describe("the dispatch waves fold in a track's gate", () => {
  it("groups the fix track's roster with fixer waiting on reproducer, not sharing its wave", async () => {
    // The default `fix` track states no `order` edge between `reproducer` and
    // `fixer` — the only thing ordering them is `gate: { proven_by:
    // reproducer, blocks: [fixer] }` — so a `dispatchWaves` that read only
    // `track.order` would put both in the roster's first wave, which is
    // exactly the wave `mjloop_run_log` refuses to accept `fixer`'s result
    // from before `reproducer`'s is on file (`GateClosedError`). `verifier
    // after fixer` is the track's one real `order` edge, layered on top.
    await runStart(project.dir, { track: 'fix', goal: 'reproduce and fix the crash' }, clock)
    const { waves } = await rosterSet(project.dir, {
      cycle: 1,
      selected: ['reproducer', 'fixer', 'verifier'],
      skipped: { investigator: 'cause already known', 'hypothesis-tester': 'no ranked hypotheses', critic: 'small fix', security: 'no auth or input path touched' },
    })
    expect(waves).toEqual([['reproducer'], ['fixer'], ['verifier']])
  })

  it("never places a gate's prover and a blocked agent in the same wave — the general invariant", async () => {
    // Not fix-track-specific: whatever the selection, a wave `dispatchWaves`
    // emits must be one every result in it can actually be logged from,
    // which for a gated agent means its prover's result is already on file.
    await runStart(project.dir, { track: 'fix', goal: 'reproduce and fix the crash' }, clock)
    const { waves } = await rosterSet(project.dir, {
      cycle: 1,
      selected: ['reproducer', 'fixer', 'verifier', 'investigator', 'critic'],
      skipped: { 'hypothesis-tester': 'no ranked hypotheses', security: 'no auth or input path touched' },
    })
    for (const wave of waves) {
      expect(wave.includes('reproducer') && wave.includes('fixer'), JSON.stringify(wave)).toBe(false)
    }
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
    config.tracks.edit = { required: ['editor', 'verifier'], available: ['critic', 'scout'], closing: [], max_cycles: 3, order: [] }
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
    config.tracks.edit = { required: ['editor', 'verifier'], available: [], closing: ['docs'], max_cycles: 3, order: [] }
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
  config.tracks.edit = { required: ['editor', 'verifier'], available, closing, max_cycles: 3, order: [] }
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
    config.tracks.edit = { required: ['editor', 'verifier'], available: [], closing: ['docs'], max_cycles: 1, order: [] }
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

/** `edit`'s track and config as they stand after the top `beforeEach` above. */
async function trackFor(name: string): Promise<{ config: Awaited<ReturnType<typeof loadConfig>>; track: ReturnType<typeof findTrack> }> {
  const config = await loadConfig(project.dir)
  const track = findTrack(config, name)
  return { config, track }
}

describe('rosterViolations — the composition rules, split out as a pure function', () => {
  it('is callable with no run started at all', async () => {
    // The property C3 exists for: `cycleRosterSet` above needs `runStart`
    // first in every other describe block in this file; this one does not.
    const { config, track } = await trackFor('edit')
    expect(track).toBeDefined()
    expect(
      rosterViolations('edit', track!, config, ['editor', 'verifier'], {
        scout: 'known files',
        critic: 'single-file change',
      }),
    ).toEqual([])
  })

  it('codes a missing required agent as roster.required', async () => {
    const { config, track } = await trackFor('edit')
    const violations = rosterViolations('edit', track!, config, ['editor'], { scout: 'x', critic: 'y' })
    expect(violations).toContainEqual({ code: 'roster.required', params: { agent: 'verifier', track: 'edit' } })
  })

  it('codes an agent in neither required nor available as roster.unknown', async () => {
    const { config, track } = await trackFor('edit')
    const violations = rosterViolations('edit', track!, config, ['editor', 'verifier', 'invented'], {
      scout: 'x',
      critic: 'y',
    })
    expect(violations).toContainEqual({ code: 'roster.unknown', params: { agent: 'invented', track: 'edit' } })
  })

  it('codes a forced specialist dropped as roster.forced', async () => {
    // Written and reloaded rather than used in-memory: `config.tracks.edit`
    // set as a bare literal has no `closing` — `ConfigSchema.parse`, which
    // `loadConfig` runs on the round trip through disk, is what defaults it.
    // The cast is deliberate: `Config['tracks']['edit']` is the schema's
    // *output* type, where `closing` is always present, so a literal missing
    // it needs the escape hatch to reach `writeConfig` at all.
    const config = await loadConfig(project.dir)
    config.tracks.edit = { required: ['editor', 'verifier'], available: ['critic'], max_cycles: 3, order: [] } as unknown as Track
    config.specialists = { critic: 'always' }
    await writeConfig(project.dir, config)
    const { config: reloaded, track } = await trackFor('edit')
    expect(reloaded.specialists['critic']).toBe('always')
    const violations = rosterViolations('edit', track!, reloaded, ['editor', 'verifier'], {})
    expect(violations).toContainEqual({ code: 'roster.forced', params: { agent: 'critic' } })
  })

  it('codes a forbidden specialist drafted as roster.forbidden', async () => {
    const config = await loadConfig(project.dir)
    config.tracks.edit = { required: ['editor', 'verifier'], available: ['critic'], closing: [], max_cycles: 3, order: [] }
    config.specialists = { critic: 'never' }
    await writeConfig(project.dir, config)
    const { config: reloaded, track } = await trackFor('edit')
    const violations = rosterViolations('edit', track!, reloaded, ['editor', 'verifier', 'critic'], {})
    expect(violations).toContainEqual({ code: 'roster.forbidden', params: { agent: 'critic' } })
  })

  it('codes a closing agent drafted into a working cycle as roster.closing', async () => {
    const config = await loadConfig(project.dir)
    config.tracks.edit = { required: ['editor', 'verifier'], available: ['scout'], closing: ['docs'], max_cycles: 3, order: [] }
    const track = findTrack(config, 'edit')!
    const violations = rosterViolations('edit', track, config, ['editor', 'verifier', 'docs'], {
      scout: 'known files',
    })
    expect(violations).toContainEqual({ code: 'roster.closing', params: { agent: 'docs', track: 'edit' } })
    // The closing check has to pre-empt the permitted check, or `docs` would
    // earn a second, contradictory `roster.unknown` too — `permittedAgents`
    // includes the closing set, so without the `continue` this would fire.
    expect(violations.filter((v) => v.code === 'roster.unknown')).toEqual([])
  })

  it('codes a drafted-and-skipped agent as roster.contradiction', async () => {
    const { config, track } = await trackFor('edit')
    const violations = rosterViolations('edit', track!, config, ['editor', 'verifier', 'scout'], {
      scout: 'story references known files only',
      critic: 'single-file change',
    })
    expect(violations).toContainEqual({ code: 'roster.contradiction', params: { agent: 'scout' } })
  })

  it('codes an unexplained omission as roster.unexplained', async () => {
    const { config, track } = await trackFor('edit')
    const violations = rosterViolations('edit', track!, config, ['editor', 'verifier'], {})
    expect(violations).toContainEqual({ code: 'roster.unexplained', params: { agent: 'scout' } })
    expect(violations).toContainEqual({ code: 'roster.unexplained', params: { agent: 'critic' } })
  })
})

describe('rosterValidity — the read door behind /api/roster/<track>/valid', () => {
  it('answers with no run in progress, and no state at all to compare against', async () => {
    const fresh = await makeTmpProject()
    try {
      await initLoop(fresh.dir, clock)
      const config = await loadConfig(fresh.dir)
      config.tracks.edit = { required: ['editor', 'verifier'], available: ['scout'], closing: [], max_cycles: 3, order: [] }
      await writeConfig(fresh.dir, config)

      const result = await rosterValidity(fresh.dir, { track: 'edit', selected: ['editor'], skipped: {} })
      expect(result.valid).toBe(false)
      expect(result.violations).toContainEqual({
        code: 'roster.required',
        params: { agent: 'verifier', track: 'edit' },
      })
    } finally {
      await fresh.cleanup()
    }
  })

  it('reports valid: true for a composition cycleRosterSet would accept, with no violations', async () => {
    const result = await rosterValidity(project.dir, {
      track: 'edit',
      selected: ['editor', 'verifier'],
      skipped: { scout: 'known files', critic: 'single-file change' },
    })
    expect(result).toEqual({ valid: true, violations: [] })
  })

  it('raises UnknownTrackError for a track this project does not define, as cycleRosterSet does', async () => {
    await expect(rosterValidity(project.dir, { track: 'nonsense', selected: [], skipped: {} })).rejects.toBeInstanceOf(
      UnknownTrackError,
    )
  })
})

describe('quality_dispatches — the counterfactual plan rosterSet returns alongside waves', () => {
  it('is present on a cycle roster even while the runtime gate stays closed', async () => {
    const result = await rosterSet(project.dir, {
      cycle: 1,
      selected: ['editor', 'verifier'],
      skipped: { scout: 'known files', critic: 'single-file change' },
    })
    expect(result.quality_dispatches.length).toBeGreaterThan(0)
    expect(result.quality_dispatches.every((d) => d.agent === 'verifier')).toBe(true)
  })

  it('never blocks an otherwise-valid roster while the gate stays closed', async () => {
    // The legacy-pinned policy on this project's run is shadow, not active,
    // so this composition is accepted purely on rosterViolations's own rules.
    const result = await rosterSet(project.dir, {
      cycle: 1,
      selected: ['editor', 'verifier'],
      skipped: { scout: 'known files', critic: 'single-file change' },
    })
    expect(result.path).toContain('roster.json')
  })

  it('is empty for a closing pass, which carries no quality dispatch of its own', async () => {
    const config = await loadConfig(project.dir)
    config.tracks.edit = { required: ['editor', 'verifier'], available: [], closing: ['docs'], max_cycles: 3, order: [] }
    await writeConfig(project.dir, config)
    await cycleAdvance(project.dir, { agents: ['editor', 'verifier'], result: 'pass' }, clock)

    const result = await rosterSet(project.dir, { closing: true, selected: ['docs'], skipped: {} })
    expect(result.quality_dispatches).toEqual([])
  })
})

describe('roster.quality — enforced only once the runtime gate opens on an active policy', () => {
  let enabledProject: TmpProject

  const skipAllAvailable = {
    scout: 'goal names the endpoint',
    critic: 'single-file change',
    'ui-designer': 'no UI surface touched',
    'ui-critic': 'no UI surface touched',
    security: 'no auth or input path touched',
    perf: 'not a hot path',
  }

  beforeEach(async () => {
    enabledProject = await makeTmpProject()
    await initLoop(enabledProject.dir, clock)
    const raw = await fs.readFile(path.join(enabledProject.dir, '.mjloop', 'config.yaml'), 'utf8')
    // An explicit mode is what pins `enforcement: active` — the same
    // distinction `quality-policy.test.ts` exercises for `buildQualityPolicy`.
    await mutateConfig(enabledProject.dir, {
      revision: configRevision(raw),
      changes: [{ kind: 'orchestration.quality.mode', value: 'strict' }],
    })
    await runStart(enabledProject.dir, { track: 'build', goal: 'Speed up the checkout API' }, clock)
  })
  afterEach(async () => { await enabledProject.cleanup() })

  it('leaves the strict plan\'s specialists out of the composition while the gate stays closed', async () => {
    const result = await rosterSet(enabledProject.dir, {
      cycle: 1,
      selected: ['builder', 'verifier'],
      skipped: skipAllAvailable,
    })
    expect(result.quality_dispatches.some((d) => d.agent === 'security')).toBe(true)
  })

  it('adds a roster.quality violation for a strict specialist the roster omitted, once the gate opens', async () => {
    vi.mocked(qualityRuntimeEnabled).mockReturnValue(true)
    await expect(
      rosterSet(enabledProject.dir, { cycle: 1, selected: ['builder', 'verifier'], skipped: skipAllAvailable }),
    ).rejects.toThrow(/security/)
  })

  it('accepts the same roster once the strict plan\'s specialists are drafted too', async () => {
    vi.mocked(qualityRuntimeEnabled).mockReturnValue(true)
    const result = await rosterSet(enabledProject.dir, {
      cycle: 1,
      selected: ['builder', 'verifier', 'security', 'critic'],
      skipped: {
        scout: 'goal names the endpoint',
        'ui-designer': 'no UI surface touched',
        'ui-critic': 'no UI surface touched',
        perf: 'not a hot path',
      },
    })
    expect(result.path).toContain('roster.json')
  })
})
