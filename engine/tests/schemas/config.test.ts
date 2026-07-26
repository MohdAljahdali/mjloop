import { describe, expect, it } from 'vitest'
import { ConfigSchema, DEFAULT_TRACKS, defaultConfig } from '../../src/schemas/config.js'

const VERIFY = { test: 'npm test', lint: 'npm run lint', build: null }

describe('defaultConfig', () => {
  it('is schema-valid and defines only the edit track', () => {
    const config = defaultConfig(VERIFY)
    expect(ConfigSchema.parse(config)).toEqual(config)
    expect(Object.keys(config.tracks)).toEqual(['edit', 'build'])
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
})
