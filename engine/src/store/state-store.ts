import * as z from 'zod'
import { StateSchema, type State } from '../schemas/state.js'
import { readJsonValidated, writeJsonAtomic } from './atomic.js'
import { withLock } from './lock.js'
import { resolveLoopPaths, type LoopPaths } from './paths.js'

export type Clock = () => Date

export class InvalidStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidStateError'
  }
}

/**
 * The only writer of `.loop/state.json`. Every mutation runs under the write
 * lock, is validated before it lands, and is written atomically.
 */
export class StateStore {
  private readonly paths: LoopPaths

  constructor(projectDir: string, private readonly now: Clock = () => new Date()) {
    this.paths = resolveLoopPaths(projectDir)
  }

  async get(): Promise<State> {
    const { value } = await readJsonValidated(this.paths.state, StateSchema)
    return value
  }

  async update(mutate: (draft: State) => void | Promise<void>): Promise<State> {
    return withLock(this.paths.lock, async () => {
      const { value, recovered } = await readJsonValidated(this.paths.state, StateSchema)
      const draft = structuredClone(value)
      await mutate(draft)
      draft.updated_at = this.now().toISOString()

      const parsed = StateSchema.safeParse(draft)
      if (!parsed.success) throw new InvalidStateError(z.prettifyError(parsed.error))

      // When the read recovered from `.bak`, the file currently on disk is
      // the corrupt primary — backing it up would replace the good backup.
      await writeJsonAtomic(this.paths.state, parsed.data, { backup: !recovered })
      return parsed.data
    })
  }
}
