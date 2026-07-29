import fs from 'node:fs/promises'
import path from 'node:path'
import * as z from 'zod'
import { findTrack, forbiddenSpecialists, permittedAgents } from '../schemas/config.js'
import { AgentNameSchema, capEvidence, parseAgentResult, type AgentResult } from '../schemas/contract.js'
import type { State } from '../schemas/state.js'
import type { LedgerEntry } from '../schemas/verify.js'
import { loadConfig } from '../store/config-store.js'
import { headSha } from '../store/git.js'
import { StateStore, type Clock } from '../store/state-store.js'
import { errorSignature } from './fingerprint.js'
import { NoActiveRunError, UnknownTrackError, cycleDirPath, runDirPath } from './run.js'
import { readVerifyLedger } from './verify.js'

export class InvalidAgentNameError extends Error {
  constructor(agent: string, detail: string) {
    super(`"${agent}" is not a usable agent name — it names a file in the cycle directory:\n${detail}`)
    this.name = 'InvalidAgentNameError'
  }
}

export class InvalidAgentResultError extends Error {
  constructor(agent: string, detail: string) {
    super(`"${agent}" returned a result that does not match the agent contract:\n${detail}`)
    this.name = 'InvalidAgentResultError'
  }
}

export class UnknownAgentError extends Error {
  constructor(agent: string, track: string, permitted: string[]) {
    super(
      `"${agent}" is not in track "${track}" — add it to required, available or closing first ` +
        `(this track runs: ${permitted.join(', ')}). A name no track defines is how a gated agent gets logged ` +
        'under a spelling the gate does not recognise.',
    )
    this.name = 'UnknownAgentError'
  }
}

/**
 * The mirror of `rosterSet`'s rule at the other end of the cycle. Its own
 * error, not an `UnknownAgentError`: the agent *is* in the track, and telling
 * a project that has switched one off to add it to the track first would send
 * the reader to the wrong line of the config.
 */
export class ForbiddenSpecialistError extends Error {
  constructor(agent: string) {
    super(
      `"${agent}" is configured as specialists.${agent}=never — its result cannot be recorded. ` +
        'A project that switched an agent off must not have it open a gate, block a pass, or ' +
        `reach its history. Drop it from the cycle, or change specialists.${agent} in .mjloop/config.yaml.`,
    )
    this.name = 'ForbiddenSpecialistError'
  }
}

/**
 * The other mirror of a `rosterSet` rule: it refuses a closing agent drafted
 * into `selected`, and this refuses the same agent's result at the other end of
 * the cycle.
 *
 * `permittedAgents` includes `closing`, so without this the name is accepted
 * and a closing agent logged mid-run files its findings into a working cycle's
 * task list, arms that cycle's guards, and documents code the run has not
 * settled — which is the entire defect the `closing` set exists to remove. It
 * also closes the window where a run has been replaced under a still-working
 * closing agent and the new run's track happens to close with the same name.
 */
export class ClosingAgentError extends Error {
  constructor(agent: string, track: string) {
    super(
      `"${agent}" is a closing agent on track "${track}" — it runs once, after the run passes, and never inside a ` +
        'working cycle. Logging it now would file its findings against a cycle it did not work and document code ' +
        'this run has not finished changing. Dispatch it from the closing_agents mjloop_cycle_advance returns.',
    )
    this.name = 'ClosingAgentError'
  }
}

export class CycleClosedError extends Error {
  constructor(agent: string, logged: number, current: number) {
    super(
      `cycle ${logged} closed while "${agent}" was being logged — the run is now at cycle ${current}. ` +
        'Its findings were not folded in; log the result against the open cycle.',
    )
    this.name = 'CycleClosedError'
  }
}

export class RunReplacedError extends Error {
  constructor(agent: string, logged: string | null, current: string | null) {
    super(
      `run ${logged} was replaced while "${agent}" was being logged — the project is now on run ${current}. ` +
        'Its findings were not folded in; log the result against the open run.',
    )
    this.name = 'RunReplacedError'
  }
}

/**
 * A gate is generic machinery, so its message is built from the gate's own
 * data. A track that gates "reviewed before implemented" must not be told to
 * reproduce a defect.
 */
export class GateClosedError extends Error {
  constructor(agent: string, provenBy: string) {
    super(
      `"${agent}" is blocked by the "${provenBy}" gate on this track. Nothing it produces can be recorded until ` +
        `"${provenBy}" returns status "pass" carrying command or test evidence. ` +
        `Run "${provenBy}" first, or halt the run — nothing opens this gate by assertion.`,
    )
    this.name = 'GateClosedError'
  }
}

