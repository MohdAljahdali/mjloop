/**
 * Deterministic, pure skill routing for the fixed agent roles.
 *
 * Nothing here does I/O and nothing here is asked to invent anything: every
 * fact this module acts on — the approved brief, the accepted profile, the
 * project's accepted skills — arrives already read and already validated by
 * the caller. That is what makes `selectSkills` byte-identical across two
 * calls given the same inputs, which is the property the story's evidence
 * view is built on: a routing decision has to be reproducible from the
 * records that produced it, never merely plausible from a model's telling of
 * it.
 *
 * Agent roles stay fixed. This module changes what guidance a role receives
 * for one task, never the role itself — there is no per-technology agent
 * anywhere in this file, and there must never be.
 */
import type { Orchestration } from '../schemas/config.js'
import type { FeatureBrief } from '../schemas/feature.js'
import type { ProjectComponent, ProjectProfile } from '../schemas/project-profile.js'
import {
  ConcurrencyDecisionSchema,
  SkillSelectionSchema,
  type AcceptedProjectSkill,
  type ConcurrencyDecision,
  type SkillSelection,
} from '../schemas/skill-selection.js'

/**
 * Selection was asked to route work for a brief nobody approved.
 *
 * A draft is still being assembled — its `affectedComponents` and `tags` can
 * change on the very next `mjloop_feature_update` call — so routing off one
 * would dispatch agents against decisions nobody has agreed to yet. The
 * status it actually got travels with the message, because a bare refusal
 * cannot tell a caller "this was never approved" apart from "this was
 * approved and something has since superseded it", and the two call for
 * different next steps.
 */
export class BriefNotApprovedError extends Error {
  constructor(featureId: string, status: string) {
    super(`skill selection needs an approved brief, and ${featureId} is "${status}"`)
    this.name = 'BriefNotApprovedError'
  }
}

/**
 * The brief names a component the accepted profile handed to this call does
 * not have.
 *
 * `mjloop_feature_approve` already refuses to seal a brief naming a component
 * the accepted map lacked at that moment, so seeing one here means the map
 * moved *after* approval — a later scan proposed a smaller component set and
 * a person accepted it. Skipping the id would silently drop that
 * component's work from the manifest with nothing anywhere recording that it
 * was ever considered, so this is an error rather than a skip.
 */
export class UnresolvedComponentError extends Error {
  constructor(
    readonly unresolved: readonly string[],
    readonly known: readonly string[],
  ) {
    super(
      `${quoted(unresolved)} is not in the accepted profile this selection was given, which names ${quoted(known)} ` +
        '— the profile moved under this brief after it was approved, and continuing would silently drop the work ' +
        'for that component.',
    )
    this.name = 'UnresolvedComponentError'
  }
}

export interface SelectSkillsInput {
  brief: FeatureBrief
  /** An ACCEPTED revision. Reading the right one is the caller's job, not this function's. */
  profile: ProjectProfile
  acceptedSkills: AcceptedProjectSkill[]
  agent: string
}

/**
 * Route this brief's affected components to the skills one agent role
 * should receive.
 *
 * Selection joins on component ids and declared tags only — never on
 * `problem` or `acceptance` prose. Reading that text for a cue like
 * "authentication" would be exactly the free-form model claim the story
 * forbids: a person declares a tag during discovery, or the tag is absent,
 * and this function has no third way to learn one.
 */
export function selectSkills(input: SelectSkillsInput): SkillSelection[] {
  const { brief, profile, acceptedSkills, agent } = input

  if (brief.status !== 'approved') {
    throw new BriefNotApprovedError(brief.id, brief.status)
  }

  const resolved = resolveComponents(brief, profile)

  const selections: SkillSelection[] = resolved.map(({ id, component }) => {
    const matches = acceptedSkills
      .filter((skill) => skill.status === 'active')
      .filter((skill) => skill.compatible)
      .filter((skill) => skill.components.includes(id))
      .filter((skill) => skill.agents.includes(agent))
      .map((skill) => matchOnTag(skill, component, brief))
      .filter((match): match is { skillId: string; reason: string } => match !== null)
      // Sorted here, ahead of the whole-array sort below, so the two
      // orderings the story demands — components, then skills within one
      // component — are each applied at the level they belong to.
      .sort((a, b) => compare(a.skillId, b.skillId))

    return {
      component: id,
      agent,
      skillIds: matches.map((match) => match.skillId),
      reasons: matches.map((match) => match.reason),
      sourceBrief: { id: brief.id, revision: brief.revision },
    }
  })

  selections.sort((a, b) => compare(a.component, b.component) || compare(a.agent, b.agent))
  // Parsed rather than merely constructed, exactly as `detectComponents`
  // parses its own output: this function is the one caller allowed to hand a
  // record no later reader could trust, and the refinement on
  // `SkillSelectionSchema` is the one thing standing between a bug in the
  // logic above and a manifest whose reasons have silently drifted from its ids.
  return selections.map((selection) => SkillSelectionSchema.parse(selection))
}

