import * as z from 'zod'
import { IdSchema } from './state.js'

/**
 * What a component's manifests *declare*, never what its directory is called.
 *
 * `unknown` is a first-class answer rather than a failure: a directory holding a
 * `package.json` with no framework in it is genuinely a component of this
 * project — it has verification commands and it can be routed to — and calling
 * it `nextjs` because it sits under `web/` would hand every later story a
 * technology nobody declared.
 */
export const ComponentTechnologySchema = z.enum(['flutter', 'nextjs', 'python', 'unknown'])

/**
 * The component's directory: POSIX, relative to the project root, `.` for the
 * root itself.
 *
 * Every later consumer joins this against the project directory to run a
 * command or read a file, so this schema is the only place that stops it
 * escaping — the same job `IdSchema` does for the ids that name run
 * directories. Three separate refusals, because they fail for three different
 * reasons and a single combined message would name none of them:
 *
 *   - a backslash, because `apps\..\..\etc` is a traversal on Windows and one
 *     legal filename on POSIX; refusing the separator outright means the `..`
 *     check below cannot be walked around by spelling it the other way;
 *   - an absolute path (including a `C:` drive), because joining one against
 *     the project directory discards the project directory entirely;
 *   - a `..`, `.` or empty segment, because those are how a relative path
 *     climbs out of the tree it was measured from.
 */
export const ComponentRootSchema = z
  .string()
  .min(1)
  .refine((root) => !root.includes('\\'), {
    error: 'a component root is a POSIX path — "\\" is not a separator here',
  })
  .refine((root) => !root.startsWith('/') && !/^[A-Za-z]:/.test(root), {
    error: 'a component root is relative to the project root, never absolute',
  })
  .refine(
    (root) => root === '.' || root.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    { error: 'a component root may not contain an empty, "." or ".." segment' },
  )

/**
 * What verifies this one component. Nullable per slot rather than optional: a
 * component that declares no lint command and a component whose lint command
 * has not been looked at yet are the same thing here, and pretending otherwise
 * would put an `undefined` into an engine-owned record.
 */
export const ComponentVerificationSchema = z.strictObject({
  test: z.string().min(1).nullable(),
  lint: z.string().min(1).nullable(),
  build: z.string().min(1).nullable(),
})

export const ProjectComponentSchema = z.strictObject({
  /** Derived from `root` by the detector, and constrained by the schema every
   * other id that reaches the filesystem goes through. */
  id: IdSchema,
  root: ComponentRootSchema,
  technology: ComponentTechnologySchema,
  verification: ComponentVerificationSchema,
  /**
   * The join later stories select skills on, derived from `technology`. The
   * default is load-bearing for the reason every other default in these schemas
   * is: the object is strict, so a record written before this field existed
   * would fail validation on read rather than gain the field.
   */
  skillTags: z.array(z.string().min(1)).default([]),
})

/**
 * Unique ids, sorted by id.
 *
 * Both halves exist so that two scans of one tree produce a byte-identical
 * record. Directory listing order is not guaranteed by any filesystem, so an
 * array whose order was free would let two equal scans disagree — and a
 * proposal that "differs from the accepted profile" only in the order of its
 * components would ask a person to accept a change nobody made. Duplicate ids
 * are the same defect one level down: the id is what later stories join on, so
 * two components under one id route work to whichever the reader happened to
 * find first.
 */
const ComponentsSchema = z.array(ProjectComponentSchema).superRefine((components, ctx) => {
  const seen = new Set<string>()
  for (const [index, component] of components.entries()) {
    if (seen.has(component.id)) {
      ctx.addIssue({
        code: 'custom',
        path: [index, 'id'],
        message: `two components claim the id "${component.id}" — it is what later stories join skills and verification on, so one of the two would silently never be selected`,
      })
    }
    seen.add(component.id)

    const previous = components[index - 1]
    // Plain `<` rather than `localeCompare`: the ordering has to be the same on
    // every machine that reads the record, and a locale-sensitive comparison is
    // by definition not.
    if (previous !== undefined && !(previous.id < component.id)) {
      ctx.addIssue({
        code: 'custom',
        path: [index, 'id'],
        message: `components must be sorted by id — "${component.id}" follows "${previous.id}"`,
      })
    }
  }
})

/**
 * The mutable proposal a scan writes, overwritten by the next one. It is a
 * suggestion and nothing routes off it: only an accepted revision does.
 */
export const ProposedProfileSchema = z.strictObject({
  schema: z.literal(1),
  generatedAt: z.iso.datetime(),
  components: ComponentsSchema,
  /**
   * The manifest paths the detection rests on, project-relative. Recorded so a
   * person reading a proposal can check the conclusion against the evidence
   * rather than take the detector's word for it — including the corroborating
   * files (a `next.config.*`, an `analysis_options.yaml`) that were consulted
   * but were not on their own sufficient.
   */
  basis: z.array(z.string().min(1)),
})

/**
 * One accepted revision — an immutable record, never rewritten in place.
 *
 * There is no mutable "current" pointer anywhere: the accepted profile is
 * whichever revision file is highest. Reselecting an earlier component map
 * means accepting its components as a *new* revision that records what it
 * `supersedes`, so a revision a run has pinned can never move under it.
 */
export const ProjectProfileSchema = z.strictObject({
  schema: z.literal(1),
  revision: z.number().int().positive(),
  /** When the scan behind these components ran, carried over from the proposal. */
  generatedAt: z.iso.datetime(),
  acceptedAt: z.iso.datetime(),
  /** Who accepted it. Free text: the engine cannot verify it, and pretending
   * otherwise would be worse — the same reason `ApprovalSchema.by` is. */
  acceptedBy: z.string().min(1),
  components: ComponentsSchema,
  /** The revision this one replaces, or null for the first. */
  supersedes: z.number().int().positive().nullable(),
})

export type ComponentTechnology = z.infer<typeof ComponentTechnologySchema>
export type ComponentVerification = z.infer<typeof ComponentVerificationSchema>
export type ProjectComponent = z.infer<typeof ProjectComponentSchema>
export type ProposedProfile = z.infer<typeof ProposedProfileSchema>
export type ProjectProfile = z.infer<typeof ProjectProfileSchema>
