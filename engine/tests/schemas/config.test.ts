import { describe, expect, it } from 'vitest'
import * as z from 'zod'
import { ConfigSchema, DEFAULT_TRACKS, defaultConfig, permittedAgents, pinnedAgents } from '../../src/schemas/config.js'

const VERIFY = { test: 'npm test', lint: 'npm run lint', build: null }

describe('defaultConfig', () => {
  it('is schema-valid and defines only the edit track', () => {
    const config = defaultConfig(VERIFY)
    expect(ConfigSchema.parse(config)).toEqual(config)
    expect(Object.keys(config.tracks)).toEqual(['edit', 'build', 'fix', 'plan'])
    expect(config.autonomous).toBe(false)
  })

  it('carries the detected verify commands through', () => {
    const { verify } = defaultConfig(VERIFY)
    expect(verify.test).toBe('npm test')
    expect(verify.lint).toBe('npm run lint')
    expect(verify.build).toBeNull()
  })

  it('fills in the verify policy the detector knows nothing about', () => {
    // detectVerifyCommands reads package.json scripts and supplies three
    // strings. Every other key of the block is executed policy the engine
    // supplies itself, and `.prefault({})` is what puts it there without a
    // literal duplicate of the schema's own defaults.
    const { verify } = defaultConfig(VERIFY)
    expect(verify.timeout_ms).toBe(900_000)
    expect(verify.lock_timeout_ms).toBe(1_800_000)
    expect(verify.failure_patterns).toEqual({ test: [], lint: [], build: [] })
  })
})

describe('DEFAULT_TRACKS', () => {
  it('makes editor and verifier required for edit, capped at one cycle', () => {
    expect(DEFAULT_TRACKS.edit).toEqual({ required: ['editor', 'verifier'], available: [], closing: [], max_cycles: 1 })
  })

  it('makes builder and verifier required for build, with scout and critic available', () => {
    expect(DEFAULT_TRACKS.build).toEqual({
      required: ['builder', 'verifier'],
      available: ['scout', 'critic', 'ui-designer', 'ui-critic', 'security', 'perf'],
      closing: ['docs'],
      max_cycles: 5,
      map: { drafted_by: 'scout' },
    })
  })

  it('gates the fix track on the reproducer and blocks the fixer', () => {
    expect(DEFAULT_TRACKS.fix).toEqual({
      required: ['reproducer', 'fixer', 'verifier'],
      available: ['investigator', 'hypothesis-tester', 'critic', 'security'],
      closing: [],
      max_cycles: 5,
      gate: { proven_by: 'reproducer', blocks: ['fixer'] },
    })
  })

  it('gates the plan track on the fit-checker and blocks the story-writer', () => {
    expect(DEFAULT_TRACKS.plan).toEqual({
      required: ['planner', 'fit-checker', 'story-writer'],
      available: ['plan-critic', 'story-critic'],
      closing: [],
      max_cycles: 6,
      gate: { proven_by: 'fit-checker', blocks: ['story-writer'] },
    })
  })

  it('spells closing out on every track, not only the one that uses it', () => {
    // `Track` is the output type, so a `.default()`ed key is required in every
    // literal. Showing only `build` gaining it is how three tracks stop
    // compiling.
    for (const [name, track] of Object.entries(DEFAULT_TRACKS)) {
      expect(Array.isArray(track.closing), name).toBe(true)
    }
  })

  it('closes the build run with docs rather than drafting it into a cycle', () => {
    // Documentation drafted in cycle 2 describes code cycle 4 replaces, and the
    // alternative under the old rule was four cycles of boilerplate skip
    // reasons. `docs` must be in exactly one of the two sets.
    expect(DEFAULT_TRACKS.build?.closing).toEqual(['docs'])
    expect(DEFAULT_TRACKS.build?.available).not.toContain('docs')
  })

  it('hands the build track a map and leaves the other three without one', () => {
    expect(DEFAULT_TRACKS.build?.map).toEqual({ drafted_by: 'scout' })
    expect(DEFAULT_TRACKS.edit?.map).toBeUndefined()
    expect(DEFAULT_TRACKS.fix?.map).toBeUndefined()
    expect(DEFAULT_TRACKS.plan?.map).toBeUndefined()
  })

  it('leaves the ungated tracks ungated', () => {
    expect(DEFAULT_TRACKS.edit?.gate).toBeUndefined()
    expect(DEFAULT_TRACKS.build?.gate).toBeUndefined()
  })

  it('offers every specialist to the build track', () => {
    expect(DEFAULT_TRACKS.build?.available).toEqual([
      'scout',
      'critic',
      'ui-designer',
      'ui-critic',
      'security',
      'perf',
    ])
  })

  it('offers security to the fix track', () => {
    expect(DEFAULT_TRACKS.fix?.available).toContain('security')
  })

  it('leaves the edit track deliberately bare', () => {
    expect(DEFAULT_TRACKS.edit?.available).toEqual([])
  })

  it('names only agents that exist', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const url = await import('node:url')
    const agentsDir = path.resolve(url.fileURLToPath(import.meta.url), '../../../../agents')
    const shipped = new Set(
      (await fs.readdir(agentsDir)).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')),
    )

    for (const [name, track] of Object.entries(DEFAULT_TRACKS)) {
      for (const agent of [...track.required, ...track.available, ...track.closing]) {
        expect(shipped.has(agent), `track ${name} names ${agent}, which has no agent file`).toBe(true)
      }
      const drafts = track.map?.drafted_by
      if (drafts !== undefined) {
        expect(shipped.has(drafts), `track ${name} maps with ${drafts}, which has no agent file`).toBe(true)
      }
    }
  })
})

