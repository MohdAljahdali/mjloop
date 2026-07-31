import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SkillPackage } from '../../src/schemas/skill-library.js'
import type { ProjectComponent } from '../../src/schemas/project-profile.js'
import { readAcceptedProjectSkills } from '../../src/ops/skill-library.js'
import { selectSkills } from '../../src/ops/skill-selection.js'
import { acceptSkill, setAcceptanceStatus } from '../../src/store/skill-acceptance-store.js'
import { writePackage } from '../../src/store/skill-library-store.js'
import { acceptProfile } from '../../src/store/project-profile-store.js'
import { approveFeatureBrief, createFeatureBrief } from '../../src/store/feature-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const DIGEST_A = 'a'.repeat(64)
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
    audit: { state: 'passed', findings: [], at: '2026-07-30T09:00:00.000Z' },
    guidance: 'Use the shared widget kit under lib/widgets.',
    importedAt: '2026-07-30T09:00:00.000Z',
    ...overrides,
  }
}

const mobileComponent: ProjectComponent = {
  id: 'mobile',
  root: 'mobile',
  technology: 'flutter',
  verification: { test: null, lint: null, build: null },
  skillTags: ['flutter'],
}

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

describe('readAcceptedProjectSkills', () => {
  it('is empty on a project with no acceptances', async () => {
    const result = await readAcceptedProjectSkills(project.dir)
    expect(result).toEqual({ skills: [], skippedSkillIds: [] })
  })

  it('joins an acceptance to its package by digest, carrying guidance from the package and everything else from the acceptance', async () => {
    await acceptProfile(project.dir, { components: [mobileComponent], by: 'tester', generatedAt: NOW.toISOString(), expectRevision: null }, clock)
    await writePackage(project.dir, skillPackage(DIGEST_A), contentDir)
    await acceptSkill(
      project.dir,
      { packageDigest: DIGEST_A, components: ['mobile'], agents: ['builder'], updatePolicy: 'review', acceptedBy: 'tester' },
      clock,
    )

    const { skills, skippedSkillIds } = await readAcceptedProjectSkills(project.dir)
    expect(skippedSkillIds).toEqual([])
    expect(skills).toEqual([
      {
        skillId: 'flutter-widgets',
        packageDigest: DIGEST_A,
        components: ['mobile'],
        tags: ['flutter'],
        agents: ['builder'],
        guidance: 'Use the shared widget kit under lib/widgets.',
        status: 'active',
        compatible: true,
      },
    ])
  })

  it('skips, and reports, an acceptance whose package this machine does not hold', async () => {
    await writePackage(project.dir, skillPackage(DIGEST_A), contentDir)
    await acceptSkill(project.dir, { packageDigest: DIGEST_A, updatePolicy: 'review', acceptedBy: 'tester' }, clock)

    // The package leaves this machine's library — the teammate-imported-it,
    // never-fetched-here case the story names — while the acceptance record
    // (as it would in a repository) stays.
    await fs.rm(path.join(dataHome, 'packages', DIGEST_A), { recursive: true, force: true })

    const { skills, skippedSkillIds } = await readAcceptedProjectSkills(project.dir)
    expect(skills).toEqual([])
    expect(skippedSkillIds).toEqual(['flutter-widgets'])
  })

  it('returns a disabled acceptance rather than filtering it out', async () => {
    await writePackage(project.dir, skillPackage(DIGEST_A), contentDir)
    await acceptSkill(project.dir, { packageDigest: DIGEST_A, updatePolicy: 'review', acceptedBy: 'tester' }, clock)
    await setAcceptanceStatus(project.dir, 'flutter-widgets', 'disabled')

    const { skills } = await readAcceptedProjectSkills(project.dir)
    expect(skills).toHaveLength(1)
    expect(skills[0]?.status).toBe('disabled')
  })
})

describe('a project cannot select an unaccepted package (S06 §8)', () => {
  async function approvedFeature() {
    const created = await createFeatureBrief(
      project.dir,
      {
        title: 'Passwordless sign-in',
        problem: 'Members forget passwords.',
        discovery: { mode: 'off', questionBudget: 1 },
        acceptance: ['A member can sign in from a link'],
        affectedComponents: ['mobile'],
      },
      clock,
    )
    return approveFeatureBrief(
      project.dir,
      { id: created.brief.id, expectRevision: created.brief.revision, expectDigest: created.digest, by: 'tester' },
      clock,
    )
  }

  it('a library package with no acceptance never appears in a routed selection', async () => {
    const profile = await acceptProfile(
      project.dir,
      { components: [mobileComponent], by: 'tester', generatedAt: NOW.toISOString(), expectRevision: null },
      clock,
    )
    // The package sits in the shared library, matches the component's tag,
    // and even declares the right agent role — but this project has never
    // accepted it.
    await writePackage(project.dir, skillPackage(DIGEST_A), contentDir)
    const approved = await approvedFeature()

    const { skills: acceptedSkills } = await readAcceptedProjectSkills(project.dir)
    expect(acceptedSkills).toEqual([])

    const selections = selectSkills({ brief: approved.brief, profile, acceptedSkills, agent: 'builder' })
    expect(selections).toHaveLength(1)
    expect(selections[0]?.skillIds).toEqual([])
  })

  it('once accepted, the same package is selected — proving the prior emptiness was about acceptance, not the join', async () => {
    const profile = await acceptProfile(
      project.dir,
      { components: [mobileComponent], by: 'tester', generatedAt: NOW.toISOString(), expectRevision: null },
      clock,
    )
    await writePackage(project.dir, skillPackage(DIGEST_A), contentDir)
    await acceptSkill(
      project.dir,
      { packageDigest: DIGEST_A, components: ['mobile'], agents: ['builder'], updatePolicy: 'review', acceptedBy: 'tester' },
      clock,
    )
    const approved = await approvedFeature()

    const { skills: acceptedSkills } = await readAcceptedProjectSkills(project.dir)
    const selections = selectSkills({ brief: approved.brief, profile, acceptedSkills, agent: 'builder' })
    expect(selections[0]?.skillIds).toEqual(['flutter-widgets'])
  })
})
