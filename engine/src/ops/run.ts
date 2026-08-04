import fs from 'node:fs/promises'
import path from 'node:path'
import * as z from 'zod'
import { findTrack, type Config } from '../schemas/config.js'
import { AgentResultSchema, RosterSchema, type AgentResult } from '../schemas/contract.js'
import { SKILL_ACCEPTANCE_AGENTS } from '../schemas/skill-acceptance.js'
import {
  SkillManifestSchema,
  type AcceptedProjectSkill,
  type SkillManifest,
  type SkillSelection,
} from '../schemas/skill-selection.js'
import type { Supervision } from '../schemas/quality.js'
import type { Finding, Result, Severity, State } from '../schemas/state.js'
import { LedgerSchema, PinnedVerifySchema, type LedgerEntry } from '../schemas/verify.js'
import { loadConfig, loadConfigRecord } from '../store/config-store.js'
import { readFeatureBrief } from '../store/feature-store.js'
import { resolveLoopPaths } from '../store/paths.js'
import { readStory } from '../store/plan-store.js'
import { expect as expectUnchanged } from '../store/precondition.js'
import { readAcceptedProfile } from '../store/project-profile-store.js'
import { StateStore, type Clock } from '../store/state-store.js'
import { cycleFingerprint, distinctFindings, errorFingerprint } from './fingerprint.js'
import { readAcceptedProjectSkills } from './skill-library.js'
import { analyseConcurrency, selectSkills } from './skill-selection.js'
import {
  QualityPolicyIntegrityError,
  buildProjectQualityPolicy,
  createInitialQualityLedger,
} from './quality-policy.js'
import { writeLedger, writePolicyOnce } from '../store/quality-store.js'

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
  return path.join(runDirPath(projectDir, state), cycleDirName(cycle))
}

/** The padding, in one place — `handoff.md` prints this name as well as joining it. */
function cycleDirName(cycle: number): string {
  return `cycle-${String(cycle).padStart(2, '0')}`
}

export interface RunStartInput {
  track: string
  goal: string
  supervision?: Supervision
  story?: string | null
  plan?: string | null
  /**
   * The feature this run's work routes against, for dynamic skill selection —
   * see `pinSkillManifest`. Absent by construction on every run that predates
   * this field, and on every run since that simply names none: nothing about
   * this story changes what a run that never mentions a feature does.
   */
  feature?: string | null
}

export async function runStart(projectDir: string, input: RunStartInput, now: Clock = () => new Date()): Promise<State> {
  // A run named after a story that does not exist would produce a run
  // directory traceable to nothing. readStory throws StoryNotFoundError.
  if (input.story !== undefined && input.story !== null) await readStory(projectDir, input.story)

  const initialization: { value: { config: Config; manifest: SkillManifest | null } | null } = { value: null }
  let integrityError: QualityPolicyIntegrityError | null = null
  const state = await new StateStore(projectDir, now).update(async (draft) => {
    // This is the authoritative run-boundary snapshot. It is read under the
    // same project lock that publishes the marker, so a config mutation either
    // completes before this read and is pinned, or waits until the complete
    // policy and ledger are visible. There is no third, stale interleaving.
    const { config, qualitySource } = await loadConfigRecord(projectDir)
    const track = findTrack(config, input.track)
    if (track === undefined) throw new UnknownTrackError(input.track, Object.keys(config.tracks))

    // Both resolutions are read-only and happen before the draft is changed.
    // A malformed feature/profile or invalid policy input therefore aborts the
    // StateStore transaction without publishing a half-started run.
    const manifest = await resolveSkillManifest(projectDir, config, input.feature, now)
    const qualityPolicy = await buildProjectQualityPolicy(projectDir, {
      config,
      qualitySource,
      track,
      goal: input.goal,
      story: input.story,
      feature: input.feature,
      supervision: input.supervision ?? 'supervised',
    }, now)
    initialization.value = { config, manifest }

    // Computed inside the locked update so two overlapping runStart calls
    // cannot observe the same sequence number. The previous run's id (still
    // on the draft at this point) covers the window where that run's
    // directory has not been created yet.
    draft.run_id = await nextRunId(projectDir, now(), draft.run_id)
    draft.track = input.track
    draft.status = 'running'
    draft.cycle = 1
    draft.goal = input.goal
    // Set here rather than by a second writer, in the update this function
    // already takes the lock for. It measures the run, and it is also the
    // marker that tells a run predating the verify pin (no pin was ever
    // written) from one whose pin was deleted — see `pinVerifyBlock`.
    draft.started_at = now().toISOString()
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
    // Marker-first by design: after this state lands, both protected records
    // are mandatory. A crash or write failure can therefore never downgrade
    // the run to live config; integrity classification halts it instead.
    draft.quality_policy_version = 1
    draft.halt_reason = null

    // Required run records are initialized before StateStore publishes the
    // marker. A guarded observer uses this same lock and therefore cannot see
    // marker=1 until both schema-valid files exist. mkdir belongs to the same
    // integrity boundary: failure must publish a halted marker, never running.
    try {
      await fs.mkdir(runDirPath(projectDir, draft), { recursive: true })
      await writePolicyOnce(projectDir, draft, qualityPolicy)
      await writeLedger(projectDir, draft, createInitialQualityLedger(qualityPolicy, now))
    } catch (error) {
      integrityError = new QualityPolicyIntegrityError(`new run could not write both records: ${errorMessage(error)}`)
      draft.status = 'halted'
      draft.current.stage = 'halted'
      draft.halt_reason = integrityError.message
    }
  })

  if (integrityError !== null) throw integrityError
  const initialized = initialization.value
  if (initialized === null) throw new Error('run initialization completed without an authoritative config snapshot')
  await pinVerifyBlock(projectDir, state, initialized.config, now)
  await writeSkillManifest(projectDir, state, initialized.manifest)
  return state
}