/**
 * A `pass` citing a command the engine itself ran and recorded as not having
 * exited 0.
 *
 * This is the counter-evidence the evidence rule never had: until the engine
 * executed verify commands itself, an agent could log `status: "pass"` with an
 * excerpt reading `tests 40, pass 40, fail 0` having run nothing, and there was
 * nothing to check it against. It only ever *refuses* — a green ledger entry
 * still does not make a pass, it merely removes one way to fake one.
 *
 * The refusal is recoverable and the message has to say how, because the check
 * keys on the **most recent** entry and any agent may call `mjloop_verify_run`:
 * a builder that ran the test slot mid-cycle, got exit 1 and then fixed the
 * defect leaves a red entry behind, and a verifier that legitimately sees green
 * afterwards would otherwise have a correct verdict thrown away with no
 * artefact — burning the leader's single corrective retry on an engine error
 * the agent did not cause.
 */
export class ContradictedEvidenceError extends Error {
  constructor(agent: string, entry: LedgerEntry, log: string | null) {
    super(
      `"${agent}" returned status "pass" citing "${entry.command}", but the verify ledger this result is logged ` +
        `against records that ` +
        `the engine ran that command and ${outcomeOf(entry)}. A pass resting on it rests on nothing. ` +
        (log === null ? '' : `What actually happened is in ${log}. `) +
        'Re-run this command through `mjloop_verify_run` so the ledger carries a newer entry, then log again.',
    )
    this.name = 'ContradictedEvidenceError'
  }
}

/** The recorded outcome, in the words the ledger's own fields justify. */
function outcomeOf(entry: LedgerEntry): string {
  if (entry.phase === 'queued') return 'it never started — it was still waiting for the project verify lock'
  if (entry.phase === 'running') return 'it had not finished'
  if (entry.timed_out) return 'it was killed at the configured ceiling'
  if (entry.exit_code === null) return 'it reported no exit code'
  return `it exited ${entry.exit_code}`
}

export interface RunLogInput {
  agent: string
  /**
   * Distinguishes concurrent runs of the same agent. N hypothesis testers in
   * one cycle would otherwise all write `hypothesis-tester.json`, and the
   * cycle would record one verdict where it produced N.
   */
  instance?: string
  /**
   * The run the agent was dispatched under, when the caller knows it.
   *
   * It exists for the closing agents, which work after `cycleAdvance` has
   * already reported the run `done` and can therefore still be running when a
   * person starts the next one. Optional because every other dispatch is
   * answered inside a cycle, where `RunReplacedError` is raised by the locked
   * update instead.
   */
  run_id?: string | null
  /** Unvalidated — this is where an agent's raw return value is checked. */
  result: unknown
}

/**
 * Record one agent's result.
 *
 * The order of what follows is fixed, and four positions in it are load-bearing
 * rather than tidy. Each is commented where it stands, because four separate
 * concerns edit this function — the contradiction check, the excerpt cap, the
 * run map and the closing branch — and each of them is correct only if it runs
 * where it does.
 */
