import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SkillPackage } from '../../src/schemas/skill-library.js'
import {
  InvalidSkillAcceptanceRecordError,
  InvalidSkillIdError,
  PackageNotAuditedError,
  PackageNotFoundError,
  SkillAcceptanceNotFoundError,
  SkillAlreadyAcceptedError,
  UnknownAcceptanceAgentError,
  UnknownAcceptanceComponentError,
  acceptSkill,
  listAcceptances,
  readAcceptance,
  removeAcceptance,
  setAcceptanceStatus,
} from '../../src/store/skill-acceptance-store.js'
import { writePackage } from '../../src/store/skill-library-store.js'
import { acceptProfile } from '../../src/store/project-profile-store.js'
import { resolveLoopPaths } from '../../src/store/paths.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const DIGEST_A = 'a'.repeat(64)
const DIGEST_B = 'b'.repeat(64)
const NOW = new Date('2026-07-31T09:00:00.000Z')
const clock = () => NOW

function skillPackage(digest: string, overrides: Partial<SkillPackage> = {}): SkillPackage {
  return {
    schema: 1,
    packageId: 'flutter-widgets',
    digest,
    source: { kind: 'github', url: 'https://github.com/example/flutter-widgets', revision: 'a1b2c3d' },
    license: { spdx: 'MIT', file: 'LICENSE' },
    skillName: 'Flutter Widgets',
    description: 'Shared widget kit conventions for the mobile component.',
    tags: ['flutter'],
    dependencies: { executables: [], packages: ['flutter'] },
    audit: { state: 'pending', findings: [], at: null },
    guidance: 'Use the shared widget kit under lib/widgets.',
    importedAt: '2026-07-30T09:00:00.000Z',
    ...overrides,
  }
}

const AUDITED = { state: 'passed' as const, findings: [], at: '2026-07-30T09:00:00.000Z' }

let dataHome: string
let contentDir: string
let project: TmpProject

beforeEach(async () => {
  dataHome = await fs.mkdtemp(path.join(os.tmpdir(), 'loop-library-'))
  process.env.MJLOOP_DATA_HOME = dataHome
  project = await makeTmpProject()
  contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loop-content-'))
  await fs.writeFile(path.join(contentDir, 'SKILL.md'), '# Flutter Widgets\n', 'utf8')
})

afterEach(async () => {
  delete process.env.MJLOOP_DATA_HOME
  await project.cleanup()
  await fs.rm(dataHome, { recursive: true, force: true })
  await fs.rm(contentDir, { recursive: true, force: true })
})

describe('listAcceptances / readAcceptance', () => {
  it('is empty on a project that has accepted nothing yet', async () => {
    expect(await listAcceptances(project.dir)).toEqual([])
    expect(await readAcceptance(project.dir, 'flutter-widgets')).toBeNull()
  })

  it('validates a skill id before it is joined into a path', async () => {
    await expect(readAcceptance(project.dir, '../../../etc/passwd')).rejects.toThrow(InvalidSkillIdError)
    await expect(readAcceptance(project.dir, path.resolve('/etc/passwd'))).rejects.toThrow(InvalidSkillIdError)
    await expect(readAcceptance(project.dir, 'skill with spaces')).rejects.toThrow(InvalidSkillIdError)
    // A unicode lookalike is not itself an ascii letter/digit/-/_ .
    await expect(readAcceptance(project.dir, 'а-skill')).rejects.toThrow(InvalidSkillIdError)
  })

  it('throws on a record that exists but does not parse, rather than reading it as absent', async () => {
    const dir = resolveLoopPaths(project.dir).skills
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'flutter-widgets.json'), '{ not json', 'utf8')
    await expect(readAcceptance(project.dir, 'flutter-widgets')).rejects.toThrow(InvalidSkillAcceptanceRecordError)
  })
})