/**
 * The basename of the run's frozen verify block.
 *
 * Spelled out here rather than imported from the module that executes it:
 * `runStart` is the only writer and `verifyRun` the only reader, and about the
 * pin the two deliberately share no code but `PinnedVerifySchema` — `verifyRun`
 * imports `runDirPath` from here, which is where the pin lives, not what it
 * says. The word itself is
 * load-bearing elsewhere — it is in `PROTECTED_BASENAMES` (`store/paths.ts`),
 * which is the entire enforcement of the pin, since the `PreToolUse` guard
 * matches by basename anywhere under `.mjloop/`.
 */
const VERIFY_PIN_FILE = 'verify-pinned.json'

/**
 * Freeze what this run may execute, once, into its own directory.
 *
 * `config.yaml` is hand-editable by deliberate decision, so an agent holding
 * `Write` can rewrite a verify command — and the engine hands that string to a
 * shell. Pinning bounds the window to a run boundary, which is where an
 * operator already expects a configuration change to land. The whole block is
 * pinned rather than the three commands: `timeout_ms` of `1` kills every suite
 * the engine starts, and a failure pattern is a regular expression this engine
 * compiles and runs.
 *
 * `wx`, with `EEXIST` treated as success. `/mjloop:resume` continues an
 * existing run rather than calling `runStart`, so ordinarily nothing attempts a
 * second pin; the flag is what makes "ordinarily" something nobody has to
 * reason about. A resume that re-pinned would reopen the hole for anyone
 * willing to wait for an interruption.
 *
 * Nothing here reads the file back. The pin has one writer and one reader, and
 * a `runStart` that validated its own write would be validating against itself.
 */