export async function runLog(
  projectDir: string,
  input: RunLogInput,
  now: Clock = () => new Date(),
): Promise<{ path: string; findingsAdded: number; gateOpened: boolean }> {
  /* 1 — the name, the instance and the result. */

  const agent = AgentNameSchema.safeParse(input.agent)
  if (!agent.success) throw new InvalidAgentNameError(input.agent, z.prettifyError(agent.error))

  // The instance is validated by the same schema as the agent name, and here
  // rather than beside the write: everything that reaches the filesystem is
  // checked in one place, before anything is read, so a bad instance leaves
  // exactly the same nothing behind as a bad agent name.
  let basename = agent.data
  if (input.instance !== undefined) {
    const instance = AgentNameSchema.safeParse(input.instance)
    if (!instance.success) throw new InvalidAgentNameError(input.instance, z.prettifyError(instance.error))
    basename = `${agent.data}--${instance.data}`
  }

  const parsed = parseAgentResult(input.result)
  if (!parsed.ok) throw new InvalidAgentResultError(agent.data, parsed.error)

  /* 2 — state, read unlocked. */

  const store = new StateStore(projectDir, now)
  const state = await store.get()

  // Checked here, before the closing branch rather than inside it, and that is
  // the whole point of the field. The scenario it exists for is a person
  // starting the next run while a closing agent is still working: `runStart`
  // sets `status` back to `running`, so the branch below is *not* taken and the
  // result would go down the ordinary path into a run that never dispatched it.
  // Inside the branch this check would never fire in exactly that case.
  if (input.run_id !== undefined && input.run_id !== null && input.run_id !== state.run_id) {
    throw new RunReplacedError(agent.data, input.run_id, state.run_id)
  }

  /* 3 — the closing branch, which must precede the refusal below. */

  // A closing agent is dispatched *after* the run passes, so it is always
  // logged against a run whose status is `done`. Placed after the
  // `status !== 'running'` refusal this branch would be unreachable by
  // construction — every closing result would be refused as "no active run".
  // It also has to precede the gate probe: a closing agent named in
  // `gate.blocks` on a gated track would otherwise be refused before the branch
  // was reached.
  if (state.status === 'done' && state.track !== null) {
    const config = await loadConfig(projectDir)
    const track = findTrack(config, state.track)
    if (track !== undefined && track.closing.includes(agent.data)) {
      // Outside every cycle directory. Nothing that walks a cycle sees it, no
      // finding is filed, no signature is appended, the gate is not probed and
      // `state.json` is not written — so a documentation pass cannot reopen,
      // contradict or arm a verdict nobody can revisit.
      const dir = path.join(runDirPath(projectDir, state), 'closing')
      const closingLedger = await readVerifyLedger(dir)
      // The contradiction check, on the one path where the leader is told not
      // to fetch the digest itself. A closing agent carries
      // `mjloop_verify_run` and files its digest as evidence, and step 8.4 of
      // the leader skill commits only on a green closing pass — so without this
      // the single mechanical refusal every cycle agent meets is absent from
      // the one result a commit rests on. It reads the ledger `verifyRun` wrote
      // into this very directory, and it runs before `mkdir`, so a refusal
      // leaves the same nothing behind here as it does below.
      refuseContradicted(projectDir, dir, agent.data, parsed.value, closingLedger, track.gate?.proven_by)
      await fs.mkdir(dir, { recursive: true })
      const capped = await capAndSpill(projectDir, dir, basename, parsed.value, closingLedger)
      const file = path.join(dir, `${basename}.json`)
      await fs.writeFile(file, `${JSON.stringify(capped, null, 2)}\n`, 'utf8')
      return { path: file, findingsAdded: 0, gateOpened: false }
    }
  }

  /* 4 — the refusal every other agent meets on a run that is not running. */

  if (state.status !== 'running' || state.track === null) throw new NoActiveRunError()

  /* 5 — the track, the roster and the gate. */

  // runLog reads config for the first time here: the gate is a property of the
  // running track, and a track is configuration. A track that has gone missing
  // from config fails closed, as it does in `rosterSet` and `cycleAdvance` — a
  // gate that cannot be found must refuse the log, not disappear.
  const config = await loadConfig(projectDir)
  const track = findTrack(config, state.track)
  if (track === undefined) throw new UnknownTrackError(state.track, Object.keys(config.tracks))

  // The same set `rosterSet` enforces: without it the gate is keyed on a name
  // the leader can change at will, and "fixer2" — or "Fixer", which on a
  // case-insensitive filesystem lands on the blocked agent's own result file —
  // records exactly the work the gate exists to refuse.
  const permitted = permittedAgents(config, track)
  if (!permitted.has(agent.data)) throw new UnknownAgentError(agent.data, state.track, [...permitted])

  // Reached only when the run is still running, because the branch above
  // returned for every closing agent whose run is done.
  if (track.closing.includes(agent.data)) throw new ClosingAgentError(agent.data, state.track)

  // `never` is checked separately rather than subtracted inside
  // `permittedAgents`: that set is also what `rosterSet` reports against, and
  // a forbidden agent removed from it would be rejected there for not being in
  // the track — which it is. Without this check the config's `never` binds the
  // roster the leader declares and nothing else, so the forbidden agent skips
  // the declaration and logs its result anyway: findings land in state, a high
  // one blocks the pass, and it can open the track's gate.
  if (forbiddenSpecialists(config).includes(agent.data)) throw new ForbiddenSpecialistError(agent.data)

  const gate = track.gate
  if (gate !== undefined && state.reproduction === null) {
    // Blocking is deliberately case-insensitive while opening below is not: a
    // variant that differs only in case must never slip past the gate, and it
    // must never be taken for the agent that opens it.
    const blocked = gate.blocks.some((name) => name.toLowerCase() === agent.data.toLowerCase())
    if (blocked) throw new GateClosedError(agent.data, gate.proven_by)
  }

  /* 6 — the contradiction check, which must precede everything that writes. */

  const cycleDir = cycleDirPath(projectDir, state)
  // Absent for every cycle of every project that predates the engine running
  // verify commands itself, and `[]` there — so the check below is inert rather
  // than newly strict about history.
  const ledger = await readVerifyLedger(cycleDir)

  refuseContradicted(projectDir, cycleDir, agent.data, parsed.value, ledger, gate?.proven_by)
  // Nothing above this line has written anything, which is the property
  // `tests/ops/log.test.ts` asserts for every refusal in this function: a
  // rejected result leaves no file, no finding and no state change behind.

  /* 7 — the cap, and the spill it must not point at before writing. */

  const capped = await capAndSpill(projectDir, cycleDir, basename, parsed.value, ledger)

  /* 8 — the gate proof, derived from the capped result. */

  // The gate opens as a side effect of the ordinary evidence-bound channel.
  // There is no tool that simply declares a defect reproduced: the engine
  // cannot read an excerpt and confirm it shows a failure, but it can insist
  // the claim came from the designated agent, carried command or test
  // evidence, and passed contract validation on the way in.
  //
  // Taken from `capped` and never from `parsed.value`. `capEvidence` returns a
  // *new* result, so a proof selected from the uncapped one points at the
  // uncapped excerpt — and the write below copies that string into
  // `state.reproduction.excerpt`, where it is re-read, re-validated and
  // re-written by every subsequent `StateStore.update` for the rest of the run.
  const proof =
    gate !== undefined && agent.data === gate.proven_by && capped.status === 'pass'
      ? capped.evidence.find((entry) => entry.kind === 'command' || entry.kind === 'test')
      : undefined

  /* 9 — the error signatures, also from the capped result. */

  // The pin: a signature is computed from the excerpt **as stored**. That is
  // what lets `cycle_errors` and HALT.md cite text a forensic reader can find
  // in the run directory, and it keeps the guard's input the same shape as its
  // evidence. Hashing the uncapped excerpt would leave the guard keyed on text
  // that exists nowhere on disk.
  const signatures = errorSignature(capped.evidence, capped.status)

  /* 10 — the result file. */

  await fs.mkdir(cycleDir, { recursive: true })
  const file = path.join(cycleDir, `${basename}.json`)
  await fs.writeFile(file, `${JSON.stringify(capped, null, 2)}\n`, 'utf8')

  /* 11 — the run map. */

  // Track data, exactly as the gate is: the engine does not know agent names,
  // and hard-coding `scout` here would be the first place it learned one. Only
  // a pass writes — an agent that returned `blocked` mapped nothing.
  if (track.map !== undefined && agent.data === track.map.drafted_by && capped.status === 'pass') {
    try {
      await writeRunMap(projectDir, state, agent.data, capped)
    } catch (error) {
      // Never fatal, for the reason `cycleAdvance` gives about the handoff: the
      // map is a projection of `cycle-NN/<agent>.json`, which is already on
      // disk, so losing it costs nothing — while letting it throw here would
      // keep this agent's findings out of state over a document that can be
      // regenerated. Named on stderr so it is diagnosable rather than absent.
      process.stderr.write(`mjloop: the run map was not written: ${String(error)}\n`)
    }
  }

  /* 12 — the conditional, locked state update. */

  if (capped.findings.length > 0 || proof !== undefined || signatures.length > 0) {
    await store.update((draft) => {
      // The read above was not locked, so a `cycleAdvance` may have landed in
      // between: it has archived the cycle these findings belong to and either
      // opened the next one or ended the run. Pushing now would file this
      // agent's work under a cycle that did not do it — or leave an open
      // finding on a run that is already `done`.
      if (draft.status !== 'running') throw new NoActiveRunError()
      // A `runStart` may have landed instead, and it resets to cycle 1: cycle
      // equality is not run identity. Without this, an evidenced reproduction
      // opens the gate of a run that demonstrated nothing — which is precisely
      // what `runStart` clearing `reproduction` exists to prevent.
      if (draft.run_id !== state.run_id) throw new RunReplacedError(agent.data, state.run_id, draft.run_id)
      if (draft.cycle !== state.cycle) throw new CycleClosedError(agent.data, state.cycle, draft.cycle)
      draft.findings.push(...capped.findings)
      if (proof !== undefined) {
        draft.reproduction = { agent: agent.data, cycle: draft.cycle, ref: proof.ref, excerpt: proof.excerpt }
      }
      // Deduplicated across agents: one defect reported by two agents is one
      // failure recurring, not two, exactly as the stagnation fingerprint
      // deduplicates findings.
      for (const signature of signatures) {
        if (!draft.cycle_errors.includes(signature)) draft.cycle_errors.push(signature)
      }
    })
  }

  return { path: file, findingsAdded: capped.findings.length, gateOpened: proof !== undefined }
}

