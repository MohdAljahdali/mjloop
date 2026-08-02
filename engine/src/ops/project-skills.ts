/**
 * A pure read of `<projectDir>/.claude/skills/`.
 *
 * No I/O beyond the one walk, nothing executed, and nothing written. A
 * malformed `SKILL.md` is *reported* rather than thrown on, for the reason
 * `listPackages` reports its unreadable entries: one bad file must not turn a
 * whole page into a 500, and silently dropping it is worse than saying so —
 * an invisible skill reads as a skill that does not exist.
 */
import fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import { parseFrontmatter } from '../store/frontmatter.js'
import {
  SkillFrontmatterSchema,
  type ProjectSkillOnDisk,
  type UnreadableProjectSkill,
} from '../schemas/project-skills.js'

/** Where Claude Code reads a project's skills from. Not configurable, here or anywhere. */
export const PROJECT_SKILLS_DIR = path.join('.claude', 'skills')

export interface ProjectSkillsListing {
  skills: ProjectSkillOnDisk[]
  unreadable: UnreadableProjectSkill[]
}

/** POSIX-separated, so the same project reads the same on Windows as in a review. */
function repoRelative(dirName: string): string {
  return `.claude/skills/${dirName}/SKILL.md`
}

export async function readProjectSkills(projectDir: string): Promise<ProjectSkillsListing> {
  const root = path.join(projectDir, PROJECT_SKILLS_DIR)

  let entries: Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    // A project with no `.claude/skills/` is the state every project starts
    // in, and it is an empty answer rather than a failure — the position
    // `readSkillsView` already takes on an empty library.
    return { skills: [], unreadable: [] }
  }

  const skills: ProjectSkillOnDisk[] = []
  const unreadable: UnreadableProjectSkill[] = []

  for (const entry of entries) {
    // A symlink counts. `isDirectory()` is false for one even when it resolves
    // to a directory, and linking is how a whole family of projects populates
    // this directory at all: the skills live somewhere agent-agnostic —
    // `.agents/skills/` — and are linked into `.claude/skills/`, which is the
    // shape this very repository uses. Claude Code follows those links and
    // loads those skills, so a walk that skipped them answered "no skills"
    // about a project whose skills all work. Nothing further is stat'ed here:
    // a link to a file, or to nothing at all, fails the `SKILL.md` read below
    // and is skipped there like any other directory that holds no skill.
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const at = repoRelative(entry.name)
    const file = path.join(root, entry.name, 'SKILL.md')

    let raw: string
    try {
      raw = await fs.readFile(file, 'utf8')
    } catch {
      // A directory with no `SKILL.md` is not a skill and not a fault: it is
      // most often a skill's `references/` or `assets/` sibling.
      continue
    }

    try {
      const { data } = parseFrontmatter(raw)
      const parsed = SkillFrontmatterSchema.safeParse(data)
      if (!parsed.success) {
        unreadable.push({
          path: at,
          reason: `its frontmatter is missing a required field: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
        })
        continue
      }
      skills.push({ name: parsed.data.name, description: parsed.data.description, path: at })
    } catch (error) {
      unreadable.push({ path: at, reason: error instanceof Error ? error.message : String(error) })
    }
  }

  skills.sort((left, right) => left.name.localeCompare(right.name))
  unreadable.sort((left, right) => left.path.localeCompare(right.path))
  return { skills, unreadable }
}
