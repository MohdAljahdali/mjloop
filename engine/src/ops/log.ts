import fs from 'node:fs/promises'
import path from 'node:path'
import * as z from 'zod'
import { AgentNameSchema, parseAgentResult } from '../schemas/contract.js'
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
): Promise<{ path: string; findingsAdded: number }> {
  const agent = AgentNameSchema.safeParse(input.agent)
  if (!agent.success) throw new InvalidAgentNameError(input.agent, z.prettifyError(agent.error))

  const parsed = parseAgentResult(input.result)
  if (!parsed.ok) throw new InvalidAgentResultError(agent.data, parsed.error)

  const store = new StateStore(projectDir, now)
  const state = await store.get()
  if (state.status !== 'running') throw new NoActiveRunError()

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

  if (parsed.value.findings.length > 0) {
    await store.update((draft) => {
      // The read above was not locked, so a `cycleAdvance` may have landed in
      // between: it has archived the cycle these findings belong to and either
      // opened the next one or ended the run. Pushing now would file this
      // agent's work under a cycle that did not do it — or leave an open
      // finding on a run that is already `done`.
      if (draft.status !== 'running') throw new NoActiveRunError()
      if (draft.cycle !== state.cycle) throw new CycleClosedError(agent.data, state.cycle, draft.cycle)
      draft.findings.push(...parsed.value.findings)
    })
  }

  return { path: file, findingsAdded: parsed.value.findings.length }
}
