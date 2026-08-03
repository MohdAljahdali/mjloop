import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { manifestPath, renderManifest } from '../../src/ops/manifest.js'
import { findPlanDir, writePlan, writeStory } from '../../src/store/plan-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-27T09:14:00.000Z')
const clock = () => NOW

let project: TmpProject

const PLAN = {
  frontmatter: {
    id: 'P001',
    slug: 'user-auth',
    title: 'User authentication',
    created_at: '2026-07-27T09:00:00.000Z',
    approval: null,
  },
  body: '',
}

function story(id: string, title: string, status: 'todo' | 'doing' | 'done' | 'blocked', dependsOn: string[] = []) {
  return {
    frontmatter: { id, plan: 'P001', title, status, ui: false, depends_on: dependsOn, acceptance: [], evidence: null },
    body: '',
  }
}

beforeEach(async () => {
  project = await makeTmpProject()
  await writePlan(project.dir, PLAN)
})
afterEach(async () => { await project.cleanup() })

describe('renderManifest', () => {
  it('writes an empty manifest for a plan with no stories', async () => {
    const manifest = await renderManifest(project.dir, 'P001', clock)
    expect(manifest.stories).toEqual([])
    expect(manifest.plan).toBe('P001')
    expect(manifest.title).toBe('User authentication')
    expect(manifest.generated_at).toBe(NOW.toISOString())
  })

  it('lists stories sorted by id with their file paths relative to the plan', async () => {
    await writeStory(project.dir, story('P001-S02', 'Session token', 'todo', ['P001-S01']))
    await writeStory(project.dir, story('P001-S01', 'Login form', 'done'))

    const manifest = await renderManifest(project.dir, 'P001', clock)
    expect(manifest.stories.map((entry) => entry.id)).toEqual(['P001-S01', 'P001-S02'])
    expect(manifest.stories[0]?.file).toBe('stories/P001-S01-login-form.md')
    expect(manifest.stories[1]?.depends_on).toEqual(['P001-S01'])
    expect(manifest.stories[0]?.status).toBe('done')
  })

  it('persists the manifest to the plan directory', async () => {
    await writeStory(project.dir, story('P001-S01', 'Login form', 'todo'))
    const manifest = await renderManifest(project.dir, 'P001', clock)

    const file = manifestPath(await findPlanDir(project.dir, 'P001'))
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(manifest)
  })

  it('overwrites a hand-corrupted manifest rather than merging with it', async () => {
    await writeStory(project.dir, story('P001-S01', 'Login form', 'todo'))
    const file = manifestPath(await findPlanDir(project.dir, 'P001'))
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '{ "schema": 1, "stories": [{"id":"GHOST"}] }', 'utf8')

    const manifest = await renderManifest(project.dir, 'P001', clock)
    expect(manifest.stories.map((entry) => entry.id)).toEqual(['P001-S01'])
    expect(JSON.stringify(await fs.readFile(file, 'utf8'))).not.toContain('GHOST')
  })

  it('is byte-identical when regenerated from unchanged input', async () => {
    await writeStory(project.dir, story('P001-S01', 'Login form', 'todo'))
    const file = manifestPath(await findPlanDir(project.dir, 'P001'))

    await renderManifest(project.dir, 'P001', clock)
    const first = await fs.readFile(file, 'utf8')
    await renderManifest(project.dir, 'P001', clock)
    expect(await fs.readFile(file, 'utf8')).toBe(first)
  })
})
