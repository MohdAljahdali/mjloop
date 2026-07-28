import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initLoop } from '../../src/ops/init.js'
import { gateSet, planCreate, storyAdd, storyUpdate } from '../../src/ops/plan.js'
import { runStart } from '../../src/ops/run.js'
import { WEB_CODES } from '../../src/web/codes.js'
import { buildSnapshot } from '../../src/web/snapshot.js'
import { applyWrite, WriteSchema } from '../../src/web/writes.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

/**
 * The three writes, and the property that makes an 800ms-stale page safe to
 * click: a write that arrives with an out-of-date expectation is **refused**
 * rather than obeyed.
 */

const NOW = new Date('2026-07-28T09:00:00.000Z')
const clock = (): Date => NOW

let project: TmpProject
beforeEach(async () => {
  project = await makeTmpProject()
  await initLoop(project.dir, clock)
  // P001 is approved and has a story; P002 is the plan nobody has looked at,
  // which is the state `gates.plan_approval: human` leaves every new plan in.
  await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
  await gateSet(project.dir, { plan: 'P001', decision: 'approved', by: 'Mohd' }, clock)
  await storyAdd(project.dir, { plan: 'P001', title: 'Login form' }, clock)
  await planCreate(project.dir, { slug: 'billing', title: 'Billing' }, clock)
})
afterEach(async () => {
  await project.cleanup()
})

async function hashTree(): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const walk = async (at: string): Promise<void> => {
    for (const entry of await fs.readdir(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name)
      if (entry.isDirectory()) await walk(full)
      else out.set(full, crypto.createHash('sha256').update(await fs.readFile(full)).digest('hex'))
    }
  }
  await walk(path.join(project.dir, '.mjloop'))
  return out
}

