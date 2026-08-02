import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readProjectSkills } from '../../src/ops/project-skills.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

/** Write one `.claude/skills/<name>/SKILL.md` under `dir`. */
async function writeSkill(dir: string, name: string, body: string): Promise<void> {
  const at = path.join(dir, '.claude', 'skills', name)
  await fs.mkdir(at, { recursive: true })
  await fs.writeFile(path.join(at, 'SKILL.md'), body, 'utf8')
}

describe('readProjectSkills', () => {
  let project: TmpProject

  beforeEach(async () => {
    project = await makeTmpProject()
  })

  afterEach(async () => {
    await project.cleanup()
  })

  it('answers empty for a project with no .claude/skills directory', async () => {
    await expect(readProjectSkills(project.dir)).resolves.toEqual({ skills: [], unreadable: [] })
  })

  it('reads name, description and a repository-relative path, sorted by name', async () => {
    await writeSkill(project.dir, 'zebra', '---\nname: zebra\ndescription: Use when striping.\n---\n\nBody.\n')
    await writeSkill(project.dir, 'alpha', '---\nname: alpha\ndescription: Use when starting.\n---\n\nBody.\n')

    const { skills, unreadable } = await readProjectSkills(project.dir)
    expect(unreadable).toEqual([])
    expect(skills).toEqual([
      { name: 'alpha', description: 'Use when starting.', path: '.claude/skills/alpha/SKILL.md' },
      { name: 'zebra', description: 'Use when striping.', path: '.claude/skills/zebra/SKILL.md' },
    ])
  })

  it('follows a symlinked skill directory, which is how a linked skill layout reaches .claude/skills', async () => {
    // The shape this repository itself uses: the skills live in `.agents/skills/`
    // and are linked into `.claude/skills/`, so every entry in the directory the
    // walk reads is a symlink and none of them is a directory. Claude Code loads
    // these, so a walk that skipped them reported "no skills" about a project
    // whose skills all work.
    const target = path.join(project.dir, '.agents', 'skills', 'linked')
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(
      path.join(target, 'SKILL.md'),
      '---\nname: linked\ndescription: Use when linked.\n---\n\nBody.\n',
      'utf8',
    )
    await fs.mkdir(path.join(project.dir, '.claude', 'skills'), { recursive: true })
    await fs.symlink(
      path.join('..', '..', '.agents', 'skills', 'linked'),
      path.join(project.dir, '.claude', 'skills', 'linked'),
    )

    const { skills, unreadable } = await readProjectSkills(project.dir)
    expect(unreadable).toEqual([])
    // Reported at the path a reader would look for it, not at the link's target.
    expect(skills).toEqual([
      { name: 'linked', description: 'Use when linked.', path: '.claude/skills/linked/SKILL.md' },
    ])
  })

  it('ignores a symlink that does not resolve to a skill directory', async () => {
    await fs.mkdir(path.join(project.dir, '.claude', 'skills'), { recursive: true })
    await fs.symlink(path.join('..', '..', 'nowhere'), path.join(project.dir, '.claude', 'skills', 'dangling'))

    await expect(readProjectSkills(project.dir)).resolves.toEqual({ skills: [], unreadable: [] })
  })

  it('reports a skill it could not read rather than dropping it or throwing', async () => {
    await writeSkill(project.dir, 'good', '---\nname: good\ndescription: Use when fine.\n---\n\nBody.\n')
    await writeSkill(project.dir, 'nofrontmatter', 'Just a body, no frontmatter at all.\n')
    await writeSkill(project.dir, 'nodescription', '---\nname: nodescription\n---\n\nBody.\n')

    const { skills, unreadable } = await readProjectSkills(project.dir)
    expect(skills.map((skill) => skill.name)).toEqual(['good'])
    expect(unreadable.map((entry) => entry.path).sort()).toEqual([
      '.claude/skills/nodescription/SKILL.md',
      '.claude/skills/nofrontmatter/SKILL.md',
    ])
    for (const entry of unreadable) expect(entry.reason.length).toBeGreaterThan(0)
  })

  it('ignores a directory with no SKILL.md and a loose file beside the directories', async () => {
    await fs.mkdir(path.join(project.dir, '.claude', 'skills', 'empty'), { recursive: true })
    await fs.writeFile(path.join(project.dir, '.claude', 'skills', 'README.md'), '# not a skill\n', 'utf8')

    await expect(readProjectSkills(project.dir)).resolves.toEqual({ skills: [], unreadable: [] })
  })

  it('prefers the frontmatter name over the directory name, and records it', async () => {
    await writeSkill(project.dir, 'dir-name', '---\nname: declared-name\ndescription: Use when renamed.\n---\n\nBody.\n')

    const { skills } = await readProjectSkills(project.dir)
    expect(skills[0]?.name).toBe('declared-name')
    expect(skills[0]?.path).toBe('.claude/skills/dir-name/SKILL.md')
  })
})