/**
 * Whether one accepted skill is selected for one component, and why.
 *
 * A component tag is tried before a brief tag, and the reason names whichever
 * one actually decided — the story requires "which of the two matched and on
 * which tag" — because a component's own `skillTags` is the narrower fact of
 * the two, and a reader auditing this decision should be given the narrower
 * reason when both happen to hold.
 */
function matchOnTag(
  skill: AcceptedProjectSkill,
  component: ProjectComponent,
  brief: FeatureBrief,
): { skillId: string; reason: string } | null {
  const componentTag = skill.tags.find((tag) => component.skillTags.includes(tag))
  if (componentTag !== undefined) {
    return {
      skillId: skill.skillId,
      reason: `"${skill.skillId}" matches component "${component.id}"'s skillTag "${componentTag}"`,
    }
  }
  const briefTag = skill.tags.find((tag) => brief.tags.includes(tag))
  if (briefTag !== undefined) {
    return {
      skillId: skill.skillId,
      reason: `"${skill.skillId}" matches the brief's declared tag "${briefTag}"`,
    }
  }
  return null
}

/**
 * Has this run's affected components been *proven* independent, and if not,
 * why not.
 *
 * Proof rests on exactly the two facts the accepted profile can state:
 * component roots, and verify command strings. **The story's
 * declared-interface and shared-resource checks are not representable in
 * today's data model** — no schema anywhere records what interface a
 * component exposes or what resource it touches outside its own verify
 * commands — and inventing a field to ask a person to fill in would be a
 * guess wearing a schema. What this function actually proves is
 * root-disjointness and shared-command-freedom; anything beyond that falls
 * to the project's `uncertain_concurrency` policy, which is a decision a
 * project has made, rather than to an analyser guessing at data it does not
 * have.
 *
 * The two arms are the whole point, and they run the way
 * `UncertainConcurrencySchema` in `schemas/config.ts` documents them rather
 * than the other way round: **proof yields parallel, and only the absence of
 * proof consults the policy.** A shared root does not demonstrate that two
 * components are dependent — `apps` and `apps/admin` may well be independent —
 * it demonstrates only that nothing here can show they are not, which is
 * exactly the "cannot be proven independent" case the setting exists to
 * settle. Consulting the policy on the proven side instead would make
 * `parallel` unreachable on every default install however disjoint the work,
 * and would leave the setting governing nothing at all on the side it names.
 */
export function analyseConcurrency(
  brief: FeatureBrief,
  profile: ProjectProfile,
  orchestration: Orchestration,
): ConcurrencyDecision {
  const resolved = resolveComponents(brief, profile)

  if (resolved.length < 2) {
    return decide({
      mode: 'sequential',
      reason:
        'fewer than two affected components — there is nothing to run in parallel, so this serialises regardless of policy',
    })
  }

  const components = resolved.map(({ component }) => component)

  for (const [a, b] of pairs(components)) {
    if (rootsOverlap(a.root, b.root)) {
      return unproven(
        orchestration,
        `component "${a.id}"'s root "${a.root}" and component "${b.id}"'s root "${b.root}" are not proven ` +
          'independent — one names, or is a path prefix of, the other (the project root "." counts as a prefix of ' +
          'everything), so their work cannot be shown to touch disjoint trees',
      )
    }
  }

  for (const [a, b] of pairs(components)) {
    const shared = sharedVerifyCommand(a, b)
    if (shared !== null) {
      return unproven(
        orchestration,
        `component "${a.id}" and component "${b.id}" share the verify command "${shared}" — one suite already ` +
          'covers both, and two agents running it at once would contend for the project verify lock',
      )
    }
  }

  // Independence is proven at this point: more than one component, disjoint
  // roots, and no shared verify command. Nothing is uncertain here, so the
  // project's uncertainty policy has no say — it is deliberately not read on
  // this path, and the reason deliberately does not name it.
  return decide({
    mode: 'parallel',
    reason:
      'component roots are disjoint and no verify command is shared between them, so these components are proven ' +
      'independent from the accepted profile alone',
  })
}

