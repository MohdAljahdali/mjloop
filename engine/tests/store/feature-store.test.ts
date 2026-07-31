import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProjectComponent } from '../../src/schemas/project-profile.js'
import {
  AcceptanceRequiredError,
  ApprovedRevisionImmutableError,
  FeatureNotApprovedError,
  FeatureNotFoundError,
  FeatureRevisionExistsError,
  InvalidFeatureRecordError,
  StaleFeatureRevisionError,
  UnknownComponentError,
  type FeatureBriefRecord,
  appendFeatureDecision,
  approveFeatureBrief,
  createFeatureBrief,
  featureDirName,
  featureRevisionFile,
  findFeatureDir,
  listFeatureIds,
  listFeatureRevisions,
  listFeatureSummaries,
  readFeatureBrief,
  readFeatureRevision,
  supersedeFeatureBrief,
  updateFeatureDraft,
} from '../../src/store/feature-store.js'
import { resolveLoopPaths } from '../../src/store/paths.js'
import { StalePreconditionError } from '../../src/store/precondition.js'
import { acceptProfile } from '../../src/store/project-profile-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const GENERATED = '2026-07-31T08:00:00.000Z'
const at = (iso: string) => () => new Date(iso)
const CREATED = '2026-07-31T09:00:00.000Z'
/** A well-formed digest of nothing, for the calls that are refused before it is read. */
const NO_SUCH_DIGEST = '0'.repeat(64)

const DRAFT = {
  title: 'Passwordless sign-in',
  problem: 'Members forget passwords and support carries the cost of every reset.',
  discovery: { mode: 'always' as const, questionBudget: 8 },
}

let project: TmpProject
beforeEach(async () => { project = await makeTmpProject() })
afterEach(async () => { await project.cleanup() })

function component(id: string): ProjectComponent {
  return { id, root: id, technology: 'unknown', verification: { test: null, lint: null, build: null }, skillTags: [] }
}

/**
 * An accepted component map, which is what `affectedComponents` is checked
 * against. `expectRevision` is threaded through so a test can move the map
 * *after* a brief was written against it, which is the case the approval check
 * exists for.
 */
async function acceptComponents(dir: string, ids: string[], expectRevision: number | null = null): Promise<void> {
  await acceptProfile(
    dir,
    { components: [...ids].sort().map(component), by: 'mohd', generatedAt: GENERATED, expectRevision },
    at(GENERATED),
  )
}

/** Every file under `.mjloop` with its contents, so a refusal can be shown to have written nothing. */
async function loopSnapshot(dir: string): Promise<Record<string, string>> {
  const root = resolveLoopPaths(dir).root
  let entries: Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true, recursive: true })
  } catch {
    return {}
  }
  const snapshot: Record<string, string> = {}
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const file = path.join(entry.parentPath, entry.name)
    snapshot[path.relative(root, file)] = await fs.readFile(file, 'utf8')
  }
  return snapshot
}

async function draftWithAcceptance(dir: string): Promise<string> {
  const created = await createFeatureBrief(dir, DRAFT, at(CREATED))
  await updateFeatureDraft(dir, created.brief.id, { acceptance: ['A member with no password signs in from a link'] })
  return created.brief.id
}

/**
 * Approve what is on disk, the way a caller that has just read it does.
 *
 * Both halves of the precondition come from the read, because that is what a
 * precondition *is*: the state the decision was made from. The tests that are
 * about the precondition itself build the call by hand instead.
 */
async function approveLatest(dir: string, id: string, when: string, note?: string): Promise<FeatureBriefRecord> {
  const read = await readFeatureBrief(dir, id)
  if (read === null) throw new Error(`no ${id} to approve`)
  return approveFeatureBrief(
    dir,
    {
      id,
      expectRevision: read.brief.revision,
      expectDigest: read.digest,
      by: 'mohd',
      ...(note === undefined ? {} : { note }),
    },
    at(when),
  )
}

