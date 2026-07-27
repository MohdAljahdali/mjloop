import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initLoop } from '../../src/ops/init.js'
import { renderIndex } from '../../src/ops/index-render.js'
import { runLog } from '../../src/ops/log.js'
import { manifestPath } from '../../src/ops/manifest.js'
import { gateSet, planCreate, storyAdd, storyNext, storyUpdate } from '../../src/ops/plan.js'
import { rosterSet } from '../../src/ops/roster.js'
import { cycleAdvance, runDirName, runDirPath, runStart } from '../../src/ops/run.js'
import { findPlanDir, readStory } from '../../src/store/plan-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-27T09:00:00.000Z')
const clock = () => NOW

let project: TmpProject

beforeEach(async () => {
  project = await makeTmpProject({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) })
  await initLoop(project.dir, clock)
  await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
  // The project is initialised, so gates.plan_approval is "human": stories need
  // an approved plan. This suite is about the build, not about the gate.
  await gateSet(project.dir, { plan: 'P001', decision: 'approved', by: 'test' }, clock)
  await storyAdd(project.dir, { plan: 'P001', title: 'Login form', acceptance: ['Shows an error on bad input'] }, clock)
  await storyAdd(project.dir, { plan: 'P001', title: 'Session token', depends_on: ['P001-S01'] }, clock)
})
afterEach(async () => { await project.cleanup() })

describe('a story-driven build', () => {
  it('runs the next ready story and writes its proof back', async () => {
    const next = await storyNext(project.dir)
    expect(next.story?.frontmatter.id).toBe('P001-S01')
    expect(next.story?.frontmatter.acceptance).toEqual(['Shows an error on bad input'])

    await storyUpdate(project.dir, 'P001-S01', { status: 'doing' }, clock)

    const state = await runStart(
      project.dir,
      { track: 'build', goal: 'Login form shows an error on bad input', plan: 'P001', story: 'P001-S01' },
      clock,
    )
    expect(runDirName(state)).toContain('P001-S01')

    await rosterSet(project.dir, {
      cycle: 1,
      selected: ['builder', 'verifier'],
      skipped: { scout: 'story names the file', critic: 'single-file change' },
    })
    await runLog(
      project.dir,
      {
        agent: 'verifier',
        result: {
          status: 'pass',
          summary: 'The acceptance criterion is met and the suite is green.',
          evidence: [{ kind: 'command', ref: 'npm test', excerpt: 'tests 1, pass 1, fail 0' }],
          findings: [],
          files_touched: [],
          next_hint: null,
        },
      },
      clock,
    )
    const closed = await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'pass' }, clock)
    expect(closed.state.status).toBe('done')

    const evidence = path.relative(project.dir, runDirPath(project.dir, closed.state))
    await storyUpdate(project.dir, 'P001-S01', { status: 'done', evidence }, clock)

    // Every derived artefact agrees with the story file.
    const story = await readStory(project.dir, 'P001-S01')
    expect(story.frontmatter.status).toBe('done')
    expect(story.frontmatter.evidence).toBe(evidence)

    const manifest = JSON.parse(await fs.readFile(manifestPath(await findPlanDir(project.dir, 'P001')), 'utf8'))
    expect(manifest.stories.find((entry: { id: string }) => entry.id === 'P001-S01').status).toBe('done')

    const index = await renderIndex(project.dir, clock)
    expect(index).toContain('| P001 | User authentication | 2 | 1 | in-progress |')

    // The dependency graph has moved on.
    expect((await storyNext(project.dir)).story?.frontmatter.id).toBe('P001-S02')
  })

  it('rebuilds a deleted manifest from the story files alone', async () => {
    const file = manifestPath(await findPlanDir(project.dir, 'P001'))
    await fs.rm(file)

    await storyUpdate(project.dir, 'P001-S01', { status: 'doing' }, clock)

    const manifest = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(manifest.stories.map((entry: { id: string }) => entry.id)).toEqual(['P001-S01', 'P001-S02'])
    expect(manifest.stories[0].status).toBe('doing')
  })

  it('refuses to open a run against a story that does not exist', async () => {
    await expect(
      runStart(project.dir, { track: 'build', goal: 'Ghost', plan: 'P001', story: 'P001-S99' }, clock),
    ).rejects.toThrow(/P001-S99/)
  })
})
