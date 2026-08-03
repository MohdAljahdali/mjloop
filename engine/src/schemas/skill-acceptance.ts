/**
 * One project's acceptance of one digest of a library package.
 *
 * Lives beside `skill-library.ts`'s `SkillPackageSchema` rather than inside
 * it, for the reason that file's own header states: a package is content a
 * *machine* has fetched once, and this is one *project's* decision to use one
 * digest of it. `readAcceptedProjectSkills` (`../ops/skill-library.js`) is
 * the seam that joins the two and produces exactly the
 * `AcceptedProjectSkillSchema` shape `skill-selection.ts` already fixed.
 */
import * as z from 'zod'
import { AgentNameSchema } from './contract.js'
import { SkillUpdateModeSchema } from './config.js'
import { IdSchema } from './state.js'
import { DigestSchema } from './skill-library.js'

/**
 * The roles skill selection routes to when a project declares no tracks at all.
 *
 * It used to be the whole answer, and a fixed four. The set is now whichever
 * agents a track in `config.yaml` names, because a project that adds an agent
 * to a track has already said that agent is one this loop runs — and a skill it
 * cannot be offered to is a skill that silently does nothing. This constant
 * remains as the floor: a config with no tracks routes to these four rather
 * than to nothing.
 */
export const SKILL_ACCEPTANCE_AGENTS = ['planner', 'builder', 'critic', 'verifier'] as const

export const ProjectSkillAcceptanceSchema = z.strictObject({
  schema: z.literal(1),
  skillId: IdSchema,
  /** Stable across revisions of one source — see `SkillPackageSchema.packageId`. */
  packageId: IdSchema,
  /**
   * A digest, never a path. The stop condition is explicit: no global-library
   * path may be stored in a project record, because the library moves per
   * machine and this record is committed.
   */
  digest: DigestSchema,
  components: z.array(IdSchema),
  agents: z.array(AgentNameSchema),
  tags: z.array(z.string().min(1)),
  /**
   * No global fallback of any kind. `orchestration.skills.update_mode` is
   * only ever a *default offered* at acceptance time by whichever caller
   * assembles this input — never consulted afterwards — because a global
   * policy could otherwise silently change what a project's already-accepted
   * skill does on its next run without that project ever having decided so.
   */
  updatePolicy: SkillUpdateModeSchema,
  status: z.enum(['active', 'disabled']),
  /**
   * The per-project host compatibility result.
   *
   * Nothing in this story determines host compatibility — no field on
   * `SkillPackage` records what a host needs, and checking `dependencies.
   * executables` against the machine that will run an agent is squarely the
   * sandboxed problem S07 owns. `acceptSkill` accepts this as an explicit
   * input rather than computing it, and defaults it to `true` when the
   * caller does not know better yet: today nothing here can prove a package
   * is *incompatible*, so recording an unearned `false` would be a claim as
   * ungrounded as an unearned `true` — the honest default is the one that
   * matches what this story can actually establish. A later story that can
   * compute this for real overwrites it rather than reads a fabricated one.
   */
  compatible: z.boolean(),
  /** Who accepted it. Free text; the engine cannot verify it. */
  acceptedBy: z.string().min(1),
  acceptedAt: z.iso.datetime(),
})

export type ProjectSkillAcceptance = z.infer<typeof ProjectSkillAcceptanceSchema>