async function pinVerifyBlock(projectDir: string, state: State, config: Config, now: Clock): Promise<void> {
  const pin = PinnedVerifySchema.parse({
    version: 1,
    pinned_at: now().toISOString(),
    verify: config.verify,
  })
  try {
    await fs.writeFile(path.join(runDirPath(projectDir, state), VERIFY_PIN_FILE), `${JSON.stringify(pin, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/**
 * The agent roles a run's pinned skill manifest routes for.
 *
 * Used to be locked to the fixed four — `agents/planner.md`, `builder.md`,
 * `critic.md`, `verifier.md` — on the theory that "dynamic skill selection for
 * fixed agent roles" was the whole shape of the story. It no longer is: this
 * mirrors `SKILL_ACCEPTANCE_AGENTS` in `schemas/skill-acceptance.ts:18-25`
 * exactly — whichever agents this project's own tracks name in `config.yaml`,
 * with the fixed four kept as the floor for a config that declares no tracks
 * at all — because a manifest pinning selections for a role no track ever
 * drafts would waste every one of them, and a project that has added an agent
 * to a track has already said dynamic skill selection should route to it too.
 * Computed from the `config` this function already loaded rather than a second
 * `loadConfig` call, the same config `skillSelectionAgents` is handed below.
 *
 * A given cycle's roster may dispatch fewer than this whole set; the manifest
 * still carries a selection for every one, because which agents a cycle
 * composes is decided fresh each cycle and this is decided once, at run
 * start, before any cycle exists to compose one.
 *
 * Exported so `tests/store/skill-acceptance-store.test.ts` can assert this
 * stays in step with the two other places that restate the identical rule —
 * `store/skill-acceptance-store.ts`'s `routableAgents` and
 * `web/app/lib/stories.ts`'s `routableAgentSet`.
 */
export function skillSelectionAgents(config: Config): string[] {
  const names = Object.values(config.tracks).flatMap((track) => [
    ...track.required,
    ...(track.available ?? []),
    ...(track.closing ?? []),
  ])
  return names.length === 0 ? [...SKILL_ACCEPTANCE_AGENTS] : [...new Set(names)]
}

/**
 * The basename of the run's frozen skill routing decision.
 *
 * Exactly `VERIFY_PIN_FILE`'s reasoning, and for the same underlying reason:
 * `selectSkills` and `analyseConcurrency` are pure functions of whatever the
 * accepted profile and the project's accepted skills say *right now*, and both
 * can move while a run is in flight — a later scan can add a profile revision,
 * and S06's shared library can gain or lose an acceptance. Pinning bounds that
 * to the run boundary, the same boundary `VERIFY_PIN_FILE` already holds a
 * `config.yaml` edit to. The word itself is the entire enforcement: it is in
 * `PROTECTED_BASENAMES` (`store/paths.ts`), which `evaluateStateGuard` matches
 * by basename anywhere under `.mjloop/`, for the identical reason stated there.
 *
 * Exported, unlike `VERIFY_PIN_FILE`, because this pin has a second reader that
 * is not this module: `runLog` joins an agent's `skills_used` against it, and
 * the name of the file the two agree on is the one thing that must not drift
 * between the writer and the check.
 */
export const SKILL_MANIFEST_FILE = 'skill-selection.json'

/**
 * Work out this run's skill routing — the whole manifest, validated — or
 * `null` when there is nothing to route.
 *
 * Split from the write below, and called *before* the `StateStore.update` that
 * opens the run, because everything that can go wrong here goes wrong on the
 * caller's own input. `readStory` sits in the same position for the same
 * reason: after the update there is no way to un-start a run, and a caller
 * that receives an exception reasonably believes none started.
 *
 * **This is the load-bearing case the story names explicitly: a run that pins
 * nothing behaves exactly as it did before this function existed.** That is
 * true of every run before this story, because none of them named a feature,
 * and it stays true of every run after it that still doesn't. Three things
 * all resolve to "pin nothing", and none of them throws:
 *
 *   - `feature` is absent — most runs, forever, since routing skills for one
 *     is an opt-in a caller has to ask for by naming it;
 *   - the named feature's latest revision is not `approved` — a draft is
 *     still being interviewed, or the last approved revision has already been
 *     superseded and its successor is not sealed yet, and `selectSkills`
 *     itself refuses to route off anything short of approved;
 *   - the project has accepted no component map at all, so there is nothing
 *     for `selectSkills`/`analyseConcurrency` to resolve a component id
 *     against.
 *
 * None of the three is treated as an error, unlike an unknown `story` above.
 * A story id becomes part of the run directory's name, so one that does not
 * exist would name a directory after nothing; a feature name has no
 * filesystem consequence here at all — it is only ever a join key selection
 * reads — and refusing to *start a run* over a feature still being discovered,
 * or a project that has not yet accepted a component map, would make dynamic
 * skill selection a stronger requirement than this story ever asks it to be.
 *
 * `acceptedSkills` comes from `readAcceptedProjectSkills` (`skill-library.js`),
 * S06's seam onto its own library and this project's acceptance records. A
 * project that has accepted nothing still gets `[]` back — no acceptance
 * store has ever been written, `listAcceptances` reads that as the ordinary
 * empty case rather than an error — and `selectSkills` already reads an empty
 * list as "nothing an agent may use" rather than as a case needing special
 * handling, which is exactly what keeps every run before this change, and
 * every run since that still accepts nothing, pinning the identical manifest
 * it always did. An acceptance whose package this machine's library does not
 * hold is skipped by that seam rather than failing this call; the skipped ids
 * are not threaded any further than this function today; a caller that needs
 * them reads `readAcceptedProjectSkills` directly.
 *
 * `UnresolvedComponentError` is deliberately left to propagate rather than
 * being folded into "pin nothing": it means the accepted profile has moved
 * *since* the very brief this run was asked to route against was approved —
 * the profile's own accepted-component invariant breaking, not merely an
 * absence of one — and an operator needs to see that rather than have this
 * run start anyway against a brief nothing on disk still supports.
 */
async function resolveSkillManifest(
  projectDir: string,
  config: Config,
  feature: string | null | undefined,
  now: Clock,
): Promise<SkillManifest | null> {
  if (feature === undefined || feature === null) return null

  const record = await readFeatureBrief(projectDir, feature)
  if (record === null || record.brief.status !== 'approved') return null

  const profile = await readAcceptedProfile(projectDir)
  if (profile === null) return null

  const { skills: acceptedSkills } = await readAcceptedProjectSkills(projectDir)
  const selections: SkillSelection[] = skillSelectionAgents(config).flatMap((agent) =>
    selectSkills({ brief: record.brief, profile, acceptedSkills, agent }),
  ).sort(compareSelections)

  return SkillManifestSchema.parse({
    schema: 1,
    generatedAt: now().toISOString(),
    sourceBrief: { id: record.brief.id, revision: record.brief.revision },
    profileRevision: profile.revision,
    selections,
    guidance: renderGuidance(selections, acceptedSkills),
    concurrency: analyseConcurrency(record.brief, profile, config.orchestration),
  })
}

/**
 * The bounded guidance text for every skill this manifest actually selected,
 * keyed by skill id.
 *
 * This is the half of the dispatch contract that makes the other half worth
 * carrying: a selection names an id, and an id on its own tells a receiving
 * agent nothing it can follow. Written once per skill rather than once per
 * selection because the same skill routinely lands on several (component,
 * agent) rows, and `guidance` is bounded at 4000 characters precisely so it
 * can be carried — repeating it per row would multiply that ceiling by the
 * number of rows for no reader's benefit.
 *
 * Only selected skills appear. A project that has accepted a hundred skills
 * still hands a run the few it routed, which is what keeps the pinned file's
 * size a function of the work rather than of the library.
 */
function renderGuidance(
  selections: readonly SkillSelection[],
  acceptedSkills: readonly AcceptedProjectSkill[],
): Record<string, string> {
  const selected = new Set(selections.flatMap((selection) => selection.skillIds))
  const guidance: Record<string, string> = {}
  for (const skill of acceptedSkills) {
    if (selected.has(skill.skillId)) guidance[skill.skillId] = skill.guidance
  }
  return guidance
}

/**
 * Write the resolved manifest into the run directory, once.
 *
 * `wx`, with `EEXIST` treated as success, exactly as `pinVerifyBlock` does and
 * for the identical reason: `/mjloop:resume` continues an existing run rather
 * than calling `runStart`, so ordinarily nothing attempts a second write, and
 * the flag is what makes "ordinarily" something nobody has to reason about. A
 * resume that re-pinned would let a library change reach a run already in
 * flight, which is the one thing pinning exists to prevent.
 */
async function writeSkillManifest(projectDir: string, state: State, manifest: SkillManifest | null): Promise<void> {
  if (manifest === null) return
  try {
    await fs.writeFile(
      path.join(runDirPath(projectDir, state), SKILL_MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/**
 * Component id, then agent — merging `skillSelectionAgents`' separate
 * `selectSkills` calls, one per routable agent, back into the one order the
 * manifest promises. Each call already returns its own selections sorted by
 * component, so this only has to break ties across agents for the same
 * component.
 */
function compareSelections(a: SkillSelection, b: SkillSelection): number {
  if (a.component !== b.component) return a.component < b.component ? -1 : 1
  return a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0
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
   * The closed cycle's findings, one entry per distinct piece of remaining
   * work. On a fail these are the next cycle's task list. On a pass they are
   * informational — the leader's pass rule forbids an open high-severity
   * finding, but a medium or low one may survive a passing cycle and there is
   * no next cycle to carry it to.
   *
   * Deduplicated here, once, before anything consumes it: the archive, the halt
   * report and the handoff all receive this list rather than `state.findings`,
   * so a defect two agents both reported is one task everywhere it is read.
   */
  carried_findings: Finding[]
  /** `null` on a pass: the run is over, so no fingerprint is recorded. */
  fingerprint: string | null
  /** `state.no_progress_count` after this cycle. */
  strikes: number
  /**
   * The repo-relative path of the cycle's handoff, and **`null` when the write
   * failed**. There is no path-shaped value for a document that was not
   * written, and this result is serialised straight to the leader, where an
   * empty string would read as a real path — the same thing `fingerprint`'s
   * `null` says about a cycle that produced none.
   */
  handoff: string | null
  /**
   * Agents to dispatch now that the run has passed. Empty on any other
   * outcome: a run that did not land its work has nothing to document, and
   * documenting it would describe a state of the code that no longer exists.
   */
  closing_agents: string[]
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
  // Hoisted for the same reason `cause` is: the handoff written after the lock
  // reports the failures this cycle closed with, and state has cleared them by
  // then on every branch that opens another cycle.
  let errors: string[] = []
  // Only a pass produces one, and only from the track's own data — the engine
  // does not know agent names.
  let closing: string[] = []
  // The cap for the handoff's "next: cycle N of M" line. Read from the track
  // inside the lock, where the track is already resolved.
  let maxCycles = 0
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

    carried = distinctFindings(draft.findings)
    // Sorted because `runLog` appends each agent's signatures as that agent
    // finishes, and agents are dispatched concurrently. `errorFingerprint`
    // sorts before hashing, so without this the halt *reason* — which names
    // `errors[0]` — would blame whichever agent happened to land first and
    // differ between two identical runs.
    errors = [...draft.cycle_errors].sort()
    closedCycle = draft.cycle
    maxCycles = track.max_cycles

    const ref = path.join('.mjloop', 'runs', runDirName(draft))
    // `at` is stamped from the injected clock inside this update, so a run can
    // be measured in minutes without a second writer or a second lock.
    draft.history.push({
      cycle: draft.cycle,
      agents: input.agents,
      result: input.result,
      ref,
      at: now().toISOString(),
    })

    if (input.result === 'pass') {
      draft.status = 'done'
      draft.current.stage = 'done'
      closing = [...track.closing]
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
  // Never fatal, and never inside the lock. The state transition has already
  // committed, so a failure here must not roll it back — losing the handoff
  // costs nothing, because every fact in it is still in the cycle's own files.
  // The failure is reported as `handoff: null` rather than as a thrown error,
  // and named on stderr so it is diagnosable rather than merely absent.
  let handoff: string | null = null
  try {
    handoff = await writeHandoff(projectDir, after, closedCycle, input.result, input.agents, carried, errors, maxCycles)
  } catch (error) {
    process.stderr.write(`mjloop: cycle ${closedCycle} handoff was not written: ${String(error)}\n`)
  }
  // The report names the findings the halted cycle closed with — state no
  // longer holds them, so they are passed in explicitly.
  if (after.status === 'halted') await writeHaltReport(projectDir, after, cause, carried)

  return {
    state: after,
    carried_findings: carried,
    fingerprint,
    strikes: after.no_progress_count,
    handoff,
    closing_agents: closing,
  }
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

/**
 * Every section has a ceiling, and every ceiling has a marker naming where the
 * rest is. Four of the six sections draw on fields with no schema ceiling —
 * `summary`, `files_touched`, `state.findings` and `cycle_errors` — and the
 * handoff is read by every agent of the next cycle, so an unbounded one is a
 * cost multiplied by the roster's width, every cycle, for the length of a run.
 * Nothing is discarded: each marker names the file that still holds it.
 */
const HANDOFF_MAX_BYTES = 6_000
const HANDOFF_SUMMARY_MAX = 200
const HANDOFF_FINDINGS_MAX = 20
const HANDOFF_FILES_MAX = 30
const HANDOFF_ERRORS_MAX = 10
/**
 * Same shape of ceiling as the four above, sized for the same reason: a
 * project routing many components through the four fixed roles produces one
 * line per matched skill, and this document is re-read by every agent of the
 * cycle that follows.
 */
const HANDOFF_SKILLS_MAX = 20

/** Highest severity first — the opposite of the alphabetical order `distinctFindings` leaves. */
const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 }

/** One `cycle-NN/<basename>.json`, with the agent its name resolves to. */
interface AgentReport {
  /** The file's basename: `builder`, or `hypothesis-tester--b` for an instance. */
  basename: string
  agent: string
  result: AgentResult
}

/**
 * What the closed cycle did, for the cycle that opens next.
 *
 * Every line is a projection of data the cycle already produced — no model
 * call, which is the point: a handoff generated by a model would cost a
 * dispatch per cycle to summarise summaries, and would be a fourth narrative to
 * keep honest.
 *
 * It carries only what the brief does not: the per-agent status table, the
 * roster's skip reasons, and the verify ledger. The brief carries a path to it.
 *
 * **Every source it reads is optional.** The roster, the agent results and the
 * verify ledger are each read with tolerance for absence and for a file that
 * will not parse, because `cycleAdvance` closes the cycle whatever happened in
 * it: a run must never fail to advance because a derived document could not be
 * assembled. A cycle where nothing landed gets a short handoff, not a crash.
 *
 * `cycle` is the cycle that closed, never `state.cycle` — the state has already
 * incremented by the time this is called, which is why `cycleDirPath` takes the
 * cycle explicitly. `maxCycles` comes in for the same reason, from the track
 * `cycleAdvance` resolved inside its lock: "next: cycle 4 of 5" needs the cap,
 * and re-reading config here would be a second load of a file the caller is
 * already holding.
 *
 * Written on every close, including a pass and a halt. On a pass it is the
 * run's closing record; on a halt it sits beside `HALT.md` and answers a
 * different question — `HALT.md` says why the run stopped and what to do next,
 * this says what the cycle did. Conflating them would make each worse.
 */
async function writeHandoff(
  projectDir: string,
  state: State,
  cycle: number,
  result: Result,
  agents: string[],
  carried: Finding[],
  errors: string[],
  maxCycles: number,
): Promise<string> {
  const dir = cycleDirPath(projectDir, state, cycle)
  const cycleRef = cycleDirName(cycle)

  const reports = await readAgentReports(dir)
  const roster = await readOptionalJson(path.join(dir, 'roster.json'), RosterSchema)
  const ledger = await readOptionalJson(path.join(dir, 'verify', 'index.json'), LedgerSchema)
  // Read from the *run* directory, not the cycle's: the manifest is pinned once
  // at `runStart` (`pinSkillManifest`) and is identical for every cycle of this
  // run, unlike everything else this function reads. Absent for the run that
  // named no feature, or named one this project had not yet accepted a
  // component map for — the ordinary case for every run today.
  const skills = await readOptionalJson(path.join(runDirPath(projectDir, state), SKILL_MANIFEST_FILE), SkillManifestSchema)

  const document = bound(
    [
      `# Handoff — cycle ${cycle} of ${state.run_id}`,
      '',
      resultLine(state, result, maxCycles),
      '',
      '## What each agent reported',
      '',
      ...agentTable(roster?.selected ?? agents, reports),
      ...skippedLines(roster?.skipped ?? {}),
      '',
      '## Files touched',
      '',
      ...filesSection(reports, cycleRef),
      '',
      '## Verification',
      '',
      ...verificationSection(ledger, cycle),
      '',
      '## Open findings',
      '',
      ...findingsSection(carried, cycleRef),
      '',
      '## Failures that could recur',
      '',
      ...errorsSection(errors),
      '',
      // No heading at all — not even an empty one — when this run pinned no
      // manifest. `writeHandoff` existed for every run before dynamic skill
      // selection did, and a run that still names no feature must render
      // byte-for-byte what it always has: an empty section a reader cannot
      // tell apart from "nothing was selected" is worse than no section.
      ...(skills === null ? [] : ['## Skills', '', ...skillsSection(skills), '']),
    ].join('\n'),
    cycleRef,
  )

  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'handoff.md'), document, 'utf8')
  return path.join('.mjloop', 'runs', runDirName(state), cycleRef, 'handoff.md')
}

