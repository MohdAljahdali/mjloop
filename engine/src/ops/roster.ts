import fs from 'node:fs/promises'
import path from 'node:path'
import * as z from 'zod'
import {
  dispatchWaves,
  findTrack,
  forbiddenSpecialists,
  forcedSpecialists,
  permittedAgents,
  type Config,
  type Track,
} from '../schemas/config.js'
import { RosterSchema, type Roster } from '../schemas/contract.js'
import { loadConfig } from '../store/config-store.js'
import { StateStore } from '../store/state-store.js'
// Type-only: erased at emit (`tsconfig.json` has neither `isolatedModules` nor
// `verbatimModuleSyntax`, so `import type` never survives to `dist/ops/roster.js`
// — `npm run build`'s byte-identical mirror and `verify:ship`'s import walk
// both see the same zero-dependency file this always was). `web/codes.ts`'s
// `WEB_CODES` is the one place a code is declared; a plain `import` here would
// invert the direction `tests/web/boundary.test.ts` polices (`src/web/` must
// not reach certain `ops/` writes), but that test says nothing about `ops/`
// reaching a *type* under `src/web/`, and this reaches nothing else there.
import type { WebCode } from '../web/codes.js'
import { qualityRuntimeEnabled } from './quality-capability.js'
import { reserveQualityDispatches } from './quality-control.js'
import { ensureRunQualityPolicy, resolveQualityContextEvidence } from './quality-policy.js'
import { planQualityDispatches, qualityRosterViolations, type PlannedQualityDispatch } from './quality-roster.js'
import { NoActiveRunError, UnknownTrackError, cycleDirPath, runDirPath } from './run.js'

/** Every code `rosterViolations` and `cycleRosterSet`'s cycle check can produce. */
export type RosterViolationCode = Extract<WebCode, `roster.${string}`>

/** One reason a candidate composition is refused, in the vocabulary the wire speaks. */
export interface RosterViolation {
  code: RosterViolationCode
  params?: Record<string, string | number>
}

/**
 * The MCP caller's English, built FROM a violation's code and params so the
 * two cannot drift the way a hand-written sentence beside a hand-written code
 * always eventually does. Never called for anything that reaches the browser
 * — `readRosterValidity` (`web/read.ts`) ships `{code, params}` on the wire and
 * lets the page render its own words, per `api.ts`'s header on that rule.
 */
function describeViolation(violation: RosterViolation): string {
  const agent = violation.params?.['agent']
  const track = violation.params?.['track']
  switch (violation.code) {
    case 'roster.cycle':
      return `roster is for cycle ${violation.params?.['given']} but state is at cycle ${violation.params?.['actual']}`
    case 'roster.required':
      return `"${agent}" is required by track "${track}" and cannot be dropped`
    case 'roster.forced':
      return `"${agent}" is configured as specialists.${agent}=always and cannot be dropped`
    case 'roster.forbidden':
      return `"${agent}" is configured as specialists.${agent}=never and cannot be drafted`
    case 'roster.closing':
      return (
        `"${agent}" is a closing agent on track "${track}" and runs after the run passes — ` +
        'drafting it into a working cycle is what `closing` exists to prevent'
      )
    case 'roster.unknown':
      return `"${agent}" is not in track "${track}" — add it to required or available first`
    case 'roster.contradiction':
      return `"${agent}" is both drafted and skipped — a roster must say one or the other`
    case 'roster.unexplained':
      return `"${agent}" was omitted without a reason — add it to skipped`
    case 'roster.quality':
      return `"${agent}" is required by the pinned quality plan's dispatch schedule and cannot be dropped`
  }
}

export class RosterViolationError extends Error {
  constructor(violations: (string | RosterViolation)[]) {
    super(`roster rejected:\n${violations.map((v) => `- ${typeof v === 'string' ? v : describeViolation(v)}`).join('\n')}`)
    this.name = 'RosterViolationError'
  }
}

/**
 * A closing roster arrived against a run that has not passed.
 *
 * Its own error rather than `NoActiveRunError`: a run that is still `running`
 * *is* active, and telling a leader that declared the closing pass one step
 * early to start a run would send it to the wrong remedy. The refusal itself is
 * load-bearing — a closing agent dispatched before the code has settled
 * documents a state of the code the next cycle replaces, which is the whole
 * defect the `closing` set exists to remove.
 */
export class RunNotClosedError extends Error {
  constructor(status: string) {
    super(
      `a closing roster records the pass that ended the run, and this run is "${status}" — ` +
        'declare it after mjloop_cycle_advance returns "pass", which is the call that reports the closing set.',
    )
    this.name = 'RunNotClosedError'
  }
}

