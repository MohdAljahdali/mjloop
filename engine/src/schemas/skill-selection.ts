/**
 * What one project has accepted from the shared skill library, and what an
 * approved feature brief routes an existing agent role to.
 *
 * Two schemas either side of a seam between two stories. `AcceptedProjectSkillSchema`
 * is the shape *this* story defines and *S06* produces: S06 owns the
 * user-local skill library and the per-project acceptance records, and
 * whatever it writes must satisfy exactly this shape, because `selectSkills`
 * (`../ops/skill-selection.js`) is built against it before S06 exists. A
 * project record references a package by `packageDigest` and never by a path
 * into the library — the library is user-local and shared across every
 * project on the machine, and a path a project record could dereference would
 * let one project's acceptance be invalidated by another project's update or
 * removal of the same package.
 *
 * `SkillSelectionSchema` and `SkillManifestSchema` are this story's own
 * output: the routing decision `selectSkills` makes for one (component,
 * agent) pair, and the whole manifest a run pins beside `verify-pinned.json`
 * before dispatch.
 */
import * as z from 'zod'
import { AgentNameSchema } from './contract.js'
import { FeatureIdSchema } from './feature.js'
import { IdSchema } from './state.js'

/**
 * One project's acceptance of one skill package.
 *
 * **Defined here, produced by S06.** This story cannot build the shared
 * library or the per-project acceptance flow — that is S06's job — but
 * `selectSkills` needs a shape to select over before either exists, so the
 * shape is fixed here and S06 is built to satisfy it. A record S06 writes
 * that fails to parse against this schema is a bug in S06; a field this
 * story reads that is absent from the schema is a bug in this story.
 */
export const AcceptedProjectSkillSchema = z.strictObject({
  skillId: IdSchema,
  /**
   * Which immutable package version this project accepted. S06 owns the
   * library and its content-addressed versions; a project record references
   * a digest and never a path into it, so one project's acceptance can never
   * be invalidated by another project's update, removal, or a library moved
   * to a different machine.
   */
  packageDigest: z.string().regex(/^[a-f0-9]{64}$/),
  /** Component ids of *this* project the acceptance enables. Empty means none. */
  components: z.array(IdSchema),
  /**
   * What the skill claims to be for. Joined against a component's
   * `skillTags`, and against the brief's own declared `tags` for the
   * cross-cutting case — an authentication boundary is not a component's
   * technology, so the join has to be able to reach the brief as well as the
   * component.
   */
  tags: z.array(z.string().min(1)),
  /** Which fixed roles may receive it. An unknown role name here selects nothing. */
  agents: z.array(AgentNameSchema),
  /**
   * The bounded text a receiving agent is handed. Bounded because it is
   * copied into a brief on every dispatch: an unbounded guidance string would
   * make every run's brief as large as the largest skill a project has ever
   * accepted, on every cycle, whether or not that skill was even selected.
   */
  guidance: z.string().min(1).max(4000),
  status: z.enum(['active', 'disabled']),
  /**
   * The per-project host compatibility result. An incompatible skill is
   * never selected, however well its tags match — compatibility is a fact
   * about whether the skill can run *here at all*, and a good match on a host
   * that cannot run it is not a selectable skill.
   */
  compatible: z.boolean(),
})

export type AcceptedProjectSkill = z.infer<typeof AcceptedProjectSkillSchema>

/**
 * One routing decision: which skills a (component, agent) pair receives, and
 * why.
 *
 * `skillIds` and `reasons` are index-aligned — the reason at index *i*
 * explains the skill at index *i* — and the refinement below enforces that
 * the two arrays can never drift apart. A reason list that has drifted from
 * its ids is worse than none at all: the evidence view built on this record
 * would attribute a routing decision to the wrong skill, and a reader would
 * trust an explanation that explains something else entirely.
 */
