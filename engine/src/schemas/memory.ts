import * as z from 'zod'

/**
 * `decision` — a choice made and why, the thing a reader cannot reconstruct
 * from the diff. `lesson` — something learned the hard way, usually from a
 * halt. `pattern` — how this project does a recurring thing.
 */
export const MemoryKindSchema = z.enum(['decision', 'lesson', 'pattern'])

/** Reaches the filesystem: it names a file. */
export const MemoryIdSchema = z.string().regex(/^M\d{3}$/, 'a memory id looks like M001')

export const MemoryFrontmatterSchema = z.strictObject({
  id: MemoryIdSchema,
  kind: MemoryKindSchema,
  title: z.string().min(1),
  at: z.iso.datetime(),
  tags: z.array(z.string().min(1)).default([]),
  /** The run that produced it, or null when a person wrote it directly. */
  run: z.string().min(1).nullable().default(null),
})

export type MemoryKind = z.infer<typeof MemoryKindSchema>
export type MemoryFrontmatter = z.infer<typeof MemoryFrontmatterSchema>