/**
 * The roster for the run's closing pass: which of the track's closing agents
 * were dispatched once the run had passed, and why each of the others was not.
 *
 * It lives here rather than beside `RosterSchema` in `schemas/contract.ts`
 * because nothing else parses it strictly — `readRunHistory` reads
 * `closing/roster.json` through its own deliberately lenient field schema, and
 * `writeHandoff` reads cycle rosters only. This is the file that writes it.
 *
 * Two differences from `RosterSchema`, both deliberate:
 *
 * - **No `cycle`.** The closing pass belongs to no cycle, which is the point of
 *   the set; `RosterSchema` is a `strictObject` that requires one.
 * - **`selected` may be empty.** A run may legitimately close with every
 *   closing agent skipped, and recording *that* decision with its stated reason
 *   is the artefact this whole path exists to produce. Requiring at least one
 *   name would leave the only case worth writing down unwritable.
 */
export const ClosingRosterSchema = z.strictObject({
  /**
   * Which kind of roster this is. A literal rather than a boolean: `false`
   * carries no meaning here, and a caller that passes it is answering a
   * question this function does not ask — better a loud parse failure than a
   * cycle roster silently validated against the wrong set of agents.
   */
  closing: z.literal(true),
  selected: z.array(z.string().min(1)).default([]),
  /** agent name -> why closing the run without it was safe */
  skipped: z.record(z.string().min(1), z.string().min(1)).default({}),
})

export type ClosingRoster = z.infer<typeof ClosingRosterSchema>

/** Either kind of roster: one cycle's composition, or the run's closing pass. */
export type RosterDeclaration = Roster | ClosingRoster

/**
 * Persist the leader's declared composition — of a working cycle, or of the
 * run's closing pass.
 *
 * This is the enforcement point for the system's hard invariant: the agents a
 * track marks `required` cannot be dropped, and every omission must carry a
 * stated reason. Which agents those are is the track's business, not the
 * engine's.
 *
 * The two kinds are validated against different sets and written to different
 * directories, and neither can be mistaken for the other: a cycle roster is
 * checked against `available` and lands in `cycle-NN/`, a closing roster is
 * checked against `closing` and lands in `closing/`.
 *
 * Returns `waves` — the topological layers `dispatchWaves` computes over the
 * roster's own `selected`, so the leader is *told* the dispatch order rather
 * than left to re-derive it from `.mjloop/config.yaml` and its own reading of
 * `order`. A closing pass has no edges that can reach it — `TrackSchema`
 * refuses any `order` edge naming a closing agent, on either end — so its
 * `waves` is always one layer holding everything `selected` names; the field
 * is still returned, rather than only from the cycle branch, so a caller
 * does not need to know which kind of roster it declared to read the answer.
 */
export async function rosterSet(
  projectDir: string,
  roster: RosterDeclaration,
): Promise<{ path: string; waves: string[][]; quality_dispatches: PlannedQualityDispatch[] }> {
  return isClosingRoster(roster)
    ? closingRosterSet(projectDir, ClosingRosterSchema.parse(roster))
    : cycleRosterSet(projectDir, RosterSchema.parse(roster))
}

function isClosingRoster(roster: RosterDeclaration): roster is ClosingRoster {
  return 'closing' in roster && roster.closing === true
}

/**
 * Whether a candidate composition — which agents are drafted, and the stated
 * reason for each one left out — would be accepted for a track.
 *
 * Pure and stateless: `track` carries its own gate as `track.gate` (the "gate
 * state" this function needs travels in with it — there is no separate
 * parameter for it), `config` is where `forcedSpecialists`/
 * `forbiddenSpecialists` read `specialists.*` from, and `selected`/`skipped`
 * are the candidate itself. Nothing here opens a file, which is what lets
 * `rosterValidity` below call it from a read that must write nothing
 * (`tests/web/read.test.ts` hashes every file under `.mjloop/` around every
 * reader) while `cycleRosterSet` calls the exact same rules right before it
 * persists something.
 *
 * This is `cycleRosterSet`'s own rule set, unchanged, minus the one rule that
 * is not a fact about the composition at all: whether the declaration names
 * the cycle a run is actually on. That check stays in `cycleRosterSet`, which
 * is the only caller with a running cycle to compare against.
 */
