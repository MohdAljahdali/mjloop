/**
 * The skills that exist in this project's own checkout, as facts rather than
 * as decisions.
 *
 * `.claude/skills/` is where Claude Code reads a project's skills from, and
 * no setting anywhere redirects that (see `LEGACY_CONFIG_KEYS` in
 * `schemas/config.ts`, which removed a setting that claimed otherwise). A
 * skill being *here* means the session can load it; it says nothing about
 * whether mjloop routes work to it — that is what an acceptance in
 * `.mjloop/skills/` says, and the two are joined for display and nowhere
 * else. Keeping them separate types is the point: a page that showed only
 * acceptances told a project full of skills that it had none.
 */
import * as z from 'zod'

/**
 * The two frontmatter fields Claude Code itself requires of a `SKILL.md`.
 *
 * Non-strict on purpose — a skill may declare `allowed-tools`, `license` or
 * anything else, and this walk has no business refusing a file over a key it
 * does not read.
 */
export const SkillFrontmatterSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().min(1),
})

export const ProjectSkillOnDiskSchema = z.strictObject({
  /** The frontmatter's `name` — what the session addresses the skill by. */
  name: z.string().min(1).max(200),
  /** The frontmatter's `description` — when the skill applies, verbatim. */
  description: z.string().min(1),
  /** Repository-relative and always POSIX-separated, so it is quotable in a review. */
  path: z.string().min(1),
})

export type ProjectSkillOnDisk = z.infer<typeof ProjectSkillOnDiskSchema>

/** A `SKILL.md` this walk found and could not turn into a record, and why. */
export const UnreadableProjectSkillSchema = z.strictObject({
  path: z.string().min(1),
  reason: z.string().min(1),
})

export type UnreadableProjectSkill = z.infer<typeof UnreadableProjectSkillSchema>