describe('ConfigSchema', () => {
  it('applies defaults to a minimal document', () => {
    const parsed = ConfigSchema.parse({
      version: 1,
      tracks: { edit: { required: ['editor', 'verifier'], max_cycles: 1 } },
    })
    expect(parsed.autonomous).toBe(false)
    expect(parsed.limits.max_parallel_agents).toBe(4)
    expect(parsed.limits.no_progress_strikes).toBe(2)
    expect(parsed.gates.plan_approval).toBe('human')
    expect((parsed as unknown as Record<string, unknown>).custom_dirs).toBeUndefined()
    expect(parsed.tracks.edit?.available).toEqual([])
    expect(parsed.tracks.edit?.closing).toEqual([])
  })

  it('gives a document that names no verify block the whole default policy', () => {
    // The compatibility case for `.prefault({})`: an existing .mjloop/config.yaml
    // written before these keys existed must keep parsing and arrive with the
    // safe setting for each, not with a half-populated block.
    const parsed = ConfigSchema.parse({
      version: 1,
      tracks: { edit: { required: ['editor'], max_cycles: 1 } },
    })
    expect(parsed.verify).toEqual({
      test: null,
      lint: null,
      build: null,
      timeout_ms: 900_000,
      lock_timeout_ms: 1_800_000,
      failure_patterns: { test: [], lint: [], build: [] },
    })
  })

  it('keeps a verify block that names only the commands', () => {
    const parsed = ConfigSchema.parse({
      version: 1,
      verify: { test: 'cd engine && npm test' },
      tracks: { edit: { required: ['editor'], max_cycles: 1 } },
    })
    expect(parsed.verify.test).toBe('cd engine && npm test')
    expect(parsed.verify.lint).toBeNull()
    expect(parsed.verify.timeout_ms).toBe(900_000)
  })

  it('accepts a configured ceiling, lock wait and failure pattern', () => {
    const parsed = ConfigSchema.parse({
      version: 1,
      verify: { timeout_ms: 60_000, lock_timeout_ms: 120_000, failure_patterns: { test: ['^BOOM'] } },
      tracks: { edit: { required: ['editor'], max_cycles: 1 } },
    })
    expect(parsed.verify.timeout_ms).toBe(60_000)
    expect(parsed.verify.lock_timeout_ms).toBe(120_000)
    expect(parsed.verify.failure_patterns).toEqual({ test: ['^BOOM'], lint: [], build: [] })
  })

  it('rejects a ceiling of zero, which would kill every command it starts', () => {
    const bad = {
      version: 1,
      verify: { timeout_ms: 0 },
      tracks: { edit: { required: ['editor'], max_cycles: 1 } },
    }
    expect(ConfigSchema.safeParse(bad).success).toBe(false)
  })

  it('leaves the verify cache off unless the project turns it on', () => {
    // A suite that is not a pure function of the worktree has flakes, and
    // re-running is how a loop finds them. The engine will not make that
    // judgement on a project's behalf.
    const parsed = ConfigSchema.parse({
      version: 1,
      tracks: { edit: { required: ['editor'], max_cycles: 1 } },
    })
    expect(parsed.verify_cache).toBe(false)
  })

  it('defaults the preflight gate to auto so no run stops for a prompt nobody reads', () => {
    const parsed = ConfigSchema.parse({
      version: 1,
      tracks: { edit: { required: ['editor'], max_cycles: 1 } },
    })
    expect(parsed.gates.preflight).toBe('auto')
    expect(ConfigSchema.parse({ version: 1, gates: { preflight: 'human' }, tracks: { edit: { required: ['editor'], max_cycles: 1 } } }).gates)
      .toEqual({ plan_approval: 'human', commit: 'auto', preflight: 'human' })
  })

  it('rejects a track whose required set is empty', () => {
    const bad = { version: 1, tracks: { edit: { required: [], max_cycles: 1 } } }
    expect(ConfigSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects max_cycles below 1', () => {
    const bad = { version: 1, tracks: { edit: { required: ['editor'], max_cycles: 0 } } }
    expect(ConfigSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects a track name that could steer a path', () => {
    // The track name is the last component of every run directory name, so a
    // path-shaped one steers writes outside .mjloop/runs.
    const bad = {
      version: 1,
      tracks: { '../../tmp/victim': { required: ['editor'], max_cycles: 1 } },
    }
    const parsed = ConfigSchema.safeParse(bad)
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(z.prettifyError(parsed.error)).toContain('tracks')
  })

  it('rejects an unknown specialist mode', () => {
    const bad = {
      version: 1,
      tracks: { edit: { required: ['editor'], max_cycles: 1 } },
      specialists: { security: 'sometimes' },
    }
    expect(ConfigSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects an unknown top-level key', () => {
    const bad = { version: 1, tracks: { edit: { required: ['editor'], max_cycles: 1 } }, extra: 1 }
    expect(ConfigSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects a gate proven by an agent the track never runs', () => {
    const bad = {
      version: 1,
      tracks: {
        fix: {
          required: ['fixer', 'verifier'],
          max_cycles: 3,
          gate: { proven_by: 'ghost', blocks: ['fixer'] },
        },
      },
    }
    const parsed = ConfigSchema.safeParse(bad)
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(z.prettifyError(parsed.error)).toContain('ghost')
  })

  it('rejects a gate blocking an agent the track never runs', () => {
    const bad = {
      version: 1,
      tracks: {
        fix: {
          required: ['reproducer', 'verifier'],
          max_cycles: 3,
          gate: { proven_by: 'reproducer', blocks: ['phantom'] },
        },
      },
    }
    const parsed = ConfigSchema.safeParse(bad)
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(z.prettifyError(parsed.error)).toContain('phantom')
  })

  it('rejects a gate that blocks the agent proving it', () => {
    // Copying `required` into `blocks` is the natural mistake, and it shuts the
    // track for good: the result that opens the gate is the one it refuses.
    const bad = {
      version: 1,
      tracks: {
        myfix: {
          required: ['prober', 'patcher'],
          max_cycles: 3,
          gate: { proven_by: 'prober', blocks: ['prober', 'patcher'] },
        },
      },
    }
    const parsed = ConfigSchema.safeParse(bad)
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(z.prettifyError(parsed.error)).toContain('cannot also be blocked')
  })

  it('names the track roster when a gate names an agent it never runs', () => {
    // The consequence alone does not show a one-character typo; the remedy and
    // the names the track does define do.
    const bad = {
      version: 1,
      tracks: {
        myfix: {
          required: ['prober', 'patcher'],
          max_cycles: 3,
          gate: { proven_by: 'proberr', blocks: ['patcher'] },
        },
      },
    }
    const parsed = ConfigSchema.safeParse(bad)
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      const message = z.prettifyError(parsed.error)
      expect(message).toContain('add it to required, available or closing first')
      expect(message).toContain('prober, patcher')
    }
  })

  it('rejects a track requiring an agent the config forbids', () => {
    const bad = {
      version: 1,
      tracks: { edit: { required: ['editor', 'verifier'], max_cycles: 1 } },
      specialists: { verifier: 'never' },
    }
    const parsed = ConfigSchema.safeParse(bad)
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      const message = z.prettifyError(parsed.error)
      expect(message).toContain('verifier')
      expect(message).toContain('edit')
    }
  })

  it('rejects a gate proven by an agent the config forbids', () => {
    const bad = {
      version: 1,
      tracks: {
        mine: {
          required: ['patcher', 'verifier'],
          available: ['prober'],
          max_cycles: 3,
          gate: { proven_by: 'prober', blocks: ['patcher'] },
        },
      },
      specialists: { prober: 'never' },
    }
    const parsed = ConfigSchema.safeParse(bad)
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      const message = z.prettifyError(parsed.error)
      expect(message).toContain('prober')
      expect(message).toContain('never')
    }
  })

  it('rejects a specialist key that is not a usable agent name', () => {
    const bad = {
      version: 1,
      tracks: { edit: { required: ['editor'], max_cycles: 1 } },
      specialists: { 'sec/urity': 'always' },
    }
    const parsed = ConfigSchema.safeParse(bad)
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(z.prettifyError(parsed.error)).toContain('sec/urity')
  })

  it('allows a never specialist that no track requires', () => {
    const good = {
      version: 1,
      tracks: { edit: { required: ['editor', 'verifier'], available: ['critic'], max_cycles: 1 } },
      specialists: { critic: 'never' },
    }
    expect(ConfigSchema.safeParse(good).success).toBe(true)
  })

  it('accepts a gate naming agents from required and available', () => {
    const good = {
      version: 1,
      tracks: {
        fix: {
          required: ['reproducer', 'fixer'],
          available: ['critic'],
          max_cycles: 3,
          gate: { proven_by: 'reproducer', blocks: ['fixer', 'critic'] },
        },
      },
    }
    expect(ConfigSchema.safeParse(good).success).toBe(true)
  })

  it('permits a closing agent', () => {
    const good = {
      version: 1,
      tracks: { mine: { required: ['builder'], closing: ['scribe'], max_cycles: 3 } },
    }
    const parsed = ConfigSchema.safeParse(good)
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.tracks.mine?.closing).toEqual(['scribe'])
  })

  it('refuses a closing agent a specialist rule forbids', () => {
    // `rosterSet` demands no skip reason for a closing agent, so a forbidden
    // one is a step that silently never happens and nothing anywhere records
    // that the run shipped without it.
    const bad = {
      version: 1,
      tracks: { mine: { required: ['builder'], closing: ['scribe'], max_cycles: 3 } },
      specialists: { scribe: 'never' },
    }
    const parsed = ConfigSchema.safeParse(bad)
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      const message = z.prettifyError(parsed.error)
      expect(message).toContain('scribe')
      expect(message).toContain('never')
    }
  })

  it('lets a gate name a closing agent', () => {
    // The gate's "not in this track" check reads required ∪ available ∪
    // closing. A closing agent is one this track runs, and permittedAgents
    // agrees, so a gate naming it is naming something real.
    const good = {
      version: 1,
      tracks: {
        mine: {
          required: ['prober', 'patcher'],
          closing: ['scribe'],
          max_cycles: 3,
          gate: { proven_by: 'prober', blocks: ['patcher', 'scribe'] },
        },
      },
    }
    expect(ConfigSchema.safeParse(good).success).toBe(true)
  })

  it('accepts a map drafted by an agent the track can draft', () => {
    const good = {
      version: 1,
      tracks: {
        mine: { required: ['builder'], available: ['mapper'], max_cycles: 3, map: { drafted_by: 'mapper' } },
      },
    }
    expect(ConfigSchema.safeParse(good).success).toBe(true)
  })

  it('rejects a map drafted by an agent the track never runs', () => {
    const bad = {
      version: 1,
      tracks: { mine: { required: ['builder'], max_cycles: 3, map: { drafted_by: 'ghost' } } },
    }
    const parsed = ConfigSchema.safeParse(bad)
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(z.prettifyError(parsed.error)).toContain('ghost')
  })

  it('rejects a map drafted by a closing agent', () => {
    // A closing agent runs after the run has passed and `runLog`'s closing
    // branch returns before the map is written, so this map would never exist.
    const bad = {
      version: 1,
      tracks: {
        mine: { required: ['builder'], closing: ['scribe'], max_cycles: 3, map: { drafted_by: 'scribe' } },
      },
    }
    const parsed = ConfigSchema.safeParse(bad)
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(z.prettifyError(parsed.error)).toContain('scribe')
  })

  it('rejects a map drafted by an agent the config forbids', () => {
    const bad = {
      version: 1,
      tracks: {
        mine: { required: ['builder'], available: ['mapper'], max_cycles: 3, map: { drafted_by: 'mapper' } },
      },
      specialists: { mapper: 'never' },
    }
    const parsed = ConfigSchema.safeParse(bad)
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      const message = z.prettifyError(parsed.error)
      expect(message).toContain('mapper')
      expect(message).toContain('never')
    }
  })

  it('rejects an unknown key inside map', () => {
    const bad = {
      version: 1,
      tracks: { mine: { required: ['builder'], max_cycles: 3, map: { drafted_by: 'builder', extra: 1 } } },
    }
    expect(ConfigSchema.safeParse(bad).success).toBe(false)
  })
})

