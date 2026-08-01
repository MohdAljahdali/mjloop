/**
 * `.mjloop/skills/` — one project's acceptances of packages from the shared,
 * user-local skill library.
 *
 * One file per accepted skill, `<skillId>.json`, where `skillId` is the
 * package's own stable `packageId` — a project has at most one live
 * acceptance per *source*, because the file it would occupy is the same file
 * whichever digest of that source it names. Two projects sharing one
 * library each keep their own `.mjloop/skills/<packageId>.json`, so they can
 * (and the story's isolation test does) pin two different digests of the
 * same source without either record moving the other.
 *
 * Every id and digest this module joins into a path is validated by a schema
 * first — `IdSchema` for a skill id, `DigestSchema` (via `readPackage`) for a
 * package digest — exactly as `feature-store.ts` and `skill-library-store.ts`
 * do, and for the identical reason: a value that has passed one of those
 * patterns cannot carry a path separator, a `.`, or anything else a
 * filesystem would treat specially, which is what makes validating *before*
 * the join the entire traversal guard.
 */
import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import * as z from 'zod'
import type { SkillUpdateMode } from '../schemas/config.js'
import {
  ProjectSkillAcceptanceSchema,
  SKILL_ACCEPTANCE_AGENTS,
  type ProjectSkillAcceptance,
} from '../schemas/skill-acceptance.js'
import { IdSchema } from '../schemas/state.js'
import { writeJsonAtomic } from './atomic.js'
import { withLock } from './lock.js'
import { resolveLoopPaths } from './paths.js'
import { readAcceptedProfile } from './project-profile-store.js'
import { readPackage } from './skill-library-store.js'
import type { Clock } from './state-store.js'

export class InvalidSkillIdError extends Error {
  constructor(skillId: string) {
    super(`"${skillId}" is not a valid skill id — a skill id is letters, digits, "-" and "_" only`)
    this.name = 'InvalidSkillIdError'
  }
}

export class InvalidSkillAcceptanceRecordError extends Error {
  constructor(file: string, detail: string) {
    super(`${file} is not a valid skill acceptance:\n${detail}`)
    this.name = 'InvalidSkillAcceptanceRecordError'
  }
}

export class SkillAcceptanceNotFoundError extends Error {
  constructor(skillId: string, dir: string) {
    super(`no accepted skill "${skillId}" under ${dir}`)
    this.name = 'SkillAcceptanceNotFoundError'
  }
}

/** `acceptSkill` was asked to accept a digest this machine's library has no package for. */
export class PackageNotFoundError extends Error {
  constructor(digest: string) {
    super(
      `no package at digest "${digest}" in this machine's skill library — import it first, or check the digest ` +
        'against `mjloop-cli skills list`',
    )
    this.name = 'PackageNotFoundError'
  }
}

/**
 * `acceptSkill` was asked to accept a package whose audit has not passed.
 *
 * Nothing in S06 can produce a `'passed'` audit — the static inspection and
 * the sandbox are S07's job — so today no package is acceptable through this
 * path at all, and that is correct rather than a gap: S06 can hold a package,
 * but it cannot yet earn one the right to be used. The tests reach the
 * accepting branch by writing a package whose audit already says `'passed'`,
 * which S07 will earn legitimately once it exists.
 */
export class PackageNotAuditedError extends Error {
  constructor(digest: string, state: string) {
    super(
      `package "${digest}" has not passed an audit (audit.state is "${state}") — nothing in this version of the ` +
        'engine can set a package\'s audit to "passed", so no package is acceptable yet through the ordinary path. ' +
        'This is expected today, not a bug: the static inspection and sandbox that earn a passed audit are a later ' +
        "story's job.",
    )
    this.name = 'PackageNotAuditedError'
  }
}

/** `acceptSkill` was asked to enable a skill against a component the accepted profile does not have. */
export class UnknownAcceptanceComponentError extends Error {
  constructor(
    readonly unknown: readonly string[],
    readonly known: readonly string[],
  ) {
    super(
      known.length === 0
        ? `this project has no accepted component map, so ${quoted(unknown)} cannot name a component of it. Run ` +
            '`mjloop-cli profile show` and `mjloop-cli profile accept` first, or accept the skill against no ' +
            'components until the map exists.'
        : `${quoted(unknown)} is not in this project's accepted component map, which names ${quoted(known)}. Skill ` +
            'selection joins on these ids, so a component nothing has accepted would route work nowhere.',
    )
    this.name = 'UnknownAcceptanceComponentError'
  }
}

/** `acceptSkill` was asked to route a skill to an agent role dynamic skill selection never dispatches. */
export class UnknownAcceptanceAgentError extends Error {
  constructor(readonly unknown: readonly string[]) {
    super(
      `${quoted(unknown)} is not one of the fixed agent roles dynamic skill selection routes to ` +
        `(${SKILL_ACCEPTANCE_AGENTS.join(', ')}) — an unknown role here would select a skill for a dispatch that ` +
        'never happens.',
    )
    this.name = 'UnknownAcceptanceAgentError'
  }
}

