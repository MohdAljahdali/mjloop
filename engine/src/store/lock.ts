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

interface LockSnapshot {
  /** Filesystem device + inode of the lock directory: a unique identity for
   * one specific mkdir'd instance, available the moment mkdir returns — no
   * follow-up write is needed to establish it, unlike a token file. */
  dev: number
  ino: number
  /** Creation time of this specific instance. `dev`/`ino` alone are not
   * quite enough under very rapid create-delete-create cycling: a freshly
   * created directory can be handed a *reused* inode number by the
   * filesystem, coincidentally matching one just deleted. `birthtimeMs`
   * guards against that: it reflects genuine creation time and is not
   * touched by the `utimes` backdating used elsewhere to simulate an aged
   * lock, so a reused inode still shows a distinct birth time. */
  birthtimeMs: number
  ageMs: number
}

/**
 * Directory-based mutual exclusion. `mkdir` is atomic on every supported
 * filesystem, which is what keeps parallel agents from interleaving writes.
 *
 * Both release (`finally`) and stale-lock reclaim must be careful not to
 * delete a lock directory that no longer belongs to the caller trying to
 * delete it: a release must not clobber a lock some other caller now holds,
 * and a reclaim must not delete a lock that changed hands (was released
 * normally, or was re-acquired by someone else) between the staleness check
 * and the delete. Both checks compare the directory's filesystem identity —
 * (dev, ino, birthtime) — immediately before deleting, against the identity
 * observed a moment earlier. This identity is assigned atomically by
 * `mkdir` itself and needs no follow-up write, so — unlike an owner token
 * written to a file inside the directory after the fact — there is never a
 * window where the directory exists but has no identity yet for a
 * concurrent waiter to be misled by.
 */
export async function withLock<T>(lockDir: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const { timeoutMs = 5000, staleMs = 30_000, pollMs = 25 } = options
  const deadline = Date.now() + timeoutMs

  let ownedSnapshot: LockSnapshot | null = null
  while (ownedSnapshot === null) {
    try {
      await fs.mkdir(lockDir, { recursive: false })
      // The directory we just created might, in principle, be removed by an
      // extremely unlucky concurrent reclaimer before we get to stat it (see
      // reclaimIfSameInstance below); if so, snapshot is null and we simply
      // retry the whole loop rather than treating it as fatal.
      ownedSnapshot = await statSnapshot(lockDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      // Checked before the stale-reclaim branch as well as the waiting
      // branch: reclaiming can fail to make progress round after round
      // (e.g. the reclaim marker is contended), and a path that never
      // reaches the deadline check would spin forever instead of failing
      // with a diagnosable timeout.
      if (Date.now() >= deadline) {
        throw new LockTimeoutError(`could not acquire ${lockDir} within ${timeoutMs}ms`)
      }
      const observed = await statSnapshot(lockDir)
      if (observed !== null && observed.ageMs >= staleMs) {
        await reclaimIfSameInstance(lockDir, observed, pollMs, staleMs)
        continue
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  }

  try {
    return await fn()
  } finally {
    // Only remove the lock if it is still the exact directory instance this
    // call created. If a different instance now sits at this path, some
    // other caller owns it — most likely because staleMs was set
    // aggressively low and a reclaimer stepped in — and removing it here
    // would break that caller's mutual exclusion instead of protecting it.
    const current = await statSnapshot(lockDir)
    if (current !== null && isSameInstance(current, ownedSnapshot)) {
      await fs.rm(lockDir, { recursive: true, force: true })
    }
  }
}

/**
 * Removes an abandoned lock directory, but only if it is still the exact
 * instance whose staleness was just checked.
 *
 * The verify-then-delete pair below is not, by itself, atomic: `fs.rm`
 * operates on a path, not on the specific instance identified by `observed`,
 * so if a large enough delay separates the check from the actual delete
 * syscall, a fresh instance could in principle occupy that path by the time
 * `rm` runs. Multiple *concurrent* reclaimers made that delay realistic —
 * each was independently queued behind the filesystem's thread pool, so a
 * straggler's check-then-delete pair could straddle another reclaimer's
 * entire successful reclaim-and-reacquire cycle. Reclaiming is therefore
 * serialised through `reclaimMarker`, a plain `mkdir`-based mutex: only the
 * one waiter that wins it ever performs the verify-then-delete pair for a
 * given round, so there is no pile-up of competing, independently-delayed
 * delete attempts to straddle a fresh acquisition. Everyone else backs off
 * and retries from the top, relying on the marker holder (or, if it was
 * mistaken, the lock's real owner) to resolve things.
 */
async function reclaimIfSameInstance(
  lockDir: string,
  observed: LockSnapshot,
  pollMs: number,
  staleMs: number,
): Promise<void> {
  const reclaimMarker = `${lockDir}.reclaiming`
  try {
    await fs.mkdir(reclaimMarker)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      // Someone else is already reclaiming this round; let them finish —
      // unless the marker itself is stale. A live reclaimer holds it only
      // for a stat-and-delete, so a marker aged past staleMs belongs to a
      // reclaimer that died between creating it and its finally-cleanup;
      // without this check an orphaned marker blocks reclaiming forever.
      const marker = await statSnapshot(reclaimMarker)
      if (marker !== null && marker.ageMs >= staleMs) {
        await fs.rm(reclaimMarker, { recursive: true, force: true })
      } else {
        await new Promise((resolve) => setTimeout(resolve, pollMs))
      }
      return
    }
    throw error
  }

  try {
    const current = await statSnapshot(lockDir)
    if (current === null || !isSameInstance(current, observed)) return // it changed hands; leave it alone
    await fs.rm(lockDir, { recursive: true, force: true })
  } finally {
    await fs.rm(reclaimMarker, { recursive: true, force: true })
  }
}

function isSameInstance(a: LockSnapshot, b: LockSnapshot): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs
}

async function statSnapshot(lockDir: string): Promise<LockSnapshot | null> {
  try {
    const stats = await fs.stat(lockDir)
    return { dev: stats.dev, ino: stats.ino, birthtimeMs: stats.birthtimeMs, ageMs: Date.now() - stats.mtimeMs }
  } catch {
    return null
  }
}