/* ── the ledger, read rather than written ─────────────────────────────────── */

/**
 * Refuse a `pass` citing a command the engine itself recorded as not green.
 *
 * One function, two callers, and that is the point: a closing agent now carries
 * `mjloop_verify_run` and is required to file its digest as evidence, so the
 * check has to hold on both paths or the path with the least oversight is the
 * one without it. Everything it needs differs between the two — the ledger, the
 * directory a log path is resolved against — and nothing it decides does, so
 * all of that is a parameter.
 *
 * `provenBy` is the track's `gate.proven_by` and the exemption keys on it
 * rather than on an agent name, because the engine does not know agent names.
 * On the `fix` track `reproducer` returns `pass` meaning "I demonstrated the
 * defect", and the command it names is *expected* to exit non-zero; a blanket
 * rule would shut that track permanently. The closing caller passes it too:
 * `TrackSchema` counts `closing` as known when validating `gate.proven_by`, so
 * a project may legitimately close a track with the agent that proves its gate.
 *
 * Synchronous and throwing rather than returning a verdict, so a caller cannot
 * write first and check after — the refusal's whole value is that nothing has
 * happened yet when it fires.
 */
function refuseContradicted(
  projectDir: string,
  workDir: string,
  agent: string,
  result: AgentResult,
  ledger: LedgerEntry[],
  provenBy: string | undefined,
): void {
  if (result.status !== 'pass' || provenBy === agent) return
  for (const entry of result.evidence) {
    // Exact `ref` equality only — no substring, no normalisation. An agent
    // that ran its own command under a different name is in exactly the
    // position it was in before this check existed: it adds nothing and takes
    // nothing away.
    const recorded = latestEntry(ledger, entry.ref)
    if (recorded === null || exitedZero(recorded)) continue
    const log = recorded.log === '' ? null : path.relative(projectDir, ledgerLogFile(workDir, recorded))
    throw new ContradictedEvidenceError(agent, recorded, log)
  }
}

