import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LockTimeoutError, withLock } from '../../src/store/lock.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

let project: TmpProject
let lockDir: string

beforeEach(async () => {
  project = await makeTmpProject()
  lockDir = path.join(project.dir, '.lock')
})
afterEach(async () => { await project.cleanup() })

describe('withLock', () => {
  it('returns the callback result and releases the lock', async () => {
    const result = await withLock(lockDir, async () => 42)
    expect(result).toBe(42)
    await expect(fs.access(lockDir)).rejects.toThrow()
  })

  it('releases the lock even when the callback throws', async () => {
    await expect(withLock(lockDir, async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(fs.access(lockDir)).rejects.toThrow()
  })

  it('serialises concurrent writers', async () => {
    const order: string[] = []
    // The second withLock starts only once the first is provably inside
    // fn(): starting both back to back races their initial mkdir calls on
    // the filesystem thread pool, and nothing guarantees the first call
    // wins — the test would then fail on ordering while mutual exclusion
    // actually held.
    let signalEntered!: () => void
    const entered = new Promise<void>((resolve) => { signalEntered = resolve })
    const slow = withLock(lockDir, async () => {
      order.push('a-start')
      signalEntered()
      await new Promise((resolve) => setTimeout(resolve, 60))
      order.push('a-end')
    })
    await entered
    const fast = withLock(lockDir, async () => { order.push('b') }, { pollMs: 5 })
    await Promise.all([slow, fast])
    expect(order).toEqual(['a-start', 'a-end', 'b'])
  })

  it('times out when the lock is held too long', async () => {
    await fs.mkdir(lockDir)
    await expect(
      withLock(lockDir, async () => 'never', { timeoutMs: 60, pollMs: 5, staleMs: 60_000 }),
    ).rejects.toBeInstanceOf(LockTimeoutError)
    await fs.rm(lockDir, { recursive: true, force: true })
  })

  it('reclaims a stale lock left by a dead process', async () => {
    await fs.mkdir(lockDir)
    const result = await withLock(lockDir, async () => 'reclaimed', { staleMs: 0, pollMs: 5, timeoutMs: 500 })
    expect(result).toBe('reclaimed')
  })

  it('reclaims a stale lock even when a crashed reclaimer left its marker behind', async () => {
    // A reclaimer that dies between creating `.lock.reclaiming` and its
    // finally-cleanup orphans the marker; both lock and marker are backdated
    // past staleMs, so the marker must be reclaimed too or the lock is
    // bricked forever.
    await fs.mkdir(lockDir)
    await fs.mkdir(`${lockDir}.reclaiming`)
    const past = new Date(Date.now() - 10_000)
    await fs.utimes(lockDir, past, past)
    await fs.utimes(`${lockDir}.reclaiming`, past, past)

    const result = await withLock(lockDir, async () => 'recovered', { staleMs: 50, pollMs: 5, timeoutMs: 2000 })
    expect(result).toBe('recovered')
  })

  it('times out instead of spinning forever when reclaim cannot make progress', async () => {
    // Stale lock, fresh marker: the reclaim branch runs every round but never
    // succeeds (the marker stays under staleMs for the whole test), so the
    // deadline check must fire on this path too.
    await fs.mkdir(lockDir)
    const past = new Date(Date.now() - 10_000)
    await fs.utimes(lockDir, past, past)
    await fs.mkdir(`${lockDir}.reclaiming`)

    await expect(
      withLock(lockDir, async () => 'never', { staleMs: 5000, pollMs: 5, timeoutMs: 200 }),
    ).rejects.toBeInstanceOf(LockTimeoutError)
    await fs.rm(`${lockDir}.reclaiming`, { recursive: true, force: true })
    await fs.rm(lockDir, { recursive: true, force: true })
  })

  it('never runs two callbacks concurrently when many waiters race the same stale lock', async () => {
    // Simulate a lock abandoned by a dead process: the directory exists, no
    // one is actively holding it, and its mtime is backdated well past
    // staleMs so every waiter immediately considers it reclaimable — they
    // all race the reclaim-then-acquire path at once, which is exactly the
    // interleaving the TOCTOU fix must prevent. staleMs (500ms) is kept
    // generously above each callback's runtime (10ms) so a *freshly*
    // acquired lock is never itself mistaken for stale by another waiter —
    // that would be a separate, inherent limitation of timestamp-only
    // staleness detection (no heartbeat), not the race under test here, and
    // is why production code should always set staleMs far above any
    // realistic fn() duration (the 30s default already assumes this).
    //
    // waiterCount (8) matters: against the pre-fix implementation this
    // reproduces the race in roughly half of runs at this contention level
    // (verified during development); at 2 waiters the same pre-fix code
    // happened not to fail reliably on this machine, which would have made
    // a 2-waiter version of this test pass "by accident" against a reverted
    // fix rather than by demonstrating correctness. The extra file below is
    // not read by withLock — its only purpose is to reproduce, on this
    // machine, the filesystem-thread-pool timing under which the pre-fix
    // race was empirically most reliable; removing it made the race harder
    // to reproduce without changing whether it exists.
    await fs.mkdir(lockDir)
    await fs.writeFile(path.join(lockDir, 'marker'), 'dead-process')
    const past = new Date(Date.now() - 10_000)
    await fs.utimes(lockDir, past, past)

    let active = 0
    let overlapDetected = false
    const events: string[] = []
    const waiterCount = 8

    const waiters = Array.from({ length: waiterCount }, (_, index) =>
      withLock(
        lockDir,
        async () => {
          active += 1
          if (active > 1) overlapDetected = true
          events.push(`enter-${index}`)
          await new Promise((resolve) => setTimeout(resolve, 10))
          events.push(`exit-${index}`)
          active -= 1
        },
        { staleMs: 500, pollMs: 3, timeoutMs: 5000 },
      ),
    )

    await Promise.all(waiters)

    expect(overlapDetected).toBe(false)
    expect(events).toHaveLength(waiterCount * 2)
  })

  it('does not remove a lock it no longer owns on release', async () => {
    const held = withLock(lockDir, async () => {
      // Give the test time to simulate another owner taking over the lock
      // directory before this call's finally block runs.
      await new Promise((resolve) => setTimeout(resolve, 40))
    })

    // Wait for the real holder to acquire the directory.
    await new Promise((resolve) => setTimeout(resolve, 10))

    // Simulate another process legitimately reclaiming/recreating the lock
    // directory while the first holder is still inside fn() (e.g. a very
    // aggressive staleMs elsewhere). Removing and recreating gives this
    // "impostor" directory a fresh (dev, ino) identity distinct from the
    // first holder's — it must survive the first holder's release.
    await fs.rm(lockDir, { recursive: true, force: true })
    await fs.mkdir(lockDir)
    const impostorStatBefore = await fs.stat(lockDir)

    await held

    const impostorStatAfter = await fs.stat(lockDir)
    expect(impostorStatAfter.ino).toBe(impostorStatBefore.ino)
    expect(impostorStatAfter.dev).toBe(impostorStatBefore.dev)
  })
})