describe('applyWrite', () => {
  it('records a decision and shows it on the next read', async () => {
    const result = await applyWrite(project.dir, {
      kind: 'gate',
      plan: 'P002',
      from: null,
      to: 'approved',
      note: 'Scope looks right.',
    })
    expect(result).toEqual({ ok: true })

    const snapshot = await buildSnapshot(project.dir)
    expect(snapshot.plans.find((plan) => plan.id === 'P002')?.approval).toBe('approved')
  })

  it('attributes the decision to the server, never to the browser', async () => {
    await applyWrite(project.dir, { kind: 'gate', plan: 'P002', from: null, to: 'approved', note: null })
    const plan = await fs.readFile(path.join(project.dir, '.mjloop', 'plans', 'P002-billing', 'PLAN.md'), 'utf8')
    // A `by` the page could type would be a forgeable audit record, which is
    // worse than the engine admitting it cannot verify who decided.
    expect(plan).toMatch(/by: dashboard:/)
  })

  it('requeues a story stuck in doing', async () => {
    await storyUpdate(project.dir, 'P001-S01', { status: 'doing' }, clock)
    const result = await applyWrite(project.dir, {
      kind: 'story.status',
      story: 'P001-S01',
      from: 'doing',
      to: 'todo',
    })
    expect(result).toEqual({ ok: true })
    // `doing` is what makes a story invisible to `--next` forever; the
    // documented repair before this was a text editor.
    const plans = (await buildSnapshot(project.dir)).plans
    expect(plans.find((plan) => plan.id === 'P001')?.stories[0]?.status).toBe('todo')
  })

  it('halts the run named on the wire', async () => {
    await runStart(project.dir, { track: 'edit', goal: 'Rename the submit label' }, clock)
    const snapshot = await buildSnapshot(project.dir)
    const result = await applyWrite(project.dir, {
      kind: 'halt',
      run: snapshot.state.run_id ?? '',
      reason: 'Wrong story.',
    })
    expect(result).toEqual({ ok: true })

    const after = await buildSnapshot(project.dir)
    expect(after.state.status).toBe('halted')
    expect(after.state.halt_reason).toBe('Wrong story.')
    // A halt that left no report would be a Stop wearing a different label.
    const runs = await fs.readdir(path.join(project.dir, '.mjloop', 'runs', after.runs[0] ?? ''))
    expect(runs).toContain('HALT.md')
  })

  it.each([
    ['plan', { kind: 'gate', plan: 'P002', from: 'approved', to: 'rejected', note: null }, 'write.stale.plan'],
    ['story', { kind: 'story.status', story: 'P001-S01', from: 'done', to: 'todo' }, 'write.stale.story'],
  ] as const)('refuses a stale %s write and changes nothing', async (_subject, write, code) => {
    const before = await hashTree()
    const result = await applyWrite(project.dir, write)
    expect(result).toEqual({ ok: false, code })
    // A precondition that threw *after* writing would be worse than none.
    expect(await hashTree()).toEqual(before)
  })

  it('refuses a halt aimed at a run that is no longer the one on record', async () => {
    await runStart(project.dir, { track: 'edit', goal: 'Rename the submit label' }, clock)
    const before = await hashTree()
    const result = await applyWrite(project.dir, { kind: 'halt', run: 'some-older-run', reason: 'stop' })
    expect(result).toEqual({ ok: false, code: 'write.stale.run' })
    expect(await hashTree()).toEqual(before)
  })

  it('reports a failure as a code and nothing else', async () => {
    const result = await applyWrite(project.dir, { kind: 'halt', run: 'nothing', reason: 'stop' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      // Every failure path: a code from the closed union, and no room for a
      // sentence. `error.message` never crosses this wire.
      expect(Object.keys(result)).toEqual(['ok', 'code'])
      expect(WEB_CODES).toContain(result.code)
    }
  })

  it('lets an undo through, and refuses it once the world has moved', async () => {
    await applyWrite(project.dir, { kind: 'story.status', story: 'P001-S01', from: 'todo', to: 'doing' })
    // The undo is conditional too, which is exactly why offering it is safe.
    expect(await applyWrite(project.dir, { kind: 'story.status', story: 'P001-S01', from: 'doing', to: 'todo' })).toEqual({
      ok: true,
    })

    await storyUpdate(project.dir, 'P001-S01', { status: 'done' }, clock)
    const late = await applyWrite(project.dir, { kind: 'story.status', story: 'P001-S01', from: 'doing', to: 'todo' })
    expect(late).toEqual({ ok: false, code: 'write.stale.story' })
  })
})

describe('WriteSchema', () => {
  it('rejects an undeclared field before a handler is reached', () => {
    expect(
      WriteSchema.safeParse({ kind: 'gate', plan: 'P001', from: null, to: 'approved', note: null, by: 'me' }).success,
    ).toBe(false)
  })

  it('refuses an id that could steer a write out of .mjloop', () => {
    // The engine's own schemas doing filesystem duty on the wire.
    expect(WriteSchema.safeParse({ kind: 'gate', plan: '../../etc', from: null, to: 'approved' }).success).toBe(false)
    expect(WriteSchema.safeParse({ kind: 'story.status', story: '../x', from: 'todo', to: 'done' }).success).toBe(false)
  })

  it('refuses a kind that is not one of the three', () => {
    expect(WriteSchema.safeParse({ kind: 'cycle.advance', result: 'pass' }).success).toBe(false)
    expect(WriteSchema.safeParse({ kind: 'run.log', agent: 'reproducer' }).success).toBe(false)
  })
})

describe('the engine ops themselves', () => {
  it('take the expectation as a trailing option, so no existing call site moves', async () => {
    // Every existing `storyUpdate` / `gateSet` / `halt` call passes `clock`
    // fourth at most, and nothing anywhere passes a fifth argument — which is
    // what makes this shape cost zero churn and leave the MCP path identical.
    await expect(storyUpdate(project.dir, 'P001-S01', { status: 'done' }, clock)).resolves.toMatchObject({
      id: 'P001-S01',
    })
    await expect(gateSet(project.dir, { plan: 'P001', decision: 'approved', by: 'Mohd' }, clock)).resolves.toMatchObject(
      { plan: 'P001' },
    )
  })
})