/** `acceptSkill` was asked to accept a source this project already has a live acceptance for. */
export class SkillAlreadyAcceptedError extends Error {
  constructor(skillId: string) {
    super(
      `this project already has an acceptance for "${skillId}" — remove it first (\`mjloop-cli skills remove\`) if ` +
        'you mean to replace it with a different digest, components, or agents.',
    )
    this.name = 'SkillAlreadyAcceptedError'
  }
}

/** Parse and validate a skill id before it is ever joined into a path. */
function validateSkillId(skillId: string): string {
  const parsed = IdSchema.safeParse(skillId)
  if (!parsed.success) throw new InvalidSkillIdError(skillId)
  return parsed.data
}

function acceptanceFile(projectDir: string, skillId: string): string {
  return path.join(resolveLoopPaths(projectDir).skills, `${validateSkillId(skillId)}.json`)
}

/** Every id on record, ascending. Only canonically-named `<id>.json` files count. */
export async function listAcceptances(projectDir: string): Promise<ProjectSkillAcceptance[]> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(resolveLoopPaths(projectDir).skills, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // No acceptance has ever been recorded in this project — the state every
    // project starts in, and not an error.
    return []
  }

  const acceptances: ProjectSkillAcceptance[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const skillId = entry.name.slice(0, -'.json'.length)
    if (!IdSchema.safeParse(skillId).success) continue
    const record = await readAcceptance(projectDir, skillId)
    if (record !== null) acceptances.push(record)
  }
  return acceptances
}

/**
 * One acceptance, or `null` when no record exists at that skill id.
 *
 * A record that exists and does not parse throws rather than reading as
 * `null` — exactly the asymmetry `feature-store.ts` and
 * `skill-library-store.ts` both take for their own load-bearing records: an
 * acceptance is a decision a project made, and treating a corrupt one as
 * "never accepted" would silently drop a run's routing without anything on
 * disk saying why.
 */
export async function readAcceptance(projectDir: string, skillId: string): Promise<ProjectSkillAcceptance | null> {
  const file = acceptanceFile(projectDir, skillId)
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const parsed = ProjectSkillAcceptanceSchema.safeParse(parseJson(raw))
  if (!parsed.success) throw new InvalidSkillAcceptanceRecordError(file, z.prettifyError(parsed.error))
  return parsed.data
}

export interface AcceptSkillInput {
  /** The digest of the package this project is pinning — never a path into the library. */
  packageDigest: string
  /** Component ids this acceptance enables. Defaults to none. */
  components?: string[]
  /** Which fixed agent roles may receive it. Defaults to none. */
  agents?: string[]
  /**
   * The update policy this acceptance runs under from now on.
   *
   * Required, with no fallback read from `config.yaml` here or anywhere
   * later: `orchestration.skills.update_mode` is only ever a default a caller
   * may *offer* while assembling this input, never a value this store
   * consults on its own, so nothing can change what an already-accepted
   * skill does out from under the acceptance that fixed it.
   */
  updatePolicy: SkillUpdateMode
  /** Who accepted it. Free text; the engine cannot verify it. */
  acceptedBy: string
  /** See `ProjectSkillAcceptanceSchema.compatible`. Defaults to `true`. */
  compatible?: boolean
}

/**
 * Accept one digest of a library package into this project.
 *
 * Refuses:
 *   - a digest this machine's library holds no package for (`PackageNotFoundError`);
 *   - a package whose audit has not passed (`PackageNotAuditedError`) — see
 *     that error's comment for why that is every acceptance today;
 *   - a `components` id the accepted profile does not have
 *     (`UnknownAcceptanceComponentError`), the way `approveFeatureBrief` does
 *     and for the same reason — selection joins on these ids;
 *   - an `agents` entry naming a role dynamic skill selection never routes to
 *     (`UnknownAcceptanceAgentError`);
 *   - a source this project already has a live acceptance for
 *     (`SkillAlreadyAcceptedError`) — `removeAcceptance` first, since this
 *     store has no update path and one skill id can only ever name one file.
 *
 * `skillId` is not part of the input: it is the package's own stable
 * `packageId`, which is what makes "two projects accept different digests of
 * one source" land on the identically-named file in each project's own
 * `.mjloop/skills/` without either project having to invent a name for it.
 */