/**
 * The most recent invocation of one command in one ledger.
 *
 * Array order is invocation order — an entry is appended when the invocation
 * begins and amended in place when it ends — so the last match is the newest
 * attempt rather than the newest *completion*. That is the intended reading:
 * a command that has been re-run supersedes what it did before, which is what
 * makes `ContradictedEvidenceError` recoverable.
 */
function latestEntry(ledger: LedgerEntry[], command: string): LedgerEntry | null {
  for (let index = ledger.length - 1; index >= 0; index -= 1) {
    const entry = ledger[index]
    if (entry !== undefined && entry.command === command) return entry
  }
  return null
}

/**
 * Did the engine see this command exit 0?
 *
 * `null` must not be inert, which is the whole reason this is three tests and
 * not one. A command still queued for the project verify lock never started; a
 * command still running has not finished; a command killed at the ceiling was
 * stopped mid-suite. All three record `exit_code: null`, and treating that as
 * "no contradiction" would let a `pass` cite a suite that never produced a
 * result — the precise hole the check exists to close.
 */
function exitedZero(entry: LedgerEntry): boolean {
  if (entry.phase !== 'complete') return false
  if (entry.timed_out) return false
  return entry.exit_code === 0
}

/**
 * Where a ledger entry's output actually is.
 *
 * `log` is a bare file name inside `<workDir>/verify/` for anything the engine
 * ran, and run-relative for a cache hit — whose output belongs to the earlier
 * cycle that produced it and is deliberately never copied forward.
 */
function ledgerLogFile(workDir: string, entry: LedgerEntry): string {
  return path.dirname(entry.log) === '.'
    ? path.join(workDir, 'verify', entry.log)
    : path.join(workDir, '..', entry.log)
}