function resultLine(state: State, result: Result, maxCycles: number): string {
  if (state.status === 'done') return `**Result:** ${result} — the run is done.`
  if (state.status === 'halted') return `**Result:** ${result} — halted: ${state.halt_reason ?? 'no reason recorded'}`
  return `**Result:** ${result} — next: cycle ${state.cycle} of ${maxCycles}`
}

/**
 * The rows are the **roster's** drafted list, not the results that landed, and
 * an agent with no result file is rendered `— no result recorded`.
 *
 * `runLog` only enters its locked update — and therefore only raises
 * `CycleClosedError` — when a result has findings, a gate proof or error
 * signatures. A `pass` carrying only `file` evidence writes its
 * `cycle-NN/<agent>.json` against the pre-read state, i.e. into a cycle that
 * has just closed. An agent landing a moment late would otherwise be absent
 * from the table with nothing saying so, and the next cycle would carry that
 * document as the record of what happened.
 *
 * A result whose agent the roster does not name is appended rather than
 * dropped, for the mirror-image reason: the roster is optional and `runLog`
 * does not check membership against it, so a row missing here is work nobody
 * can see.
 */
function agentTable(drafted: string[], reports: AgentReport[]): string[] {
  const rows: string[] = ['| Agent | Status | Summary |', '|---|---|---|']
  const shown = new Set<string>()
  for (const agent of drafted) {
    // One row per result file, so N instances of one agent are N rows rather
    // than one verdict standing in for N.
    const mine = reports.filter((report) => report.agent === agent)
    for (const report of mine) shown.add(report.basename)
    rows.push(...(mine.length === 0 ? [`| ${cell(agent)} | — | no result recorded |`] : mine.map(reportRow)))
  }
  rows.push(...reports.filter((report) => !shown.has(report.basename)).map(reportRow))
  return rows
}

