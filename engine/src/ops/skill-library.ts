/**
 * The seam between S06's library and S05's routing: this project's accepted
 * skills, exactly as `selectSkills` (`skill-selection.js`) needs them.
 *
 * Everything this module does is a join. `skill-acceptance-store.ts` knows
 * what this project decided; `skill-library-store.ts` knows what content a
 * digest names on this machine; neither knows the other exists. This module
 * reads both and produces exactly `AcceptedProjectSkillSchema` — the shape
 * `schemas/skill-selection.ts` fixed before S06 existed, and the shape
 * `ops/run.ts#resolveSkillManifest` is built to consume.
 */
import { listAcceptances } from '../store/skill-acceptance-store.js'
import { readPackage } from '../store/skill-library-store.js'
import { AcceptedProjectSkillSchema, type AcceptedProjectSkill } from '../schemas/skill-selection.js'

export interface AcceptedProjectSkillsResult {
  /** Every acceptance whose package this machine's library still holds. */
  skills: AcceptedProjectSkill[]
  /**
   * The skill ids of acceptances whose package was *not* found on this
   * machine, in the same order `listAcceptances` returned them.
   *
   * Not thrown, and not folded silently into a shorter `skills` list: a
   * teammate's acceptance record travels with the project in a repository
   * while the library package it names does not — the library is
   * per-machine, never committed — so a run must not refuse to start because
   * somebody else's import never reached this machine. Surfacing the id lets
   * a caller say so, rather than pretending the acceptance was never made.
   */
  skippedSkillIds: string[]
}

/**
 * This project's accepted skills, joined to the library package each one
 * names by digest.
 *
 * A `disabled` acceptance is included with `status: 'disabled'` rather than
 * filtered out here — `selectSkills` already filters on status before it
 * routes anything, and filtering a second time in this join would make a
 * disabled acceptance invisible to any other reader of this list (the
 * evidence view included), for a fact this join is not the place to hide.
 *
 * `guidance` comes from the package — it is the text S06 imported and the
 * only place across these two records that carries it. Every other field on
 * the returned shape comes from the acceptance: which components and agents
 * it names, which tags it recorded at accept time, and its `status` and
 * `compatible` verdict are this *project's* facts, not the package's.
 */
export async function readAcceptedProjectSkills(projectDir: string): Promise<AcceptedProjectSkillsResult> {
  const acceptances = await listAcceptances(projectDir)

  const skills: AcceptedProjectSkill[] = []
  const skippedSkillIds: string[] = []

  for (const acceptance of acceptances) {
    const pkg = await readPackage(projectDir, acceptance.digest)
    if (pkg === null) {
      skippedSkillIds.push(acceptance.skillId)
      continue
    }
    skills.push(
      AcceptedProjectSkillSchema.parse({
        skillId: acceptance.skillId,
        packageDigest: acceptance.digest,
        components: acceptance.components,
        tags: acceptance.tags,
        agents: acceptance.agents,
        guidance: pkg.guidance,
        status: acceptance.status,
        compatible: acceptance.compatible,
      }),
    )
  }

  return { skills, skippedSkillIds }
}
