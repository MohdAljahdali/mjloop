import * as z from 'zod'
import { IdSchema } from './state.js'

export const StoryStatusSchema = z.enum(['todo', 'doing', 'done', 'blocked'])

/**
 * Ids reach the filesystem — they name directories and files — so their shape
 * is constrained rather than merely conventional. Milestone 2 shipped the same
 * constraint on run directory ids after a review found a story id could steer a
 * write outside `.loop`.
 */
export const PlanIdSchema = z.string().regex(/^P\d{3}$/, 'a plan id looks like P001')
export const StoryIdSchema = z.string().regex(/^P\d{3}-S\d{2}$/, 'a story id looks like P001-S02')

export const PlanFrontmatterSchema = z.strictObject({
  id: PlanIdSchema,
  /** Also reaches the filesystem: the directory is `<id>-<slug>`. */
  slug: IdSchema,
  title: z.string().min(1),
  created_at: z.iso.datetime(),
})

export const StoryFrontmatterSchema = z
  .strictObject({
    id: StoryIdSchema,
    plan: PlanIdSchema,
    /**
     * Bounded because it reaches the filesystem: the story file is named
     * `<id>-<slugified title>.md`. The slug is truncated as well, so this bound
     * is about the caller getting a validation error naming the field rather
     * than a title that quietly loses most of itself.
     */
    title: z.string().min(1).max(200),
    status: StoryStatusSchema,
    /** Drives the conditional UI specialists in a later milestone. */
    ui: z.boolean().default(false),
    depends_on: z.array(StoryIdSchema).default([]),
    acceptance: z.array(z.string().min(1)).default([]),
    /** Run directory holding the proof this story is done. Null until it is. */
    evidence: z.string().min(1).nullable().default(null),
  })
  /**
   * `readStory` locates a story from its id and `writeStory` from its `plan`,
   * so the two must name the same directory. Without this they can disagree,
   * and a story read from one plan is then written into another.
   */
  .refine((story) => story.id.startsWith(`${story.plan}-`), {
    error: 'a story id must begin with its plan id',
    path: ['id'],
  })

export const ManifestEntrySchema = z.strictObject({
  id: StoryIdSchema,
  title: z.string().min(1),
  status: StoryStatusSchema,
  ui: z.boolean(),
  depends_on: z.array(StoryIdSchema),
  /** Relative to the plan directory. */
  file: z.string().min(1),
})

/** Derived from the story files. Never hand-edited, never patched in place. */
export const ManifestSchema = z.strictObject({
  schema: z.literal(1),
  plan: PlanIdSchema,
  slug: IdSchema,
  title: z.string().min(1),
  generated_at: z.iso.datetime(),
  stories: z.array(ManifestEntrySchema),
})

export type StoryStatus = z.infer<typeof StoryStatusSchema>
export type PlanFrontmatter = z.infer<typeof PlanFrontmatterSchema>
export type StoryFrontmatter = z.infer<typeof StoryFrontmatterSchema>
export type ManifestEntry = z.infer<typeof ManifestEntrySchema>
export type Manifest = z.infer<typeof ManifestSchema>