describe('paths', () => {
  it('roots features beside the other engine-owned records', () => {
    expect(resolveLoopPaths(project.dir).features).toBe(path.join(project.dir, '.mjloop', 'features'))
  })

  it('names a feature directory after its id and a slugified title', () => {
    expect(featureDirName('F001', 'Passwordless sign-in')).toBe('F001-passwordless-sign-in')
    expect(featureDirName('F001', 'Refresh / rotate  the token!')).toBe('F001-refresh-rotate-the-token')
  })

  it('bounds the directory name whatever the title', () => {
    // NAME_MAX is 255 bytes on every filesystem this runs on, and the id in
    // front of the slug is what makes the name unique anyway.
    expect(featureDirName('F001', 'a'.repeat(200)).length).toBeLessThanOrEqual(65)
  })

  it('still produces a findable name for a title that slugifies to nothing', () => {
    // `F001-` alone is a name `findFeatureDir` can match but nobody can read.
    expect(featureDirName('F001', '!!!')).toBe('F001-feature')
  })

  it('validates the id before it builds a path out of it', () => {
    for (const id of ['../etc', '/etc/passwd', 'Ｆ001', 'f001']) {
      expect(() => featureDirName(id, 'Anything')).toThrow(/F001/)
    }
  })

  it('validates the revision before it names a revision file', () => {
    expect(path.basename(featureRevisionFile('/tmp/F001-x', 1))).toBe('rev-001.json')
    expect(path.basename(featureRevisionFile('/tmp/F001-x', 12))).toBe('rev-012.json')
    for (const revision of [0, -1, 1.5, Number.NaN]) {
      expect(() => featureRevisionFile('/tmp/F001-x', revision)).toThrow()
    }
  })
})

describe('createFeatureBrief', () => {
  it('mints the first draft', async () => {
    const record = await createFeatureBrief(project.dir, DRAFT, at(CREATED))

    expect(record.brief.id).toBe('F001')
    expect(record.brief.revision).toBe(1)
    expect(record.brief.status).toBe('draft')
    expect(record.status).toBe('draft')
    expect(record.brief.approval).toBeNull()
    expect(record.brief.supersedes).toBeNull()
    expect(record.brief.createdAt).toBe(CREATED)
    expect(record.brief.discovery).toEqual({ mode: 'always', questionBudget: 8, completedAt: null })
    expect(record.brief.acceptance).toEqual([])
    expect(record.brief.decisions).toEqual([])

    expect(record.file).toBe(
      path.join(resolveLoopPaths(project.dir).features, 'F001-passwordless-sign-in', 'rev-001.json'),
    )
    expect(JSON.parse(await fs.readFile(record.file, 'utf8'))).toEqual(record.brief)
  })

  it('allocates the next id per feature', async () => {
    await createFeatureBrief(project.dir, DRAFT, at(CREATED))
    const second = await createFeatureBrief(project.dir, { ...DRAFT, title: 'Audit log' }, at(CREATED))
    expect(second.brief.id).toBe('F002')
    expect(await listFeatureIds(project.dir)).toEqual(['F001', 'F002'])
  })

  it('leaves no .bak beside a record that is on its way to being immutable', async () => {
    await createFeatureBrief(project.dir, DRAFT, at(CREATED))
    expect(Object.keys(await loopSnapshot(project.dir)).filter((name) => name.endsWith('.bak'))).toEqual([])
  })

  it('accepts an affected component that is in the accepted map', async () => {
    await acceptComponents(project.dir, ['admin', 'mobile'])
    const record = await createFeatureBrief(project.dir, { ...DRAFT, affectedComponents: ['mobile'] }, at(CREATED))
    expect(record.brief.affectedComponents).toEqual(['mobile'])
  })

  it('refuses a component id the accepted map has never heard of', async () => {
    await acceptComponents(project.dir, ['admin', 'mobile'])
    await expect(
      createFeatureBrief(project.dir, { ...DRAFT, affectedComponents: ['mobile', 'ghost'] }, at(CREATED)),
    ).rejects.toBeInstanceOf(UnknownComponentError)
    expect(await listFeatureIds(project.dir)).toEqual([])
  })

  it('refuses a component id that is not even the shape of an id', async () => {
    await acceptComponents(project.dir, ['mobile'])
    await expect(
      createFeatureBrief(project.dir, { ...DRAFT, affectedComponents: ['../etc'] }, at(CREATED)),
    ).rejects.toBeInstanceOf(InvalidFeatureRecordError)
  })

  it('lets a feature touch nothing yet', async () => {
    await acceptComponents(project.dir, ['mobile'])
    const record = await createFeatureBrief(project.dir, { ...DRAFT, affectedComponents: [] }, at(CREATED))
    expect(record.brief.affectedComponents).toEqual([])
  })

  it('handles a project that has no accepted component map at all', async () => {
    // An empty list is still legal — a project may never have been mapped —
    // but no id can be known, so naming one is refused rather than waved
    // through into a record later routing would join on.
    const record = await createFeatureBrief(project.dir, DRAFT, at(CREATED))
    expect(record.brief.affectedComponents).toEqual([])

    const refused = createFeatureBrief(project.dir, { ...DRAFT, affectedComponents: ['mobile'] }, at(CREATED))
    await expect(refused).rejects.toBeInstanceOf(UnknownComponentError)
    await expect(refused).rejects.toThrow(/accepted component map/)
  })
})