describe('acceptSkill', () => {
  it('refuses a digest this machine has no package for', async () => {
    await expect(
      acceptSkill(project.dir, { packageDigest: DIGEST_A, updatePolicy: 'review', acceptedBy: 'tester' }, clock),
    ).rejects.toThrow(PackageNotFoundError)
  })

  it('refuses a package whose audit has not passed', async () => {
    await writePackage(project.dir, skillPackage(DIGEST_A), contentDir)
    await expect(
      acceptSkill(project.dir, { packageDigest: DIGEST_A, updatePolicy: 'review', acceptedBy: 'tester' }, clock),
    ).rejects.toThrow(PackageNotAuditedError)
    expect(await listAcceptances(project.dir)).toEqual([])
  })

  it('accepts a passed-audit package and derives the skill id from the package id', async () => {
    // No `--agents`, so the acceptance takes every role dynamic selection
    // dispatches to. Omitting the flag means "wherever this skill fits", not
    // "nowhere": selection joins on the component id AND on a tag, so a wide
    // role set cannot widen what actually matches, while an empty one matches
    // nothing at all and would have recorded a live-looking acceptance that
    // routed nothing on every run.
    await writePackage(project.dir, skillPackage(DIGEST_A, { audit: AUDITED }), contentDir)
    const record = await acceptSkill(
      project.dir,
      { packageDigest: DIGEST_A, updatePolicy: 'review', acceptedBy: 'tester' },
      clock,
    )
    expect(record).toEqual({
      schema: 1,
      skillId: 'flutter-widgets',
      packageId: 'flutter-widgets',
      digest: DIGEST_A,
      // This project has accepted no component map, so there is no id to
      // default to. The acceptance is inert until one lands, which `skills
      // list` shows rather than hides.
      components: [],
      agents: ['planner', 'builder', 'critic', 'verifier'],
      tags: ['flutter'],
      updatePolicy: 'review',
      status: 'active',
      compatible: true,
      acceptedBy: 'tester',
      acceptedAt: NOW.toISOString(),
    })
    expect(await readAcceptance(project.dir, 'flutter-widgets')).toEqual(record)
  })

  it('defaults the component set to the accepted map, so the headline invocation is not inert', async () => {
    // The defect this default closes: `skills accept <digest>` with no flags
    // used to write `components: []`, which `selectSkills` can never match, and
    // report success. The tag join is what makes widening safe — a package
    // tagged `flutter` accepted for both components still selects only on the
    // one whose `skillTags` carry `flutter`.
    await acceptProfile(
      project.dir,
      {
        components: [
          { id: 'admin', root: 'admin', technology: 'nextjs', verification: { test: null, lint: null, build: null }, skillTags: ['nextjs'] },
          { id: 'mobile', root: 'mobile', technology: 'flutter', verification: { test: null, lint: null, build: null }, skillTags: ['flutter'] },
        ],
        by: 'tester',
        generatedAt: NOW.toISOString(),
        expectRevision: null,
      },
      clock,
    )
    await writePackage(project.dir, skillPackage(DIGEST_A, { audit: AUDITED }), contentDir)

    const record = await acceptSkill(
      project.dir,
      { packageDigest: DIGEST_A, updatePolicy: 'review', acceptedBy: 'tester' },
      clock,
    )
    expect(record.components).toEqual(['admin', 'mobile'])
    expect(record.agents).toEqual(['planner', 'builder', 'critic', 'verifier'])
  })

  it('refuses a components id the accepted profile does not have', async () => {
    await writePackage(project.dir, skillPackage(DIGEST_A, { audit: AUDITED }), contentDir)
    await expect(
      acceptSkill(
        project.dir,
        { packageDigest: DIGEST_A, components: ['mobile'], updatePolicy: 'review', acceptedBy: 'tester' },
        clock,
      ),
    ).rejects.toThrow(UnknownAcceptanceComponentError)
    expect(await listAcceptances(project.dir)).toEqual([])
  })

  it('accepts a known component once the profile has it', async () => {
    await acceptProfile(
      project.dir,
      {
        components: [{ id: 'mobile', root: 'mobile', technology: 'flutter', verification: { test: null, lint: null, build: null }, skillTags: [] }],
        by: 'tester',
        generatedAt: NOW.toISOString(),
        expectRevision: null,
      },
      clock,
    )
    await writePackage(project.dir, skillPackage(DIGEST_A, { audit: AUDITED }), contentDir)
    const record = await acceptSkill(
      project.dir,
      { packageDigest: DIGEST_A, components: ['mobile'], agents: ['builder'], updatePolicy: 'auto', acceptedBy: 'tester' },
      clock,
    )
    expect(record.components).toEqual(['mobile'])
    expect(record.agents).toEqual(['builder'])
  })

  it('refuses an agent name that is not one of the fixed roles', async () => {
    await writePackage(project.dir, skillPackage(DIGEST_A, { audit: AUDITED }), contentDir)
    await expect(
      acceptSkill(
        project.dir,
        { packageDigest: DIGEST_A, agents: ['hypothesis-tester'], updatePolicy: 'review', acceptedBy: 'tester' },
        clock,
      ),
    ).rejects.toThrow(UnknownAcceptanceAgentError)
  })

  it('refuses a second acceptance of the same source without removing the first', async () => {
    await writePackage(project.dir, skillPackage(DIGEST_A, { audit: AUDITED }), contentDir)
    await acceptSkill(project.dir, { packageDigest: DIGEST_A, updatePolicy: 'review', acceptedBy: 'tester' }, clock)
    await expect(
      acceptSkill(project.dir, { packageDigest: DIGEST_A, updatePolicy: 'review', acceptedBy: 'tester' }, clock),
    ).rejects.toThrow(SkillAlreadyAcceptedError)
  })
})

