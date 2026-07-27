import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initLoop } from '../../src/ops/init.js'
import { renderIndex } from '../../src/ops/index-render.js'
import { GateClosedError, runLog } from '../../src/ops/log.js'
import { ApprovalRequiredError, gateSet, planCreate, storyAdd } from '../../src/ops/plan.js'
import { rosterSet } from '../../src/ops/roster.js'
import { cycleAdvance, runStart } from '../../src/ops/run.js'
import { findPlanDir } from '../../src/store/plan-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-27T09:00:00.000Z')
const clock = () => NOW

let project: TmpProject

const CRITIC_FAIL = {
  status: 'fail' as const,
  summary: 'The token lifetime is never stated.',
  evidence: [{ kind: 'file' as const, ref: '.mjloop/plans/P001-user-auth/PLAN.md', excerpt: 'Tokens are issued on login.' }],
  findings: [
    {
      severity: 'high' as const,
      file: '.mjloop/plans/P001-user-auth/PLAN.md',
      line: 12,
      claim: 'the token lifetime is never stated, so no story can carry a checkable criterion for expiry',
    },
  ],
  files_touched: ['.mjloop/plans/P001-user-auth/REVIEW.md'],
  next_hint: null,
}

const FIT_PASS = {
  status: 'pass' as const,
  summary: 'The plan fits: the session module exists and the dependency is present.',
  evidence: [{ kind: 'command' as const, ref: 'ls src/session', excerpt: 'index.ts  store.ts' }],
  findings: [],
  files_touched: [],
  next_hint: null,
}

const WRITER_PASS = {
  status: 'pass' as const,
  summary: 'Two stories, in dependency order.',
  evidence: [{ kind: 'file' as const, ref: '.mjloop/plans/P001-user-auth/stories', excerpt: 'two stories added' }],
  findings: [],
  files_touched: [],
  next_hint: null,
}

beforeEach(async () => {
  project = await makeTmpProject({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) })
  await initLoop(project.dir, clock)
  await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
  await runStart(project.dir, { track: 'plan', goal: 'Add authentication', plan: 'P001' }, clock)
})
afterEach(async () => { await project.cleanup() })

describe('an idea becomes stories', () => {
  it('criticises, fit-checks, waits for approval, then writes stories', async () => {
    await rosterSet(project.dir, {
      cycle: 1,
      selected: ['planner', 'plan-critic', 'fit-checker', 'story-writer'],
      skipped: { 'story-critic': 'two stories, both single-file' },
    })

    // The critic objects, and its finding carries into the next cycle.
    await runLog(project.dir, { agent: 'plan-critic', result: CRITIC_FAIL }, clock)
    const first = await cycleAdvance(
      project.dir,
      { agents: ['planner', 'plan-critic'], result: 'fail' },
      clock,
    )
    expect(first.state.status).toBe('running')
    expect(first.carried_findings).toHaveLength(1)
    expect(first.carried_findings[0]?.claim).toContain('token lifetime')

    await rosterSet(project.dir, {
      cycle: 2,
      selected: ['planner', 'fit-checker', 'story-writer'],
      skipped: { 'plan-critic': 'the single objection was addressed', 'story-critic': 'two stories, both single-file' },
    })

    // story-writer is blocked until the fit-check gate opens.
    await expect(
      runLog(project.dir, { agent: 'story-writer', result: WRITER_PASS }, clock),
    ).rejects.toBeInstanceOf(GateClosedError)

    const fit = await runLog(project.dir, { agent: 'fit-checker', result: FIT_PASS }, clock)
    expect(fit.gateOpened).toBe(true)

    // Now the engine accepts it — but stories still need approval.
    await runLog(project.dir, { agent: 'story-writer', result: WRITER_PASS }, clock)
    await expect(storyAdd(project.dir, { plan: 'P001', title: 'Login form' }, clock)).rejects.toBeInstanceOf(
      ApprovalRequiredError,
    )

    await gateSet(project.dir, { plan: 'P001', decision: 'approved', by: 'mohd', note: 'Ship it.' }, clock)

    await storyAdd(project.dir, { plan: 'P001', title: 'Login form', acceptance: ['Renders the form'] }, clock)
    await storyAdd(
      project.dir,
      { plan: 'P001', title: 'Session token', acceptance: ['Tokens expire after 24h'], depends_on: ['P001-S01'] },
      clock,
    )

    const closed = await cycleAdvance(
      project.dir,
      { agents: ['planner', 'fit-checker', 'story-writer'], result: 'pass' },
      clock,
    )
    expect(closed.state.status).toBe('done')

    const index = await renderIndex(project.dir, clock)
    expect(index).toContain('| P001 | User authentication | 2 | 0 | planned | yes |')

    const stories = await fs.readdir(path.join(await findPlanDir(project.dir, 'P001'), 'stories'))
    expect(stories).toHaveLength(2)
  })
})

describe('both gates hold', () => {
  it('refuses story-writer before the fit check and writes nothing', async () => {
    await expect(
      runLog(project.dir, { agent: 'story-writer', result: WRITER_PASS }, clock),
    ).rejects.toBeInstanceOf(GateClosedError)

    const dir = await findPlanDir(project.dir, 'P001')
    expect(await fs.readdir(path.join(dir, 'stories'))).toEqual([])
  })

  it('refuses a story on a plan the user only asked for changes to', async () => {
    await gateSet(project.dir, { plan: 'P001', decision: 'changes_requested', by: 'mohd', note: 'State the TTL.' }, clock)
    await expect(storyAdd(project.dir, { plan: 'P001', title: 'Login form' }, clock)).rejects.toBeInstanceOf(
      ApprovalRequiredError,
    )
  })

  it('shows an unapproved plan as such in the index', async () => {
    expect(await renderIndex(project.dir, clock)).toContain('| planned | no |')
  })
})
