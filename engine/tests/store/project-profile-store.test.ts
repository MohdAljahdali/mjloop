import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProjectComponent, ProposedProfile } from '../../src/schemas/project-profile.js'
import { resolveLoopPaths } from '../../src/store/paths.js'
import { StalePreconditionError } from '../../src/store/precondition.js'
import {
  InvalidProfileRecordError,
  ProfileRevisionExistsError,
  StaleProfileRevisionError,
  acceptProfile,
  acceptedRevisionFile,
  listAcceptedRevisions,
  proposedProfileFile,
  readAcceptedProfile,
  readAcceptedRevision,
  readProposedProfile,
  writeProposedProfile,
} from '../../src/store/project-profile-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const GENERATED = '2026-07-31T09:00:00.000Z'
const ACCEPTED = new Date('2026-07-31T09:05:00.000Z')

const MOBILE: ProjectComponent = {
  id: 'mobile',
  root: 'mobile',
  technology: 'flutter',
  verification: { test: 'cd mobile && flutter test', lint: null, build: null },
  skillTags: ['flutter'],
}

const SERVICE: ProjectComponent = {
  id: 'service',
  root: 'service',
  technology: 'python',
  verification: { test: 'cd service && pytest', lint: null, build: null },
  skillTags: ['python'],
}

const PROPOSED: ProposedProfile = {
  schema: 1,
  generatedAt: GENERATED,
  components: [MOBILE, SERVICE],
  basis: ['mobile/pubspec.yaml', 'service/pyproject.toml'],
}

let project: TmpProject
beforeEach(async () => { project = await makeTmpProject() })
afterEach(async () => { await project.cleanup() })

/** Every path under `.mjloop`, so a refusal can be shown to have written nothing. */
async function loopTree(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(resolveLoopPaths(dir).root, { withFileTypes: true, recursive: true })
    return entries.map((entry) => path.join(entry.parentPath, entry.name)).sort()
  } catch {
    return []
  }
}

describe('the proposal', () => {
  it('is absent until something proposes one', async () => {
    expect(await readProposedProfile(project.dir)).toBeNull()
  })

  it('round-trips through disk', async () => {
    await writeProposedProfile(project.dir, PROPOSED)
    expect(await readProposedProfile(project.dir)).toEqual(PROPOSED)
    expect(proposedProfileFile(project.dir)).toBe(
      path.join(resolveLoopPaths(project.dir).profile, 'proposed.json'),
    )
  })

  it('is overwritten by the next scan rather than versioned', async () => {
    await writeProposedProfile(project.dir, PROPOSED)
    await writeProposedProfile(project.dir, { ...PROPOSED, components: [MOBILE], basis: ['mobile/pubspec.yaml'] })

    const read = await readProposedProfile(project.dir)
    expect(read?.components.map((component) => component.id)).toEqual(['mobile'])
  })

  it('refuses to write a proposal the schema rejects', async () => {
    await expect(
      writeProposedProfile(project.dir, { ...PROPOSED, components: [SERVICE, MOBILE] }),
    ).rejects.toBeInstanceOf(InvalidProfileRecordError)
    expect(await readProposedProfile(project.dir)).toBeNull()
  })

  it('reads as absent when the file on disk is unusable', async () => {
    // A proposal is disposable: the next scan rewrites it. Failing every reader
    // over a file the engine can always regenerate would be worse than saying
    // there is not one yet.
    await writeProposedProfile(project.dir, PROPOSED)
    await fs.writeFile(proposedProfileFile(project.dir), '{ not json', 'utf8')
    await fs.rm(`${proposedProfileFile(project.dir)}.bak`, { force: true })
    expect(await readProposedProfile(project.dir)).toBeNull()
  })
})

