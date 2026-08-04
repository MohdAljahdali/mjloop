import fs from 'node:fs/promises'
import path from 'node:path'
import * as z from 'zod'
import { findTrack, forbiddenSpecialists, permittedAgents, type Track } from '../schemas/config.js'
import { AgentNameSchema, AgentResultSchema, capEvidence, parseAgentResult, type AgentResult } from '../schemas/contract.js'
import type { QualityPolicy } from '../schemas/quality.js'
import { SkillManifestSchema, type SkillManifest } from '../schemas/skill-selection.js'
import type { State } from '../schemas/state.js'
import type { LedgerEntry } from '../schemas/verify.js'
import { loadConfig } from '../store/config-store.js'
import { headSha, worktreeDigest } from '../store/git.js'
import { readLedger, readPolicy } from '../store/quality-store.js'
import { StateStore, type Clock } from '../store/state-store.js'
import { errorSignature } from './fingerprint.js'
import { qualityRuntimeEnabled } from './quality-capability.js'
import { recordQualityEvidenceBatch, type QualityEvidenceInput } from './quality-ledger.js'
import { resolveQualityContextEvidence } from './quality-policy.js'
import { planQualityDispatches, type PlannedQualityDispatch } from './quality-roster.js'
import { NoActiveRunError, SKILL_MANIFEST_FILE, UnknownTrackError, cycleDirPath, runDirPath } from './run.js'
import { completedVerifyReceipts, readVerifyLedger, type CompletedVerifyReceipt } from './verify.js'

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
 * A `skills_used` naming a skill this run's pinned manifest never selected for
 * this agent.
 *
 * The counter-evidence `ContradictedEvidenceError` is for a claimed pass, and
 * it exists for the same stated reason: until the engine had a record of its
 * own, "there was nothing to check it against". Here there is — the manifest is
 * written once at run start, protected from edits by `PROTECTED_BASENAMES`, and
 * names exactly which skills each role was offered — so a `skills_used` that
 * nothing joins against it would be a claim with its own witness standing
 * unasked in the run directory. Dynamic skill selection's whole point is that
 * routing is decided from records rather than asserted by a model, and a report
 * of what was *followed* is worth no more than the selection it can be checked
 * against.
 *
 * The refusal names both sides, because the recoverable action differs: an
 * agent that mistyped an id it really was offered needs the list, and one that
 * invented a skill outright needs to be told the honest answer is `[]`. A run
 * that pinned no manifest, or a role the manifest holds no row for, offers
 * nothing at all — that is not an error state, it is most runs, and `[]` is the
 * correct report for it.
 */
export class UnselectedSkillError extends Error {
  constructor(agent: string, claimed: readonly string[], offered: readonly string[]) {
    super(
      `"${agent}" reported using ${quoted(claimed)}, which this run's pinned skill manifest did not select for it. ` +
        (offered.length === 0
          ? 'Nothing was selected for this agent on this run, so "skills_used" must be [].'
          : `It was offered ${quoted(offered)}; "skills_used" may name only those, and [] when none was followed.`) +
        ' No agent may add a skill the validated selection did not produce, however well one seems to fit.',
    )
    this.name = 'UnselectedSkillError'
  }
}