function reportRow(report: AgentReport): string {
  const summary = cell(truncate(report.result.summary, HANDOFF_SUMMARY_MAX))
  return `| ${cell(report.basename)} | ${report.result.status} | ${summary} |`
}

/** The stated reason for each omission — the whole product of `rosterSet`'s invariant. */
function skippedLines(skipped: Record<string, string>): string[] {
  const entries = Object.entries(skipped)
  if (entries.length === 0) return []
  return ['', `Skipped: ${entries.map(([agent, reason]) => `\`${agent}\` — ${oneLine(reason)}`).join('; ')}`]
}

function filesSection(reports: AgentReport[], cycleRef: string): string[] {
  const lines = reports
    .flatMap((report) => report.result.files_touched.map((file) => `- \`${oneLine(file)}\` — ${report.basename}`))
    .filter((line, index, all) => all.indexOf(line) === index)
    .sort()
  if (lines.length === 0) return ['_none recorded_']
  return elide(lines, HANDOFF_FILES_MAX, (rest) => `*${rest} more in ${cycleRef}/<agent>.json*`)
}

/**
 * The ledger, as a table, with the two parentheticals it carries for free: a
 * reused result and its source cycle, and the live `config.yaml` command when
 * the run's pinned one has diverged from it. The second is the only place a
 * person who is not watching the cockpit finds out that an edit they made
 * mid-run is waiting for the next one.
 */
