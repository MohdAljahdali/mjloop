/**
 * A feature brief: what the discovery interview decided, written down so a plan
 * can be built on a record rather than on chat scrollback.
 *
 * One revision is one immutable answer to "what are we building and why". The
 * lifecycle is deliberately the same shape as the component profile's, for the
 * same reason: a run may pin a brief, so nothing a run was planned against may
 * ever move under it. A change is a *successor* revision, and rollback is
 * reselection — approving an earlier revision's content as a new revision —
 * never an edit and never a delete.
 */
import * as z from 'zod'
import { FeatureDiscoveryModeSchema } from './config.js'
import { IdSchema } from './state.js'

/**
 * Feature ids reach the filesystem — `.mjloop/features/F001-<slug>/` is named
 * after one — so their shape is constrained rather than merely conventional,
 * exactly as `PlanIdSchema` constrains the id that names a plan directory. The
 * character class is ascii by construction: `\d` without the `u` flag is `[0-9]`
 * and nothing else, so a fullwidth `Ｆ` or an Arabic-Indic digit is refused
 * rather than folded into a directory name that reads like a different one.
 */
export const FeatureIdSchema = z.string().regex(/^F\d{3}$/, 'a feature id looks like F001')

/**
 * The whole lifecycle a reader speaks, including the one value that is never
 * stored. See `FeatureBriefSchema` below for why `superseded` is derived.
 */
export const FeatureBriefStatusSchema = z.enum(['draft', 'approved', 'superseded'])

/**
 * One question the interview asked and what came back.
 *
 * Both `recommendation` and `answer` are nullable, and a null `answer` is a
 * real output rather than a missing one: it is an *unresolved* decision, which
 * the interview emits when its question budget runs out. Dropping those would
 * hand planning a brief that looks more settled than it is — the one failure
 * this record exists to prevent.
 */
export const DecisionSchema = z.strictObject({
  question: z.string().min(1).max(2000),
  recommendation: z.string().min(1).max(2000).nullable(),
  answer: z.string().min(1).max(4000).nullable(),
  /** When it was asked. Stamped by the engine, never by the caller. */
  at: z.iso.datetime(),
})

/**
 * The policy the interview behind this brief actually ran under, rather than
 * whatever `.mjloop/config.yaml` says today.
 *
 * A per-feature choice overrides the project default — `/mjloop:plan` says so —
 * and this is where that override is recorded. Reading the mode back off the
 * live config would answer a question about the past with a value from the
 * present: a project that switched discovery `off` last week would make every
 * brief it ever produced look like it was never interviewed.
 */
const DiscoverySchema = z.strictObject({
  mode: FeatureDiscoveryModeSchema,
  /**
   * Bounded here to the same 1..20 the project policy is bounded to. The two
   * bounds are the same fact stated in the two places it can be violated: the
   * config schema catches a hand-edited `question_budget`, and this one catches
   * a per-feature override that never went through the config at all.
   */
  questionBudget: z.number().int().min(1).max(20),
  /** When the interview stopped asking. Null while it is still running. */
  completedAt: z.iso.datetime().nullable(),
})

/**
 * Who approved this revision and when.
 *
 * Additive to the story's required interface and necessary: the story requires
 * approval to record the local actor and a timestamp, and a bare `status:
 * 'approved'` has nowhere to put either. `by` is free text because the engine
 * cannot verify who is at the keyboard, and pretending otherwise would be worse
 * — the same reason `ApprovalSchema.by` and `ProjectProfileSchema.acceptedBy`
 * are free text.
 */
const FeatureApprovalSchema = z.strictObject({
  by: z.string().min(1),
  at: z.iso.datetime(),
  /** The approver's own words, so the approval is auditable rather than a flag. */
  note: z.string().nullable(),
})

/**
 * One revision on disk: `.mjloop/features/F###-<slug>/rev-NNN.json`.
 *
 * **`superseded` is never stored, and that is a consequence of immutability
 * rather than a shortcut.** An approved revision is immutable; marking it
 * superseded would mean writing to the very record that must not change, so the
 * two requirements can only both hold if the third status is *derived*: a
 * revision is superseded when a higher revision of the same feature exists. The
 * read model reports it, nothing writes it, and the refinement below is what
 * stops a caller storing it anyway.
 *
 * `acceptance` may be empty while the record is a draft and may not be once it
 * is approved. A draft is assembled one answer at a time and cannot carry
 * acceptance criteria from its first call, so making it unrepresentable would
 * make the interview unimplementable; refusing an *approved* revision without
 * them keeps "an approved brief always has acceptance criteria" true, which is
 * the property later stories are built on.
 *
 * What this schema deliberately cannot check is `affectedComponents`: every id
 * must name a component in the project's accepted profile, and the profile is
 * on disk. That check therefore lives in the store, where the profile can be
 * read. All this schema can guarantee is that the ids are the shape every
 * filesystem-bound id in the engine has.
 */
