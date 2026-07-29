import fs from 'node:fs/promises'
import path from 'node:path'
import * as z from 'zod'
import { findTrack, forbiddenSpecialists, forcedSpecialists, permittedAgents, type Config, type Track } from '../schemas/config.js'
import { RosterSchema, type Roster } from '../schemas/contract.js'
import { loadConfig } from '../store/config-store.js'
import { StateStore } from '../store/state-store.js'
import { NoActiveRunError, UnknownTrackError, cycleDirPath, runDirPath } from './run.js'

export class RosterViolationError extends Error {
  constructor(violations: string[]) {
    super(`roster rejected:\n${violations.map((v) => `- ${v}`).join('\n')}`)
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
 */
export async function rosterSet(projectDir: string, roster: RosterDeclaration): Promise<{ path: string }> {
  return isClosingRoster(roster)
    ? closingRosterSet(projectDir, ClosingRosterSchema.parse(roster))
    : cycleRosterSet(projectDir, RosterSchema.parse(roster))
}

function isClosingRoster(roster: RosterDeclaration): roster is ClosingRoster {
  return 'closing' in roster && roster.closing === true
}

/** One working cycle's composition, written to `cycle-NN/roster.json`. */
async function cycleRosterSet(projectDir: string, parsed: Roster): Promise<{ path: string }> {
  const state = await new StateStore(projectDir).get()
  if (state.status !== 'running' || state.track === null) throw new NoActiveRunError()

  const { config, track } = await loadTrack(projectDir, state.track)

  const forced = forcedSpecialists(config)
  const forbidden = new Set(forbiddenSpecialists(config))
  const permitted = permittedAgents(config, track)
  const closing = new Set(track.closing)
  const selected = new Set(parsed.selected)

  const violations: string[] = []

  if (parsed.cycle !== state.cycle) {
    violations.push(`roster is for cycle ${parsed.cycle} but state is at cycle ${state.cycle}`)
  }

  for (const agent of track.required) {
    if (!selected.has(agent)) {
      violations.push(`"${agent}" is required by track "${state.track}" and cannot be dropped`)
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
    if (!selected.has(agent)) {
      violations.push(`"${agent}" is configured as specialists.${agent}=always and cannot be dropped`)
    }
  }

  // The mirror of the forced rule above: `always` means it cannot be dropped,
  // `never` means it cannot be drafted. Before this the config accepted three
  // modes and enforced one, so a project asking for no security review got one
  // whenever the leader felt like drafting it.
  for (const agent of forbidden) {
    if (selected.has(agent)) {
      violations.push(`"${agent}" is configured as specialists.${agent}=never and cannot be drafted`)
    }
  }

  for (const agent of parsed.selected) {
    // Checked before `permitted`, which now contains the closing set — a
    // closing agent passes that test and would otherwise be drafted into a
    // working cycle with nothing to stop it. Documentation written against
    // cycle 2's code and rewritten in cycle 4 is the defect `closing` was added
    // to remove, and permitting it while recommending against it would leave
    // the defect in place under a recommendation.
    if (closing.has(agent)) {
      violations.push(
        `"${agent}" is a closing agent on track "${state.track}" and runs after the run passes — ` +
          'drafting it into a working cycle is what `closing` exists to prevent',
      )
      continue
    }
    if (!permitted.has(agent)) {
      violations.push(`"${agent}" is not in track "${state.track}" — add it to required or available first`)
    }
  }

  violations.push(...contradictions(selected, parsed.skipped))

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
    if (!selected.has(agent) && parsed.skipped[agent] === undefined) {
      violations.push(`"${agent}" was omitted without a reason — add it to skipped`)
    }
  }

  if (violations.length > 0) throw new RosterViolationError(violations)

  // Per cycle, alongside that cycle's agent results: a roster is validated
  // against `state.cycle`, so one file per run would leave a multi-cycle run
  // holding only its last composition — and the stated reason for each
  // omission, which is the whole product of the invariant, is not recoverable
  // from anywhere else.
  return write(path.join(cycleDirPath(projectDir, state), 'roster.json'), parsed)
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
async function closingRosterSet(projectDir: string, parsed: ClosingRoster): Promise<{ path: string }> {
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
  return write(path.join(runDirPath(projectDir, state), 'closing', 'roster.json'), parsed)
}

/**
 * An agent cannot both have run and have been safely left out. Without this the
 * "explain every omission" invariant is satisfiable by one boilerplate reason
 * per known agent, whatever the leader actually dispatched, and the persisted
 * roster — the only record of either fact — contradicts itself about both.
 *
 * One rule for both kinds of roster, because it is one rule: a cycle roster and
 * a closing roster make the same two claims about an agent, a cycle apart.
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
