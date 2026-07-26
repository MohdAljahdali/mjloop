import fs from 'node:fs/promises'
import path from 'node:path'
import { findTrack } from '../schemas/config.js'
import type { Finding, Result, State } from '../schemas/state.js'
import { loadConfig } from '../store/config-store.js'
import { resolveLoopPaths } from '../store/paths.js'
import { readStory } from '../store/plan-store.js'
import { StateStore, type Clock } from '../store/state-store.js'
import { cycleFingerprint } from './fingerprint.js'

export class UnknownTrackError extends Error {
  constructor(track: string, known: string[]) {
    super(`unknown track "${track}" — config defines: ${known.join(', ')}`)
    this.name = 'UnknownTrackError'
  }
}

export class NoActiveRunError extends Error {
  constructor() {
    super('no active run — call loop_run_start first')
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
    // A new run has proven nothing. Carrying a previous run's reproduction
    // would open this run's gate for a defect nobody demonstrated here.
    draft.reproduction = null
    draft.halt_reason = null
  })

  await fs.mkdir(runDirPath(projectDir, state), { recursive: true })
  return state
}

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

  // Status and cap are evaluated against the draft inside the locked update,
  // not a pre-lock snapshot: two racing advances (or an advance racing a
  // halt) must each judge the state the other one left behind, or a run can
  // step past its cycle cap.
  const after = await store.update((draft) => {
    if (draft.status !== 'running' || draft.track === null) throw new NoActiveRunError()
    const track = findTrack(config, draft.track)
    if (track === undefined) throw new UnknownTrackError(draft.track, Object.keys(config.tracks))

    carried = [...draft.findings]
    closedCycle = draft.cycle

    const ref = path.join('.loop', 'runs', runDirName(draft))
    draft.history.push({ cycle: draft.cycle, agents: input.agents, result: input.result, ref })

    if (input.result === 'pass') {
      draft.status = 'done'
      draft.current.stage = 'done'
      return
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
      return
    }
    if (draft.cycle >= track.max_cycles) {
      draft.status = 'halted'
      draft.current.stage = 'halted'
      draft.halt_reason = `cycle cap ${track.max_cycles} reached for track ${draft.track}`
      return
    }

    // Findings describe one cycle's remaining work, so the cycle opening here
    // starts with an empty list: that keeps state bounded across a long run
    // and keeps the next fingerprint meaningful, and the caller gets the list
    // back to fold into the next brief. A run that ended above keeps them
    // instead — they are the work it ended with, and the summary and HALT.md
    // have nothing else to report it from.
    draft.findings = []
    draft.cycle += 1
    draft.current.stage = 'compose'
  })

  await archiveFindings(projectDir, after, closedCycle, carried)
  // The report names the findings the halted cycle closed with — state no
  // longer holds them, so they are passed in explicitly.
  if (after.status === 'halted') await writeHaltReport(projectDir, after, carried)

  return { state: after, carried_findings: carried, fingerprint, strikes: after.no_progress_count }
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
  await writeHaltReport(projectDir, state)
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

async function writeHaltReport(projectDir: string, state: State, open: Finding[] = state.findings): Promise<void> {
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

Review the per-agent output in this directory, then either widen the track's
\`max_cycles\` in \`.loop/config.yaml\` or narrow the goal and start a new run.
`
  await fs.writeFile(path.join(dir, 'HALT.md'), report, 'utf8')
}
