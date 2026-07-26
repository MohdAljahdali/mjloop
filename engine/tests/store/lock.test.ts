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
    const slow = withLock(lockDir, async () => {
      order.push('a-start')
      await new Promise((resolve) => setTimeout(resolve, 60))
      order.push('a-end')
    })
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
})