export function rosterViolations(
  trackName: string,
  track: Track,
  config: Config,
  selected: Iterable<string>,
  skipped: Record<string, string>,
): RosterViolation[] {
  const forced = forcedSpecialists(config)
  const forbidden = new Set(forbiddenSpecialists(config))
  const permitted = permittedAgents(config, track)
  const closing = new Set(track.closing)
  // Kept as the array it arrived as for the loop below, which walks it once
  // per entry the way `cycleRosterSet` always did — a duplicate name in
  // `selected` produced one violation per occurrence before this refactor, and
  // a `Set` here would silently start collapsing that to one.
  const selectedList = [...selected]
  const selectedSet = new Set(selectedList)

  const violations: RosterViolation[] = []

  for (const agent of track.required) {
    if (!selectedSet.has(agent)) {
      violations.push({ code: 'roster.required', params: { agent, track: trackName } })
    }
  }

  for (const agent of forced) {
    // `always` cannot force a closing agent into a cycle, or this track's every
    // possible roster would be unsatisfiable: the rule below refuses a closing
    // agent in `selected`, so the two demands would contradict each other and
    // the leader could compose nothing at all. `preflightEstimate` already
    // counts the track this way — it deletes closing agents from the per-cycle
    // set *after* adding the forced ones — so the exemption is what keeps the
    // estimate and the enforcement describing the same track. The force is not
    // discarded: `closingRosterSet` applies it where the agent actually runs.
    if (closing.has(agent)) continue
    if (!selectedSet.has(agent)) {
      violations.push({ code: 'roster.forced', params: { agent } })
    }
  }

  // The mirror of the forced rule above: `always` means it cannot be dropped,
  // `never` means it cannot be drafted. Before this the config accepted three
  // modes and enforced one, so a project asking for no security review got one
  // whenever the leader felt like drafting it.
  for (const agent of forbidden) {
    if (selectedSet.has(agent)) {
      violations.push({ code: 'roster.forbidden', params: { agent } })
    }
  }

  for (const agent of selectedList) {
    // Checked before `permitted`, which now contains the closing set — a
    // closing agent passes that test and would otherwise be drafted into a
    // working cycle with nothing to stop it. Documentation written against
    // cycle 2's code and rewritten in cycle 4 is the defect `closing` was added
    // to remove, and permitting it while recommending against it would leave
    // the defect in place under a recommendation.
    if (closing.has(agent)) {
      violations.push({ code: 'roster.closing', params: { agent, track: trackName } })
      continue
    }
    if (!permitted.has(agent)) {
      violations.push({ code: 'roster.unknown', params: { agent, track: trackName } })
    }
  }

  violations.push(
    ...Object.keys(skipped)
      .filter((agent) => selectedSet.has(agent))
      .map((agent) => ({ code: 'roster.contradiction' as const, params: { agent } })),
  )

  // Every optional agent is either drafted or explained. Silence is not an
  // answer — except where the config or the track has already answered.
  for (const agent of track.available) {
    // An agent configured `never` cannot be drafted, so demanding a per-cycle
    // reason for its absence would make the project restate a decision it has
    // already recorded.
    if (forbidden.has(agent)) continue
    // A track that lists one agent in both sets is saying two things about it;
    // `closing` is the stronger, because it is the one this function enforces
    // above. Without this line such an agent would be un-draftable *and* owe a
    // reason every cycle for not being drafted — and the reason it owes is
    // already recorded once, in `closing/roster.json`.
    if (closing.has(agent)) continue
    if (!selectedSet.has(agent) && skipped[agent] === undefined) {
      violations.push({ code: 'roster.unexplained', params: { agent } })
    }
  }

  return violations
}

export interface RosterValidity {
  valid: boolean
  violations: RosterViolation[]
}

/**
 * The read door: "would this composition be accepted for this track", with no
 * run required and nothing written.
 *
 * `web/read.ts`'s `readRosterValidity` is the only caller, from a route that
 * `web/writes.ts` and `tests/web/boundary.test.ts`'s `FORBIDDEN` list do not
 * touch — `rosterSet` itself stays refused there. This hands the browser an
 * answer to a question about a track, never a way to make the answer come
 * true: nothing here writes, and nothing here requires (or reads) a running
 * state.
 */
export async function rosterValidity(
  projectDir: string,
  input: { track: string; selected: readonly string[]; skipped: Record<string, string> },
): Promise<RosterValidity> {
  const { config, track } = await loadTrack(projectDir, input.track)
  const violations = rosterViolations(input.track, track, config, input.selected, input.skipped)
  return { valid: violations.length === 0, violations }
}

