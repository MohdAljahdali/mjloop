import fs from 'node:fs/promises'
import path from 'node:path'
import { findTrack } from '../schemas/config.js'
import type { Finding, Result, State } from '../schemas/state.js'
import { loadConfig } from '../store/config-store.js'
import { resolveLoopPaths } from '../store/paths.js'
import { readStory } from '../store/plan-store.js'
import { StateStore, type Clock } from '../store/state-store.js'
import { cycleFingerprint, errorFingerprint } from './fingerprint.js'

export class UnknownTrackError extends Error {
  constructor(track: string, known: string[]) {
    super(`unknown track "${track}" — config defines: ${known.join(', ')}`)
    this.name = 'UnknownTrackError'
  }
}

export class NoActiveRunError extends Error {
  constructor() {
    super('no active run — call mjloop_run_start first')
    this.name = 'NoActiveRunError'
  }
}

/** `<run_id>--<story|adhoc>--<track>` — traceable from the directory name alone. */
export function runDirName(state: State): string {
  if (state.run_id === null || state.track === null) throw new NoActiveRunError()
  return `${state.run_id}--${state.current.story ?? 'adhoc'}--${state.track}`
}

export function runDirPath(projectDir: string, state: State): string {
  return path.join(resolveLoopPaths(projectDir).runs, runDirName(state))
}

/**
 * Everything a cycle produces — agent results, the roster, the findings
 * archive — lives in one directory, named from a single place so the writers
 * cannot drift apart on the padding.
 */
export function cycleDirPath(projectDir: string, state: State, cycle: number = state.cycle): string {
  return path.join(runDirPath(projectDir, state), `cycle-${String(cycle).padStart(2, '0')}`)
}

export interface RunStartInput {
  track: string
  goal: string
  story?: string | null
  plan?: string | null
}

export async function runStart(projectDir: string, input: RunStartInput, now: Clock = () => new Date()): Promise<State> {
  const config = await loadConfig(projectDir)
  if (findTrack(config, input.track) === undefined) {
    throw new UnknownTrackError(input.track, Object.keys(config.tracks))
  }

  // A run named after a story that does not exist would produce a run
  // directory traceable to nothing. readStory throws StoryNotFoundError.
  if (input.story !== undefined && input.story !== null) await readStory(projectDir, input.story)

  const state = await new StateStore(projectDir, now).update(async (draft) => {
    // Computed inside the locked update so two overlapping runStart calls
    // cannot observe the same sequence number. The previous run's id (still
    // on the draft at this point) covers the window where that run's
    // directory has not been created yet.
    draft.run_id = await nextRunId(projectDir, now(), draft.run_id)
    draft.track = input.track
    draft.status = 'running'
    draft.cycle = 1
    draft.goal = input.goal
    draft.current = {
      plan: input.plan ?? null,
      story: input.story ?? null,
      stage: 'compose',
    }
    draft.findings = []
    draft.history = []
    // The counter and the fingerprint it counts against are one piece of
    // state. Keeping the previous run's fingerprint would arm this run's first
    // cycle for an immediate strike — and `cycleFingerprint([], 'fail')` is a
    // constant, so any run whose last cycle closed with no findings would do
    // it to the next run whatever the two were about.
    draft.no_progress_count = 0
    draft.last_fingerprint = null
    // The repeated-error guard's state resets for the same reason, and needs
    // saying separately because `cycleAdvance` returns early on both a halt and
    // a pass: the previous run's signatures and fingerprint are still on the
    // draft here. Keeping either arms this run's *first* cycle — the error
    // guard halts on one repeat where stagnation waits for two — so a narrowed
    // goal would halt after a single cycle on a command this run never ran.
    draft.cycle_errors = []
    draft.last_error_fingerprint = null
    // A new run has proven nothing. Carrying a previous run's reproduction
    // would open this run's gate for a defect nobody demonstrated here.
    draft.reproduction = null
    draft.halt_reason = null
  })

  await fs.mkdir(runDirPath(projectDir, state), { recursive: true })
  return state
}

/**
 * Why a run stopped. `manual` covers `/mjloop:stop` — a person deciding, which
 * needs no diagnosis. The other three are guards, and each calls for a
 * different next step from whoever reads HALT.md.
 */
export type HaltCause = 'cycle-cap' | 'stagnation' | 'repeated-error' | 'manual'

export interface CycleAdvanceInput {
  agents: string[]
  result: Result
}

export interface CycleAdvanceResult {
  state: State
  /**
   * The closed cycle's findings. On a fail these are the next cycle's task
   * list. On a pass they are informational — the leader's pass rule forbids an
   * open high-severity finding, but a medium or low one may survive a passing
   * cycle and there is no next cycle to carry it to.
   */
  carried_findings: Finding[]
  /** `null` on a pass: the run is over, so no fingerprint is recorded. */
  fingerprint: string | null
  /** `state.no_progress_count` after this cycle. */
  strikes: number
}

