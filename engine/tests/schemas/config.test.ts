import { describe, expect, it } from 'vitest'
import * as z from 'zod'
import {
  ConfigSchema,
  DEFAULT_TRACKS,
  defaultConfig,
  dispatchWaves,
  permittedAgents,
  pinnedAgents,
  QualityModeSchema,
} from '../../src/schemas/config.js'

const VERIFY = { test: 'npm test', lint: 'npm run lint', build: null }

/** The whole orchestration tree as the schema supplies it when nobody names a key. */
const DEFAULT_ORCHESTRATION = {
  profile: { auto_accept: false },
  discovery: { mode: 'off', question_budget: 8, completion: 'review' },
  execution: { after_plan_approval: 'manual', uncertain_concurrency: 'sequential', repair_attempts: 1 },
  quality: { mode: 'economy' },
  skills: { sources: ['github'], trusted_registries: [], update_mode: 'review' },
}

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
    expect(DEFAULT_TRACKS.edit).toEqual({
      required: ['editor', 'verifier'],
      available: [],
      closing: [],
      // `verifier` runs after `editor` — nothing to check until the code
      // exists — the two-agent case of the same rule `build` and `fix` state.
      order: [{ agent: 'verifier', after: ['editor'] }],
      max_cycles: 1,
    })
  })

  it('makes builder and verifier required for build, with scout and critic available', () => {
    expect(DEFAULT_TRACKS.build).toEqual({
      required: ['builder', 'verifier'],
      available: ['scout', 'critic', 'ui-designer', 'ui-critic', 'security', 'perf'],
      closing: ['docs'],
      // The leader's three real orderings, as edges rather than as prose in
      // skills/mjloop-leader/SKILL.md: a contract nobody checks and a check
      // with no contract are both worthless, so the pair is ordered on both
      // sides of the code it concerns, and `verifier` — like every track's
      // verifying agent — runs only after the agent whose work it checks.
      order: [
        { agent: 'builder', after: ['ui-designer'] },
        { agent: 'verifier', after: ['builder'] },
        { agent: 'ui-critic', after: ['verifier'] },
      ],
      max_cycles: 5,
      map: { drafted_by: 'scout' },
    })
  })

  it('gates the fix track on the reproducer and blocks the fixer', () => {
    expect(DEFAULT_TRACKS.fix).toEqual({
      required: ['reproducer', 'fixer', 'verifier'],
      available: ['investigator', 'hypothesis-tester', 'critic', 'security'],
      closing: [],
      // `reproducer before fixer` is the gate below, not an edge here —
      // `verifier` after `fixer` is the track's one real `order` edge.
      order: [{ agent: 'verifier', after: ['fixer'] }],
      max_cycles: 5,
      gate: { proven_by: 'reproducer', blocks: ['fixer'] },
    })
  })

  it('gates the plan track on the fit-checker and blocks the story-writer', () => {
    expect(DEFAULT_TRACKS.plan).toEqual({
      required: ['planner', 'fit-checker', 'story-writer'],
      available: ['plan-critic', 'story-critic'],
      closing: [],
      order: [],
      max_cycles: 6,
      gate: { proven_by: 'fit-checker', blocks: ['story-writer'] },
    })
  })

  it("gives every track's verifying agent an order edge onto the agent it verifies", () => {
    // C2 gave `build` its `ui-designer`/`ui-critic` pair; the follow-up that
    // fixed C2's review closed the gap it left open — `verifier` itself was
    // ordered nowhere, so a leader following `waves` literally could dispatch
    // and log it before the agent whose work it checks had written a line.
    // `plan` has no verifying agent (step 3d gives its rule instead), so it
    // alone keeps no `order` edge.
    expect(DEFAULT_TRACKS.edit?.order).toContainEqual({ agent: 'verifier', after: ['editor'] })
    expect(DEFAULT_TRACKS.build?.order).toContainEqual({ agent: 'verifier', after: ['builder'] })
    expect(DEFAULT_TRACKS.fix?.order).toContainEqual({ agent: 'verifier', after: ['fixer'] })
    expect(DEFAULT_TRACKS.plan?.order).toEqual([])
  })

  it('orders the build track exactly on its three real dependencies', () => {
    expect(DEFAULT_TRACKS.build?.order).toEqual([
      { agent: 'builder', after: ['ui-designer'] },
      { agent: 'verifier', after: ['builder'] },
      { agent: 'ui-critic', after: ['verifier'] },
    ])
  })

  it("places builder strictly before verifier in the build track's UI-cycle waves", () => {
    // The defect this test exists to keep fixed: `mjloop_roster_set` used to
    // return waves that put `verifier` and `ui-designer` together and
    // `ui-critic` alongside `builder`, which contradicted SKILL.md step 4's
    // own instruction to dispatch a wave's agents in parallel — a compliant
    // leader could log `verifier` before `builder` had written a line.
    const track = DEFAULT_TRACKS.build!
    // `docs` closes the track rather than joining a cycle, so it is not in
    // `available` and needs no exclusion here.
    const selected = [...track.required, ...track.available]
    const waves = dispatchWaves(track, selected)

    const waveOf = (agent: string): number => waves.findIndex((wave) => wave.includes(agent))
    expect(waveOf('ui-designer')).toBeGreaterThanOrEqual(0)
    expect(waveOf('builder')).toBeGreaterThan(waveOf('ui-designer'))
    expect(waveOf('verifier')).toBeGreaterThan(waveOf('builder'))
    expect(waveOf('ui-critic')).toBeGreaterThan(waveOf('verifier'))
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
    expect(parsed.tracks.edit?.order).toEqual([])
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

describe('order', () => {
  it('defaults to no edges', () => {
    const parsed = ConfigSchema.parse({
      version: 1,
      tracks: { edit: { required: ['editor'], max_cycles: 1 } },
    })
    expect(parsed.tracks.edit?.order).toEqual([])
  })

  it('accepts the leader\'s two real orderings, both cross-set', () => {
    // skills/mjloop-leader/SKILL.md ~124-126: "ui-designer runs before
    // builder" (available before required) and "ui-critic runs after
    // verifier" (required before available). Neither is a position in one
    // array — this is the shape C2 will move that prose into.
    const good = {
      version: 1,
      tracks: {
        build: {
          required: ['builder', 'verifier'],
          available: ['ui-designer', 'ui-critic'],
          max_cycles: 5,
          order: [
            { agent: 'builder', after: ['ui-designer'] },
            { agent: 'ui-critic', after: ['verifier'] },
          ],
        },
      },
    }
    const parsed = ConfigSchema.safeParse(good)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.tracks.build?.order).toEqual([
        { agent: 'builder', after: ['ui-designer'] },
        { agent: 'ui-critic', after: ['verifier'] },
      ])
    }
  })

  it('rejects an edge naming an unknown agent', () => {
    const bad = {
      version: 1,
      tracks: {
        mine: { required: ['builder'], max_cycles: 3, order: [{ agent: 'ghost', after: ['builder'] }] },
      },
    }
    const parsed = ConfigSchema.safeParse(bad)
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(['tracks', 'mine', 'order', 0, 'agent'])
      expect(z.prettifyError(parsed.error)).toContain('ghost')
    }
  })

  it('rejects an edge waiting on an unknown agent', () => {
    const bad = {
      version: 1,
      tracks: {
        mine: { required: ['builder'], max_cycles: 3, order: [{ agent: 'builder', after: ['ghost'] }] },
      },
    }
    const parsed = ConfigSchema.safeParse(bad)
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(['tracks', 'mine', 'order', 0, 'after', 0])
      expect(z.prettifyError(parsed.error)).toContain('ghost')
    }
  })

  it('rejects an edge naming a closing agent as the ordered agent', () => {
    // A closing agent runs once, outside every cycle — an edge naming it
    // could never be met inside a cycle roster.
    const bad = {
      version: 1,
      tracks: {
        mine: {
          required: ['builder'],
          closing: ['docs'],
          max_cycles: 3,
          order: [{ agent: 'docs', after: ['builder'] }],
        },
      },
    }
    const parsed = ConfigSchema.safeParse(bad)
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      const message = z.prettifyError(parsed.error)
      expect(message).toContain('docs')
      expect(message).toContain('closes this track')
    }
  })

  it('rejects an edge waiting on a closing agent', () => {
    const bad = {
      version: 1,
      tracks: {
        mine: {
          required: ['builder'],
          closing: ['docs'],
          max_cycles: 3,
          order: [{ agent: 'builder', after: ['docs'] }],
        },
      },
    }
    const parsed = ConfigSchema.safeParse(bad)
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      const message = z.prettifyError(parsed.error)
      expect(message).toContain('docs')
      expect(message).toContain('closes this track')
    }
  })

  it('rejects a two-node cycle', () => {
    const bad = {
      version: 1,
      tracks: {
        mine: {
          required: ['a', 'b'],
          max_cycles: 3,
          order: [
            { agent: 'a', after: ['b'] },
            { agent: 'b', after: ['a'] },
          ],
        },
      },
    }
    const parsed = ConfigSchema.safeParse(bad)
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(z.prettifyError(parsed.error)).toContain('cycle')
  })

  it('rejects a longer cycle', () => {
    const bad = {
      version: 1,
      tracks: {
        mine: {
          required: ['a', 'b', 'c'],
          max_cycles: 3,
          order: [
            { agent: 'a', after: ['b'] },
            { agent: 'b', after: ['c'] },
            { agent: 'c', after: ['a'] },
          ],
        },
      },
    }
    const parsed = ConfigSchema.safeParse(bad)
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(z.prettifyError(parsed.error)).toContain('cycle')
  })

  it('rejects a self-loop', () => {
    const bad = {
      version: 1,
      tracks: { mine: { required: ['a'], max_cycles: 3, order: [{ agent: 'a', after: ['a'] }] } },
    }
    const parsed = ConfigSchema.safeParse(bad)
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(z.prettifyError(parsed.error)).toContain('cycle')
  })

  it('rejects an edge that inverts the track\'s own gate', () => {
    // gate: reproducer proves, fixer is blocked until it does — so reproducer
    // must run before fixer. An edge saying the opposite is a permanent,
    // silent deadlock of exactly the family the gate exists to guard.
    const bad = {
      version: 1,
      tracks: {
        fix: {
          required: ['reproducer', 'fixer'],
          max_cycles: 3,
          gate: { proven_by: 'reproducer', blocks: ['fixer'] },
          order: [{ agent: 'reproducer', after: ['fixer'] }],
        },
      },
    }
    const parsed = ConfigSchema.safeParse(bad)
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      const message = z.prettifyError(parsed.error)
      expect(message).toContain('reproducer')
      expect(message).toContain('deadlock')
    }
  })

  it('accepts an edge that only restates the gate\'s own order', () => {
    // fixer after reproducer is redundant with the gate, not opposed to it —
    // this must stay legal so a project can state its ordering explicitly
    // even where a gate already implies it.
    const good = {
      version: 1,
      tracks: {
        fix: {
          required: ['reproducer', 'fixer'],
          max_cycles: 3,
          gate: { proven_by: 'reproducer', blocks: ['fixer'] },
          order: [{ agent: 'fixer', after: ['reproducer'] }],
        },
      },
    }
    expect(ConfigSchema.safeParse(good).success).toBe(true)
  })

  it('rejects a gate inversion through a third agent, not just a direct one', () => {
    // The direct check only looks at edge.agent === gate.proven_by with
    // gate.blocks in that same edge's `after` — a 2-cycle. This is the same
    // deadlock one hop removed: fixer waits on investigator, investigator
    // waits on reproducer (order), and the gate makes fixer wait on
    // reproducer's pass — so reproducer, which must run first, is forced to
    // wait on fixer, which cannot run until reproducer already has. Nothing
    // in the cycle could ever be logged. Review-caught: a prior version of
    // this check only tested the direct inversion in isolation and admitted
    // this graph.
    const bad = {
      version: 1,
      tracks: {
        fix: {
          required: ['reproducer', 'fixer', 'investigator'],
          max_cycles: 3,
          gate: { proven_by: 'reproducer', blocks: ['fixer'] },
          order: [
            { agent: 'reproducer', after: ['investigator'] },
            { agent: 'investigator', after: ['fixer'] },
          ],
        },
      },
    }
    const parsed = ConfigSchema.safeParse(bad)
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(z.prettifyError(parsed.error)).toContain('cycle')
  })

  it('rejects an edge with no after entries', () => {
    const bad = {
      version: 1,
      tracks: { mine: { required: ['a', 'b'], max_cycles: 3, order: [{ agent: 'a', after: [] }] } },
    }
    expect(ConfigSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects an unknown key on an edge', () => {
    const bad = {
      version: 1,
      tracks: {
        mine: { required: ['a', 'b'], max_cycles: 3, order: [{ agent: 'a', after: ['b'], before: ['c'] }] },
      },
    }
    expect(ConfigSchema.safeParse(bad).success).toBe(false)
  })

  it('travels through the existing track write kind with no wire change', async () => {
    // The claim C1 ships under: ConfigChangeSchema's `track` variant is
    // already `TrackSchema.nullable()` (store/config-mutation.ts), so `order`
    // needs no new ConfigChange variant. Proven by constructing one and
    // parsing it through the schema that already exists.
    const { ConfigChangeSchema } = await import('../../src/store/config-mutation.js')
    const { TrackSchema } = await import('../../src/schemas/config.js')
    const value = TrackSchema.parse({
      required: ['builder', 'verifier'],
      max_cycles: 3,
      order: [{ agent: 'builder', after: ['verifier'] }],
    })
    const change = ConfigChangeSchema.parse({ kind: 'track', track: 'mine', value })
    expect(change.kind).toBe('track')
    if (change.kind === 'track') expect(change.value?.order).toEqual([{ agent: 'builder', after: ['verifier'] }])
  })
})