/* ── the cap and its spill ────────────────────────────────────────────────── */

/**
 * Bound every excerpt in a result and put the overflow somewhere retrievable.
 *
 * **The cap always applies.** A ledger match changes only the *destination* the
 * truncation marker names — the verify log the engine already wrote, instead of
 * a fresh spill file — never whether truncation happens. A digest-built excerpt
 * is short but not bounded: twenty failure lines at 240 characters plus a
 * headline is around 5 KB, which is well over the ceiling, and the fix track
 * copies one such excerpt straight into `state.reproduction`.
 *
 * The write order is the invariant: a marker must never name a file that does
 * not exist, so the tail is on disk before anything points at it. If a spill
 * write throws, the result file is never written and the log fails loudly —
 * the same failure mode an unwritable cycle directory already produces.
 *
 * The evidence directory is created only when something overflows, so a result
 * under the ceiling leaves no empty directory behind for a reader to wonder at.
 */
async function capAndSpill(
  projectDir: string,
  workDir: string,
  basename: string,
  result: AgentResult,
  ledger: LedgerEntry[],
): Promise<AgentResult> {
  const evidenceDir = path.join(workDir, 'evidence')

  // One command, one file. Where the engine ran the command itself the full
  // output is already on disk, and copying it into a spill file beside the
  // result would store the same bytes twice under two names that can drift.
  const engineLog = new Map<number, string>()
  result.evidence.forEach((entry, index) => {
    const recorded = latestEntry(ledger, entry.ref)
    if (recorded === null || recorded.log === '') return
    engineLog.set(index, path.relative(projectDir, ledgerLogFile(workDir, recorded)))
  })

  const { result: capped, spills } = capEvidence(
    result,
    (index) => engineLog.get(index) ?? path.relative(projectDir, spillFile(evidenceDir, basename, index)),
  )

  const fresh = spills.filter((spill) => !engineLog.has(spill.index))
  if (fresh.length > 0) {
    await fs.mkdir(evidenceDir, { recursive: true })
    for (const spill of fresh) {
      await fs.writeFile(spillFile(evidenceDir, basename, spill.index), spill.text, 'utf8')
    }
  }
  return capped
}

/** One name, so the marker and the file cannot be written from two spellings. */
function spillFile(evidenceDir: string, basename: string, index: number): string {
  return path.join(evidenceDir, `${basename}--${index}.txt`)
}

/* ── the run map ──────────────────────────────────────────────────────────── */

/** The file `StateSummary.map` reports and every later brief points at. */
const MAP_FILE = 'map.md'

/**
 * Two ceilings, because this file sits in front of every agent of every later
 * cycle: an unbounded append rule is growth multiplied by the roster width.
 * Nothing is lost at either — every section is a projection of a
 * `cycle-NN/<agent>.json` that is still on disk, and both markers say so.
 */
const MAP_MAX_BYTES = 8_000
const MAP_MAX_SECTIONS = 3

/**
 * File bullets one section may carry.
 *
 * The third ceiling, and the one that keeps the other two from ever binding in
 * practice. A scout naming 220 files renders a section larger than
 * `MAP_MAX_BYTES` on its own, and a byte cut applied to the whole document would
 * then spend the entire budget on that one section — leaving nothing for the
 * cycles that came after it. Bounding the unbounded part where it is produced is
 * what makes "the newest section always survives" achievable rather than
 * aspirational.
 */
const MAP_MAX_FILES = 40

/** What a section's heading records, and what parsing one back recovers. */
interface MapSection {
  cycle: number
  agent: string
  head: string
  /** Everything under the heading. Replaced wholesale when a section is elided. */
  body: string
  /** The paths this section names, which is what the precedence rule reads. */
  files: string[]
}

const SECTION_HEADING = /^## Cycle (\d+) — (\S+) \(HEAD (.+)\)$/
const SECTION_FILE = /^- `(.+)`$/

/**
 * What a section's heading says when `store/git.ts` cannot name the tree.
 *
 * A map section is prose about a tree, and without the sha a reader cannot tell
 * which tree — which is what makes two contradicting sections unresolvable
 * rather than merely ordered. Saying so is not an error: a project that is not a
 * git repository still gets a map, it simply cannot stamp one, and `headSha`
 * returns `null` rather than inventing a sha that would make the heading lie.
 */
const NO_GIT = 'no git'