/**
 * Close the current cycle. `pass` finishes the run; anything else opens the
 * next cycle unless the track's cap is reached, in which case the run halts.
 */
export async function cycleAdvance(
  projectDir: string,
  input: CycleAdvanceInput,
  now: Clock = () => new Date(),
): Promise<CycleAdvanceResult> {
  const store = new StateStore(projectDir, now)
  const config = await loadConfig(projectDir)

  // Captured inside the locked callback so the archive written afterwards
  // describes exactly the findings the state transition consumed.
  let carried: Finding[] = []
  let closedCycle = 0
  let fingerprint: string | null = null
  // Which guard ended the run, carried out of the update as a value rather
  // than re-derived from `halt_reason`: HALT.md recommends a different next
  // step per guard, and parsing the sentence back apart would couple the
  // report to the wording.
  let cause: HaltCause = 'manual'

  // Status and cap are evaluated against the draft inside the locked update,
  // not a pre-lock snapshot: two racing advances (or an advance racing a
  // halt) must each judge the state the other one left behind, or a run can
  // step past its cycle cap.
  const after = await store.update((draft) => {
    if (draft.status !== 'running' || draft.track === null) throw new NoActiveRunError()
    const track = findTrack(config, draft.track)
    if (track === undefined) throw new UnknownTrackError(draft.track, Object.keys(config.tracks))

    carried = [...draft.findings]
    // Sorted because `runLog` appends each agent's signatures as that agent
    // finishes, and agents are dispatched concurrently. `errorFingerprint`
    // sorts before hashing, so without this the halt *reason* — which names
    // `errors[0]` — would blame whichever agent happened to land first and
    // differ between two identical runs.
    const errors = [...draft.cycle_errors].sort()
    closedCycle = draft.cycle

    const ref = path.join('.mjloop', 'runs', runDirName(draft))
    draft.history.push({ cycle: draft.cycle, agents: input.agents, result: input.result, ref })

    if (input.result === 'pass') {
      draft.status = 'done'
      draft.current.stage = 'done'
      return
    }

    // Checked before stagnation because it fires a cycle earlier and names a
    // more specific cause. An identical command failing identically is
    // stronger evidence than identical findings, so one repeat is enough
    // where stagnation waits for two strikes.
    if (errors.length > 0) {
      const currentErrors = errorFingerprint(errors)
      const repeated = currentErrors === draft.last_error_fingerprint
      draft.last_error_fingerprint = currentErrors
      if (repeated) {
        draft.status = 'halted'
        draft.current.stage = 'halted'
        draft.halt_reason = `the same verification failure recurred: ${refOf(errors[0] ?? '')}`
        cause = 'repeated-error'
        return
      }
    }

    // Computed from the findings this cycle closed with, captured above
    // before they were cleared.
    fingerprint = cycleFingerprint(carried, input.result)
    draft.no_progress_count = fingerprint === draft.last_fingerprint ? draft.no_progress_count + 1 : 0
    draft.last_fingerprint = fingerprint

    // Stagnation is checked before the cap because halting earlier is its
    // entire purpose. The two reasons stay distinct: "the loop is stuck" and
    // "the loop ran out of budget" call for different responses from whoever
    // reads HALT.md.
    if (draft.no_progress_count >= config.limits.no_progress_strikes) {
      draft.status = 'halted'
      draft.current.stage = 'halted'
      draft.halt_reason = `no progress for ${draft.no_progress_count} consecutive cycles on track ${draft.track}`
      cause = 'stagnation'
      return
    }
    if (draft.cycle >= track.max_cycles) {
      draft.status = 'halted'
      draft.current.stage = 'halted'
      draft.halt_reason = `cycle cap ${track.max_cycles} reached for track ${draft.track}`
      cause = 'cycle-cap'
      return
    }

    // Findings describe one cycle's remaining work, so the cycle opening here
    // starts with an empty list: that keeps state bounded across a long run
    // and keeps the next fingerprint meaningful, and the caller gets the list
    // back to fold into the next brief. A run that ended above keeps them
    // instead — they are the work it ended with, and the summary and HALT.md
    // have nothing else to report it from.
    draft.findings = []
    draft.cycle_errors = []
    draft.cycle += 1
    draft.current.stage = 'compose'
  })

  await archiveFindings(projectDir, after, closedCycle, carried)
  // The report names the findings the halted cycle closed with — state no
  // longer holds them, so they are passed in explicitly.
  if (after.status === 'halted') await writeHaltReport(projectDir, after, cause, carried)

  return { state: after, carried_findings: carried, fingerprint, strikes: after.no_progress_count }
}