describe('orchestration', () => {
  it('gives a document that names no orchestration block the whole defaulted tree', () => {
    // The compatibility rule this feature ships under: an already-provisioned
    // .mjloop/config.yaml has no `orchestration:` key at all, and must keep
    // parsing, keep everything it did declare, and gain the whole tree.
    const parsed = ConfigSchema.parse({
      version: 1,
      verify: { test: 'npm test', timeout_ms: 60_000 },
      tracks: { edit: { required: ['editor', 'verifier'], available: ['critic'], max_cycles: 1 } },
      specialists: { critic: 'always' },
      gates: { plan_approval: 'auto' },
    })
    expect(parsed.orchestration).toEqual(DEFAULT_ORCHESTRATION)
    // Nothing the document did declare moved.
    expect(parsed.verify.test).toBe('npm test')
    expect(parsed.verify.timeout_ms).toBe(60_000)
    expect(parsed.tracks.edit?.available).toEqual(['critic'])
    expect(parsed.specialists).toEqual({ critic: 'always' })
    expect(parsed.gates).toEqual({ plan_approval: 'auto', commit: 'auto', preflight: 'auto' })
  })

  it('fills every sibling sub-block when the document names only one setting', () => {
    // What `.prefault({})` on each sub-object buys and a `.default({...})`
    // literal would not: naming `discovery.mode` must not cost a project the
    // defaults for `profile`, `execution`, `quality` and `skills`, nor the two
    // discovery keys it did not name.
    const parsed = ConfigSchema.parse({
      version: 1,
      tracks: { edit: { required: ['editor'], max_cycles: 1 } },
      orchestration: { discovery: { mode: 'always' } },
    })
    expect(parsed.orchestration).toEqual({
      ...DEFAULT_ORCHESTRATION,
      discovery: { mode: 'always', question_budget: 8, completion: 'review' },
    })
  })

  it('leaves discovery off, so this feature landing changes no existing plan flow', () => {
    // Any other default would silently change what /mjloop:plan does in every
    // project that was provisioned before this key existed.
    expect(defaultConfig(VERIFY).orchestration.discovery.mode).toBe('off')
  })

  it.each([
    [{ independent_plan_review: false, independent_verification: false }, 'economy'],
    [{ independent_plan_review: true, independent_verification: false }, 'adaptive'],
    [{ independent_plan_review: false, independent_verification: true }, 'adaptive'],
    [{ independent_plan_review: true, independent_verification: true }, 'strict'],
  ] as const)('normalizes legacy quality %j to %s', (quality, mode) => {
    const parsed = ConfigSchema.parse({
      version: 1,
      tracks: { edit: { required: ['editor'], max_cycles: 1 } },
      orchestration: { quality },
    })
    expect(parsed.orchestration.quality).toEqual({ mode })
  })

  it('rejects mode mixed with a legacy quality boolean', () => {
    const quality = { mode: 'adaptive', independent_plan_review: true }
    expect(
      ConfigSchema.safeParse({
        version: 1,
        tracks: { edit: { required: ['editor'], max_cycles: 1 } },
        orchestration: { quality },
      }).success,
    ).toBe(false)
  })

  it('exports exactly the supported quality modes', () => {
    expect(QualityModeSchema.options).toEqual(['economy', 'adaptive', 'strict'])
  })

  it('rejects a question budget outside 1..20', () => {
    for (const question_budget of [0, 21, 8.5]) {
      const bad = {
        version: 1,
        tracks: { edit: { required: ['editor'], max_cycles: 1 } },
        orchestration: { discovery: { question_budget } },
      }
      expect(ConfigSchema.safeParse(bad).success, `question_budget ${question_budget}`).toBe(false)
    }
    expect(
      ConfigSchema.safeParse({
        version: 1,
        tracks: { edit: { required: ['editor'], max_cycles: 1 } },
        orchestration: { discovery: { question_budget: 20 } },
      }).success,
    ).toBe(true)
  })

  it('rejects a repair attempt count outside 0..5', () => {
    for (const repair_attempts of [-1, 6]) {
      const bad = {
        version: 1,
        tracks: { edit: { required: ['editor'], max_cycles: 1 } },
        orchestration: { execution: { repair_attempts } },
      }
      expect(ConfigSchema.safeParse(bad).success, `repair_attempts ${repair_attempts}`).toBe(false)
    }
    // Zero is a real setting — it means "never repair", not "unset".
    expect(
      ConfigSchema.safeParse({
        version: 1,
        tracks: { edit: { required: ['editor'], max_cycles: 1 } },
        orchestration: { execution: { repair_attempts: 0 } },
      }).success,
    ).toBe(true)
  })

  it('rejects a trusted registry that is not https', () => {
    const bad = {
      version: 1,
      tracks: { edit: { required: ['editor'], max_cycles: 1 } },
      orchestration: { skills: { sources: ['registry'], trusted_registries: ['http://skills.example.com'] } },
    }
    const parsed = ConfigSchema.safeParse(bad)
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(z.prettifyError(parsed.error)).toContain('https://')
  })

  it('rejects an unknown key inside the orchestration block', () => {
    const bad = {
      version: 1,
      tracks: { edit: { required: ['editor'], max_cycles: 1 } },
      orchestration: { discovery: { mode: 'ask', budget: 3 } },
    }
    expect(ConfigSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects auto-plan completion while discovery is off', () => {
    const bad = {
      version: 1,
      tracks: { edit: { required: ['editor'], max_cycles: 1 } },
      orchestration: { discovery: { mode: 'off', completion: 'auto-plan' } },
    }
    const parsed = ConfigSchema.safeParse(bad)
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(['orchestration', 'discovery', 'completion'])
      const message = z.prettifyError(parsed.error)
      expect(message).toContain('auto-plan')
      expect(message).toContain('orchestration.discovery.mode')
    }
  })

  it('accepts auto-plan completion once discovery can actually run', () => {
    for (const mode of ['ask', 'always']) {
      const good = {
        version: 1,
        tracks: { edit: { required: ['editor'], max_cycles: 1 } },
        orchestration: { discovery: { mode, completion: 'auto-plan' } },
      }
      expect(ConfigSchema.safeParse(good).success, mode).toBe(true)
    }
  })

  it('rejects the registry source while no registry is trusted', () => {
    const bad = {
      version: 1,
      tracks: { edit: { required: ['editor'], max_cycles: 1 } },
      orchestration: { skills: { sources: ['github', 'registry'] } },
    }
    const parsed = ConfigSchema.safeParse(bad)
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(['orchestration', 'skills', 'sources'])
      const message = z.prettifyError(parsed.error)
      expect(message).toContain('registry')
      expect(message).toContain('orchestration.skills.trusted_registries')
    }
  })

  it('accepts the registry source once a registry is trusted', () => {
    const good = {
      version: 1,
      tracks: { edit: { required: ['editor'], max_cycles: 1 } },
      orchestration: {
        skills: { sources: ['registry'], trusted_registries: ['https://skills.example.com'] },
      },
    }
    expect(ConfigSchema.safeParse(good).success).toBe(true)
  })

  it('accepts an empty source list, which is how a project turns external discovery off', () => {
    const good = {
      version: 1,
      tracks: { edit: { required: ['editor'], max_cycles: 1 } },
      orchestration: { skills: { sources: [] } },
    }
    const parsed = ConfigSchema.safeParse(good)
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.orchestration.skills.sources).toEqual([])
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

describe('dispatchWaves', () => {
  it('puts every selected agent in one wave when the track has no edges', () => {
    const track = ConfigSchema.parse({
      version: 1,
      tracks: { mine: { required: ['builder', 'verifier'], max_cycles: 3 } },
    }).tracks.mine!
    expect(dispatchWaves(track, ['builder', 'verifier'])).toEqual([['builder', 'verifier']])
  })

  it('splits a cross-set edge into two waves, predecessor first', () => {
    // The leader's own example: ui-designer (available) before builder
    // (required).
    const track = ConfigSchema.parse({
      version: 1,
      tracks: {
        build: {
          required: ['builder', 'verifier'],
          available: ['ui-designer'],
          max_cycles: 5,
          order: [{ agent: 'builder', after: ['ui-designer'] }],
        },
      },
    }).tracks.build!
    expect(dispatchWaves(track, ['builder', 'verifier', 'ui-designer'])).toEqual([
      ['verifier', 'ui-designer'],
      ['builder'],
    ])
  })

  it('treats an edge as vacuous when its predecessor was not selected', () => {
    // The subtlety the schema comment states: ui-critic after verifier must
    // not brick a cycle that skipped verifier — verifier is `required` on
    // `build` so this is hypothetical, but the rule is track-agnostic.
    const track = ConfigSchema.parse({
      version: 1,
      tracks: {
        mine: {
          required: ['builder'],
          available: ['ui-critic', 'verifier'],
          max_cycles: 5,
          order: [{ agent: 'ui-critic', after: ['verifier'] }],
        },
      },
    }).tracks.mine!
    // verifier is not in `selected` — the edge is satisfied by the omission,
    // not violated by it, so ui-critic dispatches in the first wave.
    expect(dispatchWaves(track, ['builder', 'ui-critic'])).toEqual([['builder', 'ui-critic']])
  })

  it('waits for every predecessor, not just one', () => {
    const track = ConfigSchema.parse({
      version: 1,
      tracks: {
        mine: {
          required: ['a', 'b', 'c'],
          max_cycles: 3,
          order: [{ agent: 'c', after: ['a', 'b'] }],
        },
      },
    }).tracks.mine!
    expect(dispatchWaves(track, ['a', 'b', 'c'])).toEqual([['a', 'b'], ['c']])
  })

  it('layers a chain into as many waves as it has links', () => {
    const track = ConfigSchema.parse({
      version: 1,
      tracks: {
        mine: {
          required: ['a', 'b', 'c'],
          max_cycles: 3,
          order: [
            { agent: 'b', after: ['a'] },
            { agent: 'c', after: ['b'] },
          ],
        },
      },
    }).tracks.mine!
    expect(dispatchWaves(track, ['a', 'b', 'c'])).toEqual([['a'], ['b'], ['c']])
  })

  it('throws rather than silently dropping agents from a cycle among a hand-built track', () => {
    // Unreachable through ConfigSchema.parse — TrackSchema.superRefine already
    // refuses this graph — so this constructs the shape directly to prove the
    // defensive throw is not dead code.
    const track = {
      required: ['a', 'b'],
      available: [],
      closing: [],
      max_cycles: 3,
      order: [
        { agent: 'a', after: ['b'] },
        { agent: 'b', after: ['a'] },
      ],
    }
    expect(() => dispatchWaves(track, ['a', 'b'])).toThrow(RangeError)
  })
})
