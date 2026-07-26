import fs from 'node:fs/promises'
import path from 'node:path'
import { parseAgentResult } from '../schemas/contract.js'
import { StateStore, type Clock } from '../store/state-store.js'
import { NoActiveRunError, runDirPath } from './run.js'

export class InvalidAgentResultError extends Error {
  constructor(agent: string, detail: string) {
    super(`"${agent}" returned a result that does not match the agent contract:\n${detail}`)
    this.name = 'InvalidAgentResultError'
  }
}

export interface RunLogInput {
  agent: string
  /** Unvalidated — this is where an agent's raw return value is checked. */
  result: unknown
}

export async function runLog(
  projectDir: string,
  input: RunLogInput,
  now: Clock = () => new Date(),
): Promise<{ path: string; findingsAdded: number }> {
  const parsed = parseAgentResult(input.result)
  if (!parsed.ok) throw new InvalidAgentResultError(input.agent, parsed.error)

  const store = new StateStore(projectDir, now)
  const state = await store.get()
  if (state.status !== 'running') throw new NoActiveRunError()

  const cycleDir = path.join(runDirPath(projectDir, state), `cycle-${String(state.cycle).padStart(2, '0')}`)
  await fs.mkdir(cycleDir, { recursive: true })
  const file = path.join(cycleDir, `${input.agent}.json`)
  await fs.writeFile(file, `${JSON.stringify(parsed.value, null, 2)}\n`, 'utf8')

  if (parsed.value.findings.length > 0) {
    await store.update((draft) => {
      draft.findings.push(...parsed.value.findings)
    })
  }

  return { path: file, findingsAdded: parsed.value.findings.length }
}
