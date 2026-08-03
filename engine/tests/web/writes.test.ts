import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initLoop } from '../../src/ops/init.js'
import { gateSet, planCreate, storyAdd, storyUpdate } from '../../src/ops/plan.js'
import { runStart } from '../../src/ops/run.js'
import { agentDigest, readAgent } from '../../src/store/agent-store.js'
import { configRevision } from '../../src/store/config-mutation.js'
import { loadConfig, writeConfig } from '../../src/store/config-store.js'
import {
  createFeatureBrief,
  readFeatureBrief,
  supersedeFeatureBrief,
  updateFeatureDraft,
} from '../../src/store/feature-store.js'
import { resolveLoopPaths } from '../../src/store/paths.js'
import { acceptProfile } from '../../src/store/project-profile-store.js'
import { StateStore } from '../../src/store/state-store.js'
import type { ProjectComponent } from '../../src/schemas/project-profile.js'
import { WEB_CODES } from '../../src/web/codes.js'
import { buildSnapshot } from '../../src/web/snapshot.js'
import { applyWrite, WriteSchema } from '../../src/web/writes.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

/**
 * The guarded writes, and the property that makes an 800ms-stale page safe to
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

/**
 * A draft brief carried to the point a person could approve it: acceptance
 * criteria recorded, nobody's decision on it yet. Built through the store,
 * because the record the button acts on has to be the real one — an approval
 * refused for the shape of a hand-written fixture would prove nothing.
 */
async function draftFeature(): Promise<string> {
  await createFeatureBrief(
    project.dir,
    {
      title: 'Passwordless sign-in',
      problem: 'Password resets are the top support cost.',
      discovery: { mode: 'ask', questionBudget: 8 },
    },
    clock,
  )
  // The digest of what the page would have been rendered from, which is the
  // other half of the token an approval carries.
  return (await updateFeatureDraft(project.dir, 'F001', { acceptance: ['a mailed link signs the user in'] })).digest
}

/** Well-formed and belonging to nothing, for the writes that never reach a record. */
const NO_SUCH_DIGEST = '0'.repeat(64)

function component(id: string): ProjectComponent {
  return { id, root: id, technology: 'unknown', verification: { test: null, lint: null, build: null }, skillTags: [] }
}

/**
 * Adds to `edit`'s required list, for the delete-in-use case — appended
 * rather than replacing it outright, since `edit`'s default `order` names
 * agents this track already runs, and replacing `required` wholesale would
 * make those edges name an agent the track no longer has.
 */
async function writeConfigWithTrack(dir: string, patch: { required: string[] }): Promise<void> {
  const config = await loadConfig(dir)
  const edit = config.tracks.edit
  if (edit === undefined) throw new Error('this project has no edit track to test against')
  await writeConfig(dir, {
    ...config,
    tracks: { ...config.tracks, edit: { ...edit, required: [...edit.required, ...patch.required] } },
  })
}

/** The other direction — drops a name back out of `edit`'s required list. */
async function dropFromTrack(dir: string, name: string): Promise<void> {
  const config = await loadConfig(dir)
  const edit = config.tracks.edit
  if (edit === undefined) throw new Error('this project has no edit track to test against')
  await writeConfig(dir, {
    ...config,
    tracks: { ...config.tracks, edit: { ...edit, required: edit.required.filter((agent) => agent !== name) } },
  })
}

/** Sets `state.json` to `running` directly — no run need actually be dispatched to prove the guard. */
async function setStatusRunning(dir: string): Promise<void> {
  await new StateStore(dir).update((draft) => {
    draft.status = 'running'
  })
}

