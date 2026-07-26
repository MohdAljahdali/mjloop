import fs from 'node:fs/promises'
import path from 'node:path'
import * as z from 'zod'
import { AgentNameSchema, parseAgentResult } from '../schemas/contract.js'
import { loadConfig } from '../store/config-store.js'
import { StateStore, type Clock } from '../store/state-store.js'
import { NoActiveRunError, cycleDirPath } from './run.js'

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

export class CycleClosedError extends Error {
  constructor(agent: string, logged: number, current: number) {
    super(
      `cycle ${logged} closed while "${agent}" was being logged — the run is now at cycle ${current}. ` +
        'Its findings were not folded in; log the result against the open cycle.',
    )
    this.name = 'CycleClosedError'
  }
}

export class ReproductionGateError extends Error {
  constructor(agent: string, provenBy: string) {
    super(
      `"${agent}" is blocked by the "${provenBy}" gate on this track. Nothing it produces can be recorded until ` +
        `"${provenBy}" returns status "pass" carrying command or test evidence that the defect is real. ` +
        'Reproduce the defect first, or halt the run — do not fix what has not been demonstrated.',
    )
    this.name = 'ReproductionGateError'
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
  if (state.status !== 'running') throw new NoActiveRunError()

  // runLog reads config for the first time here: the gate is a property of the
  // running track, and a track is configuration.
  const config = await loadConfig(projectDir)
  const gate = state.track === null ? undefined : config.tracks[state.track]?.gate

  if (gate !== undefined && state.reproduction === null && gate.blocks.includes(agent.data)) {
    throw new ReproductionGateError(agent.data, gate.proven_by)
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

  if (parsed.value.findings.length > 0 || proof !== undefined) {
    await store.update((draft) => {
      // The read above was not locked, so a `cycleAdvance` may have landed in
      // between: it has archived the cycle these findings belong to and either
      // opened the next one or ended the run. Pushing now would file this
      // agent's work under a cycle that did not do it — or leave an open
      // finding on a run that is already `done`.
      if (draft.status !== 'running') throw new NoActiveRunError()
      if (draft.cycle !== state.cycle) throw new CycleClosedError(agent.data, state.cycle, draft.cycle)
      draft.findings.push(...parsed.value.findings)
      if (proof !== undefined) {
        draft.reproduction = { agent: agent.data, cycle: draft.cycle, ref: proof.ref, excerpt: proof.excerpt }
      }
    })
  }

  return { path: file, findingsAdded: parsed.value.findings.length, gateOpened: proof !== undefined }
}
