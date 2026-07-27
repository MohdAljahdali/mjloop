import { describe, expect, it } from 'vitest'
import * as z from 'zod'
import { ConfigSchema, DEFAULT_TRACKS, defaultConfig } from '../../src/schemas/config.js'

const VERIFY = { test: 'npm test', lint: 'npm run lint', build: null }

describe('defaultConfig', () => {
  it('is schema-valid and defines only the edit track', () => {
    const config = defaultConfig(VERIFY)
    expect(ConfigSchema.parse(config)).toEqual(config)
    expect(Object.keys(config.tracks)).toEqual(['edit', 'build', 'fix', 'plan'])
    expect(config.autonomous).toBe(false)
  })

  it('carries the detected verify commands through', () => {
    expect(defaultConfig(VERIFY).verify).toEqual(VERIFY)
  })
})

describe('DEFAULT_TRACKS', () => {
  it('makes editor and verifier required for edit, capped at one cycle', () => {
    expect(DEFAULT_TRACKS.edit).toEqual({ required: ['editor', 'verifier'], available: [], max_cycles: 1 })
  })

  it('makes builder and verifier required for build, with scout and critic available', () => {
    expect(DEFAULT_TRACKS.build).toEqual({
      required: ['builder', 'verifier'],
      available: ['scout', 'critic'],
      max_cycles: 5,
    })
  })

  it('gates the fix track on the reproducer and blocks the fixer', () => {
    expect(DEFAULT_TRACKS.fix).toEqual({
      required: ['reproducer', 'fixer', 'verifier'],
      available: ['investigator', 'hypothesis-tester', 'critic'],
      max_cycles: 5,
      gate: { proven_by: 'reproducer', blocks: ['fixer'] },
    })
  })

  it('gates the plan track on the fit-checker and blocks the story-writer', () => {
    expect(DEFAULT_TRACKS.plan).toEqual({
      required: ['planner', 'fit-checker', 'story-writer'],
      available: ['plan-critic', 'story-critic'],
      max_cycles: 6,
      gate: { proven_by: 'fit-checker', blocks: ['story-writer'] },
    })
  })

  it('leaves the ungated tracks ungated', () => {
    expect(DEFAULT_TRACKS.edit?.gate).toBeUndefined()
    expect(DEFAULT_TRACKS.build?.gate).toBeUndefined()
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
    expect(parsed.custom_dirs.agents).toBe('.loop/agents')
    expect(parsed.tracks.edit?.available).toEqual([])
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
    // path-shaped one steers writes outside .loop/runs.
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
      expect(message).toContain('add it to required or available first')
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
})
