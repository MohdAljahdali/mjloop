import fs from 'node:fs/promises'

export class LockTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LockTimeoutError'
  }
}

export interface LockOptions {
  /** How long to wait for the lock before giving up. Default 5000ms. */
  timeoutMs?: number
  /** A lock older than this is assumed abandoned and reclaimed. Default 30000ms. */
  staleMs?: number
  /** Retry interval. Default 25ms. */
  pollMs?: number
}

/**
 * Directory-based mutual exclusion. `mkdir` is atomic on every supported
 * filesystem, which is what keeps parallel agents from interleaving writes.
 */
export async function withLock<T>(lockDir: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const { timeoutMs = 5000, staleMs = 30_000, pollMs = 25 } = options
  const deadline = Date.now() + timeoutMs

  for (;;) {
    try {
      await fs.mkdir(lockDir, { recursive: false })
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const age = await lockAgeMs(lockDir)
      if (age !== null && age >= staleMs) {
        await fs.rm(lockDir, { recursive: true, force: true })
        continue
      }
      if (Date.now() >= deadline) {
        throw new LockTimeoutError(`could not acquire ${lockDir} within ${timeoutMs}ms`)
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  }

  try {
    return await fn()
  } finally {
    await fs.rm(lockDir, { recursive: true, force: true })
  }
}

async function lockAgeMs(lockDir: string): Promise<number | null> {
  try {
    const stats = await fs.stat(lockDir)
    return Date.now() - stats.mtimeMs
  } catch {
    return null
  }
}