/** The command from a `<ref> :: <headline>` signature. */
function refOf(signature: string): string {
  return signature.split(' :: ')[0] ?? signature
}

/**
 * A convenience aggregate over the `cycle-NN/<agent>.json` files `runLog` has
 * already written — not a second source of truth. Losing it to an interruption
 * costs nothing: every finding is still in the per-agent files — and `findings`
 * is a reserved agent name, so this write can never land on one of them.
 */
async function archiveFindings(
  projectDir: string,
  state: State,
  cycle: number,
  findings: Finding[],
): Promise<void> {
  const dir = cycleDirPath(projectDir, state, cycle)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'findings.json'), `${JSON.stringify(findings, null, 2)}\n`, 'utf8')
}

export async function halt(projectDir: string, reason: string, now: Clock = () => new Date()): Promise<State> {
  const store = new StateStore(projectDir, now)
  const state = await store.update((draft) => {
    // Guarded inside the locked update: with no run to halt, the mutation
    // must never land — writeHaltReport would fail right after it and leave
    // a "halted" state for a run that never existed.
    if (draft.run_id === null || draft.track === null) throw new NoActiveRunError()
    draft.status = 'halted'
    draft.current.stage = 'halted'
    draft.halt_reason = reason
  })
  await writeHaltReport(projectDir, state, 'manual')
  return state
}

async function nextRunId(projectDir: string, now: Date, previousRunId: string | null): Promise<string> {
  const date = now.toISOString().slice(0, 10)
  const runsDir = resolveLoopPaths(projectDir).runs
  let entries: string[] = []
  try {
    entries = await fs.readdir(runsDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  // The previous run's id counts alongside the directory scan: its directory
  // is created only after the state write, so a concurrent (or crashed)
  // start may not have produced one yet.
  const fromDirs = entries.map((entry) => new RegExp(`^${date}-(\\d{3})--`).exec(entry)?.[1])
  const fromState = new RegExp(`^${date}-(\\d{3})$`).exec(previousRunId ?? '')?.[1]
  const used = [...fromDirs, fromState]
    .filter((seq): seq is string => seq !== undefined)
    .map(Number)
  const next = used.length === 0 ? 1 : Math.max(...used) + 1
  return `${date}-${String(next).padStart(3, '0')}`
}

/**
 * What to do next, per guard. Only the cap is a budget, so only the cap is
 * answered by widening one: the stagnation and repeated-error guards fire
 * before the cap is consulted, and a reader who edits `max_cycles` on their
 * advice halts again at exactly the same place. The leader skill forbids
 * raising a cap to get past a halt, so a report that recommended it for every
 * reason would put the leader in the position of relaying advice it is banned
 * from giving.
 */
const NEXT_STEP: Record<HaltCause, string> = {
  'cycle-cap': `The run used every cycle the track allows. Narrow the goal so it fits and start a
new run — or, if the work really is that large, widen the track's \`max_cycles\` in
\`.mjloop/config.yaml\` first. That second one is the user's call, not the loop's.`,
  stagnation: `The same work was still outstanding cycle after cycle, so more cycles would not
have helped and widening \`max_cycles\` will not change the outcome. Narrow the
goal to the finding that would not move, or fix it by hand and start a new run.`,
  'repeated-error': `One command failed the same way twice running, so the loop was not making
progress against it and widening \`max_cycles\` will not change the outcome. Run
the command named in the reason yourself, fix what it reports, then start a new
run.`,
  manual: `The run was stopped by hand. Start a new one when the work is ready to continue.`,
}

async function writeHaltReport(
  projectDir: string,
  state: State,
  cause: HaltCause,
  open: Finding[] = state.findings,
): Promise<void> {
  const dir = runDirPath(projectDir, state)
  await fs.mkdir(dir, { recursive: true })

  const cycles = state.history
    .map((entry) => `| ${entry.cycle} | ${entry.agents.join(', ')} | ${entry.result} |`)
    .join('\n')
  const findings = open.length === 0
    ? '_none recorded_'
    : open.map((f) => `- **${f.severity}** ${f.file}:${f.line} — ${f.claim}`).join('\n')

  const report = `# Halt report — ${state.run_id}

**Track:** ${state.track}
**Goal:** ${state.goal ?? '_not set_'}
**Reason:** ${state.halt_reason ?? '_not set_'}
**Halted at cycle:** ${state.cycle}

## Cycles

| Cycle | Agents | Result |
|---|---|---|
${cycles || '| — | — | — |'}

## Open findings

${findings}

## Next step

Review the per-agent output in this directory.

${NEXT_STEP[cause]}
`
  await fs.writeFile(path.join(dir, 'HALT.md'), report, 'utf8')
}