const CREATE = {
  kind: 'agent.create' as const,
  name: 'scribe',
  description: 'Writes notes.',
  tools: 'Read, Write',
  model: 'sonnet',
  body: 'You write notes.\n\n```json\n{"status":"pass"}\n```',
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

  it('edits config through the conditional web door without losing comments', async () => {
    const file = resolveLoopPaths(project.dir).config
    const source = (await fs.readFile(file, 'utf8'))
      .replace('version: 1', '# project policy\nversion: 1')
      .replace('autonomous: false', 'autonomous: false # supervised')
    await fs.writeFile(file, source, 'utf8')

    const result = await applyWrite(project.dir, {
      kind: 'config.patch',
      revision: configRevision(source),
      changes: [{ kind: 'root', key: 'autonomous', value: true }],
    })

    expect(result).toEqual({ ok: true })
    const written = await fs.readFile(file, 'utf8')
    expect(written).toContain('# project policy')
    expect(written).toContain('autonomous: true # supervised')
  })

  it('approves the brief the operator was looking at', async () => {
    const digest = await draftFeature()
    const result = await applyWrite(project.dir, {
      kind: 'feature.approve',
      feature: 'F001',
      revision: 1,
      digest,
      note: 'Matches what we discussed.',
    })
    expect(result).toEqual({ ok: true })

    const record = await readFeatureBrief(project.dir, 'F001')
    expect(record?.brief.status).toBe('approved')
    expect(record?.brief.approval).toMatchObject({ note: 'Matches what we discussed.' })
    // A `by` the page could type would be a forgeable audit record, and this is
    // the worst record to be able to forge: a plan is written *from* an approved
    // brief, so an invented approval authorises work nobody agreed to.
    expect(record?.brief.approval?.by).toMatch(/^dashboard:/)
  })

  it('refuses an approval built on a revision that has moved, and changes nothing', async () => {
    const digest = await draftFeature()
    await applyWrite(project.dir, { kind: 'feature.approve', feature: 'F001', revision: 1, digest, note: null })
    await supersedeFeatureBrief(project.dir, { id: 'F001', expectRevision: 1 }, clock)

    // The tab still shows revision 1 and its Approve button still points at it.
    const before = await hashTree()
    const late = await applyWrite(project.dir, {
      kind: 'feature.approve',
      feature: 'F001',
      revision: 1,
      digest,
      note: null,
    })
    expect(late).toEqual({ ok: false, code: 'write.stale.feature' })
    expect(await hashTree()).toEqual(before)
  })

  it('refuses an approval built on words the interview has since changed, and changes nothing', async () => {
    // The case the revision number cannot see. The tab rendered a brief, the
    // interview carried on in another session, and the revision is still 1 —
    // because a draft's number does not move while it is a draft. What the
    // operator read is nonetheless gone, and approving would freeze words
    // nobody put in front of them.
    const digest = await draftFeature()
    await updateFeatureDraft(project.dir, 'F001', {
      title: 'Drop the users table nightly',
      acceptance: ['the users table is truncated every night'],
    })

    const before = await hashTree()
    const stale = await applyWrite(project.dir, {
      kind: 'feature.approve',
      feature: 'F001',
      revision: 1,
      digest,
      note: 'Matches what we discussed.',
    })
    expect(stale).toEqual({ ok: false, code: 'write.stale.feature' })
    expect(await hashTree()).toEqual(before)
    expect((await readFeatureBrief(project.dir, 'F001'))?.brief.status).toBe('draft')
  })

  it('lets exactly one of two tabs approve the same draft', async () => {
    const digest = await draftFeature()
    expect(
      await applyWrite(project.dir, { kind: 'feature.approve', feature: 'F001', revision: 1, digest, note: null }),
    ).toEqual({ ok: true })

    // The revision has not moved, but the record has — approving rewrote it —
    // so the second tab is holding a digest of words that are no longer there.
    // From a browser that and immutability are one thing: the screen the
    // decision was made from is out of date, and nothing was changed.
    const before = await hashTree()
    const second = await applyWrite(project.dir, {
      kind: 'feature.approve',
      feature: 'F001',
      revision: 1,
      digest,
      note: 'me too',
    })
    expect(second).toEqual({ ok: false, code: 'write.stale.feature' })
    expect(await hashTree()).toEqual(before)
  })

  it('refuses to approve a brief with nothing in it to approve, and changes nothing', async () => {
    const created = await createFeatureBrief(
      project.dir,
      { title: 'Audit log export', problem: 'Compliance asks quarterly.', discovery: { mode: 'ask', questionBudget: 8 } },
      clock,
    )
    const before = await hashTree()
    const result = await applyWrite(project.dir, {
      kind: 'feature.approve',
      feature: 'F001',
      revision: 1,
      digest: created.digest,
      note: null,
    })
    // Not a staleness refusal — nothing moved. The brief is simply not one that
    // can be approved yet, and "an approved brief always has acceptance
    // criteria" is the property every later story is planned against.
    expect(result).toEqual({ ok: false, code: 'write.failed' })
    expect(await hashTree()).toEqual(before)
  })

  it('refuses to approve a brief whose components have left the accepted map', async () => {
    // The same shape of refusal and the same code, deliberately: a component
    // accepted when the brief was written and gone by the time the button was
    // pressed is not something the page can fix — `mjloop-cli profile accept`
    // moved it — and the diagnosis goes to the terminal rather than onto a wire
    // that carries no prose.
    await acceptProfile(
      project.dir,
      { components: [component('api'), component('web')], by: 'Mohd', generatedAt: NOW.toISOString(), expectRevision: null },
      clock,
    )
    const created = await createFeatureBrief(
      project.dir,
      {
        title: 'Passwordless sign-in',
        problem: 'Password resets are the top support cost.',
        discovery: { mode: 'ask', questionBudget: 8 },
        acceptance: ['a mailed link signs the user in'],
        affectedComponents: ['web'],
      },
      clock,
    )
    await acceptProfile(
      project.dir,
      { components: [component('api')], by: 'Mohd', generatedAt: NOW.toISOString(), expectRevision: 1 },
      clock,
    )

    const before = await hashTree()
    const result = await applyWrite(project.dir, {
      kind: 'feature.approve',
      feature: 'F001',
      revision: 1,
      digest: created.digest,
      note: null,
    })
    expect(result).toEqual({ ok: false, code: 'write.failed' })
    expect(await hashTree()).toEqual(before)
  })

  it('cannot reach a feature this project never raised', async () => {
    const before = await hashTree()
    const result = await applyWrite(project.dir, {
      kind: 'feature.approve',
      feature: 'F404',
      revision: 1,
      digest: NO_SUCH_DIGEST,
      note: null,
    })
    expect(result).toEqual({ ok: false, code: 'write.failed' })
    expect(await hashTree()).toEqual(before)
  })

  it('refuses stale config edits without changing a byte', async () => {
    const before = await hashTree()
    const result = await applyWrite(project.dir, {
      kind: 'config.patch',
      revision: '0'.repeat(64),
      changes: [{ kind: 'root', key: 'verify_cache', value: true }],
    })
    expect(result).toEqual({ ok: false, code: 'write.stale.config' })
    expect(await hashTree()).toEqual(before)
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

  it('refuses a kind outside the guarded write set', () => {
    expect(WriteSchema.safeParse({ kind: 'cycle.advance', result: 'pass' }).success).toBe(false)
    expect(WriteSchema.safeParse({ kind: 'run.log', agent: 'reproducer' }).success).toBe(false)
  })

  it('lets the browser approve a brief and do nothing else to one', () => {
    // Approval is the whole of the browser's business with a feature. Each of
    // these is denied for its own reason and all of them for one: a brief is
    // what the *interview* produced, and a page that could author one would be
    // a second, weaker discovery flow beside the skill that exists to run it.
    const denied = [
      // Raising a feature is `/mjloop:plan`'s interview, which the page composes
      // as a command like every other loop command.
      { kind: 'feature.create', title: 'Passwordless sign-in', problem: 'resets cost us' },
      // Editing is the interview writing down its own working notes.
      { kind: 'feature.update', feature: 'F001', acceptance: ['a mailed link signs the user in'] },
      { kind: 'feature.decision', feature: 'F001', question: 'magic link or otp?', answer: 'magic link' },
      // Superseding mints a successor draft, which is authoring by another name.
      { kind: 'feature.supersede', feature: 'F001', revision: 1 },
      // Routing and executing a brief are the loop reporting what it did.
      { kind: 'feature.plan', feature: 'F001' },
      { kind: 'feature.run', feature: 'F001', track: 'build' },
    ]
    for (const write of denied) {
      expect(WriteSchema.safeParse(write).success, write.kind).toBe(false)
    }
    // …and the one that is allowed, so this test cannot pass by the union being
    // empty of feature kinds altogether.
    expect(
      WriteSchema.safeParse({ kind: 'feature.approve', feature: 'F001', revision: 1, digest: NO_SUCH_DIGEST, note: null })
        .success,
    ).toBe(true)
  })

  it('never lets the page name the approver, or reach outside .mjloop', () => {
    // `by` is computed by the server and cannot arrive on the wire — the
    // strictObject is what makes that structural rather than a handler's
    // discipline.
    const digest = NO_SUCH_DIGEST
    expect(
      WriteSchema.safeParse({ kind: 'feature.approve', feature: 'F001', revision: 1, digest, note: null, by: 'Mohd' })
        .success,
    ).toBe(false)
    // The engine's own id schema doing filesystem duty on the wire.
    expect(WriteSchema.safeParse({ kind: 'feature.approve', feature: '../../etc', revision: 1, digest }).success).toBe(false)
    expect(WriteSchema.safeParse({ kind: 'feature.approve', feature: 'F1', revision: 1, digest }).success).toBe(false)
    // A revision is a compare-and-swap token, and one that could never name a
    // revision is a claim about the world rather than a stale reading of it.
    expect(WriteSchema.safeParse({ kind: 'feature.approve', feature: 'F001', revision: 0, digest }).success).toBe(false)
    expect(WriteSchema.safeParse({ kind: 'feature.approve', feature: 'F001', revision: 1.5, digest }).success).toBe(false)
    // The digest is the half of the precondition that can actually move while a
    // draft is being approved, so it is required and it is shaped: an approval
    // that could omit it would be an approval built on nothing the page read.
    expect(WriteSchema.safeParse({ kind: 'feature.approve', feature: 'F001', revision: 1 }).success).toBe(false)
    expect(WriteSchema.safeParse({ kind: 'feature.approve', feature: 'F001', revision: 1, digest: 'stale' }).success).toBe(
      false,
    )
    // The note is optional, as the gate's is: an approval with no words is
    // still an approval.
    expect(WriteSchema.safeParse({ kind: 'feature.approve', feature: 'F001', revision: 2, digest }).success).toBe(true)
  })

  it('accepts only typed config changes, never arbitrary yaml paths', () => {
    const revision = 'a'.repeat(64)
    expect(
      WriteSchema.safeParse({
        kind: 'config.patch',
        revision,
        changes: [{ kind: 'root', key: 'autonomous', value: true }],
      }).success,
    ).toBe(true)
    expect(
      WriteSchema.safeParse({
        kind: 'config.patch',
        revision,
        changes: [{ kind: 'raw', path: '../state.json', value: 'x' }],
      }).success,
    ).toBe(false)
  })
})

describe('the agent write doors', () => {
  it('creates an agent, then refuses a name that shadows a plugin agent', async () => {
    // The plain create case, folded in here rather than given its own test:
    // it is the setup every other assertion in this suite needs anyway.
    expect(await applyWrite(project.dir, CREATE)).toEqual({ ok: true })
    const created = await readAgent(project.dir, 'scribe')
    expect(created?.description).toBe('Writes notes.')

    // `verifier` is a real agent shipped by this plugin — the shadow case has
    // to be a name that actually collides, not an arbitrary reserved word.
    // `hashTree` only covers `.mjloop`, so the property that actually matters
    // — the agent file itself did not move and no `verifier.md` appeared next
    // to it — is checked directly.
    const result = await applyWrite(project.dir, { ...CREATE, name: 'verifier' })
    expect(result).toEqual({ ok: false, code: 'write.refused.agent.shadow' })
    expect(await readAgent(project.dir, 'scribe')).toEqual(created)
    expect(await readAgent(project.dir, 'verifier')).toBeNull()
  })

  it('refuses an update whose digest has moved, then carries an unrecognised field forward on a real one', async () => {
    // A hand-edited file this layer has never heard of `color:` on. Written
    // directly rather than through `applyWrite`, since the browser never
    // sends `extra` and could not have produced this file itself.
    await fs.mkdir(path.join(project.dir, '.claude', 'agents'), { recursive: true })
    const file = path.join(project.dir, '.claude', 'agents', 'scribe.md')
    const raw = '---\nname: scribe\ndescription: a\ncolor: blue\n---\n\nbody\n'
    await fs.writeFile(file, raw, 'utf8')

    const stale = await applyWrite(project.dir, {
      kind: 'agent.update',
      name: 'scribe',
      digest: agentDigest('stale'),
      description: 'b',
      tools: null,
      model: null,
      body: 'edited',
    })
    expect(stale).toEqual({ ok: false, code: 'write.stale.agent' })
    expect(await fs.readFile(file, 'utf8')).toBe(raw)

    // The correct digest this time — the browser did not author `color`, and
    // it survives the round trip anyway because the store reads it from the
    // file itself, inside the same lock the digest check runs under.
    const ok = await applyWrite(project.dir, {
      kind: 'agent.update',
      name: 'scribe',
      digest: agentDigest(raw),
      description: 'b',
      tools: null,
      model: null,
      body: 'body',
    })
    expect(ok).toEqual({ ok: true })
    const after = await readAgent(project.dir, 'scribe')
    expect(after?.description).toBe('b')
    expect(after?.extra).toEqual({ color: 'blue' })
  })

  it('refuses to delete an agent a track still names', async () => {
    await applyWrite(project.dir, CREATE)
    const doc = await readAgent(project.dir, 'scribe')
    await writeConfigWithTrack(project.dir, { required: ['scribe'] })

    const result = await applyWrite(project.dir, { kind: 'agent.delete', name: 'scribe', digest: doc?.digest ?? '' })
    expect(result).toEqual({ ok: false, code: 'write.refused.agent.inUse' })
    // Not `hashTree` — the agent file lives outside `.mjloop` entirely, so the
    // check that matters is the file itself, unmoved.
    expect(await readAgent(project.dir, 'scribe')).toEqual(doc)

    // Proof that it is `deleteAgent`'s own `guard` doing the refusing, run
    // live inside its lock, and not a cached answer from a check made before
    // this handler was ever called: take the same agent back out of the
    // track's `required` list and the very same digest now succeeds.
    await dropFromTrack(project.dir, 'scribe')
    const retried = await applyWrite(project.dir, { kind: 'agent.delete', name: 'scribe', digest: doc?.digest ?? '' })
    expect(retried).toEqual({ ok: true })
    expect(await readAgent(project.dir, 'scribe')).toBeNull()
  })

  it('refuses every agent write while a run is open', async () => {
    await applyWrite(project.dir, CREATE)
    await setStatusRunning(project.dir)

    const before = await hashTree()
    const result = await applyWrite(project.dir, { ...CREATE, name: 'second-scribe' })
    expect(result).toEqual({ ok: false, code: 'write.refused.running' })
    expect(await readAgent(project.dir, 'second-scribe')).toBeNull()
    expect(await hashTree()).toEqual(before)
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
