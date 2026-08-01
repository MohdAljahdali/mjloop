import * as z from 'zod'
import { PlanIdSchema, StoryIdSchema } from './plan.js'

/**
 * `decision` — a choice made and why, the thing a reader cannot reconstruct
 * from the diff. `lesson` — something learned the hard way, usually from a
 * halt. `pattern` — how this project does a recurring thing.
 */
export const MemoryKindSchema = z.enum(['decision', 'lesson', 'pattern'])

/** Reaches the filesystem: it names a file. */
export const MemoryIdSchema = z.string().regex(/^M\d{3}$/, 'a memory id looks like M001')

/** Three digits is the id format, so this is the last id a project can allocate. */
export const MAX_MEMORY_NUMBER = 999

/**
 * Title and tags are echoed verbatim into every search hit, so they are bounded
 * here — the excerpt being capped bounds nothing if the fields beside it are
 * free. A search that can return an unbounded amount of text costs a leader more
 * context than not having memory at all, which is the one thing memory may not do.
 */
const TITLE_MAX = 200
const TAG_MAX = 40
const TAGS_MAX = 10

/** Trimmed before it is measured, so a title of blanks is the empty title it is. */
export const MemoryTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(TITLE_MAX, 'a memory title is one line — put the detail in the body')

export const MemoryTagsSchema = z.array(z.string().trim().min(1).max(TAG_MAX)).max(TAGS_MAX)

/**
 * `mjloop_memory_get` returns a body whole, by design. That is only safe while the
 * body has a ceiling, and `listMemories` reads every entry on every search and
 * every add — one pasted transcript taxes the whole project from then on.
 */
export const MEMORY_BODY_MAX = 20_000

export const MemoryBodySchema = z
  .string()
  .trim()
  .min(1)
  .max(
    MEMORY_BODY_MAX,
    `a memory body runs to ${MEMORY_BODY_MAX} characters — record the conclusion, not the transcript`,
  )

export const MemoryFrontmatterSchema = z.strictObject({
  id: MemoryIdSchema,
  kind: MemoryKindSchema,
  title: MemoryTitleSchema,
  at: z.iso.datetime(),
  tags: MemoryTagsSchema.default([]),
  /** The run that produced it, or null when a person wrote it directly. */
  run: z.string().min(1).nullable().default(null),
  /**
   * The plan and story this memory is scoped to, or null when it is
   * project-wide. Both are bounded by the engine's own id shapes rather than
   * a free string because they reach a query — `panels/plans.js`'s Plan
   * Memory joins on them — and an id that could not name a real plan or story
   * would join against nothing while looking like it matched something.
   *
   * Both default to null, as `run` above does: the schema is strict, so
   * without a default every memory recorded before this field existed would
   * fail validation on the next read.
   */
  plan: PlanIdSchema.nullable().default(null),
  story: StoryIdSchema.nullable().default(null),
})

export type MemoryKind = z.infer<typeof MemoryKindSchema>
export type MemoryFrontmatter = z.infer<typeof MemoryFrontmatterSchema>