/**
 * What to do when independence could not be shown: whatever this project said
 * to do about work it cannot prove independent.
 *
 * `ask` reports `sequential` and names itself, because a pure analyser cannot
 * put a question to anyone — the naming is the whole mechanism, since it is
 * the only thing that tells the leader reading this reason that there is a
 * choice to offer rather than a verdict to obey. `parallel` is honoured: a
 * project that set it has already decided that unproven is not the same as
 * unsafe here, and refusing it would leave the setting governing nothing on
 * the one side it is documented to govern.
 */
function unproven(orchestration: Orchestration, rule: string): ConcurrencyDecision {
  const policy = orchestration.execution.uncertain_concurrency
  if (policy === 'parallel') {
    return decide({
      mode: 'parallel',
      reason: `${rule}, and orchestration.execution.uncertain_concurrency is "parallel"`,
    })
  }
  if (policy === 'ask') {
    return decide({
      mode: 'sequential',
      reason:
        `${rule}, and orchestration.execution.uncertain_concurrency is "ask" — a pure analyser cannot put a ` +
        'question to a person, so this serialises and the leader should offer the choice',
    })
  }
  return decide({
    mode: 'sequential',
    reason:
      `${rule}, and orchestration.execution.uncertain_concurrency is "sequential", the default that cannot ` +
      'corrupt a worktree by itself',
  })
}

function decide(candidate: ConcurrencyDecision): ConcurrencyDecision {
  return ConcurrencyDecisionSchema.parse(candidate)
}

/** One resolved component, alongside the id it was resolved from. */
interface ResolvedComponent {
  id: string
  component: ProjectComponent
}

/**
 * Every affected component id resolved against the accepted profile, in
 * order and de-duplicated. Throws `UnresolvedComponentError` naming every id
 * the profile lacks, in one call, rather than failing on the first.
 *
 * De-duplicated because a brief naming one component twice must not produce
 * two identical selections for it — the sort in `selectSkills` would put
 * them beside each other with nothing to tell them apart, and two runs of an
 * agent against the same skills would look like independent evidence for a
 * decision that was only ever made once.
 */
function resolveComponents(brief: FeatureBrief, profile: ProjectProfile): ResolvedComponent[] {
  const byId = new Map(profile.components.map((component) => [component.id, component]))
  const ids = [...new Set(brief.affectedComponents)]

  const resolved: ResolvedComponent[] = []
  const unresolved: string[] = []
  for (const id of ids) {
    const component = byId.get(id)
    if (component === undefined) unresolved.push(id)
    else resolved.push({ id, component })
  }
  if (unresolved.length > 0) throw new UnresolvedComponentError(unresolved, [...byId.keys()])
  return resolved
}

/**
 * Two roots are not independent when one names, or path-prefixes, the other
 * — segment-aware, so `apps/web` does not collide with `apps/webapp`. The
 * project root `.` collides with everything, stated as its own case because
 * `.` is not a string prefix of anything in the segment sense above.
 */
function rootsOverlap(a: string, b: string): boolean {
  if (a === '.' || b === '.') return true
  if (a === b) return true
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

/** A verify command string the two components have in common, in any slot, or null. */
function sharedVerifyCommand(a: ProjectComponent, b: ProjectComponent): string | null {
  const bCommands = new Set(verifyCommands(b))
  return verifyCommands(a).find((command) => bCommands.has(command)) ?? null
}

function verifyCommands(component: ProjectComponent): string[] {
  return [component.verification.test, component.verification.lint, component.verification.build].filter(
    (command): command is string => command !== null,
  )
}

/**
 * Every unordered pair of distinct items, built without indexing the array —
 * `tsconfig.json`'s `noUncheckedIndexedAccess` makes `items[i]` a
 * `T | undefined`, and this keeps every caller working with `T` instead of
 * re-deriving the same "this index is always in range" argument at each use.
 */
function pairs<T>(items: readonly T[]): Array<[T, T]> {
  const found: Array<[T, T]> = []
  for (const [i, a] of items.entries()) {
    for (const b of items.slice(i + 1)) {
      found.push([a, b])
    }
  }
  return found
}

function compare(a: string, b: string): number {
  // Plain comparison, not `localeCompare`: the ordering has to agree across
  // every machine that reads a manifest, and a locale-sensitive comparison is
  // by definition not guaranteed to.
  return a < b ? -1 : a > b ? 1 : 0
}

function quoted(ids: readonly string[]): string {
  return ids.map((id) => `"${id}"`).join(', ')
}