function quoted(ids: readonly string[]): string {
  return ids.map((id) => `"${id}"`).join(', ')
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
 * The `order` mirror of `GateClosedError`: generic, built from the track's own
 * `order` edge rather than a hardcoded agent name, and refusing the same way —
 * nothing the blocked agent produces is recorded until the predecessor's
 * result exists.
 *
 * This is the only enforcement an engine that dispatches nothing can give an
 * `order` edge. The leader is a skill and the engine is MCP tools, so nothing
 * here stops a leader from dispatching `agent` before `predecessor` returns —
 * it can only refuse to *log* what comes back, exactly as `GateClosedError`
 * cannot stop a blocked agent from being dispatched early, only from being
 * recorded.
 */
export class OrderViolationError extends Error {
  constructor(agent: string, predecessor: string, track: string) {
    super(
      `"${agent}" is ordered after "${predecessor}" on track "${track}", and "${predecessor}" was drafted into ` +
        `this cycle but has not logged a result yet. Log "${predecessor}" first, then log "${agent}".`,
    )
    this.name = 'OrderViolationError'
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

/**
 * A planned dispatch this cycle has already answered, answered again with the
 * same result.
 *
 * The two halves of the refusal are separate facts and both are required. The
 * *input* half is the pinned plan's own `inputFingerprint`: this is the same
 * planned dispatch, not merely the same agent name — which matters because
 * strict mode gives the base dispatch and each specialist overlapping
 * dimensions by construction, so nothing about a *dimension's* state can
 * identify who answered for it. The *information* half is this dispatch's own
 * previous result file: the same verdict, over the same cited receipts, over
 * the same files. Change any of those and the repeat is carrying something, so
 * it is not refused; change none and it cost a dispatch and could not have
 * moved a dimension, which is the budget leak `max_dispatches` alone cannot
 * see.
 *
 * Raised from `runLog`'s refusal block, before anything is written, so it is
 * recoverable the way every other refusal there is.
 */
export class DuplicateQualityDispatchError extends Error {
  constructor(agent: string, instance: string | null, fingerprint: string) {
    super(
      `"${instance === null ? agent : `${agent}--${instance}`}" repeats a quality dispatch this cycle already ` +
        `answered (input fingerprint ${fingerprint.slice(0, 12)}…) with the same verdict over the same evidence ` +
        'and the same files. Re-running a dispatch against evidence that has not moved cannot move a dimension: ' +
        'run the command whose receipt is missing, or dispatch the agent the pending dimension is waiting on.',
    )
    this.name = 'DuplicateQualityDispatchError'
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

  /* 2b — the claimed skills, against the ones this run actually selected. */

  // Placed above the closing branch rather than beside the contradiction check
  // below, and that position is load-bearing for the same reason `run_id`'s is:
  // a closing agent returns through the branch that follows and never reaches
  // the ordinary path, so a join placed there would leave the one result a
  // commit rests on as the only one able to carry an unbacked claim.
  //
  // Reads nothing when the agent claimed nothing, which is every result written
  // before this field existed and every agent this run handed no skills — the
  // manifest is not even opened for them, so the unchanged-by-default path
  // stays exactly as unchanged as it was.
  await refuseUnselectedSkills(projectDir, state, agent.data, parsed.value)

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

  /* 5b — the order edges, refused the same shape the gate is. */

  // Moved above the contradiction check so an out-of-order result is refused
  // before anything is read that a legitimate write below would depend on —
  // the same reasoning that puts the gate probe ahead of it.
  const cycleDir = cycleDirPath(projectDir, state)
  const violation = await findOrderViolation(cycleDir, track, agent.data)
  if (violation !== null) throw new OrderViolationError(agent.data, violation, state.track)

  /* 6 — the contradiction check, which must precede everything that writes. */
  // Absent for every cycle of every project that predates the engine running
  // verify commands itself, and `[]` there — so the check below is inert rather
  // than newly strict about history.
  const ledger = await readVerifyLedger(cycleDir)

  refuseContradicted(projectDir, cycleDir, agent.data, parsed.value, ledger, gate?.proven_by)

  /* 6b — the repeated quality dispatch, refused where every other refusal is. */

  // Here rather than beside the recording at step 13, and the position is the
  // whole difference between a refusal and a trap. Step 13 runs after the
  // result file is written and after findings and error signatures have been
  // merged into state; a refusal thrown there leaves all of that behind and
  // the retry reproduces it. Refused from inside the block below, nothing has
  // happened yet — the same property every other refusal in this function has.
  await refuseRepeatedDispatch(projectDir, state, { agent: agent.data, instance: input.instance ?? null }, parsed.value, cycleDir)

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

  /* 13 — the quality ledger, last, because it rests on everything above. */

  // Last rather than beside the contradiction check, and that position is
  // load-bearing twice over. The refusals in steps 1-6 are the authority this
  // recording must not widen — a result they rejected must never reach a
  // dimension — and the receipt this dispatch's own `agent` evidence resolves
  // to is `cycle-NN/<basename>.json`, which does not exist until step 10 wrote
  // it. It also keeps the property every refusal above is tested for: nothing
  // here can leave a file behind for a result that was refused.
  await recordDispatchResult(projectDir, state, { agent: agent.data, instance: input.instance ?? null }, capped, now)

  return { path: file, findingsAdded: capped.findings.length, gateOpened: proof !== undefined }
}

/* ── the quality ledger, written from an already-recorded result ──────────── */

/**
 * Fold one answered dispatch into this run's quality ledger.
 *
 * It records nothing an agent asserted. The verdict comes from the result
 * `runLog` already validated and refused counter-evidence for; the receipts
 * come from the engine's own verify ledger, joined to the commands this
 * dispatch's own result cited, and from the stored result file — all of it
 * re-resolved by `resolveQualityEvidenceReceipts`, which is the single path
 * that decides what a receipt *is*. So a pass carrying only `file` evidence
 * resolves to traceability and no receipt kind at all, and a dimension
 * declaring `command` or `test` stays pending under it however many green
 * receipts the cycle happens to hold — the agent cannot promote its own claim
 * by making it, and cannot inherit a receipt it never asked for.
 *
 * Which dimensions it may touch is the pinned plan's decision, not the
 * agent's: `{agent, instance}` is matched against `planQualityDispatches`, and
 * an agent the plan did not schedule records nothing at all.
 *
 * **Counterfactual until Task 17.** The ledger is written on every run,
 * including a shadow one, because the whole point of the shadow phase is to
 * observe what the closure rule *would* have said — but nothing here may
 * change what `runLog` returns or refuses. It cannot: every failure is dropped
 * to stderr, and the one refusal this milestone adds lives in `runLog`'s own
 * refusal block, before anything is written.
 */
export async function recordDispatchResult(
  projectDir: string,
  state: State,
  dispatch: { agent: string; instance: string | null },
  result: AgentResult,
  now: Clock = () => new Date(),
): Promise<void> {
  try {
    await foldDispatchIntoLedger(projectDir, state, dispatch, result, now)
  } catch (error) {
    // Reported and dropped, for the reason the run map above gives: the result
    // is already on disk, the ledger is a projection of records that are still
    // there, and a telemetry write that could not land must not cost an agent
    // its logged findings. It cannot loosen anything either — a dimension that
    // was not recorded stays pending, and pending is what `assertRunCanPass`
    // refuses to close on.
    process.stderr.write(`mjloop: the quality ledger was not updated for "${dispatch.agent}": ${String(error)}\n`)
  }
}

async function foldDispatchIntoLedger(
  projectDir: string,
  state: State,
  dispatch: { agent: string; instance: string | null },
  result: AgentResult,
  now: Clock,
): Promise<void> {
  const plan = await scheduledDispatch(projectDir, state, dispatch)
  if (plan === null) return

  const ledger = await readLedger(projectDir, state)
  const receipts = await citedReceipts(cycleDirPath(projectDir, state), state.cycle, result)
  const selfRef = `cycle-${String(state.cycle).padStart(2, '0')}/${basenameOf(dispatch)}.json`

  const submitted: Omit<QualityEvidenceInput, 'worktree'>[] = []
  for (const dimension of plan.dispatch.dimensions) {
    // The analyzer owns applicability, and `recordQualityEvidenceBatch` refuses
    // a dimension the pinned plan marked not applicable — a refusal that aborts
    // the whole batch. Filtering here keeps that from being the only outcome of
    // an ordinary dispatch.
    const entry = ledger.dimensions[dimension]
    if (entry.applicability !== 'required') continue
    // The dispatch's own result is cited only where the pinned plan asks for
    // `agent` evidence. A dimension that asks for `command` or `test` gets the
    // engine's receipts and nothing else: routing the agent result through a
    // dimension it cannot satisfy adds no receipt kind, and `agentReceipt`
    // refuses the whole dimension when the agent labelled its own citation with
    // the wrong kind — throwing away a green engine receipt over the agent's
    // bookkeeping.
    const refs = receipts
      .filter((receipt) => entry.required_evidence.includes(receipt.kind))
      .map((receipt) => receipt.ref)
    if (entry.required_evidence.includes('agent')) refs.unshift(selfRef)
    // An empty list proves nothing, and submitting one calls `setPending` —
    // which would let a dispatch that produced no receipt at all knock out a
    // pass another dispatch earned this cycle. It is submitted in exactly two
    // cases: onto a dimension that is already pending, where the recorded
    // "references are missing" reason is the diagnostic the shadow phase exists
    // to collect; and under a `fail` or `blocked` verdict, where withdrawing a
    // pass is the answer.
    if (refs.length === 0 && entry.status !== 'pending' && result.status === 'pass') continue
    submitted.push({
      dimension,
      verdict: result.status,
      evidenceRefs: refs,
      reason: `${basenameOf(dispatch)} returned ${result.status} for ${dimension} under the pinned quality plan.`,
      criteria: plan.acceptance,
      changedFiles: result.files_touched,
    })
  }
  // Sampled after the list is built, so a dispatch with nothing to submit
  // spawns no git at all.
  if (submitted.length === 0) return
  const digest = await worktreeDigest(projectDir)
  const inputs = submitted.map((input) => ({ ...input, worktree: digest }))

  // One transition for the whole dispatch: one digest sample, one lock, and
  // every dimension of one answer stamped against the same tree. A receipt the
  // engine will not stand behind concerns only the dimension that cited it and
  // comes back in `rejected`, leaving that dimension exactly as it was —
  // pending stays pending, and pending does not close.
  //
  // The rejections are not announced. An agent citing a command it ran itself
  // rather than through `mjloop_verify_run` is ordinary, the answer is "that is
  // not a receipt", and saying so once per dimension per dispatch would put
  // four lines of noise behind every agent result on a project that opted in to
  // nothing. Where the rejection is instead a *missing* kind, the writer records
  // the reason into the dimension itself, which is where a reader looks.
  await recordQualityEvidenceBatch(projectDir, state, inputs, now)
}

/**
 * The pinned plan's entry for this `{agent, instance}`, or `null` when the run
 * has no plan or the plan never scheduled it.
 *
 * The marker rather than `ensureRunQualityPolicy`, which is what
 * `cycleRosterSet` calls. The difference is what each one owes: a roster must
 * *return* a dispatch plan, so it bootstraps a legacy run's policy to have one;
 * a logged result only records against a plan that already exists, and a run
 * pinned before this feature has none — no dispatch is scheduled, so there is
 * nothing to record. Reading rather than bootstrapping also keeps this seam
 * free of the state lock and of the integrity halt that comes with it, which is
 * what lets a closed rollout gate leave `runLog` byte-for-byte where it was.
 */
async function scheduledDispatch(
  projectDir: string,
  state: State,
  dispatch: { agent: string; instance: string | null },
): Promise<{ policy: QualityPolicy; dispatch: PlannedQualityDispatch; acceptance: string[] } | null> {
  if (state.run_id === null || state.track === null || state.quality_policy_version !== 1) return null

  const policy = await readPolicy(projectDir, state)
  const config = await loadConfig(projectDir)
  const track = findTrack(config, state.track)
  if (track === undefined) return null

  const evidence = await resolveQualityContextEvidence(projectDir, { story: state.current.story, allowMissingStory: true })
  const planned = planQualityDispatches({
    trackName: state.track,
    track,
    config,
    policy,
    goal: state.goal ?? '',
    ...evidence,
  })
  const scheduled = planned.find(
    (candidate) => candidate.agent === dispatch.agent && (candidate.instance ?? null) === dispatch.instance,
  )
  return scheduled === undefined ? null : { policy, dispatch: scheduled, acceptance: evidence.acceptance }
}

/**
 * The engine receipts this dispatch's own result cites, and no others.
 *
 * **Attribution is the whole point.** A verify receipt records that the engine
 * ran a command; it does not record who asked for it. Citing every completed
 * receipt of a declared kind would close `correctness` on somebody else's green
 * `npm test`, and close `security` — which declares `command` — on a green
 * `npm run lint` that has nothing to do with security, for a dispatch that
 * returned `pass` carrying only `file` evidence. The dispatch's own evidence
 * list is the only attribution available, so that is what is joined on: the
 * agent names a command, and the engine supplies the receipt for it. The agent
 * never supplies the kind — `slot` does.
 *
 * **The latest invocation per identity, and only this cycle's.** A cycle that
 * ran one slot twice under different labels leaves an earlier receipt that
 * `resolveQualityEvidenceReceipts` rejects as "superseded by a later
 * invocation", and a prior cycle's receipt can fail the current-tree
 * fingerprint. Either would be one poisoned ref in a list resolved as a whole,
 * throwing away a dimension over an entry the dispatch never needed. Selecting
 * the survivor up front means nothing citable can be rejected for being stale.
 *
 * Outcome must match the verdict for the same reason: a receipt contradicting
 * the verdict is refused downstream, and refusing it is *correct* when the
 * dispatch cited it directly — which it still does, through the agent receipt.
 * `blocked` cites none at all: a verify receipt can prove a command's outcome
 * and never that a tool was unavailable.
 */
async function citedReceipts(
  cycleDir: string,
  cycle: number,
  result: AgentResult,
): Promise<CompletedVerifyReceipt[]> {
  if (result.status === 'blocked') return []
  const named = new Set(result.evidence.filter((entry) => entry.kind !== 'file').map((entry) => entry.ref))
  const latest = new Map<string, CompletedVerifyReceipt>()
  for (const receipt of await completedVerifyReceipts(cycleDir, cycle)) {
    if (!named.has(receipt.command) && !named.has(receipt.ref)) continue
    if (receipt.passed !== (result.status === 'pass')) continue
    latest.set(`${receipt.slot}\0${receipt.command}`, receipt)
  }
  return [...latest.values()]
}

/**
 * Refuse a planned dispatch this cycle has already answered with the same
 * result.
 *
 * Keyed on **this dispatch's own** prior answer — the `cycle-NN/<basename>.json`
 * its previous run left behind — and never on the ledger's state, which several
 * dispatches share. In strict mode the plan gives the base dispatch and each
 * specialist an overlapping dimension by construction, so a rule that read "some
 * dimension I was assigned is already recorded and I moved nothing" would refuse
 * a specialist's first-ever run because the base dispatch got there first.
 *
 * "No new information" is decided on what could move a dimension: the verdict,
 * the receipts the result cites, and the files it touched. An excerpt that reads
 * differently over the same receipts is the same evidence, and findings are the
 * cycle's business rather than the ledger's.
 *
 * Gated on the release capability and the run's own pinned intent together,
 * exactly as `cycleRosterSet` gates `roster.quality`. With the gate closed this
 * reads nothing at all.
 */
async function refuseRepeatedDispatch(
  projectDir: string,
  state: State,
  dispatch: { agent: string; instance: string | null },
  result: AgentResult,
  cycleDir: string,
): Promise<void> {
  if (!qualityRuntimeEnabled()) return

  const plan = await scheduledDispatch(projectDir, state, dispatch)
  if (plan === null || plan.policy.enforcement !== 'active') return

  const raw = await fs.readFile(path.join(cycleDir, `${basenameOf(dispatch)}.json`), 'utf8').catch(() => null)
  if (raw === null) return
  let previous: AgentResult
  try {
    const parsed = AgentResultSchema.safeParse(JSON.parse(raw) as unknown)
    if (!parsed.success) return
    previous = parsed.data
  } catch {
    return
  }

  if (answerIdentity(previous) !== answerIdentity(result)) return
  throw new DuplicateQualityDispatchError(dispatch.agent, dispatch.instance, plan.dispatch.inputFingerprint)
}

/** What a dispatch actually told the ledger: its verdict, the receipts it cited, and the files it touched. */
function answerIdentity(result: AgentResult): string {
  return JSON.stringify({
    status: result.status,
    evidence: result.evidence.map((entry) => [entry.kind, entry.ref]).sort(),
    files: [...result.files_touched].sort(),
  })
}

/** The one spelling `runLog`'s own writer uses, so a receipt ref and its file cannot drift apart. */
function basenameOf(dispatch: { agent: string; instance: string | null }): string {
  return dispatch.instance === null ? dispatch.agent : `${dispatch.agent}--${dispatch.instance}`
}

/* ── the pinned skill manifest, read rather than written ──────────────────── */

/**
 * Refuse a result claiming a skill this run never selected for this agent.
 *
 * Returns immediately when the agent claimed nothing, and that early return is
 * what keeps every result the engine has ever written on exactly the path it
 * was already on: `skills_used` defaults to `[]`, so the file below is not even
 * opened for a run that pinned no manifest and an agent that named no skill —
 * which is every run today and most runs forever.
 *
 * A manifest that is absent, unreadable, or will not parse offers nothing,
 * rather than excusing the claim. That direction is deliberate and it is the
 * one that fails safe: an unreadable pin is exactly the circumstance in which
 * an unverifiable claim would otherwise slip through, and the correct report
 * against a selection nobody can read is `[]`. It is also the same tolerance
 * the handoff applies to the same file, read the other way round — a document
 * that cannot be assembled must not fail a cycle, and a claim that cannot be
 * checked must not be recorded as checked.
 *
 * The manifest's rows cover the four fixed roles skill selection routes for;
 * every other agent a track defines — `editor`, `fixer`, `scout`, `docs` — has
 * no row and is therefore offered nothing, which is the correct answer under
 * this story's model rather than an oversight of it: those roles are dispatched
 * without a per-component routing decision, so there is no selection for them
 * to have followed.
 */
async function refuseUnselectedSkills(
  projectDir: string,
  state: State,
  agent: string,
  result: AgentResult,
): Promise<void> {
  if (result.skills_used.length === 0) return

  const offered = await selectedSkillsFor(projectDir, state, agent)
  const claimed = result.skills_used.filter((skillId) => !offered.has(skillId))
  if (claimed.length > 0) throw new UnselectedSkillError(agent, claimed, [...offered].sort())
}

/** Every skill id this run's pinned manifest selected for one agent, in any component. */
async function selectedSkillsFor(projectDir: string, state: State, agent: string): Promise<Set<string>> {
  if (state.run_id === null || state.track === null) return new Set()

  const file = path.join(runDirPath(projectDir, state), SKILL_MANIFEST_FILE)
  const raw = await fs.readFile(file, 'utf8').catch(() => null)
  if (raw === null) return new Set()

  const parsed = safeJson(raw)
  if (parsed === null) return new Set()

  return new Set(
    parsed.selections.filter((selection) => selection.agent === agent).flatMap((selection) => selection.skillIds),
  )
}

/** The manifest, or `null` for anything that will not read back as one. */
function safeJson(raw: string): SkillManifest | null {
  try {
    const parsed = SkillManifestSchema.safeParse(JSON.parse(raw) as unknown)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/* ── the cycle roster, read rather than written ────────────────────────────── */

/**
 * Fields `cycle-NN/roster.json` carries that this check needs, read leniently
 * rather than through `RosterSchema`. That schema is `strictObject` and
 * requires `cycle`; a roster written by a later milestone that adds a key
 * must still tell this check who was drafted, so an unrecognised key must not
 * fail the read the way it correctly fails `rosterSet`'s own write.
 */
const CycleRosterFields = z.object({ selected: z.array(z.string().min(1)).default([]) })

/** This cycle's declared `selected` set, or `null` for anything that will not read back as one. */
async function selectedThisCycle(cycleDir: string): Promise<Set<string> | null> {
  try {
    const raw = await fs.readFile(path.join(cycleDir, 'roster.json'), 'utf8')
    const parsed = CycleRosterFields.safeParse(JSON.parse(raw) as unknown)
    return parsed.success ? new Set(parsed.data.selected) : null
  } catch {
    return null
  }
}

/**
 * The predecessor `agent` is ordered after but has no logged result yet, or
 * `null` when nothing in `track.order` blocks it.
 *
 * Reads `cycle-NN/roster.json` from disk rather than any in-memory record of
 * what has run, and that is load-bearing rather than incidental: the leader's
 * resume path (`skills/mjloop-leader/SKILL.md` step 2a) picks an interrupted
 * cycle back up from exactly the result files already on disk, with no
 * dispatch history surviving the restart that carried it there. A check keyed
 * on anything else would refuse every agent after the first on every resume.
 *
 * Applies the same vacuous-edge rule `dispatchWaves` applies: a predecessor
 * this cycle never drafted cannot be waited on, so an edge naming one is
 * satisfied rather than violated. A roster that is missing or will not parse
 * is read the same way `refuseUnselectedSkills` reads a missing manifest —
 * as "nothing on record", which is fail-open here. The alternative — refusing
 * every result until a roster exists — would make `runLog` a second, stricter
 * copy of the "declare the roster first" rule `mjloop-leader/SKILL.md` step 3
 * already states in prose, and wrong about it whenever a project reads a
 * roster this check cannot parse for a reason that has nothing to do with
 * ordering.
 */
async function findOrderViolation(cycleDir: string, track: Track, agent: string): Promise<string | null> {
  const edges = track.order.filter((edge) => edge.agent === agent)
  if (edges.length === 0) return null

  const selected = await selectedThisCycle(cycleDir)
  if (selected === null) return null

  for (const edge of edges) {
    for (const predecessor of edge.after) {
      if (!selected.has(predecessor)) continue // vacuous: predecessor was not drafted this cycle
      if (!(await predecessorLogged(cycleDir, predecessor))) return predecessor
    }
  }
  return null
}

/**
 * Whether `predecessor` has a logged result anywhere in `cycleDir`, honouring
 * an instanced result the same way the rest of the engine already reads a
 * cycle directory. `runLog`'s own writer (above, the `basename` built from
 * `agent.data` and an optional `instance`) files an instanced result as
 * `<agent>--<instance>.json`, and `ops/run.ts`'s `readAgentReports` resolves
 * the agent from a basename by splitting on the first `--` for exactly that
 * reason (`ops/run.ts:915-917`: "an agent name may not contain `--`, so the
 * first split is the agent"). An exact `${predecessor}.json` match alone
 * would deadlock any order edge whose predecessor only ever logs under an
 * instance — reachable today on the shipped `fix` track, whose leader skill
 * (`skills/mjloop-leader/SKILL.md:193-196`) fans `hypothesis-tester` out
 * N-wide, each with a distinct `instance`, and never logs it under its bare
 * name.
 */
async function predecessorLogged(cycleDir: string, predecessor: string): Promise<boolean> {
  const entries = await fs.readdir(cycleDir).catch(() => [] as string[])
  return entries.some((name) => {
    if (!name.endsWith('.json')) return false
    const basename = name.slice(0, -'.json'.length)
    return basename === predecessor || basename.startsWith(`${predecessor}--`)
  })
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