export const SkillSelectionSchema = z
  .strictObject({
    component: IdSchema,
    agent: AgentNameSchema,
    skillIds: z.array(IdSchema),
    reasons: z.array(z.string().min(1)),
    sourceBrief: z.strictObject({ id: FeatureIdSchema, revision: z.number().int().positive() }),
  })
  .superRefine((selection, ctx) => {
    if (selection.skillIds.length !== selection.reasons.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['reasons'],
        message:
          `${selection.skillIds.length} skill(s) selected for component "${selection.component}" / agent ` +
          `"${selection.agent}" but ${selection.reasons.length} reason(s) recorded — the two arrays are index-aligned ` +
          'by construction, and one reason per skill is what lets the evidence view attribute a routing decision to ' +
          'the tag that actually matched rather than to whichever skill happens to share its position.',
      })
    }
  })

export type SkillSelection = z.infer<typeof SkillSelectionSchema>

/**
 * Whether independent dispatch of this run's affected components has been
 * *proven*, and the one sentence naming which rule decided.
 *
 * A bare `mode` would answer "what happens" and leave "why did this
 * serialise" — the question an operator actually asks — unanswered, so the
 * reason travels with the mode everywhere this shape appears rather than
 * being optional.
 */
export const ConcurrencyDecisionSchema = z.strictObject({
  mode: z.enum(['parallel', 'sequential']),
  reason: z.string().min(1),
})

export type ConcurrencyDecision = z.infer<typeof ConcurrencyDecisionSchema>

/**
 * The whole routing decision for one run, pinned beside `verify-pinned.json`
 * before dispatch.
 *
 * `profileRevision` travels with `sourceBrief` for the reason the brief
 * itself is pinned at all: a manifest is a claim about what one *specific*
 * accepted profile and one *specific* approved brief produced together, and
 * either one moving after the run started must not rewrite a task already in
 * flight.
 */
export const SkillManifestSchema = z
  .strictObject({
    schema: z.literal(1),
    generatedAt: z.iso.datetime(),
    sourceBrief: z.strictObject({ id: FeatureIdSchema, revision: z.number().int().positive() }),
    profileRevision: z.number().int().positive(),
    selections: z.array(SkillSelectionSchema),
    /**
     * The bounded guidance text for every skill the selections above name,
     * keyed by skill id — the half of the dispatch contract that makes the
     * other half actionable. A selection carries an id and the reason it was
     * chosen; neither tells a receiving agent what to *do*, and an agent
     * instructed to "apply exactly the guidance it carries" against a file
     * carrying none would be left inventing the skill's meaning, which is the
     * free-form claim this whole record exists to replace.
     *
     * A map rather than a per-selection array because one skill routinely
     * lands on several (component, agent) rows: `AcceptedProjectSkill.guidance`
     * is capped at 4000 characters so that copying it is affordable, and
     * repeating the same 4000 characters once per row would spend that budget
     * as many times as the manifest has rows. The cap is restated here rather
     * than inherited, because this record is read by agents that never see an
     * acceptance record and its own bound has to hold on its own terms.
     *
     * Defaulted to `{}` for the reason every default in this codebase exists:
     * no project has accepted a skill yet — S06 owns the library — so every
     * manifest pinned today selects nothing and has nothing to render, and an
     * empty map is that fact rather than a missing field.
     */
    guidance: z.record(IdSchema, z.string().min(1).max(4000)).default({}),
    concurrency: ConcurrencyDecisionSchema,
  })
  .superRefine((manifest, ctx) => {
    const selected = [...new Set(manifest.selections.flatMap((selection) => selection.skillIds))]
    const unguided = selected.filter((skillId) => manifest.guidance[skillId] === undefined)
    if (unguided.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['guidance'],
        message:
          `${unguided.map((skillId) => `"${skillId}"`).join(', ')} is selected by this manifest but carries no ` +
          'guidance — an agent handed a skill id and no text to follow has been told which skill to apply and ' +
          'nothing about how, which leaves it deciding for itself what the skill meant.',
      })
    }
  })

export type SkillManifest = z.infer<typeof SkillManifestSchema>