function verificationSection(ledger: LedgerEntry[] | null, cycle: number): string[] {
  if (ledger === null || ledger.length === 0) return ['_nothing was verified through the engine_']
  return [
    '| Command | Exit | Log |',
    '|---|---|---|',
    ...ledger.map((entry) => `| \`${cell(entry.command)}\` | ${exitCell(entry)} | ${logCell(entry, cycle)} |`),
  ]
}

/**
 * An exit code, or why there is none. A `queued` or `running` entry has not
 * produced one yet and a killed one never will, and each of the three means
 * something different to a reader deciding whether this cycle was verified.
 */
function exitCell(entry: LedgerEntry): string {
  if (entry.timed_out) return '— (timed out)'
  return entry.exit_code === null ? `— (${entry.phase})` : String(entry.exit_code)
}

function logCell(entry: LedgerEntry, cycle: number): string {
  const notes: string[] = []
  if (entry.cached_from_cycle !== null) notes.push(`cached, cycle ${entry.cached_from_cycle}`)
  if (entry.live_command !== null) notes.push(`config.yaml now says \`${oneLine(entry.live_command)}\``)
  const tail = notes.length === 0 ? '' : ` (${notes.join('; ')})`
  if (entry.log === '') return `—${tail}`
  // A reused entry's log belongs to the cycle that produced it, not to this
  // one. `log` is a bare file name within `cycle-NN/verify/`; a value that
  // already carries a separator is a run-relative path and is left alone,
  // rather than being nested under a second cycle directory that does not
  // exist.
  const source = entry.cached_from_cycle ?? cycle
  const ref = entry.log.includes('/') ? entry.log : `${cycleDirName(source)}/verify/${entry.log}`
  return `\`${oneLine(ref)}\`${tail}`
}

