import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initLoop } from '../../src/ops/init.js'
import { memoryAdd, memoryGet, memorySearch } from '../../src/ops/memory.js'
import { cycleAdvance, runStart } from '../../src/ops/run.js'
import { stateSummary } from '../../src/ops/summary.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-27T15:00:00.000Z')
const clock = () => NOW

let project: TmpProject

beforeEach(async () => {
  project = await makeTmpProject()
  await initLoop(project.dir, clock)
})
afterEach(async () => { await project.cleanup() })

describe('a run that remembers', () => {
  it('records a decision and finds it while composing the next run', async () => {
    const first = await runStart(project.dir, { track: 'build', goal: 'Add session handling' }, clock)
    await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'pass' }, clock)

    await memoryAdd(
      project.dir,
      {
        kind: 'decision',
        title: 'Session tokens rather than server sessions',
        body: 'The deployment target has no shared session store, and adding one would mean a new dependency for a single feature.',
        tags: ['auth', 'architecture'],
        run: first.run_id,
      },
      clock,
    )

    // A later run consults memory before composing.
    const { hits, reason } = await memorySearch(project.dir, 'session store dependency')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.id).toBe('M001')
    expect(hits[0]?.title).toContain('Session tokens')
    expect(reason).toContain('1 of 1')

    // The excerpt is an excerpt, not the whole entry.
    expect(hits[0]?.excerpt.length).toBeLessThan(300)

    // The full entry is one call away, and carries the run that produced it.
    const full = await memoryGet(project.dir, 'M001')
    expect(full.frontmatter.run).toBe(first.run_id)
    expect(full.body).toContain('new dependency')
  })

  it('answers honestly when nothing matches', async () => {
    await memoryAdd(project.dir, { kind: 'pattern', title: 'Route wrapping', body: 'Every route wraps its handler.' }, clock)
    const { hits, reason } = await memorySearch(project.dir, 'kubernetes ingress')
    expect(hits).toEqual([])
    expect(reason).toContain('No memory')
  })

  it('leaves the summary clean on a sound config', async () => {
    expect((await stateSummary(project.dir)).config_error).toBeNull()
  })
})