describe('reading', () => {
  it('answers null for a feature nobody has created', async () => {
    // A read of a feature that does not exist is a question with an answer;
    // only a *write* to one is a caller mistake.
    expect(await readFeatureBrief(project.dir, 'F009')).toBeNull()
    expect(await readFeatureRevision(project.dir, 'F009', 1)).toBeNull()
    expect(await listFeatureRevisions(project.dir, 'F009')).toEqual([])
    expect(await listFeatureIds(project.dir)).toEqual([])
    expect(await listFeatureSummaries(project.dir)).toEqual([])
  })

  it('answers null for a revision the feature never reached', async () => {
    await createFeatureBrief(project.dir, DRAFT, at(CREATED))
    expect(await readFeatureRevision(project.dir, 'F001', 4)).toBeNull()
  })

  it('refuses to read a record that is on disk and no longer parses', async () => {
    // The opposite of the profile *proposal*, and deliberately: nothing
    // regenerates a brief, so answering "there is no such feature" for one
    // plainly sitting on disk would let planning proceed as though the
    // interview never happened.
    const record = await createFeatureBrief(project.dir, DRAFT, at(CREATED))
    await fs.writeFile(record.file, '{ not json', 'utf8')
    await expect(readFeatureRevision(project.dir, 'F001', 1)).rejects.toBeInstanceOf(InvalidFeatureRecordError)
  })

  it('summarises every feature for a list view', async () => {
    const id = await draftWithAcceptance(project.dir)
    await approveLatest(project.dir, id, '2026-07-31T09:30:00.000Z')
    await createFeatureBrief(project.dir, { ...DRAFT, title: 'Audit log' }, at(CREATED))

    expect(await listFeatureSummaries(project.dir)).toEqual([
      {
        id: 'F001',
        title: 'Passwordless sign-in',
        status: 'approved',
        latestRevision: 1,
        approvedRevision: 1,
        revisions: [1],
        createdAt: CREATED,
      },
      {
        id: 'F002',
        title: 'Audit log',
        status: 'draft',
        latestRevision: 1,
        approvedRevision: null,
        revisions: [1],
        createdAt: CREATED,
      },
    ])
  })

  it('fingerprints the record, and the fingerprint survives the round trip to disk', async () => {
    // The token an approval swaps on. It is worth nothing unless the value a
    // write hands back is the value the next read produces — otherwise every
    // approval would be refused as stale — and worth nothing unless it moves
    // when the content does.
    const created = await createFeatureBrief(project.dir, DRAFT, at(CREATED))
    expect(created.digest).toMatch(/^[a-f0-9]{64}$/)
    expect((await readFeatureBrief(project.dir, 'F001'))?.digest).toBe(created.digest)
    expect((await readFeatureRevision(project.dir, 'F001', 1))?.digest).toBe(created.digest)

    const updated = await updateFeatureDraft(project.dir, 'F001', { title: 'Magic-link sign-in' })
    expect(updated.digest).not.toBe(created.digest)
    expect((await readFeatureBrief(project.dir, 'F001'))?.digest).toBe(updated.digest)
  })

  it('dates a feature from when it was raised, not from when somebody last changed their mind', async () => {
    const id = await draftWithAcceptance(project.dir)
    await approveLatest(project.dir, id, '2026-07-31T09:30:00.000Z')
    await supersedeFeatureBrief(project.dir, { id, expectRevision: 1 }, at('2026-08-14T17:00:00.000Z'))

    const [summary] = await listFeatureSummaries(project.dir)
    expect(summary?.latestRevision).toBe(2)
    // Revision 1's timestamp, and the extra read `listFeatureSummaries` performs
    // to fetch it is pure cost unless this holds.
    expect(summary?.createdAt).toBe(CREATED)
  })

  it('validates an id before it builds a path from it, on every read', async () => {
    const before = await loopSnapshot(project.dir)
    for (const id of ['../etc', '/etc/passwd', 'Ｆ001', 'F001/../../../etc']) {
      await expect(readFeatureBrief(project.dir, id)).rejects.toThrow(/F001/)
      await expect(readFeatureRevision(project.dir, id, 1)).rejects.toThrow(/F001/)
      await expect(listFeatureRevisions(project.dir, id)).rejects.toThrow(/F001/)
      await expect(findFeatureDir(project.dir, id)).rejects.toThrow(/F001/)
    }
    expect(await loopSnapshot(project.dir)).toEqual(before)
  })

  it('validates an id before it builds a path from it, on every write', async () => {
    const before = await loopSnapshot(project.dir)
    for (const id of ['../etc', '/etc/passwd', 'Ｆ001']) {
      await expect(updateFeatureDraft(project.dir, id, { title: 'Anything' })).rejects.toThrow(/F001/)
      await expect(
        appendFeatureDecision(project.dir, id, { question: 'Why?', recommendation: null, answer: null }),
      ).rejects.toThrow(/F001/)
      await expect(
        approveFeatureBrief(project.dir, { id, expectRevision: 1, expectDigest: NO_SUCH_DIGEST, by: 'mohd' }),
      ).rejects.toThrow(/F001/)
      await expect(supersedeFeatureBrief(project.dir, { id, expectRevision: 1 })).rejects.toThrow(/F001/)
    }
    expect(await loopSnapshot(project.dir)).toEqual(before)
  })

  it('refuses to write to a feature that does not exist', async () => {
    await expect(updateFeatureDraft(project.dir, 'F009', { title: 'Anything' })).rejects.toBeInstanceOf(
      FeatureNotFoundError,
    )
    await expect(
      approveFeatureBrief(project.dir, { id: 'F009', expectRevision: 1, expectDigest: NO_SUCH_DIGEST, by: 'mohd' }),
    ).rejects.toBeInstanceOf(FeatureNotFoundError)
  })
})