function findingsSection(carried: Finding[], cycleRef: string): string[] {
  if (carried.length === 0) return ['_none recorded_']
  const lines = [...carried]
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    .map((finding) => `- **${finding.severity}** \`${oneLine(finding.file)}:${finding.line}\` — ${oneLine(finding.claim)}`)
  return elide(lines, HANDOFF_FINDINGS_MAX, (rest) => `*${rest} more in ${cycleRef}/findings.json*`)
}

function errorsSection(errors: string[]): string[] {
  if (errors.length === 0) return ['_none recorded_']
  return elide(
    errors.map((signature) => `- \`${oneLine(signature)}\``),
    HANDOFF_ERRORS_MAX,
    (rest) => `*${rest} more*`,
  )
}

/**
 * This run's routing decision, as a cycle's reader needs it: the concurrency
 * verdict and the rule that produced it, then one line per skill the manifest
 * actually selected, naming the component, the role it was offered to, and the
 * reason `selectSkills` recorded for it — the dispatch-side evidence the story
 * asks for: what each agent was told, and why.
 *
 * The concurrency line comes first and is written unconditionally, because it
 * is the half of the decision that has consequences for how the *next* cycle
 * is dispatched rather than for what one agent reads. It is also the only way
 * `analyseConcurrency`'s `ask` branch can do what its own reason string says —
 * "the leader should offer the choice" is unreachable advice if the verdict is
 * never rendered anywhere a leader looks. One line, bounded by construction,
 * unlike the per-selection rows below.
 *
 * A selection with no matched skill contributes no line here. The manifest
 * itself keeps that row — `skill-selection.json` is where "this component was
 * considered and nothing matched" has to stay distinguishable from "this
 * component was never considered" — but repeating an empty verdict once per
 * (component, agent) pair in a document every agent of the next cycle reads
 * would be the unbounded-by-default cost every other section here was built
 * to avoid, for a fact the pinned file already states in full.
 */