export async function acceptSkill(
  projectDir: string,
  input: AcceptSkillInput,
  now: Clock = () => new Date(),
): Promise<ProjectSkillAcceptance> {
  return locked(projectDir, async () => {
    const pkg = await readPackage(projectDir, input.packageDigest)
    if (pkg === null) throw new PackageNotFoundError(input.packageDigest)
    if (pkg.audit.state !== 'passed') throw new PackageNotAuditedError(pkg.digest, pkg.audit.state)

    const skillId = pkg.packageId
    if ((await readAcceptance(projectDir, skillId)) !== null) throw new SkillAlreadyAcceptedError(skillId)

    // Omitting `--components` or `--agents` means "wherever this skill fits",
    // not "nowhere". `selectSkills` joins on the component id AND on a tag —
    // the package's tags against the component's `skillTags` — so widening the
    // component set here cannot widen what actually matches: a Flutter skill
    // accepted for every component still selects only on the Flutter one. An
    // empty set, by contrast, matches nothing at all, and the record would sit
    // in `.mjloop/skills/` reading `status active` while routing nothing on
    // every run. The resolved sets are written into the record rather than left
    // implied, so `skills list` shows exactly what was enabled and a later
    // reader never has to know what the defaults were on the day.
    const accepted = await readAcceptedProfile(projectDir)
    const components = input.components ?? (accepted?.components ?? []).map((component) => component.id)
    await assertKnownComponents(projectDir, components)

    const agents = input.agents ?? [...SKILL_ACCEPTANCE_AGENTS]
    const unknownAgents = agents.filter(
      (agent) => !SKILL_ACCEPTANCE_AGENTS.includes(agent as (typeof SKILL_ACCEPTANCE_AGENTS)[number]),
    )
    if (unknownAgents.length > 0) throw new UnknownAcceptanceAgentError(unknownAgents)

    // The one case no default can rescue: a project with no accepted component
    // map has no component to name, so the acceptance is inert whatever this
    // function does. Deliberately NOT refused — a project may legitimately
    // accept skills before it accepts a map, and the acceptance becomes live
    // the moment one lands. `skills list` renders the empty component set, so
    // the state is visible rather than silent, which is what the failure
    // actually needed.

    const parsed = ProjectSkillAcceptanceSchema.parse({
      schema: 1,
      skillId,
      packageId: pkg.packageId,
      digest: pkg.digest,
      components,
      agents,
      tags: pkg.tags,
      updatePolicy: input.updatePolicy,
      status: 'active',
      compatible: input.compatible ?? true,
      acceptedBy: input.acceptedBy,
      acceptedAt: now().toISOString(),
    })

    await writeJsonAtomic(acceptanceFile(projectDir, skillId), parsed, { backup: false })
    return parsed
  })
}

/** Flip an acceptance's status. Refuses when this project has no such acceptance. */
export async function setAcceptanceStatus(
  projectDir: string,
  skillId: string,
  status: ProjectSkillAcceptance['status'],
): Promise<ProjectSkillAcceptance> {
  return locked(projectDir, async () => {
    const current = await readAcceptance(projectDir, skillId)
    if (current === null) throw new SkillAcceptanceNotFoundError(skillId, resolveLoopPaths(projectDir).skills)
    const parsed = ProjectSkillAcceptanceSchema.parse({ ...current, status })
    await writeJsonAtomic(acceptanceFile(projectDir, skillId), parsed, { backup: false })
    return parsed
  })
}

/**
 * Remove this project's acceptance only — never the package, and never
 * another project's record.
 *
 * That is this store's central isolation claim, and it holds by construction
 * rather than by a check: this function only ever touches the one file
 * `acceptanceFile` names for *this* `projectDir`, which is a path under this
 * project's own `.mjloop/skills/` and nowhere else. `fs.rm(..., force: true)`
 * makes the call idempotent — removing an acceptance that is already gone is
 * not an error, the same position `removePackage` takes on a missing digest.
 */
export async function removeAcceptance(projectDir: string, skillId: string): Promise<void> {
  await locked(projectDir, async () => {
    await fs.rm(acceptanceFile(projectDir, skillId), { force: true })
  })
}

/**
 * Every id in `components` must name a component of the accepted map.
 *
 * Mirrors `feature-store.ts`'s `assertKnownComponents` exactly, including its
 * asymmetry: an empty list is legal whether or not a map has ever been
 * accepted, but naming a component while no accepted map exists is refused,
 * because then no id is knowable and the acceptance would carry a claim
 * nothing could check.
 */
async function assertKnownComponents(projectDir: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  const profile = await readAcceptedProfile(projectDir)
  const known = (profile?.components ?? []).map((component) => component.id)
  const unknown = ids.filter((id) => !known.includes(id))
  if (unknown.length > 0) throw new UnknownAcceptanceComponentError(unknown, known)
}

/**
 * `withLock` creates its lock directory with a non-recursive `mkdir`, so
 * `.mjloop/` has to exist before the lock can be taken at all. Created here
 * for the reason `feature-store.ts`'s `locked` creates it: the writes this
 * guards make their own parents, so refusing purely because the *lock's*
 * parent was missing would refuse over a directory the very next line would
 * have created.
 */
async function locked<T>(projectDir: string, fn: () => Promise<T>): Promise<T> {
  const paths = resolveLoopPaths(projectDir)
  await fs.mkdir(paths.root, { recursive: true })
  return withLock(paths.lock, fn)
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

function quoted(ids: readonly string[]): string {
  return ids.map((id) => `"${id}"`).join(', ')
}