describe('a draft is built up', () => {
  it('appends decisions in the order they were asked, stamped by the engine', async () => {
    const created = await createFeatureBrief(project.dir, DRAFT, at(CREATED))
    await appendFeatureDecision(
      project.dir,
      created.brief.id,
      { question: 'Does a link expire?', recommendation: 'Fifteen minutes.', answer: 'Yes, fifteen.' },
      at('2026-07-31T09:05:00.000Z'),
    )
    const record = await appendFeatureDecision(
      project.dir,
      created.brief.id,
      { question: 'Which providers?', recommendation: null, answer: null },
      at('2026-07-31T09:06:00.000Z'),
    )

    expect(record.brief.decisions).toEqual([
      {
        question: 'Does a link expire?',
        recommendation: 'Fifteen minutes.',
        answer: 'Yes, fifteen.',
        at: '2026-07-31T09:05:00.000Z',
      },
      { question: 'Which providers?', recommendation: null, answer: null, at: '2026-07-31T09:06:00.000Z' },
    ])
  })

  it('takes acceptance, components, a title and a problem', async () => {
    await acceptComponents(project.dir, ['mobile'])
    const created = await createFeatureBrief(project.dir, DRAFT, at(CREATED))
    const record = await updateFeatureDraft(project.dir, created.brief.id, {
      title: 'Magic-link sign-in',
      problem: 'Password resets are the single largest support cost.',
      acceptance: ['A member signs in from a link', 'A link expires after fifteen minutes'],
      affectedComponents: ['mobile'],
      discoveryCompletedAt: '2026-07-31T09:20:00.000Z',
    })

    expect(record.brief.title).toBe('Magic-link sign-in')
    expect(record.brief.problem).toBe('Password resets are the single largest support cost.')
    expect(record.brief.acceptance).toHaveLength(2)
    expect(record.brief.affectedComponents).toEqual(['mobile'])
    expect(record.brief.discovery.completedAt).toBe('2026-07-31T09:20:00.000Z')
  })

  it('leaves the directory named after the title the feature was created with', async () => {
    // The directory name is the id's index, not a display value. Renaming it on
    // a retitle would move a record a run may already have pinned, and would do
    // it for a change that is only ever cosmetic.
    const created = await createFeatureBrief(project.dir, DRAFT, at(CREATED))
    await updateFeatureDraft(project.dir, created.brief.id, { title: 'Magic-link sign-in' })

    expect(await findFeatureDir(project.dir, 'F001')).toBe(
      path.join(resolveLoopPaths(project.dir).features, 'F001-passwordless-sign-in'),
    )
    expect((await readFeatureBrief(project.dir, 'F001'))?.brief.title).toBe('Magic-link sign-in')
  })

  it('lets the interview behind a successor record its own policy', async () => {
    // A successor inherits the whole of its predecessor's content, `discovery`
    // included — but the second interview is a different interview, and it may
    // run under a mode the project has since moved to or an override stated for
    // this request alone. Without this, every revision above the first records
    // the policy the revision before it ran under, which is the one thing
    // `DiscoverySchema` says the block must never do.
    const id = await draftWithAcceptance(project.dir)
    await approveLatest(project.dir, id, '2026-07-31T09:30:00.000Z')
    await supersedeFeatureBrief(project.dir, { id, expectRevision: 1 }, at('2026-07-31T10:00:00.000Z'))
    expect((await readFeatureBrief(project.dir, id))?.brief.discovery.mode).toBe('always')

    const record = await updateFeatureDraft(project.dir, id, { discoveryMode: 'ask', discoveryQuestionBudget: 3 })
    expect(record.brief.discovery).toEqual({ mode: 'ask', questionBudget: 3, completedAt: null })
  })

  it('refuses a component the accepted map does not name, and writes nothing', async () => {
    await acceptComponents(project.dir, ['mobile'])
    const created = await createFeatureBrief(project.dir, DRAFT, at(CREATED))
    const before = await loopSnapshot(project.dir)

    await expect(
      updateFeatureDraft(project.dir, created.brief.id, { affectedComponents: ['ghost'] }),
    ).rejects.toBeInstanceOf(UnknownComponentError)
    expect(await loopSnapshot(project.dir)).toEqual(before)
  })
})

