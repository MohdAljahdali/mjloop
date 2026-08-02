import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readProjectSkills } from '../../src/ops/project-skills.js'
import { makeTmpProject } from '../helpers/tmp-project.js'

/** Write one `.claude/skills/<name>/SKILL.md` under `dir`. */
async function writeSkill(dir: string, name: string, body: string): Promise<void> {
  const at = path.join(dir, '.claude', 'skills', name)
  await fs.mkdir(at, { recursive: true })
  await fs.writeFile(path.join(at, 'SKILL.md'), body, 'utf8')
}

describe('readProjectSkills', () => {
  it('answers empty for a project with no .claude/skills directory', async () => {
    const { dir } = await makeTmpProject()
    await expect(readProjectSkills(dir)).resolves.toEqual({ skills: [], unreadable: [] })
  })

  it('reads name, description and a repository-relative path, sorted by name', async () => {
    const { dir } = await makeTmpProject()
    await writeSkill(dir, 'zebra', '---\nname: zebra\ndescription: Use when striping.\n---\n\nBody.\n')
    await writeSkill(dir, 'alpha', '---\nname: alpha\ndescription: Use when starting.\n---\n\nBody.\n')

    const { skills, unreadable } = await readProjectSkills(dir)
    expect(unreadable).toEqual([])
    expect(skills).toEqual([
      { name: 'alpha', description: 'Use when starting.', path: '.claude/skills/alpha/SKILL.md' },
      { name: 'zebra', description: 'Use when striping.', path: '.claude/skills/zebra/SKILL.md' },
    ])
  })

  it('reports a skill it could not read rather than dropping it or throwing', async () => {
    const { dir } = await makeTmpProject()
    await writeSkill(dir, 'good', '---\nname: good\ndescription: Use when fine.\n---\n\nBody.\n')
    await writeSkill(dir, 'nofrontmatter', 'Just a body, no frontmatter at all.\n')
    await writeSkill(dir, 'nodescription', '---\nname: nodescription\n---\n\nBody.\n')

    const { skills, unreadable } = await readProjectSkills(dir)
    expect(skills.map((skill) => skill.name)).toEqual(['good'])
    expect(unreadable.map((entry) => entry.path).sort()).toEqual([
      '.claude/skills/nodescription/SKILL.md',
      '.claude/skills/nofrontmatter/SKILL.md',
    ])
    for (const entry of unreadable) expect(entry.reason.length).toBeGreaterThan(0)
  })

  it('ignores a directory with no SKILL.md and a loose file beside the directories', async () => {
    const { dir } = await makeTmpProject()
    await fs.mkdir(path.join(dir, '.claude', 'skills', 'empty'), { recursive: true })
    await fs.writeFile(path.join(dir, '.claude', 'skills', 'README.md'), '# not a skill\n', 'utf8')

    await expect(readProjectSkills(dir)).resolves.toEqual({ skills: [], unreadable: [] })
  })

  it('prefers the frontmatter name over the directory name, and records it', async () => {
    const { dir } = await makeTmpProject()
    await writeSkill(dir, 'dir-name', '---\nname: declared-name\ndescription: Use when renamed.\n---\n\nBody.\n')

    const { skills } = await readProjectSkills(dir)
    expect(skills[0]?.name).toBe('declared-name')
    expect(skills[0]?.path).toBe('.claude/skills/dir-name/SKILL.md')
  })
})
