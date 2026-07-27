import * as z from 'zod'
import { AgentNameSchema } from './contract.js'
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

/**
 * Keys earlier versions wrote that no longer exist. `loadConfig` drops them
 * before parsing, so a config written by an older milestone keeps parsing.
 *
 * The strip is a read, not a rewrite: nothing writes the cleaned document back,
 * so the key stays in the hand-editable file until a person removes it, and is
 * dropped again on every read. It is inert there, which is the point.
 *
 * The migration only removes keys — it adds nothing. A config keeps whatever
 * `tracks` it was written with, so a project provisioned before a track shipped
 * does not gain it: `/mjloop:build` on a milestone-1 config is refused by name
 * ("unknown track"), and the remedy is to add the track to `tracks:`.
 *
 * `custom_dirs` pointed at `.mjloop/agents` and `.mjloop/skills`. Claude Code reads
 * project agents from `.claude/agents` and skills from `.claude/skills`, and no
 * setting anywhere redirects that — so the field's default, and every value it
 * could be given, produced files that are never loaded.
 */
export const LEGACY_CONFIG_KEYS = ['custom_dirs'] as const

export const ConfigSchema = z
  .strictObject({
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
    /** Keyed on the same schema every other agent name goes through. A key
     * here is load-bearing and matched against a name the leader supplies, so
     * a typo fails silently in both directions: `never` on a misspelling
     * forbids nothing and the agent runs every cycle, while `always` on a name
     * `runLog` would refuse forces a cycle that can be composed but never
     * logged. Neither is reported anywhere, so this is the only place to catch
     * it. */
    specialists: z.record(AgentNameSchema, SpecialistModeSchema).default({}),
    gates: z
      .strictObject({
        plan_approval: z.enum(['human', 'auto']).default('human'),
        commit: z.enum(['auto', 'human']).default('auto'),
      })
      .default({ plan_approval: 'human', commit: 'auto' }),
  })
  // A track cannot see the `specialists` map, so the contradiction between a
  // track that requires an agent and a config that forbids it can only be
  // caught here, on the whole document.
  .superRefine((config, ctx) => {
    const forbidden = new Set(
      Object.entries(config.specialists)
        .filter(([, mode]) => mode === 'never')
        .map(([name]) => name),
    )
    for (const [trackName, track] of Object.entries(config.tracks)) {
      for (const agent of track.required) {
        if (forbidden.has(agent)) {
          ctx.addIssue({
            code: 'custom',
            path: ['tracks', trackName, 'required'],
            message: `"${agent}" is required by track "${trackName}" but specialists.${agent} is "never" — every possible roster for that track would be rejected. Drop one of the two.`,
          })
        }
      }
      // The sibling contradiction, and the same permanent, silent shutdown
      // `TrackSchema`'s own gate checks exist to prevent: a prover in
      // `available` passes those checks, so only the whole document can see
      // that the config has forbidden the one agent that opens the gate.
      if (track.gate !== undefined && forbidden.has(track.gate.proven_by)) {
        ctx.addIssue({
          code: 'custom',
          path: ['tracks', trackName, 'gate', 'proven_by'],
          message: `"${track.gate.proven_by}" proves the gate on track "${trackName}" but specialists.${track.gate.proven_by} is "never" — the only result that opens the gate could never be produced, so everything it blocks would be refused for the whole run. Drop one of the two.`,
        })
      }
    }
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
 * Specialists the project has forbidden. The mirror image of
 * `forcedSpecialists`: one says an agent cannot be dropped, this says it
 * cannot be drafted. Both return names the engine never interprets.
 */
export function forbiddenSpecialists(config: Config): string[] {
  return Object.entries(config.specialists)
    .filter(([, mode]) => mode === 'never')
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
  build: {
    required: ['builder', 'verifier'],
    // Ordered from the general to the specific: the leader reads this list
    // when composing, and every omission needs a stated reason.
    available: ['scout', 'critic', 'ui-designer', 'ui-critic', 'security', 'docs', 'perf'],
    max_cycles: 5,
  },
  fix: {
    required: ['reproducer', 'fixer', 'verifier'],
    available: ['investigator', 'hypothesis-tester', 'critic', 'security'],
    max_cycles: 5,
    gate: { proven_by: 'reproducer', blocks: ['fixer'] },
  },
  plan: {
    required: ['planner', 'fit-checker', 'story-writer'],
    available: ['plan-critic', 'story-critic'],
    max_cycles: 6,
    // An evidence gate: whether a plan fits the project that exists is a fact,
    // and fit-checker demonstrates it. The approval gate is a different kind
    // and lives on the plan, not here.
    gate: { proven_by: 'fit-checker', blocks: ['story-writer'] },
  },
}

export function defaultConfig(verify: Verify): Config {
  return ConfigSchema.parse({ version: 1, verify, tracks: DEFAULT_TRACKS })
}