describe('approveFeatureBrief', () => {
  it('records the actor, the timestamp and the approver\'s own words', async () => {
    const id = await draftWithAcceptance(project.dir)
    const record = await approveLatest(project.dir, id, '2026-07-31T09:30:00.000Z', 'Ship the link, not the code.')

    expect(record.brief.status).toBe('approved')
    expect(record.brief.approval).toEqual({
      by: 'mohd',
      at: '2026-07-31T09:30:00.000Z',
      note: 'Ship the link, not the code.',
    })
    expect(JSON.parse(await fs.readFile(record.file, 'utf8'))).toEqual(record.brief)
    // No `.bak` anywhere along the draft-to-approved path: a backup beside an
    // immutable record is a second, mutable copy of it, and the two can then
    // disagree about what a run pinned.
    expect(Object.keys(await loopSnapshot(project.dir)).filter((name) => name.endsWith('.bak'))).toEqual([])
  })

  it('refuses a brief with no acceptance criteria, and writes nothing', async () => {
    // The other half of the schema's rule: a draft may have an empty list, and
    // approval is where that stops being allowed.
    const created = await createFeatureBrief(project.dir, DRAFT, at(CREATED))
    const before = await loopSnapshot(project.dir)

    await expect(
      approveFeatureBrief(project.dir, {
        id: created.brief.id,
        expectRevision: 1,
        expectDigest: created.digest,
        by: 'mohd',
      }),
    ).rejects.toBeInstanceOf(AcceptanceRequiredError)
    expect(await loopSnapshot(project.dir)).toEqual(before)
  })

  it('refuses an approval built on a revision that has moved on, and writes nothing', async () => {
    const id = await draftWithAcceptance(project.dir)
    const first = await approveLatest(project.dir, id, '2026-07-31T09:30:00.000Z')
    await supersedeFeatureBrief(project.dir, { id, expectRevision: 1 }, at('2026-07-31T09:40:00.000Z'))
    const before = await loopSnapshot(project.dir)

    // Revision 1's own digest, which is what a screen still showing revision 1
    // would hand back. The number is what moved, and that is what is reported.
    const stale = approveFeatureBrief(project.dir, {
      id,
      expectRevision: 1,
      expectDigest: first.digest,
      by: 'someone else',
    })
    await expect(stale).rejects.toBeInstanceOf(StaleFeatureRevisionError)
    // The base class is what every existing caller catches, and the web write
    // path is one of them.
    await expect(stale).rejects.toBeInstanceOf(StalePreconditionError)
    expect(await loopSnapshot(project.dir)).toEqual(before)
  })

  it('refuses an approval built on words that moved after they were read, and writes nothing', async () => {
    // The revision number cannot answer this. A draft keeps the same number for
    // its whole editable life — that is what makes it a draft — so an approval
    // that only swapped on the number would land on whatever the brief says by
    // the time it arrives, which is the case `docs/usage.md` says is refused:
    // "another window, another session, one last decision appended".
    const id = await draftWithAcceptance(project.dir)
    const read = await readFeatureBrief(project.dir, id)
    await appendFeatureDecision(
      project.dir,
      id,
      { question: 'Should a session expire after thirty days?', recommendation: null, answer: 'Yes, expire it.' },
      at('2026-07-31T09:20:00.000Z'),
    )
    const before = await loopSnapshot(project.dir)

    const stale = approveFeatureBrief(project.dir, {
      id,
      expectRevision: read?.brief.revision ?? 1,
      expectDigest: read?.digest ?? '',
      by: 'mohd',
    })
    await expect(stale).rejects.toBeInstanceOf(StalePreconditionError)
    expect(await loopSnapshot(project.dir)).toEqual(before)
    // …and the record is still a draft, so the words nobody read are still editable.
    expect((await readFeatureBrief(project.dir, id))?.brief.status).toBe('draft')
  })

  it('approves the words that were actually read', async () => {
    // The other half: the precondition refuses a moved brief and must not
    // refuse an unmoved one, or approval would be unreachable.
    const id = await draftWithAcceptance(project.dir)
    const record = await approveLatest(project.dir, id, '2026-07-31T09:30:00.000Z')
    expect(record.brief.status).toBe('approved')
  })

  it('refuses an approval whose components have left the accepted map, and writes nothing', async () => {
    // The map moved between drafting and approving. Approval is the write after
    // which the revision can never be rewritten, so it is the last moment this
    // can be caught — and `updateFeatureDraft` already refuses the identical
    // state, which would make approval the more permissive of the two.
    await acceptComponents(project.dir, ['api', 'web'])
    const created = await createFeatureBrief(
      project.dir,
      { ...DRAFT, affectedComponents: ['web'], acceptance: ['A member signs in from a link'] },
      at(CREATED),
    )
    const read = await readFeatureBrief(project.dir, created.brief.id)
    await acceptComponents(project.dir, ['api'], 1)
    const before = await loopSnapshot(project.dir)

    const refused = approveFeatureBrief(project.dir, {
      id: created.brief.id,
      expectRevision: 1,
      expectDigest: read?.digest ?? '',
      by: 'mohd',
    })
    await expect(refused).rejects.toBeInstanceOf(UnknownComponentError)
    expect(await loopSnapshot(project.dir)).toEqual(before)
    // The draft is still writable, so the way out is naming the components the
    // project now has rather than a record frozen around one it does not.
    expect((await readFeatureBrief(project.dir, created.brief.id))?.brief.status).toBe('draft')
  })

  it('lets exactly one of two concurrent approvals win', async () => {
    const id = await draftWithAcceptance(project.dir)
    // Both read the same draft, which is what makes them concurrent rather than
    // sequential: they hold the same expectation and only one can still be true
    // by the time the second takes the lock.
    const read = await readFeatureBrief(project.dir, id)
    const expectation = { expectRevision: read?.brief.revision ?? 1, expectDigest: read?.digest ?? '' }
    const results = await Promise.allSettled([
      approveFeatureBrief(project.dir, { id, ...expectation, by: 'first' }, at('2026-07-31T09:30:00.000Z')),
      approveFeatureBrief(project.dir, { id, ...expectation, by: 'second' }, at('2026-07-31T09:31:00.000Z')),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const approval = (await readFeatureBrief(project.dir, id))?.brief.approval
    expect(['first', 'second']).toContain(approval?.by)
  })
})

describe('an approved revision is immutable', () => {
  it('is refused by every mutator, byte for byte', async () => {
    const id = await draftWithAcceptance(project.dir)
    const approved = await approveLatest(project.dir, id, '2026-07-31T09:30:00.000Z')
    const before = await loopSnapshot(project.dir)

    await expect(updateFeatureDraft(project.dir, id, { title: 'Something else' })).rejects.toBeInstanceOf(
      ApprovedRevisionImmutableError,
    )
    await expect(updateFeatureDraft(project.dir, id, { acceptance: ['Anything'] })).rejects.toBeInstanceOf(
      ApprovedRevisionImmutableError,
    )
    await expect(
      appendFeatureDecision(project.dir, id, { question: 'One more?', recommendation: null, answer: null }),
    ).rejects.toBeInstanceOf(ApprovedRevisionImmutableError)
    // Approving with the *approved* record's own digest: nothing has moved
    // since this caller read it, so what it is told is that somebody else got
    // there first rather than that the words changed.
    await expect(
      approveFeatureBrief(project.dir, {
        id,
        expectRevision: 1,
        expectDigest: approved.digest,
        by: 'someone else',
      }),
    ).rejects.toBeInstanceOf(ApprovedRevisionImmutableError)

    expect(await loopSnapshot(project.dir)).toEqual(before)
    expect(JSON.parse(await fs.readFile(approved.file, 'utf8'))).toEqual(approved.brief)
  })

  it('names superseding as the way forward', async () => {
    const id = await draftWithAcceptance(project.dir)
    await approveLatest(project.dir, id, '2026-07-31T09:30:00.000Z')
    await expect(updateFeatureDraft(project.dir, id, { title: 'Something else' })).rejects.toThrow(/[Ss]upersede/)
  })
})

describe('supersedeFeatureBrief', () => {
  it('creates the successor as a draft and leaves its predecessor byte-identical', async () => {
    await acceptComponents(project.dir, ['mobile'])
    const id = await draftWithAcceptance(project.dir)
    await updateFeatureDraft(project.dir, id, { affectedComponents: ['mobile'] })
    await appendFeatureDecision(
      project.dir,
      id,
      { question: 'Does a link expire?', recommendation: null, answer: 'Fifteen minutes.' },
      at('2026-07-31T09:10:00.000Z'),
    )
    const approved = await approveLatest(project.dir, id, '2026-07-31T09:30:00.000Z')
    const predecessorBytes = await fs.readFile(approved.file, 'utf8')

    const successor = await supersedeFeatureBrief(project.dir, { id, expectRevision: 1 }, at('2026-07-31T10:00:00.000Z'))

    expect(successor.brief.revision).toBe(2)
    expect(successor.brief.status).toBe('draft')
    expect(successor.brief.approval).toBeNull()
    expect(successor.brief.supersedes).toEqual({ id, revision: 1 })
    expect(successor.brief.createdAt).toBe('2026-07-31T10:00:00.000Z')
    // The content it carries forward is the approved content, verbatim.
    expect(successor.brief.problem).toBe(approved.brief.problem)
    expect(successor.brief.acceptance).toEqual(approved.brief.acceptance)
    expect(successor.brief.affectedComponents).toEqual(['mobile'])
    expect(successor.brief.decisions).toEqual(approved.brief.decisions)
    expect(successor.brief.discovery).toEqual(approved.brief.discovery)

    expect(path.basename(successor.file)).toBe('rev-002.json')
    expect(await fs.readFile(approved.file, 'utf8')).toBe(predecessorBytes)
    expect(await listFeatureRevisions(project.dir, id)).toEqual([1, 2])
  })

  it('refuses to supersede a draft, which can simply be edited', async () => {
    const id = await draftWithAcceptance(project.dir)
    await expect(supersedeFeatureBrief(project.dir, { id, expectRevision: 1 })).rejects.toBeInstanceOf(
      FeatureNotApprovedError,
    )
    expect(await listFeatureRevisions(project.dir, id)).toEqual([1])
  })

  it('refuses a stale expectation, and writes nothing', async () => {
    const id = await draftWithAcceptance(project.dir)
    await approveLatest(project.dir, id, '2026-07-31T09:30:00.000Z')
    const before = await loopSnapshot(project.dir)

    await expect(supersedeFeatureBrief(project.dir, { id, expectRevision: 2 })).rejects.toBeInstanceOf(
      StaleFeatureRevisionError,
    )
    expect(await loopSnapshot(project.dir)).toEqual(before)
  })

  it('refuses to write a revision file twice, over something the scan cannot see', async () => {
    // `listRevisionsIn` counts canonically named regular *files*, so a
    // directory sitting at the successor's path is invisible to `latest + 1`
    // and the atomic rename would land on top of it: without the guard the
    // caller gets a raw EISDIR and a stray `.tmp` is left beside an immutable
    // record. The accepted profile's analogue is asserted the same way.
    const id = await draftWithAcceptance(project.dir)
    await approveLatest(project.dir, id, '2026-07-31T09:30:00.000Z')
    await fs.mkdir(featureRevisionFile(await findFeatureDir(project.dir, id), 2))
    const before = await loopSnapshot(project.dir)

    await expect(supersedeFeatureBrief(project.dir, { id, expectRevision: 1 })).rejects.toBeInstanceOf(
      FeatureRevisionExistsError,
    )
    expect(await loopSnapshot(project.dir)).toEqual(before)
    expect(await listFeatureRevisions(project.dir, id)).toEqual([1])
  })

  it('makes the latest revision the one a reader gets', async () => {
    const id = await draftWithAcceptance(project.dir)
    await approveLatest(project.dir, id, '2026-07-31T09:30:00.000Z')
    await supersedeFeatureBrief(project.dir, { id, expectRevision: 1 }, at('2026-07-31T10:00:00.000Z'))

    expect((await readFeatureBrief(project.dir, id))?.brief.revision).toBe(2)
  })
})

describe('superseded is derived', () => {
  it('reports an earlier revision as superseded without ever storing the word', async () => {
    const id = await draftWithAcceptance(project.dir)
    await approveLatest(project.dir, id, '2026-07-31T09:30:00.000Z')
    await supersedeFeatureBrief(project.dir, { id, expectRevision: 1 }, at('2026-07-31T10:00:00.000Z'))

    const first = await readFeatureRevision(project.dir, id, 1)
    expect(first?.status).toBe('superseded')
    // The record itself still says exactly what it always said.
    expect(first?.brief.status).toBe('approved')

    const latest = await readFeatureRevision(project.dir, id, 2)
    expect(latest?.status).toBe('draft')

    for (const [file, contents] of Object.entries(await loopSnapshot(project.dir))) {
      expect(contents, `${file} stores a status nothing may write`).not.toContain('superseded')
    }
  })
})

describe('rollback is reselection', () => {
  it('walks 1 to 2 to an approval of 1\'s content as 3, changing neither 1 nor 2', async () => {
    const id = await draftWithAcceptance(project.dir)
    const first = await approveLatest(project.dir, id, '2026-07-31T09:30:00.000Z')
    const firstBytes = await fs.readFile(first.file, 'utf8')

    await supersedeFeatureBrief(project.dir, { id, expectRevision: 1 }, at('2026-07-31T10:00:00.000Z'))
    await updateFeatureDraft(project.dir, id, {
      problem: 'A second answer to the same question.',
      acceptance: ['A member signs in with a one-time code'],
    })
    const second = await approveLatest(project.dir, id, '2026-07-31T10:30:00.000Z')
    const secondBytes = await fs.readFile(second.file, 'utf8')

    // Rolling back is approving the earlier content again as a *new* revision.
    // Nothing is mutated and nothing is deleted.
    await supersedeFeatureBrief(project.dir, { id, expectRevision: 2 }, at('2026-07-31T11:00:00.000Z'))
    await updateFeatureDraft(project.dir, id, {
      problem: first.brief.problem,
      acceptance: [...first.brief.acceptance],
    })
    const third = await approveLatest(project.dir, id, '2026-07-31T11:30:00.000Z', 'Back to the link.')

    expect(third.brief.revision).toBe(3)
    expect(third.brief.problem).toBe(first.brief.problem)
    expect(third.brief.acceptance).toEqual(first.brief.acceptance)
    expect(third.brief.supersedes).toEqual({ id, revision: 2 })

    expect(await fs.readFile(first.file, 'utf8')).toBe(firstBytes)
    expect(await fs.readFile(second.file, 'utf8')).toBe(secondBytes)
    expect(await listFeatureRevisions(project.dir, id)).toEqual([1, 2, 3])
    expect((await readFeatureRevision(project.dir, id, 1))?.status).toBe('superseded')
    expect((await readFeatureRevision(project.dir, id, 2))?.status).toBe('superseded')
    expect((await readFeatureBrief(project.dir, id))?.status).toBe('approved')
  })
})
