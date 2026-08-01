/**
 * The shared contract for S07's external discovery/inspection/sandbox
 * pipeline. This module fixes the shapes once so discovery, inspection and
 * the sandbox agree on them rather than each phase inventing its own — the
 * same reason `skill-selection.ts` fixed `AcceptedProjectSkillSchema` ahead
 * of the store that produces it.
 */
import * as z from 'zod'
import { SkillSourceSchema } from './config.js'
import { DigestSchema } from './skill-library.js'

/**
 * A search result and nothing more.
 *
 * A candidate is metadata only — where a package claims to live, not its
 * content. No candidate is ever written to the library (`writePackage` takes
 * a `SkillPackage`, a wholly different, inspected shape), and no candidate
 * can reach skill selection (`selectSkills` reads accepted packages, never
 * search results). The only path from a candidate to anything a project can
 * use runs through `inspectCandidate` and then a passed sandbox.
 */
export const SkillCandidateSchema = z.strictObject({
  source: SkillSourceSchema,
  /** The page a person would open to look at this candidate. */
  url: z.string().url().startsWith('https://'),
  /** `owner/name` for GitHub, or whatever the registry's own scheme is. */
  repository: z.string().min(1),
  /**
   * The ref the candidate was found at — commonly a branch, so **not**
   * assumed to be immutable here. `inspectCandidate` resolves this to a
   * pinned commit sha before fetching anything; a candidate itself makes no
   * such promise.
   */
  ref: z.string().min(1),
  skillName: z.string().min(1).max(200),
  description: z.string().min(1).max(1000),
  /** Absent when the source does not report a popularity signal. */
  stars: z.number().int().min(0).optional(),
})

export type SkillCandidate = z.infer<typeof SkillCandidateSchema>

/** One completed (or attempted) run of a package's declared smoke checks. */
export const SandboxCheckResultSchema = z.strictObject({
  /** A bare argv array — never a shell string; see the story's rule 7. */
  argv: z.array(z.string().min(1)).min(1),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
})

export type SandboxCheckResult = z.infer<typeof SandboxCheckResultSchema>

/**
 * Bounded, labelled output — never the raw captured stream. Capped well
 * below any UI or wire limit so a chatty smoke check cannot make a report
 * unusable; the cap is named here so every reader of `output` knows it was
 * already truncated with that fact recorded, not silently.
 */
export const SANDBOX_OUTPUT_CAP = 20_000

export const SandboxOutputSchema = z.strictObject({
  text: z.string().max(SANDBOX_OUTPUT_CAP),
  truncated: z.boolean(),
})

/**
 * What the sandbox phase found, honestly.
 *
 * The four states are deliberately not collapsible into a boolean pass/fail:
 * `'skipped'` and `'unavailable'` both mean "did not run", but only one of
 * them lets the package through. `audit.state` may become `'passed'` only
 * when this is `'passed'` or `'skipped'` — never `'unavailable'`, because
 * that state means this machine could not verify executable content at all,
 * and running it unsandboxed to find out is the exact false claim this
 * schema exists to make impossible to represent.
 */
export const SandboxResultSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('skipped'),
    /** Always "no executable content" today — the common, markdown-only case. */
    reason: z.string().min(1),
  }),
  z.strictObject({
    state: z.literal('unavailable'),
    /** Names the backend that would let this machine verify it, e.g. sandbox-exec or bwrap. */
    reason: z.string().min(1),
  }),
  z.strictObject({
    state: z.literal('passed'),
    checks: z.array(SandboxCheckResultSchema),
    output: SandboxOutputSchema,
  }),
  z.strictObject({
    state: z.literal('failed'),
    checks: z.array(SandboxCheckResultSchema),
    output: SandboxOutputSchema,
  }),
])

export type SandboxResult = z.infer<typeof SandboxResultSchema>

/**
 * A user-initiated follow-up after a failure — never chosen automatically.
 * `inspectCandidate` and the sandbox both offer this instead of retrying a
 * different candidate themselves; per the story's rule 4, only a person
 * triggers the next search.
 */
export const NextActionSchema = z.strictObject({
  action: z.literal('search-alternative'),
  query: z.string().min(1),
})

export type NextAction = z.infer<typeof NextActionSchema>

/**
 * The full report `inspectCandidate` produces, and what the sandbox phase
 * augments it with. Every field that inspection could not determine because
 * an earlier step already refused the candidate is `null` rather than
 * omitted, so a caller can render "why this stopped" without a discriminated
 * union of its own.
 */
export const ImportReportSchema = z.strictObject({
  schema: z.literal(1),
  candidate: SkillCandidateSchema,
  /** The commit sha the candidate's `ref` was pinned to before anything was fetched, or `null` if pinning failed. */
  revision: z.string().min(1).nullable(),
  /** sha256 over the canonical sorted content — the same digest `SkillPackageSchema` addresses a package by. */
  digest: DigestSchema.nullable(),
  skillName: z.string().min(1).max(200).nullable(),
  description: z.string().min(1).max(1000).nullable(),
  license: z
    .strictObject({
      spdx: z.string().min(1).nullable(),
      file: z.string().min(1).nullable(),
    })
    .nullable(),
  dependencies: z
    .strictObject({
      executables: z.array(z.string().min(1)),
      packages: z.array(z.string().min(1)),
    })
    .nullable(),
  /** Paths classified as executable content — read to classify, never executed to do so. */
  executableFiles: z.array(z.string().min(1)),
  /** Every refusal and every concern, each a sentence naming what and why. */
  findings: z.array(z.string().min(1)),
  /** Whether any finding above blocks acceptance outright (e.g. a missing license, a hostile path). */
  blocking: z.boolean(),
  /** `null` until the sandbox phase has run; inspection alone never sets this. */
  sandbox: SandboxResultSchema.nullable(),
  /** `'passed'` only when `blocking` is `false` and `sandbox.state` is `'passed'` or `'skipped'`. */
  auditState: z.enum(['pending', 'passed', 'failed']),
  /** Present only on a failed or blocked report; absent otherwise. */
  nextAction: NextActionSchema.nullable(),
})

export type ImportReport = z.infer<typeof ImportReportSchema>