/** One working cycle's composition, written to `cycle-NN/roster.json`. */
async function cycleRosterSet(
  projectDir: string,
  parsed: Roster,
): Promise<{ path: string; waves: string[][]; quality_dispatches: PlannedQualityDispatch[] }> {
  const state = await new StateStore(projectDir).get()
  if (state.status !== 'running' || state.track === null) throw new NoActiveRunError()

  const { config, track } = await loadTrack(projectDir, state.track)

  // Planned regardless of whether enforcement is live: `qualityRuntimeEnabled`
  // stays closed until Task 17, so today this is counterfactual data only —
  // what the pinned mode *would* dispatch — never a change to which roster is
  // accepted. `ensureRunQualityPolicy`, not a bare `readPolicy`: a run that
  // reached `running` before this feature — or one that never touched config
  // through the guarded write `ensureRunQualityPolicy`'s only other caller
  // sits behind — has no `quality-policy.json` on disk yet, and a bare read
  // would turn that legitimate absence into `StateCorruptedError` on every
  // roster call the run makes. `ensureRunQualityPolicy` recovers exactly that
  // case (`classifyPolicyIntegrity`'s `legacy-bootstrap`), pinning a shadow
  // policy from the run's live config — the correct answer for a run that
  // never opted in, not a corruption.
  const policy = await ensureRunQualityPolicy(projectDir)
  const evidence = await resolveQualityContextEvidence(projectDir, { story: state.current.story, allowMissingStory: true })
  const qualityDispatches = planQualityDispatches({
    trackName: state.track,
    track,
    config,
    policy,
    goal: state.goal ?? '',
    ...evidence,
  })

  const violations: (string | RosterViolation)[] = []

  if (parsed.cycle !== state.cycle) {
    // Not one of `rosterViolations`'s rules: it is a fact about *when* this
    // declaration arrived, not about whether this track would accept this
    // composition, and it needs a running cycle to compare against — exactly
    // what the read door above does not have and does not ask for.
    violations.push({
      code: 'roster.cycle',
      // Strings, not numbers: `lib/i18n.js:129` says a cycle number must never
      // reach `renderParam`, which runs a JS `number` through
      // `Intl.NumberFormat` and would render Arabic-Indic digits. This code
      // never reaches the browser today — `rosterSet` is on `FORBIDDEN` — but
      // it is built the same disciplined way the ones that do are.
      params: { given: String(parsed.cycle), actual: String(state.cycle) },
    })
  }

  violations.push(...rosterViolations(state.track, track, config, parsed.selected, parsed.skipped))

  // The one behaviour change this task is allowed to make, and only under two
  // conditions at once: the release gate is open (a test may inject this; it
  // is `false` in production until Task 17) and this run's own pinned policy
  // opted in (`enforcement === 'active'`, which requires an explicit quality
  // mode — a shadow policy enforces nothing, same as the gate being closed).
  if (qualityRuntimeEnabled() && policy.enforcement === 'active') {
    violations.push(...qualityRosterViolations(qualityDispatches, parsed.selected))
  }

  if (violations.length > 0) throw new RosterViolationError(violations)

  // Reserved before the roster is written, never after: a suspension must leave
  // no artefact behind for the action it refused, and this is the last point at
  // which nothing about this cycle exists yet. The rollout gate and the run's
  // own pinned intent are checked inside, so a shadow run reserves nothing and
  // reads nothing.
  await reserveQualityDispatches(projectDir, state, qualityDispatches)

  // Per cycle, alongside that cycle's agent results: a roster is validated
  // against `state.cycle`, so one file per run would leave a multi-cycle run
  // holding only its last composition — and the stated reason for each
  // omission, which is the whole product of the invariant, is not recoverable
  // from anywhere else.
  const { path: file } = await write(path.join(cycleDirPath(projectDir, state), 'roster.json'), parsed)
  return { path: file, waves: dispatchWaves(track, parsed.selected), quality_dispatches: qualityDispatches }
}

/**
 * The run's closing pass, written to `closing/roster.json`.
 *
 * This exists because moving an agent from `available` to `closing` removes it
 * from the "drafted or explained" demand above, and the stated reason written
 * into `cycle-NN/roster.json` was the only durable record that a run decided to
 * ship without it. Dropping that record with no substitute would let a run pass
 * and ship with its documentation silently never regenerated, and nothing
 * anywhere saying so.
 *
 * `never` is not checked here: `ConfigSchema` refuses a document that forbids
 * an agent its own track closes with, so the combination cannot reach this
 * function.
 */
