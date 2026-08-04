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
 * The only writer of `.mjloop/state.json`. Every mutation runs under the write
 * lock, is validated before it lands, and is written atomically.
 */
export class StateStore {
  private readonly paths: LoopPaths

  constructor(projectDir: string, private readonly now: Clock = () => new Date()) {
    this.paths = resolveLoopPaths(projectDir)
  }

  async get(): Promise<State> {
    return (await this.read()).state
  }

  /**
   * The state plus whether it came from `.bak`. Most callers want `get`; a
   * caller that acts on the state rather than reporting it needs to know the
   * primary was unreadable, because a recovered value is by definition the
   * *previous* write — stale by exactly one update.
   */
  async read(): Promise<{ state: State; recovered: boolean }> {
    const { value, recovered } = await readJsonValidated(this.paths.state, StateSchema)
    return { state: value, recovered }
  }

  async update(mutate: (draft: State) => void | Promise<void>): Promise<State> {
    return withLock(this.paths.lock, async (ownership) => {
      const { value, recovered } = await readJsonValidated(this.paths.state, StateSchema)
      const draft = structuredClone(value)
      await mutate(draft)
      draft.updated_at = this.now().toISOString()

      const parsed = StateSchema.safeParse(draft)
      if (!parsed.success) throw new InvalidStateError(z.prettifyError(parsed.error))

      // When the read recovered from `.bak`, the file currently on disk is
      // the corrupt primary — backing it up would replace the good backup.
      await ownership.runIfOwned(async (stagingDir) => {
        await writeJsonAtomic(this.paths.state, parsed.data, { backup: !recovered, stagingDir })
      })
      return parsed.data
    })
  }
}