describe('acceptProfile', () => {
  it('writes revision 1 superseding nothing', async () => {
    const accepted = await acceptProfile(
      project.dir,
      { components: [MOBILE, SERVICE], by: 'mohd', generatedAt: GENERATED, expectRevision: null },
      () => ACCEPTED,
    )

    expect(accepted.revision).toBe(1)
    expect(accepted.supersedes).toBeNull()
    expect(accepted.acceptedAt).toBe(ACCEPTED.toISOString())
    expect(accepted.acceptedBy).toBe('mohd')
    expect(accepted.generatedAt).toBe(GENERATED)

    const file = acceptedRevisionFile(project.dir, 1)
    expect(path.basename(file)).toBe('rev-001.json')
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(accepted)
  })

  it('leaves no .bak beside an immutable record', async () => {
    await acceptProfile(
      project.dir,
      { components: [MOBILE], by: 'mohd', generatedAt: GENERATED, expectRevision: null },
      () => ACCEPTED,
    )
    // A `.bak` beside a record nothing may rewrite is a second, mutable copy of
    // it — and the two can then disagree about what a run pinned.
    await expect(fs.access(`${acceptedRevisionFile(project.dir, 1)}.bak`)).rejects.toThrow()
  })

  it('writes revision 2 superseding revision 1', async () => {
    await acceptProfile(
      project.dir,
      { components: [MOBILE], by: 'mohd', generatedAt: GENERATED, expectRevision: null },
      () => ACCEPTED,
    )
    const second = await acceptProfile(
      project.dir,
      { components: [MOBILE, SERVICE], by: 'mohd', generatedAt: GENERATED, expectRevision: 1 },
      () => ACCEPTED,
    )

    expect(second.revision).toBe(2)
    expect(second.supersedes).toBe(1)
    // Rollback is a new revision, never a mutation: revision 1 is still exactly
    // what it was, so nothing a run pinned has moved under it.
    expect((await readAcceptedRevision(project.dir, 1))?.components.map((c) => c.id)).toEqual(['mobile'])
  })

  it('refuses a stale expectRevision and writes nothing', async () => {
    await acceptProfile(
      project.dir,
      { components: [MOBILE], by: 'mohd', generatedAt: GENERATED, expectRevision: null },
      () => ACCEPTED,
    )
    const before = await loopTree(project.dir)

    const refusal = acceptProfile(
      project.dir,
      { components: [SERVICE], by: 'someone-else', generatedAt: GENERATED, expectRevision: null },
      () => ACCEPTED,
    )
    // Everything that already catches a stale precondition catches this — that
    // is the part of the contract that matters — and the message still names
    // the revision rather than borrowing a subject it is not.
    await expect(refusal).rejects.toBeInstanceOf(StalePreconditionError)
    await expect(refusal).rejects.toBeInstanceOf(StaleProfileRevisionError)
    await expect(refusal).rejects.toThrow(/accepted profile revision has moved on.*now on revision 1/)

    expect(await loopTree(project.dir)).toEqual(before)
    expect(await listAcceptedRevisions(project.dir)).toEqual([1])
  })

  it('refuses an expectRevision ahead of what is on record', async () => {
    await expect(
      acceptProfile(
        project.dir,
        { components: [MOBILE], by: 'mohd', generatedAt: GENERATED, expectRevision: 3 },
        () => ACCEPTED,
      ),
    ).rejects.toBeInstanceOf(StalePreconditionError)
    expect(await listAcceptedRevisions(project.dir)).toEqual([])
  })

  it('never overwrites a revision file that is already there', async () => {
    // `listAcceptedRevisions` counts canonical regular files only, so anything
    // else at that path is invisible to the scan yet would still be clobbered.
    const dir = path.join(resolveLoopPaths(project.dir).profile, 'accepted')
    await fs.mkdir(dir, { recursive: true })
    await fs.mkdir(acceptedRevisionFile(project.dir, 1))

    await expect(
      acceptProfile(
        project.dir,
        { components: [MOBILE], by: 'mohd', generatedAt: GENERATED, expectRevision: null },
        () => ACCEPTED,
      ),
    ).rejects.toBeInstanceOf(ProfileRevisionExistsError)
  })

  it('refuses components the schema rejects, before anything lands', async () => {
    await expect(
      acceptProfile(
        project.dir,
        { components: [SERVICE, MOBILE], by: 'mohd', generatedAt: GENERATED, expectRevision: null },
        () => ACCEPTED,
      ),
    ).rejects.toBeInstanceOf(InvalidProfileRecordError)
    expect(await listAcceptedRevisions(project.dir)).toEqual([])
  })
})

describe('reading accepted revisions', () => {
  async function accept(components: ProjectComponent[], expectRevision: number | null): Promise<void> {
    await acceptProfile(project.dir, { components, by: 'mohd', generatedAt: GENERATED, expectRevision }, () => ACCEPTED)
  }

  it('reports none before the first acceptance', async () => {
    expect(await listAcceptedRevisions(project.dir)).toEqual([])
    expect(await readAcceptedProfile(project.dir)).toBeNull()
    expect(await readAcceptedRevision(project.dir, 1)).toBeNull()
  })

  it('returns the highest revision as the accepted profile', async () => {
    await accept([MOBILE], null)
    await accept([SERVICE], 1)
    await accept([MOBILE, SERVICE], 2)

    expect(await listAcceptedRevisions(project.dir)).toEqual([1, 2, 3])
    // There is no mutable "current" pointer to go stale: the accepted profile
    // is whichever revision file is highest.
    expect((await readAcceptedProfile(project.dir))?.revision).toBe(3)
  })

  it('ignores a file in the accepted directory that is not a canonical revision', async () => {
    await accept([MOBILE], null)
    const dir = path.join(resolveLoopPaths(project.dir).profile, 'accepted')
    for (const name of ['notes.md', 'rev-1.json', 'rev-0002.json', 'rev-002.json.tmp']) {
      await fs.writeFile(path.join(dir, name), 'stray\n', 'utf8')
    }
    expect(await listAcceptedRevisions(project.dir)).toEqual([1])
  })

  it('refuses a revision number that could never name a record', async () => {
    for (const revision of [0, -1, 1.5, Number.NaN]) {
      await expect(readAcceptedRevision(project.dir, revision)).rejects.toThrow()
    }
  })

  it('names the file when an accepted revision no longer parses', async () => {
    await accept([MOBILE], null)
    await fs.writeFile(acceptedRevisionFile(project.dir, 1), '{"schema":1}\n', 'utf8')

    // An accepted revision is immutable and pins routing for every later run.
    // Reporting "no accepted profile" for a record that exists but is broken
    // would activate the wrong thing, and silently.
    await expect(readAcceptedProfile(project.dir)).rejects.toBeInstanceOf(InvalidProfileRecordError)
    await expect(readAcceptedProfile(project.dir)).rejects.toThrow(/rev-001\.json/)
  })
})
