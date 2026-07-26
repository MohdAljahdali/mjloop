import * as z from 'zod'
import { IdSchema } from './state.js'

export const SpecialistModeSchema = z.enum(['auto', 'always', 'never'])

/**
 * A precondition on a track: nothing in `blocks` may be logged until
 * `proven_by` has returned an evidenced pass.
 *
 * This is track configuration rather than a rule in the engine because the
 * engine does not know agent names — that is what makes a track data and lets
 * a new one ship without touching code.
 */
export const GateSchema = z.strictObject({
  /** Whose passing, evidenced result opens the gate. */
  proven_by: z.string().min(1),
  /** Agents that may not be logged until it is open. */
  blocks: z.array(z.string().min(1)).min(1),
})

export const TrackSchema = z
  .strictObject({
    /** Agents the leader may never drop from a cycle. */
    required: z.array(z.string().min(1)).min(1),
    /** Agents the leader may draft when the task calls for them. */
    available: z.array(z.string().min(1)).default([]),
    max_cycles: z.number().int().positive(),
    /** Optional precondition. A track without one behaves as it always has. */
    gate: GateSchema.optional(),
  })
  .superRefine((track, ctx) => {
    if (track.gate === undefined) return
    const known = new Set([...track.required, ...track.available])
    // The remedy travels with the message: an error that names only the
    // consequence leaves a one-character typo invisible.
    const remedy = `add it to required or available first (this track has: ${[...known].join(', ')})`

    if (!known.has(track.gate.proven_by)) {
      ctx.addIssue({
        code: 'custom',
        path: ['gate', 'proven_by'],
        message: `"${track.gate.proven_by}" is not in this track — a gate proven by an agent the leader can never draft would shut the track permanently, and silently. Check the spelling, or ${remedy}`,
      })
    }
    for (const [index, agent] of track.gate.blocks.entries()) {
      if (!known.has(agent)) {
        ctx.addIssue({
          code: 'custom',
          path: ['gate', 'blocks', index],
          message: `"${agent}" is not in this track — blocking an agent it never runs has no effect. Check the spelling, or ${remedy}`,
        })
      }
    }
    // A gate that blocks its own prover is the same permanent, silent shutdown
    // the checks above exist to prevent: the one result that would open it is
    // the one it refuses.
    if (track.gate.blocks.includes(track.gate.proven_by)) {
      ctx.addIssue({
        code: 'custom',
        path: ['gate', 'blocks'],
        message: `"${track.gate.proven_by}" proves this gate and cannot also be blocked by it — the result that would open the gate could never be logged. Drop it from blocks`,
      })
    }
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
  /** A track name reaches the filesystem — it is the last component of every
   * run directory name — so it is constrained where it is defined, exactly as
   * the story id in the same template is. `config.yaml` is hand-editable and
   * travels with a cloned repository, so this is the only place to catch it. */
  tracks: z.record(IdSchema, TrackSchema),
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
export type Gate = z.infer<typeof GateSchema>
export type Track = z.infer<typeof TrackSchema>
export type Verify = z.infer<typeof VerifySchema>
export type Config = z.infer<typeof ConfigSchema>

/**
 * Own-property lookup. Track names arrive from the leader model and from
 * state, and `tracks.toString` inherits a function from `Object.prototype`: a
 * plain index would hand every caller a "track" with no `required` and no
 * `max_cycles` instead of the unknown-track error they check for.
 */
export function findTrack(config: Config, track: string): Track | undefined {
  return Object.hasOwn(config.tracks, track) ? config.tracks[track] : undefined
}

/** Specialists the config forces into every cycle regardless of the roster. */
export function forcedSpecialists(config: Config): string[] {
  return Object.entries(config.specialists)
    .filter(([, mode]) => mode === 'always')
    .map(([name]) => name)
}

/**
 * Every agent a track may run. One definition for the two places that must
 * agree about it: the roster the leader declares and the results it logs.
 */
export function permittedAgents(config: Config, track: Track): Set<string> {
  return new Set([...track.required, ...track.available, ...forcedSpecialists(config)])
}

/**
 * Tracks shipped in milestone 1. Further tracks are appended by their own
 * milestones; a track is data, so adding one touches no code.
 */
export const DEFAULT_TRACKS: Record<string, Track> = {
  edit: { required: ['editor', 'verifier'], available: [], max_cycles: 1 },
  // max_cycles is a ceiling, not a target: with the stagnation guard in place
  // a stuck run halts well before reaching it.
  build: { required: ['builder', 'verifier'], available: ['scout', 'critic'], max_cycles: 5 },
  fix: {
    required: ['reproducer', 'fixer', 'verifier'],
    available: ['investigator', 'hypothesis-tester', 'critic'],
    max_cycles: 5,
    gate: { proven_by: 'reproducer', blocks: ['fixer'] },
  },
}

export function defaultConfig(verify: Verify): Config {
  return ConfigSchema.parse({ version: 1, verify, tracks: DEFAULT_TRACKS })
}
