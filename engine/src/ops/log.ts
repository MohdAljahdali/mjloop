import fs from 'node:fs/promises'
import path from 'node:path'
import * as z from 'zod'
import { findTrack, forbiddenSpecialists, permittedAgents } from '../schemas/config.js'
import { AgentNameSchema, parseAgentResult } from '../schemas/contract.js'
import { loadConfig } from '../store/config-store.js'
import { StateStore, type Clock } from '../store/state-store.js'
import { errorSignature } from './fingerprint.js'
import { NoActiveRunError, UnknownTrackError, cycleDirPath } from './run.js'

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
      `"${agent}" is not in track "${track}" — add it to required or available first ` +
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
        `reach its history. Drop it from the cycle, or change specialists.${agent} in .loop/config.yaml.`,
    )
    this.name = 'ForbiddenSpecialistError'
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

export interface RunLogInput {
  agent: string
  /**
   * Distinguishes concurrent runs of the same agent. N hypothesis testers in
   * one cycle would otherwise all write `hypothesis-tester.json`, and the
   * cycle would record one verdict where it produced N.
   */
  instance?: string
  /** Unvalidated — this is where an agent's raw return value is checked. */
  result: unknown
}

export async function runLog(
  projectDir: string,
  input: RunLogInput,
  now: Clock = () => new Date(),
): Promise<{ path: string; findingsAdded: number; gateOpened: boolean }> {
  const agent = AgentNameSchema.safeParse(input.agent)
  if (!agent.success) throw new InvalidAgentNameError(input.agent, z.prettifyError(agent.error))

  const parsed = parseAgentResult(input.result)
  if (!parsed.ok) throw new InvalidAgentResultError(agent.data, parsed.error)

  const store = new StateStore(projectDir, now)
  const state = await store.get()
  if (state.status !== 'running' || state.track === null) throw new NoActiveRunError()

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

  // The gate opens as a side effect of the ordinary evidence-bound channel.
  // There is no tool that simply declares a defect reproduced: the engine
  // cannot read an excerpt and confirm it shows a failure, but it can insist
  // the claim came from the designated agent, carried command or test
  // evidence, and passed contract validation on the way in.
  const proof =
    gate !== undefined && agent.data === gate.proven_by && parsed.value.status === 'pass'
      ? parsed.value.evidence.find((entry) => entry.kind === 'command' || entry.kind === 'test')
      : undefined

  const signatures = errorSignature(parsed.value.evidence, parsed.value.status)

  // Validated by the same schema as the agent name: anything that reaches the
  // filesystem goes through one check, in one place.
  let basename = agent.data
  if (input.instance !== undefined) {
    const instance = AgentNameSchema.safeParse(input.instance)
    if (!instance.success) throw new InvalidAgentNameError(input.instance, z.prettifyError(instance.error))
    basename = `${agent.data}--${instance.data}`
  }

  const cycleDir = cycleDirPath(projectDir, state)
  await fs.mkdir(cycleDir, { recursive: true })
  const file = path.join(cycleDir, `${basename}.json`)
  await fs.writeFile(file, `${JSON.stringify(parsed.value, null, 2)}\n`, 'utf8')

  if (parsed.value.findings.length > 0 || proof !== undefined || signatures.length > 0) {
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
      draft.findings.push(...parsed.value.findings)
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

  return { path: file, findingsAdded: parsed.value.findings.length, gateOpened: proof !== undefined }
}
