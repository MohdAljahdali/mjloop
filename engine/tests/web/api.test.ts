import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initLoop } from '../../src/ops/init.js'
import { gateSet, planCreate, storyAdd } from '../../src/ops/plan.js'
import { etag, handleApi } from '../../src/web/api.js'
import { WEB_CODES } from '../../src/web/codes.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

/**
 * The read api's two jobs: answer, and never say anything.
 *
 * "Never say anything" is the strict one. Every error is `{ error: { code } }`
 * with **no `params` at all** — a params hole is exactly how a sentence gets
 * smuggled past the no-prose rule the day a code feels too vague.
 */

const NOW = new Date('2026-07-28T09:00:00.000Z')
const clock = (): Date => NOW

let project: TmpProject
beforeEach(async () => {
  project = await makeTmpProject()
  await initLoop(project.dir, clock)
  await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
  await gateSet(project.dir, { plan: 'P001', decision: 'approved', by: 'Mohd' }, clock)
  await storyAdd(project.dir, { plan: 'P001', title: 'Login form' }, clock)
})
afterEach(async () => {
  await project.cleanup()
})

const call = (pathname: string, method = 'GET') => handleApi(project.dir, method, pathname)

describe('handleApi', () => {
  it('leaves every non-api path alone', async () => {
    expect(await call('/')).toBe(null)
    expect(await call('/app.js')).toBe(null)
    // Not `/api`-prefixed as a *path segment* — a static file whose name merely
    // begins with those letters must still be served.
    expect(await call('/apiary.css')).toBe(null)
  })

  it('serves what the tabs read', async () => {
    expect((await call('/api/state'))?.status).toBe(200)
    expect((await call('/api/config'))?.status).toBe(200)
    expect((await call('/api/plans/P001'))?.status).toBe(200)
    expect((await call('/api/stories/P001-S01'))?.status).toBe(200)
    expect((await call('/api/runs'))?.status).toBe(200)
    expect((await call('/api/memory'))?.status).toBe(200)
  })

  it('refuses anything that is not a read', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      expect((await call('/api/state', method))?.status).toBe(405)
    }
  })

  it('cannot be steered out of .mjloop', async () => {
    // The id shape is itself the traversal guard: `.` is outside `[\w-]`, so
    // `..` cannot match. These are the engine's own schemas doing filesystem
    // duty on the wire.
    const traversals = [
      '/api/plans/../../etc',
      '/api/plans/..%2F..%2Fetc',
      '/api/stories/../../../etc/passwd',
      '/api/runs/../..',
      '/api/memory/../config.yaml',
      '/api/runs/P001/../../..',
      // An un-normalised path, which a browser would never send but a raw
      // socket can: it is still ours to refuse rather than to resolve.
      '/api/../app.js',
      '/api/../../package.json',
    ]
    for (const attempt of traversals) {
      const result = await call(attempt)
      expect([400, 404], attempt).toContain(result?.status)
    }
  })

  it('answers an unknown route with a code and nothing else', async () => {
    const result = await call('/api/nope')
    expect(result?.status).toBe(404)
    expect(result?.body).toEqual({ error: { code: 'error.notFound' } })
  })

  it('never puts a parameter on an error', async () => {
    const failures = [
      await call('/api/nope'),
      await call('/api/plans/nonsense'),
      await call('/api/plans/P999'),
      await call('/api/state', 'POST'),
      await call('/api/runs/x/0'),
    ]
    for (const failure of failures) {
      const error = (failure?.body as { error?: Record<string, unknown> }).error ?? {}
      expect(Object.keys(error)).toEqual(['code'])
      expect(WEB_CODES).toContain(error['code'])
    }
  })

  it('is stable enough to be conditional', async () => {
    // A flapping body would make every conditional GET a 200, which is what
    // makes `revisions.cycle` being a tick counter affordable in the first place.
    const first = JSON.stringify((await call('/api/plans/P001'))?.body)
    const second = JSON.stringify((await call('/api/plans/P001'))?.body)
    expect(first).toBe(second)
    expect(etag(first)).toBe(etag(second))
  })
})
