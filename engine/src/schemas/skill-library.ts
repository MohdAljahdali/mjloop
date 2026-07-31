/**
 * One package in the shared, user-local skill library.
 *
 * This is S06's own record and lives beside `skill-selection.ts`'s
 * `AcceptedProjectSkillSchema` rather than replacing it: a package here is
 * content a machine has fetched once, an acceptance there is one project's
 * decision to use one digest of it. `readAcceptedProjectSkills`
 * (`../ops/skill-library.js`) is the seam that joins the two and produces
 * exactly the shape S05 already fixed.
 */
import * as z from 'zod'
import { IdSchema } from './state.js'
import { SkillSourceSchema } from './config.js'

/**
 * A package's content digest — sha256 of the fetched content, lower-case
 * hex. This is also the directory name a package's record and content live
 * under (`library-paths.ts#packagesDir`), which is the whole reason it is
 * constrained this tightly rather than accepted as an arbitrary string: a
 * 64-character lower-case hex string cannot contain a path separator, a
 * `.`, or anything else a filesystem would treat specially, so validating
 * against this schema *before* a digest is joined into a path is what makes
 * the join safe. `IdSchema` plays the identical role for ids elsewhere in
 * this codebase; this is that same guard for digests.
 */
export const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/, 'a digest is 64 lower-case hex characters')

export type Digest = z.infer<typeof DigestSchema>

/**
 * One immutable package: what it declares about itself, and nothing this
 * story has verified yet.
 *
 * `audit.state` defaults to `'pending'` and nothing in this story ever sets
 * it to `'passed'` — static inspection and the sandbox are S07's job, not
 * this schema's or this store's. A `'pending'` package is therefore not
 * acceptable through the ordinary acceptance path (`skill-acceptance-store`
 * enforces that, not here), and that is correct today rather than a gap:
 * S06 can *hold* a package, but it cannot yet earn one the right to be used.
 */
export const SkillPackageSchema = z.strictObject({
  schema: z.literal(1),
  /**
   * Stable across revisions of one source. Two imports of the same GitHub
   * repository at two different pinned revisions share a `packageId` and
   * differ in `digest` — `packageId` is "which skill", `digest` is "which
   * bytes of it".
   */
  packageId: IdSchema,
  /** Of the content; also the directory name under the library root. */
  digest: DigestSchema,
  source: z.strictObject({
    kind: SkillSourceSchema,
    url: z.string().url().startsWith('https://'),
    /**
     * A pinned commit or tag, never a moving ref such as a branch name. A
     * branch would let the *same recorded revision* resolve to different
     * bytes over time, which is precisely what content-addressing by digest
     * is here to make impossible — the revision has to hold that promise on
     * its own terms, not merely happen to agree with the digest today.
     */
    revision: z.string().min(1),
  }),
  license: z.strictObject({
    spdx: z.string().min(1).nullable(),
    file: z.string().min(1).nullable(),
  }),
  skillName: z.string().min(1).max(200),
  description: z.string().min(1).max(1000),
  tags: z.array(z.string().min(1)),
  dependencies: z.strictObject({
    /** An inventory of what the package declares — never a resolution. */
    executables: z.array(z.string().min(1)),
    /** Likewise: named, not installed. */
    packages: z.array(z.string().min(1)),
  }),
  audit: z.strictObject({
    state: z.enum(['pending', 'passed', 'failed']),
    findings: z.array(z.string().min(1)),
    at: z.iso.datetime().nullable(),
  }),
  /**
   * The bounded text S05 hands an agent. Capped at the same 4000 characters
   * `AcceptedProjectSkill.guidance` is, for the same reason stated there: it
   * is copied into a brief on every dispatch, so an unbounded string here
   * would make every dispatch as large as the largest guidance any package
   * in the library has ever carried.
   */
  guidance: z.string().min(1).max(4000),
  importedAt: z.iso.datetime(),
})

export type SkillPackage = z.infer<typeof SkillPackageSchema>
