import * as z from 'zod'

export const SpecialistModeSchema = z.enum(['auto', 'always', 'never'])

export const TrackSchema = z.strictObject({
  /** Agents the leader may never drop from a cycle. */
  required: z.array(z.string().min(1)).min(1),
  /** Agents the leader may draft when the task calls for them. */
  available: z.array(z.string().min(1)).default([]),
  max_cycles: z.number().int().positive(),
})

export const VerifySchema = z.strictObject({
  test: z.string().min(1).nullable().default(null),
  lint: z.string().min(1).nullable().default(null),
  build: z.string().min(1).nullable().default(null),
})

export const ConfigSchema = z.strictObject({
  version: z.literal(1),
  autonomous: z.boolean().default(false),
  limits: z
    .strictObject({
      max_parallel_agents: z.number().int().positive().default(4),
      no_progress_strikes: z.number().int().positive().default(2),
    })
    .default({ max_parallel_agents: 4, no_progress_strikes: 2 }),
  verify: VerifySchema.default({ test: null, lint: null, build: null }),
  tracks: z.record(z.string().min(1), TrackSchema),
  specialists: z.record(z.string().min(1), SpecialistModeSchema).default({}),
  gates: z
    .strictObject({
      plan_approval: z.enum(['human', 'auto']).default('human'),
      commit: z.enum(['auto', 'human']).default('auto'),
    })
    .default({ plan_approval: 'human', commit: 'auto' }),
  custom_dirs: z
    .strictObject({
      agents: z.string().min(1).default('.loop/agents'),
      skills: z.string().min(1).default('.loop/skills'),
    })
    .default({ agents: '.loop/agents', skills: '.loop/skills' }),
})

export type SpecialistMode = z.infer<typeof SpecialistModeSchema>
export type Track = z.infer<typeof TrackSchema>
export type Verify = z.infer<typeof VerifySchema>
export type Config = z.infer<typeof ConfigSchema>

/**
 * Tracks shipped in milestone 1. Further tracks are appended by their own
 * milestones; a track is data, so adding one touches no code.
 */
export const DEFAULT_TRACKS: Record<string, Track> = {
  edit: { required: ['editor', 'verifier'], available: [], max_cycles: 1 },
}

export function defaultConfig(verify: Verify): Config {
  return ConfigSchema.parse({ version: 1, verify, tracks: DEFAULT_TRACKS })
}