function skillsSection(manifest: SkillManifest): string[] {
  const verdict = `- **Concurrency:** \`${manifest.concurrency.mode}\` — ${oneLine(manifest.concurrency.reason)}`
  const lines = manifest.selections.flatMap((selection) =>
    selection.skillIds.map((skillId, index) => {
      const reason = selection.reasons[index] ?? ''
      return `- \`${selection.component}\` / \`${selection.agent}\`: \`${skillId}\` — ${oneLine(reason)}`
    }),
  )
  if (lines.length === 0) return [verdict, '', '_no skill selected_']
  return [verdict, '', ...elide(lines, HANDOFF_SKILLS_MAX, (rest) => `*${rest} more in ${SKILL_MANIFEST_FILE}*`)]
}

/** Keep the first `max`, and say where the rest went. */
function elide(lines: string[], max: number, marker: (rest: number) => string): string[] {
  if (lines.length <= max) return lines
  return [...lines.slice(0, max), '', marker(lines.length - max)]
}

/**
 * The whole-document ceiling, counted in bytes and with the marker spent out of
 * the budget rather than added to it — so the file never exceeds the constant,
 * exactly as `capEvidence`'s truncation does.
 */
function bound(document: string, cycleRef: string): string {
  if (Buffer.byteLength(document, 'utf8') <= HANDOFF_MAX_BYTES) return document
  const marker = `\n\n*Truncated at ${HANDOFF_MAX_BYTES} bytes — the whole cycle is in \`${cycleRef}/\`.*\n`
  const budget = HANDOFF_MAX_BYTES - Buffer.byteLength(marker, 'utf8')
  // Trimmed a character at a time rather than sliced by byte offset: cutting a
  // multi-byte character in half would put a replacement character in a
  // document every agent of the next cycle reads.
  let kept = document.slice(0, budget)
  while (Buffer.byteLength(kept, 'utf8') > budget) kept = kept.slice(0, -1)
  return kept + marker
}

/**
 * The cycle's agent results.
 *
 * Directory entries are skipped — `verify/` and `evidence/` are written by
 * other ops and neither is an agent result — as are the two aggregates
 * `rosterSet` and `archiveFindings` write. A file that will not parse is
 * skipped rather than fatal, the same rule the cockpit's cycle view applies:
 * one bad result must not blank the whole handoff.
 */
async function readAgentReports(dir: string): Promise<AgentReport[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const reports: AgentReport[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    if (entry.name === 'roster.json' || entry.name === 'findings.json') continue
    const result = await readOptionalJson(path.join(dir, entry.name), AgentResultSchema)
    if (result === null) continue
    const basename = entry.name.slice(0, -'.json'.length)
    // `runLog` writes an instance as `<agent>--<instance>.json`, and an agent
    // name may not contain `--`, so the first split is the agent.
    reports.push({ basename, agent: basename.split('--')[0] ?? basename, result })
  }
  return reports
}

/** Absent, unreadable and unparseable are one answer here: this section is short. */
async function readOptionalJson<T>(file: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const parsed = schema.safeParse(JSON.parse(await fs.readFile(file, 'utf8')) as unknown)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** A table cell holds one line and no bare pipe, or the row stops being a row. */
function cell(text: string): string {
  return oneLine(text).replaceAll('|', '\\|')
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function halt(
  projectDir: string,
  reason: string,
  now: Clock = () => new Date(),
  options: { expectRun?: string } = {},
): Promise<State> {
  const store = new StateStore(projectDir, now)
  const state = await store.update((draft) => {
    // Guarded inside the locked update: with no run to halt, the mutation
    // must never land — writeHaltReport would fail right after it and leave
    // a "halted" state for a run that never existed.
    if (draft.run_id === null || draft.track === null) throw new NoActiveRunError()
    // Same lock, same reason: halting the run that started *after* the one the
    // caller was looking at is the exact accident this refuses.
    expectUnchanged('run', draft.run_id, draft.run_id, options.expectRun)
    draft.status = 'halted'
    draft.current.stage = 'halted'
    draft.halt_reason = reason
  })
  // Deduplicated here as well as at the cycle close, so a guard halt and a
  // `/mjloop:stop` print the same list for the same run in the same file.
  await writeHaltReport(projectDir, state, 'manual', distinctFindings(state.findings))
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

/**
 * `open` has no default any more, and that is deliberate: both callers pass a
 * deduplicated list, and a default of `state.findings` would let a third one
 * print the raw one — the same run's open findings, listed twice over in the
 * same file, depending on which way it halted.
 */
async function writeHaltReport(projectDir: string, state: State, cause: HaltCause, open: Finding[]): Promise<void> {
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