/**
 * Append this pass to the run's map, or create it.
 *
 * Write-once, append-never-overwrite: overwriting the first map would erase the
 * ground truth the run started from, which is the thing this file exists to
 * keep. But appending alone leaves two sections contradicting each other by
 * cycle 4 — the cycle-1 prose naming a file cycle 2 moved — so three things are
 * stamped into what is rendered. Provenance, so a reader can tell which tree a
 * paragraph describes. Precedence, stated in the header above the prose it
 * governs. And an explicit supersede list, so the suspect parts of the original
 * map are visible without re-reading it.
 *
 * Everything here is a deterministic projection of data already parsed. No
 * model call, no second pass, nothing generated — which is what lets the
 * mapping agent keep `Read, Grep, Glob` and no `Write`.
 */
async function writeRunMap(projectDir: string, state: State, agent: string, result: AgentResult): Promise<void> {
  const file = path.join(runDirPath(projectDir, state), MAP_FILE)
  const existing = await fs.readFile(file, 'utf8').catch(() => null)
  const sections = existing === null ? [] : parseSections(existing)

  const files = mappedFiles(result)
  sections.push({
    cycle: state.cycle,
    agent,
    head: (await headSha(projectDir)) ?? NO_GIT,
    body: renderBody(result.summary, files, supersededBy(sections, files), resultRef(state.cycle, agent)),
    files,
  })

  await fs.writeFile(file, render(state, sections, agent), 'utf8')
}

/**
 * The paths a mapping result names: what it touched, plus the `ref` of every
 * `file`-kind evidence entry. A scout writes nothing, so its `files_touched` is
 * ordinarily empty and its evidence is the whole list — but both are read,
 * because a mapping agent on another track may well have done both.
 */
function mappedFiles(result: AgentResult): string[] {
  const refs = result.evidence.filter((entry) => entry.kind === 'file').map((entry) => entry.ref)
  return [...new Set([...result.files_touched, ...refs])]
}

/**
 * Which earlier cycles this section supersedes, and for which files.
 *
 * Only sections that still carry their file list can be compared — an elided
 * one has given up its bullets, which is why its marker names the result file
 * it was projected from.
 */
function supersededBy(earlier: MapSection[], files: string[]): { cycles: number[]; files: string[] } {
  const named = new Set(files)
  const cycles: number[] = []
  const shared = new Set<string>()
  for (const section of earlier) {
    const overlap = section.files.filter((file) => named.has(file))
    if (overlap.length === 0) continue
    cycles.push(section.cycle)
    for (const file of overlap) shared.add(file)
  }
  return { cycles, files: [...shared] }
}

function renderBody(
  summary: string,
  files: string[],
  superseded: { cycles: number[]; files: string[] },
  ref: string,
): string {
  const lines: string[] = []
  if (superseded.cycles.length > 0) {
    const which = superseded.cycles.length === 1 ? `cycle ${superseded.cycles[0]}` : `cycles ${superseded.cycles.join(', ')}`
    lines.push(`*Superseding ${which} for:* ${superseded.files.map((file) => `\`${file}\``).join(', ')}`, '')
  }
  lines.push(summary.trim(), '')
  const shown = files.slice(0, MAP_MAX_FILES)
  for (const file of shown) lines.push(`- \`${file}\``)
  // The marker is deliberately not a `- \`path\`` bullet, so `parseSections`
  // reads it as prose and never mistakes it for a file this section named.
  if (files.length > shown.length) {
    lines.push(`- *(${files.length - shown.length} more files elided — see ${ref})*`)
  }
  return lines.join('\n').trimEnd()
}

/**
 * Render the whole document under the section policy, then hand it to `fit`.
 *
 * The first section is kept because it is the run's original ground truth, and
 * the two most recent because they describe the tree as it now stands. An
 * elided section keeps its heading — the provenance is the cheapest and most
 * useful part of it — and loses the prose, which is the unbounded part and the
 * part recoverable from the result file the marker names.
 *
 * The byte ceiling is `fit`'s, and it is applied section by section rather than
 * to the assembled string, for the reason stated there.
 */
function render(state: State, sections: MapSection[], agent: string): string {
  const header = [
    `# Map — ${state.run_id ?? 'unknown'}`,
    '',
    `**Track:** ${state.track ?? 'unknown'}`,
    `**Goal:** ${state.goal}`,
    '',
    '> Sections are in cycle order. **Where two sections name the same file, the later one wins** — the run',
    '> changes the tree it mapped.',
    '',
    '',
  ].join('\n')

  const bodies = sections.map((section, index) =>
    index === 0 || index >= sections.length - (MAP_MAX_SECTIONS - 1) ? section.body : elided(section),
  )

  return fit(header, sections, bodies, resultRef(state.cycle, agent))
}