describe('pinnedAgents', () => {
  it('names every category ConfigSchema refuses a "never" for', () => {
    const track = ConfigSchema.parse({
      version: 1,
      tracks: {
        mine: {
          required: ['builder'],
          available: ['critic', 'mapper'],
          closing: ['scribe'],
          max_cycles: 3,
          map: { drafted_by: 'mapper' },
          gate: { proven_by: 'builder', blocks: ['critic'] },
        },
      },
    }).tracks.mine!

    expect([...pinnedAgents(track)].sort()).toEqual(['builder', 'builder', 'mapper', 'scribe'])
    // `critic` is available and nothing more: it is the one name here a
    // project may legitimately be advised to forbid.
    expect(pinnedAgents(track)).not.toContain('critic')
  })

  it('is the set no shipped track can be told to forbid', () => {
    // The drift guard. `readTelemetry` excludes these names from `flagged`
    // because the remedy the report prints for a flagged name is
    // `specialists.<agent>: never` — so if this schema ever pins a fifth
    // category and `pinnedAgents` does not learn about it, this fails here
    // rather than in a `config.yaml` that stopped parsing on someone's machine.
    for (const [name, track] of Object.entries(DEFAULT_TRACKS)) {
      for (const agent of pinnedAgents(track)) {
        const parsed = ConfigSchema.safeParse({
          version: 1,
          tracks: DEFAULT_TRACKS,
          specialists: { [agent]: 'never' },
        })
        expect(parsed.success, `${agent} is pinned by ${name} but "never" was accepted`).toBe(false)
      }
    }
  })
})

describe('permittedAgents', () => {
  const config = ConfigSchema.parse({
    version: 1,
    tracks: { mine: { required: ['builder'], available: ['critic'], closing: ['scribe'], max_cycles: 3 } },
    specialists: { security: 'always' },
  })

  it('includes the closing set, or runLog refuses the agent it was told to run', () => {
    // Without `closing` here, `cycleAdvance` hands the leader a closing agent
    // and `runLog` throws UnknownAgentError for it — the run's documentation
    // step failing at the very last step of the run.
    expect([...permittedAgents(config, config.tracks.mine!)].sort()).toEqual(['builder', 'critic', 'scribe', 'security'])
  })
})