export const FeatureBriefSchema = z
  .strictObject({
    schema: z.literal(1),
    id: FeatureIdSchema,
    revision: z.number().int().positive(),
    title: z.string().min(1).max(200),
    status: FeatureBriefStatusSchema,
    problem: z.string().min(1).max(20000),
    decisions: z.array(DecisionSchema),
    acceptance: z.array(z.string().min(1)),
    affectedComponents: z.array(IdSchema),
    /**
     * What this brief declares itself to be about, beyond its component ids —
     * joined against a component's `skillTags` by skill selection, for the
     * case a component's technology cannot express: an authentication
     * boundary is not a Flutter or a Next.js concern, it is a concern that
     * cuts across whichever component happens to hold the login form.
     *
     * **Declared only, and never derived from `problem` or `acceptance`
     * text.** A tag inferred by scanning prose for a word like
     * "authentication" is exactly the free-form model claim skill selection
     * is built to refuse — the interview names a tag during discovery because
     * a person decided it belonged, or the tag is absent and no skill routes
     * on it. Reading it back out of the words the person used to describe the
     * problem would make that decision the model's to make after all.
     *
     * Defaulted for the reason every other default in this strict schema is:
     * a brief written before this field existed would otherwise fail
     * validation on read rather than gain the field on its next write.
     */
    tags: z.array(z.string().min(1)).default([]),
    discovery: DiscoverySchema,
    approval: FeatureApprovalSchema.nullable(),
    /** The revision this one replaces, or null for the first. */
    supersedes: z.strictObject({ id: FeatureIdSchema, revision: z.number().int().positive() }).nullable(),
    createdAt: z.iso.datetime(),
  })
  .superRefine((brief, ctx) => {
    if (brief.status === 'superseded') {
      ctx.addIssue({
        code: 'custom',
        path: ['status'],
        message:
          'a stored revision is only ever "draft" or "approved" — "superseded" is derived on read from the existence of a higher revision, because writing it would mean editing the immutable record it describes',
      })
    }

    if (brief.status === 'approved' && brief.acceptance.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['acceptance'],
        message:
          'an approved brief must carry at least one acceptance criterion — later stories plan against these, and a draft is where an empty list belongs',
      })
    }

    // The status and the approval block are two spellings of one fact, and
    // either one alone is a lie: an approved record with no approval is an
    // approval nobody signed, and a draft carrying one is an approval the
    // status hides from every reader that only looks at `status`.
    if (brief.status === 'approved' && brief.approval === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['approval'],
        message: 'an approved brief must record who approved it and when',
      })
    }
    if (brief.status === 'draft' && brief.approval !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['approval'],
        message: 'a draft cannot carry an approval — approving is what makes a revision stop being a draft',
      })
    }

    // A successor that does not point at its predecessor breaks the only
    // record of why revision 2 exists. The store always writes `revision - 1`
    // — the revision being replaced, exactly as an accepted profile does — but
    // the rule enforced here is the weaker "somewhere behind it in this same
    // feature", so that a later rollback which wants to record a different
    // predecessor is a store decision rather than a schema rewrite.
    if (brief.revision === 1 && brief.supersedes !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['supersedes'],
        message: 'the first revision of a feature supersedes nothing',
      })
    }
    if (brief.revision > 1 && brief.supersedes === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['supersedes'],
        message: `revision ${brief.revision} exists because it replaced an earlier one, and must name it`,
      })
    }
    if (brief.supersedes !== null) {
      if (brief.supersedes.id !== brief.id) {
        ctx.addIssue({
          code: 'custom',
          path: ['supersedes', 'id'],
          message: `revision ${brief.revision} of ${brief.id} cannot supersede ${brief.supersedes.id} — a successor replaces an earlier revision of its own feature`,
        })
      }
      if (brief.supersedes.revision >= brief.revision) {
        ctx.addIssue({
          code: 'custom',
          path: ['supersedes', 'revision'],
          message: `revision ${brief.revision} cannot supersede revision ${brief.supersedes.revision} — a predecessor comes before its successor`,
        })
      }
    }
  })

export type FeatureBriefStatus = z.infer<typeof FeatureBriefStatusSchema>
export type Decision = z.infer<typeof DecisionSchema>
export type FeatureApproval = z.infer<typeof FeatureApprovalSchema>
export type FeatureDiscovery = z.infer<typeof DiscoverySchema>
export type FeatureBrief = z.infer<typeof FeatureBriefSchema>