describe('setAcceptanceStatus', () => {
  it('flips status and refuses when there is no such acceptance', async () => {
    await writePackage(project.dir, skillPackage(DIGEST_A, { audit: AUDITED }), contentDir)
    await acceptSkill(project.dir, { packageDigest: DIGEST_A, updatePolicy: 'review', acceptedBy: 'tester' }, clock)

    const disabled = await setAcceptanceStatus(project.dir, 'flutter-widgets', 'disabled')
    expect(disabled.status).toBe('disabled')
    expect((await readAcceptance(project.dir, 'flutter-widgets'))?.status).toBe('disabled')

    await expect(setAcceptanceStatus(project.dir, 'no-such-skill', 'active')).rejects.toThrow(SkillAcceptanceNotFoundError)
  })
})

describe('removeAcceptance', () => {
  it('deletes this project\'s record and is idempotent when there is none', async () => {
    await writePackage(project.dir, skillPackage(DIGEST_A, { audit: AUDITED }), contentDir)
    await acceptSkill(project.dir, { packageDigest: DIGEST_A, updatePolicy: 'review', acceptedBy: 'tester' }, clock)
    await removeAcceptance(project.dir, 'flutter-widgets')
    expect(await readAcceptance(project.dir, 'flutter-widgets')).toBeNull()
    await expect(removeAcceptance(project.dir, 'flutter-widgets')).resolves.toBeUndefined()
  })

  it('validates the skill id before deleting anything', async () => {
    await expect(removeAcceptance(project.dir, '../../../etc')).rejects.toThrow(InvalidSkillIdError)
  })
})

describe('cross-project isolation (S06 §8)', () => {
  it('two projects sharing one library accept different digests of the same source, unaffected by each other', async () => {
    const other = await makeTmpProject()
    try {
      await writePackage(project.dir, skillPackage(DIGEST_A, { audit: AUDITED }), contentDir)
      await writePackage(
        other.dir,
        skillPackage(DIGEST_B, {
          audit: AUDITED,
          source: { kind: 'github', url: 'https://github.com/example/flutter-widgets', revision: 'z9y8x7w' },
        }),
        contentDir,
      )

      await acceptSkill(project.dir, { packageDigest: DIGEST_A, updatePolicy: 'review', acceptedBy: 'a' }, clock)
      await acceptSkill(other.dir, { packageDigest: DIGEST_B, updatePolicy: 'pinned', acceptedBy: 'b' }, clock)

      const mine = await readAcceptance(project.dir, 'flutter-widgets')
      const theirs = await readAcceptance(other.dir, 'flutter-widgets')
      expect(mine?.digest).toBe(DIGEST_A)
      expect(theirs?.digest).toBe(DIGEST_B)

      // Neither record moved when the other project wrote its own.
      expect(mine?.updatePolicy).toBe('review')
      expect(theirs?.updatePolicy).toBe('pinned')

      // Both packages still exist in the one shared library.
      const { listPackages } = await import('../../src/store/skill-library-store.js')
      expect((await listPackages(project.dir)).packages.map((p) => p.digest).sort()).toEqual([DIGEST_A, DIGEST_B])
    } finally {
      await other.cleanup()
    }
  })

  it("removing one project's acceptance leaves the other project's record and the package byte-identical", async () => {
    const other = await makeTmpProject()
    try {
      await writePackage(project.dir, skillPackage(DIGEST_A, { audit: AUDITED }), contentDir)
      await acceptSkill(project.dir, { packageDigest: DIGEST_A, updatePolicy: 'review', acceptedBy: 'a' }, clock)
      await acceptSkill(other.dir, { packageDigest: DIGEST_A, updatePolicy: 'auto', acceptedBy: 'b' }, clock)

      const theirsBefore = await readAcceptance(other.dir, 'flutter-widgets')

      await removeAcceptance(project.dir, 'flutter-widgets')

      expect(await readAcceptance(project.dir, 'flutter-widgets')).toBeNull()
      expect(await readAcceptance(other.dir, 'flutter-widgets')).toEqual(theirsBefore)

      const { readPackage } = await import('../../src/store/skill-library-store.js')
      expect(await readPackage(project.dir, DIGEST_A)).not.toBeNull()
    } finally {
      await other.cleanup()
    }
  })
})