async function closingRosterSet(
  projectDir: string,
  parsed: ClosingRoster,
): Promise<{ path: string; waves: string[][]; quality_dispatches: PlannedQualityDispatch[] }> {
  const state = await new StateStore(projectDir).get()
  // `done`, not `running`. This is also what keeps a late closing roster out of
  // a run that replaced this one — the hazard §12 gives `runLog` a `run_id`
  // for: a replacement run is `running` while it works, so the write is refused
  // rather than misfiled. `runLog` needs more than this because its window
  // spans a closing agent's whole working time; this call is made before any
  // closing agent is dispatched, so the window is one read and one write.
  if (state.status !== 'done' || state.track === null) throw new RunNotClosedError(state.status)

  const { config, track } = await loadTrack(projectDir, state.track)

  const forced = new Set(forcedSpecialists(config))
  const closing = new Set(track.closing)
  const selected = new Set(parsed.selected)

  const violations: string[] = []

  if (closing.size === 0) {
    // Not merely pointless: `readRunHistory` reports a `closing/` directory as
    // a cycle record numbered 0, so an empty roster written here would give
    // every later report a closing pass this run never had.
    violations.push(
      `track "${state.track}" declares no closing agents — there is no closing pass to record. ` +
        'Move the agent to `closing` under this track first, or log it inside a cycle',
    )
  }

  for (const agent of parsed.selected) {
    if (!closing.has(agent)) {
      violations.push(
        `"${agent}" does not close track "${state.track}" — a closing roster draws only from that track's ` +
          `closing set (this one closes with: ${track.closing.join(', ') || 'nothing'})`,
      )
    }
  }

  violations.push(...contradictions(selected, parsed.skipped))

  for (const agent of track.closing) {
    if (selected.has(agent)) continue
    // Where `always` lands for a closing agent, the cycle path having exempted
    // it. Without this the setting would be inert on exactly the agents a
    // project is most likely to mark it on, and a config that says "always run
    // docs" would be obeyed nowhere and reported nowhere.
    if (forced.has(agent)) {
      violations.push(
        `"${agent}" is configured as specialists.${agent}=always and cannot be dropped from the closing pass`,
      )
      continue
    }
    if (parsed.skipped[agent] === undefined) {
      violations.push(`"${agent}" closes this track and was not dispatched — add it to skipped with a reason`)
    }
  }

  if (violations.length > 0) throw new RosterViolationError(violations)

  // Beside the closing agents' own results and outside every `cycle-NN/`, which
  // is what keeps a pass that is already recorded out of the readers that walk
  // cycles: `readRunDetail` filters `/^cycle-\d+$/`, and `writeHandoff` reads
  // one cycle directory. The `closing: true` marker is written rather than
  // stripped, so the file says which kind of roster it is to a person reading
  // it and to the strict `RosterSchema`, which will refuse it if it ever
  // reaches a cycle reader by mistake.
  const { path: file } = await write(path.join(runDirPath(projectDir, state), 'closing', 'roster.json'), parsed)
  // Closing agents document a run that already ended; they carry no quality
  // dispatch of their own, so the counterfactual plan is always empty here.
  return { path: file, waves: dispatchWaves(track, parsed.selected), quality_dispatches: [] }
}

/**
 * An agent cannot both have run and have been safely left out. Without this the
 * "explain every omission" invariant is satisfiable by one boilerplate reason
 * per known agent, whatever the leader actually dispatched, and the persisted
 * roster — the only record of either fact — contradicts itself about both.
 *
 * `closingRosterSet`'s own rule, now: a cycle roster makes the same claim
 * through `rosterViolations`'s own contradiction check above, in `{code,
 * params}` rather than a string, so it can be returned to a read as well as
 * thrown from a write. The closing pass has no read door to share it with —
 * `rosterValidity` above takes a track, not "which pass" — so this one string
 * form is left as it was rather than split for a caller that does not exist.
 */
function contradictions(selected: Set<string>, skipped: Record<string, string>): string[] {
  return Object.keys(skipped)
    .filter((agent) => selected.has(agent))
    .map((agent) => `"${agent}" is both drafted and skipped — a roster must say one or the other`)
}

/**
 * The track this run is on. Fails closed on a track that has gone missing from
 * config, as `runLog` and `cycleAdvance` do: a roster validated against no
 * track at all is a roster that enforces nothing.
 */
async function loadTrack(projectDir: string, name: string): Promise<{ config: Config; track: Track }> {
  const config = await loadConfig(projectDir)
  const track = findTrack(config, name)
  if (track === undefined) throw new UnknownTrackError(name, Object.keys(config.tracks))
  return { config, track }
}

async function write(file: string, roster: Roster | ClosingRoster): Promise<{ path: string }> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(roster, null, 2)}\n`, 'utf8')
  return { path: file }
}