/** What is left of a section the section policy dropped. */
function elided(section: MapSection): string {
  return `*(cycle ${section.cycle} elided — see ${resultRef(section.cycle, section.agent)})*`
}

function sectionText(section: MapSection, body: string): string {
  return `## Cycle ${section.cycle} — ${section.agent} (HEAD ${section.head})\n\n${body}\n\n`
}

/**
 * Bring the document under `MAP_MAX_BYTES` by dropping the **oldest** prose
 * first.
 *
 * The obvious implementation — assemble everything and cut the tail at the byte
 * budget — discards the newest sections first, which is the exact inverse of
 * what `MAP_MAX_SECTIONS` promises and of what the document's own precedence
 * header asserts. Worse, it is absorbing: `writeRunMap` re-parses what it last
 * wrote, so once the cut lands the document is frozen at that content and every
 * later cycle's section vanishes on the way in, while the header still tells the
 * reader that the later section wins.
 *
 * So the pressure is taken off the far end. Each section that still carries
 * prose is reduced to its elision marker, oldest first, and the newest section
 * is the last thing standing. If that section alone still does not fit, its body
 * is cut — it is the only place where a byte cut cannot lose a whole cycle.
 */
function fit(header: string, sections: MapSection[], bodies: string[], ref: string): string {
  const assemble = (): string => {
    const parts = sections.map((section, index) => sectionText(section, bodies[index] ?? ''))
    return `${`${header}${parts.join('')}`.trimEnd()}\n`
  }

  let document = assemble()
  while (Buffer.byteLength(document) > MAP_MAX_BYTES) {
    // Never the last section: it describes the tree as it now stands, and a
    // document that dropped it would be entirely about trees that are gone.
    const next = bodies.findIndex((body, index) => index < bodies.length - 1 && body !== elided(sections[index] as MapSection))
    if (next === -1) break
    bodies[next] = elided(sections[next] as MapSection)
    document = assemble()
  }
  if (Buffer.byteLength(document) <= MAP_MAX_BYTES) return document

  // Only the newest section's prose is left and it is still too large. Cutting
  // it is the one truncation that cannot cost a cycle, and the marker names the
  // result file the whole section was projected from.
  const marker = `\n\n*(map truncated at ${MAP_MAX_BYTES} bytes — see ${ref})*\n`
  return `${cutToBytes(document, MAP_MAX_BYTES - Buffer.byteLength(marker)).trimEnd()}${marker}`
}

/** `cycle-NN/<agent>.json` — where every part of a section came from. */
function resultRef(cycle: number, agent: string): string {
  return `cycle-${String(cycle).padStart(2, '0')}/${agent}.json`
}

/** Cut at a byte budget without splitting a character in half. */
function cutToBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return text
  let end = Math.max(0, maxBytes)
  // A UTF-8 continuation byte is `10xxxxxx`. While the byte *after* the cut is
  // one, the cut lands inside a character, so step back until it does not.
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1
  return buffer.subarray(0, end).toString('utf8')
}

/**
 * Read back what this function itself wrote.
 *
 * A markdown re-parse is the right shape here rather than a sidecar JSON index:
 * the document is the artefact, a person edits and reads it, and a second file
 * describing it could drift from it silently. Both patterns are ones `render`
 * emits, so nothing here has to cope with prose it did not write — an
 * unrecognised line is simply body text.
 */
function parseSections(text: string): MapSection[] {
  const sections: MapSection[] = []
  let body: string[] = []
  const close = (): void => {
    const section = sections[sections.length - 1]
    if (section !== undefined) section.body = body.join('\n').trim()
  }
  for (const line of text.split('\n')) {
    const heading = SECTION_HEADING.exec(line)
    if (heading !== null) {
      close()
      body = []
      sections.push({ cycle: Number(heading[1]), agent: heading[2] ?? '', head: heading[3] ?? '', body: '', files: [] })
      continue
    }
    if (sections.length === 0) continue
    body.push(line)
    const file = SECTION_FILE.exec(line)
    const section = sections[sections.length - 1]
    if (file !== null && section !== undefined) section.files.push(file[1] ?? '')
  }
  close()
  return sections
}
