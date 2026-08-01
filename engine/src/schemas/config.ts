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

/**
 * The agent whose passing result becomes the run's map.
 *
 * Track data rather than a rule in the engine, for the reason `GateSchema`
 * states: the engine does not know agent names. Hard-coding `scout` in `runLog`
 * would be the first place it learned one, and a project that maps its ground
 * with a differently named agent could never hand a map forward.
 */
export const MapSchema = z.strictObject({
  /** Whose passing result becomes the run's map. */
  drafted_by: z.string().min(1),
})

export const TrackSchema = z
  .strictObject({
    /** Agents the leader may never drop from a cycle. */
    required: z.array(z.string().min(1)).min(1),
    /** Agents the leader may draft when the task calls for them. */
    available: z.array(z.string().min(1)).default([]),
    /**
     * Agents that run once, after the run passes — never inside a working
     * cycle.
     *
     * The default is load-bearing in the same way `available`'s is: `Track` is
     * the output type, so every literal in `DEFAULT_TRACKS` must spell the key
     * out, while an existing hand-written `config.yaml` gains `closing: []` on
     * read and keeps parsing untouched.
     */
    closing: z.array(z.string().min(1)).default([]),
    max_cycles: z.number().int().positive(),
    /** Optional precondition. A track without one behaves as it always has. */
    gate: GateSchema.optional(),
    /** Optional. A track that hands a map forward names who drafts it. */
    map: MapSchema.optional(),
  })
  .superRefine((track, ctx) => {
    // `closing` counts as known. A gate naming a closing agent is naming an
    // agent this track genuinely runs, and `permittedAgents` lets it log, so a
    // check that called it unknown would be wrong about the track rather than
    // strict about it.
    const known = new Set([...track.required, ...track.available, ...track.closing])
    // The remedy travels with the message: an error that names only the
    // consequence leaves a one-character typo invisible. It names all three
    // sets because `known` is all three — telling a reader to add the agent to
    // `required` when they meant to close the run with it would send them to
    // the wrong line.
    const remedy = `add it to required, available or closing first (this track has: ${[...known].join(', ')})`

    if (track.map !== undefined) {
      // Deliberately narrower than `known`. A closing agent runs after the run
      // has passed, and `runLog`'s closing branch returns before the map is
      // written — so a map drafted by one is a document that could never be
      // produced. That is the same permanent, silent absence the gate checks
      // below exist to prevent, arriving through a different field.
      const draftable = new Set([...track.required, ...track.available])
      if (!draftable.has(track.map.drafted_by)) {
        ctx.addIssue({
          code: 'custom',
          path: ['map', 'drafted_by'],
          message: `"${track.map.drafted_by}" is not draftable in a working cycle on this track — a map drafted by an agent the leader can never draft is a map that is never written, and silently. Check the spelling, or add it to required or available first (this track draws cycles from: ${[...draftable].join(', ')})`,
        })
      }
    }

    if (track.gate === undefined) return

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

/**
 * What the engine executes to verify a project, and the policy around it.
 *
 * The whole block is executed policy, not just the three command strings: a
 * `timeout_ms` of `1` kills every suite the engine starts, and a failure
 * pattern is a regular expression this engine compiles and runs. That is why
 * `runStart` pins the whole object into the run directory rather than the
 * commands alone, and why `PinnedVerifySchema` wraps this schema instead of
 * restating it — a pin written before a key existed gains that key's default
 * when it is re-parsed here.
 */
export const VerifySchema = z.strictObject({
  test: z.string().min(1).nullable().default(null),
  lint: z.string().min(1).nullable().default(null),
  build: z.string().min(1).nullable().default(null),
  /** Hard ceiling per invocation. The child is killed, and the kill is reported. */
  timeout_ms: z.number().int().positive().default(900_000),
  /**
   * How long an invocation waits for the project verify lock before returning
   * a terminal `phase: 'queued'`. Two full ceilings by default, so a waiter
   * never gives up on a suite that is still legitimately running: one holder
   * may legitimately hold for `timeout_ms`, and a waiter that abandoned sooner
   * would report a queue where there was only a slow test suite.
   */
  lock_timeout_ms: z.number().int().positive().default(1_800_000),
  /**
   * Optional per-slot overrides for the digest's failure patterns. Compiled
   * with `new RegExp` at use, inside a `try` — a typo in a regex must not stop
   * a project verifying, so an invalid pattern falls back to the documented
   * default and is reported in the digest.
   */
  failure_patterns: z
    .strictObject({
      test: z.array(z.string().min(1)).default([]),
      lint: z.array(z.string().min(1)).default([]),
      build: z.array(z.string().min(1)).default([]),
    })
    .prefault({}),
})

/**
 * When a feature request is turned into a brief by questioning the person who
 * asked for it, rather than by guessing.
 *
 * `off` is not "unset" — it is the setting that keeps `/mjloop:plan` behaving
 * exactly as it did before this block existed.
 */
export const FeatureDiscoveryModeSchema = z.enum(['always', 'ask', 'off'])

/** What happens to a brief once discovery has finished producing it. */
export const DiscoveryCompletionSchema = z.enum(['auto-plan', 'review', 'save-only'])

/**
 * What to do with stories whose dependencies cannot be proven independent.
 * `sequential` is the only one of the three that cannot corrupt a worktree by
 * itself, so it is the default.
 */
export const UncertainConcurrencySchema = z.enum(['sequential', 'ask', 'parallel'])

/** Whether an approved plan starts building on its own, or waits to be told. */
export const AfterPlanApprovalSchema = z.enum(['auto', 'manual'])

/** Where a skill this project does not already have may be discovered from. */
export const SkillSourceSchema = z.enum(['github', 'registry', 'web'])

/** What happens when a skill this project uses has a newer version. */
export const SkillUpdateModeSchema = z.enum(['auto', 'review', 'pinned'])

/**
 * Project-scoped orchestration policy: how much this project wants the loop to
 * decide on its own, and how much it wants to be asked.
 *
 * Every field is defaulted and every sub-block is `.prefault({})`, for the
 * reason `VerifySchema.prefault({})` states above and one more that is specific
 * to this block: it lands on projects that are already provisioned. A
 * `.mjloop/config.yaml` written before this key existed has no `orchestration:`
 * at all, and one that names a single setting — `discovery: {mode: always}` —
 * must gain every other default rather than a half-populated tree. A
 * `.default({...})` literal on a sub-object would satisfy the first case and
 * fail the second, because `.default` is only consulted when the key is absent.
 */
export const OrchestrationSchema = z.strictObject({
  profile: z
    .strictObject({
      /**
       * May a scan activate a component map with nobody accepting it?
       *
       * Off by default. An accepted profile is what every later run routes on,
       * so a project that gains one without a person looking has had its
       * routing decided by a directory walk.
       */
      auto_accept: z.boolean().default(false),
    })
    .prefault({}),
  discovery: z
    .strictObject({
      /**
       * Deliberately `off`.
       *
       * The compatibility rule this whole feature ships under is that an
       * existing project's plan flow is unchanged by it landing. Any other
       * default would silently change what `/mjloop:plan` does in every
       * already-provisioned project the moment the engine is upgraded — the
       * command would start asking questions nobody configured it to ask.
       * Turning it on is a decision a project makes, once, in writing.
       */
      mode: FeatureDiscoveryModeSchema.default('off'),
      /**
       * A ceiling on questions, not a target. The bound is enforced here rather
       * than at the caller because `config.yaml` is hand-edited: a `0` would
       * make a mode of `always` ask nothing and look like a broken feature, and
       * a `200` is an interview no person finishes.
       */
      question_budget: z.number().int().min(1).max(20).default(8),
      completion: DiscoveryCompletionSchema.default('review'),
    })
    .prefault({}),
  execution: z
    .strictObject({
      after_plan_approval: AfterPlanApprovalSchema.default('manual'),
      uncertain_concurrency: UncertainConcurrencySchema.default('sequential'),
      /**
       * How many times a failed story may be re-attempted before the run stops
       * and says so. `0` is a real setting — it means never repair — which is
       * why the bound starts there rather than at 1.
       */
      repair_attempts: z.number().int().min(0).max(5).default(1),
    })
    .prefault({}),
  quality: z
    .strictObject({
      independent_plan_review: z.boolean().default(false),
      independent_verification: z.boolean().default(false),
    })
    .prefault({}),
  skills: z
    .strictObject({
      /**
       * An empty list is meaningful and permitted: it is how a project says no
       * skill may be discovered from outside it at all.
       */
      sources: z.array(SkillSourceSchema).default(['github']),
      /**
       * A registry named here is a place this project will fetch executable
       * instructions from, so plain `http://` is refused at the schema — the
       * one place a hand-edited, repository-travelling file can be caught.
       */
      trusted_registries: z
        .array(z.string().min(1).startsWith('https://', 'a trusted registry must be an https:// URL'))
        .default([]),
      update_mode: SkillUpdateModeSchema.default('review'),
    })
    .prefault({}),
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
    /**
     * Whether an identical verify command may reuse an earlier green result
     * within the same run.
     *
     * Off by default. A suite that is not a pure function of the worktree —
     * one that touches the network, the clock, a shared database or a port —
     * has flakes, and re-running is how a loop finds them; a cache hides
     * exactly that class of failure. A project whose build inputs live outside
     * git (an ignored `.env`, generated code, `node_modules`) must leave it
     * off, because the digest the cache keys on cannot see any of them.
     */
    verify_cache: z.boolean().default(false),
    limits: z
      .strictObject({
        max_parallel_agents: z.number().int().positive().default(4),
        no_progress_strikes: z.number().int().positive().default(2),
      })
      .default({ max_parallel_agents: 4, no_progress_strikes: 2 }),
    // `.prefault({})` rather than a literal default object: `.default()` takes
    // the schema's *output*, in which every `.default()`ed field is required,
    // so a literal here is a hand-maintained duplicate of the schema's own
    // defaults that has to be edited twice every time `VerifySchema` gains a
    // key. `.prefault` re-parses its argument, so each field arrives with its
    // own default and the duplicate is retired.
    verify: VerifySchema.prefault({}),
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
        /**
         * Does a person see the run's estimate before the first dispatch?
         * `auto` by default: an estimate shown before every run that then
         * always proceeds is a prompt nobody reads.
         */
        preflight: z.enum(['human', 'auto']).default('auto'),
      })
      // Unlike `verify` above, this literal stays: exactly one schema changes
      // shape at a time, and the duplicate is one the compiler refuses to let
      // you forget — `npm run typecheck` fails on a missing key here.
      .default({ plan_approval: 'human', commit: 'auto', preflight: 'auto' }),
    /** `.prefault({})` for the reason `verify` above uses it, and because this
     * key is absent from every config written before it existed. */
    orchestration: OrchestrationSchema.prefault({}),
  })
  // A track cannot see the `specialists` map, so the contradiction between a
  // track that requires an agent and a config that forbids it can only be
  // caught here, on the whole document.
  .superRefine((config, ctx) => {
    // The orchestration contradictions are the same species as the track ones
    // below: every value involved is legal on its own, the combination can
    // never take effect, and nothing at runtime would ever report that the
    // setting did nothing. A sub-schema cannot see across to its sibling, so
    // the whole document is the only place either can be caught.
    const { discovery, skills } = config.orchestration
    if (discovery.completion === 'auto-plan' && discovery.mode === 'off') {
      ctx.addIssue({
        code: 'custom',
        path: ['orchestration', 'discovery', 'completion'],
        message:
          'orchestration.discovery.completion is "auto-plan" but orchestration.discovery.mode is "off" — auto-plan names a start driven by an approved feature brief, and a project with discovery off never produces one, so planning would silently never begin the way this setting promises. Set discovery.mode to "ask" or "always", or choose a completion of "review" or "save-only".',
      })
    }
    if (skills.sources.includes('registry') && skills.trusted_registries.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['orchestration', 'skills', 'sources'],
        message:
          'orchestration.skills.sources names "registry" but orchestration.skills.trusted_registries is empty — a source that names no registry admits nothing, so this project believes it enabled a source that can never return a skill. Add the registry\'s https:// URL to trusted_registries, or drop "registry" from sources.',
      })
    }

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
      // A closing agent a specialist rule forbids is a step that silently
      // never happens: `rosterSet` demands no skip reason for a closing agent,
      // so nothing anywhere would record that the run shipped without it.
      for (const agent of track.closing) {
        if (forbidden.has(agent)) {
          ctx.addIssue({
            code: 'custom',
            path: ['tracks', trackName, 'closing'],
            message: `"${agent}" closes track "${trackName}" but specialists.${agent} is "never" — it could never be dispatched, and a closing agent needs no skip reason, so nothing would record that the run shipped without it. Drop one of the two.`,
          })
        }
      }
      // The same contradiction through the map: a map drafted by an agent the
      // config forbids is a document no run ever writes, and every later cycle
      // re-derives the ground it was meant to hand forward.
      if (track.map !== undefined && forbidden.has(track.map.drafted_by)) {
        ctx.addIssue({
          code: 'custom',
          path: ['tracks', trackName, 'map', 'drafted_by'],
          message: `"${track.map.drafted_by}" drafts the map on track "${trackName}" but specialists.${track.map.drafted_by} is "never" — the only result that becomes a map could never be produced, so every cycle would re-derive the ground. Drop one of the two.`,
        })
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
export type FeatureDiscoveryMode = z.infer<typeof FeatureDiscoveryModeSchema>
export type DiscoveryCompletion = z.infer<typeof DiscoveryCompletionSchema>
export type UncertainConcurrency = z.infer<typeof UncertainConcurrencySchema>
export type AfterPlanApproval = z.infer<typeof AfterPlanApprovalSchema>
export type SkillSource = z.infer<typeof SkillSourceSchema>
export type SkillUpdateMode = z.infer<typeof SkillUpdateModeSchema>
/** The parsed block — every key present — not the sparse thing a hand-edited
 * `config.yaml` may contain. Later stories read policy from this type. */
export type Orchestration = z.infer<typeof OrchestrationSchema>
export type Gate = z.infer<typeof GateSchema>
/** Not `Map`: that name is the global the engine uses everywhere else. */
export type TrackMap = z.infer<typeof MapSchema>
export type Track = z.infer<typeof TrackSchema>
/**
 * The verify block as a *caller supplies* it, not as the engine reads it.
 *
 * Deliberately the input type. `detectVerifyCommands` builds this from
 * `package.json` scripts and knows nothing about `timeout_ms`,
 * `lock_timeout_ms` or `failure_patterns`; typing it as the schema's output
 * would make every defaulted key required at the one call site whose whole job
 * is to supply the three it can actually detect. The parsed block — every key
 * present, and the thing the engine executes and `runStart` pins — is
 * `Config['verify']`.
 */
export type Verify = z.input<typeof VerifySchema>
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
 * The agents a track pins in place: the names this schema refuses to let
 * `specialists.<agent>: never` name, and which `TrackSchema` additionally
 * refuses to let a track drop from its own sets.
 *
 * The four categories are exactly the four `ConfigSchema`'s `superRefine`
 * rejects above — `required`, `closing`, `map.drafted_by`, `gate.proven_by` —
 * and this is where any reader who needs that set as *data* rather than as
 * four error messages should take it from. Telemetry is the reader that
 * matters: a report that advised `never` for a name on this list would be
 * advising an operator to make their own `config.yaml` stop parsing.
 */
export function pinnedAgents(track: Track): string[] {
  const pinned = [...track.required, ...track.closing]
  if (track.map !== undefined) pinned.push(track.map.drafted_by)
  if (track.gate !== undefined) pinned.push(track.gate.proven_by)
  return pinned
}

/**
 * Every agent a track may run. One definition for the two places that must
 * agree about it: the roster the leader declares and the results it logs.
 *
 * `closing` is in the union because a closing agent is an agent this track
 * runs — just not inside a cycle. Without it `runLog` throws
 * `UnknownAgentError` for the very agent `cycleAdvance` told the leader to
 * dispatch, and the run's documentation step fails at the last step of the run.
 */
export function permittedAgents(config: Config, track: Track): Set<string> {
  return new Set([...track.required, ...track.available, ...track.closing, ...forcedSpecialists(config)])
}

/**
 * Tracks shipped in milestone 1. Further tracks are appended by their own
 * milestones; a track is data, so adding one touches no code.
 */
export const DEFAULT_TRACKS: Record<string, Track> = {
  // Every literal spells `closing` out, including the three that declare none.
  // `Track` is the output type, in which a `.default()`ed field is required —
  // the same reason `available: []` has always been written here.
  edit: { required: ['editor', 'verifier'], available: [], closing: [], max_cycles: 1 },
  // max_cycles is a ceiling, not a target: with the stagnation guard in place
  // a stuck run halts well before reaching it.
  build: {
    required: ['builder', 'verifier'],
    // Ordered from the general to the specific: the leader reads this list
    // when composing, and every omission needs a stated reason.
    available: ['scout', 'critic', 'ui-designer', 'ui-critic', 'security', 'perf'],
    // `docs` closes the run rather than joining a cycle. Documentation drafted
    // in cycle 2 describes code cycle 4 replaces, and the alternative under the
    // old rule was four cycles of boilerplate skip reasons.
    closing: ['docs'],
    max_cycles: 5,
    // The only track with ground worth handing forward: `edit` is one cycle,
    // `fix` has a reproduction, and `plan` produces a document.
    map: { drafted_by: 'scout' },
  },
  fix: {
    required: ['reproducer', 'fixer', 'verifier'],
    available: ['investigator', 'hypothesis-tester', 'critic', 'security'],
    closing: [],
    max_cycles: 5,
    gate: { proven_by: 'reproducer', blocks: ['fixer'] },
  },
  plan: {
    required: ['planner', 'fit-checker', 'story-writer'],
    available: ['plan-critic', 'story-critic'],
    closing: [],
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
