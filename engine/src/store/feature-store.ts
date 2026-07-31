/**
 * `.mjloop/features/` — the feature briefs.
 *
 * One directory per feature, `F001-<slug>/`, holding numbered revisions:
 * `rev-001.json`, `rev-002.json`, … The layout is the accepted profile's on
 * purpose, and so is the rule that governs it: **the latest revision is
 * whichever file is highest, and an approved revision never changes again.**
 * There is no mutable "current" pointer, because a second place the answer
 * lives is a second answer that can disagree with the first about what a run
 * was planned against.
 *
 * The one difference from the profile is the draft. A brief is *assembled* — an
 * interview asks a question, records the answer, and asks the next one — so
 * while a revision is a draft its file is rewritten in place, and that is the
 * only in-place write in this module. The instant a revision is approved it
 * becomes exactly as immutable as an accepted profile revision: a change is a
 * successor revision, and rollback is reselection — approving an earlier
 * revision's content as a *new* revision — never an edit and never a delete.
 *
 * That invariant is enforced here rather than asked of callers. Every write
 * goes through `writeDraftRevision` or `writeNewRevision`, and only the first
 * can land on a file that already exists — after reading it back and refusing
 * if what is there is approved.
 */
import crypto from 'node:crypto'
import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import * as z from 'zod'
import {
  FeatureBriefSchema,
  FeatureIdSchema,
  type FeatureBrief,
  type FeatureBriefStatus,
  type FeatureDiscovery,
} from '../schemas/feature.js'
import { writeJsonAtomic } from './atomic.js'
import { withLock } from './lock.js'
import { resolveLoopPaths } from './paths.js'
import { StalePreconditionError } from './precondition.js'
import { readAcceptedProfile } from './project-profile-store.js'
import type { Clock } from './state-store.js'

export class InvalidFeatureRecordError extends Error {
  constructor(file: string, detail: string) {
    super(`${file} is not a valid feature brief:\n${detail}`)
    this.name = 'InvalidFeatureRecordError'
  }
}

export class FeatureNotFoundError extends Error {
  constructor(featureId: string, dir: string) {
    super(`no feature "${featureId}" under ${dir}`)
    this.name = 'FeatureNotFoundError'
  }
}

/** A revision file already sits where the next revision would land. */
export class FeatureRevisionExistsError extends Error {
  constructor(file: string) {
    super(`${file} already exists — a feature revision is never written twice`)
    this.name = 'FeatureRevisionExistsError'
  }
}

/**
 * A write that would have changed an approved revision.
 *
 * The message names superseding because that is the whole of the way forward:
 * an approved brief is what a plan was built on, so changing one's mind about
 * it is a new revision that records what it replaced, not an edit that leaves
 * no trace of what the approver actually saw.
 */
export class ApprovedRevisionImmutableError extends Error {
  constructor(featureId: string, revision: number) {
    super(
      `revision ${revision} of ${featureId} is approved and is never rewritten — a later plan may already rest on ` +
        'exactly these words. Supersede it: that creates the next revision as a draft, carrying this content ' +
        'forward, and leaves this one saying what it always said.',
    )
    this.name = 'ApprovedRevisionImmutableError'
  }
}

/** Approval of a brief that has no acceptance criteria to approve. */
export class AcceptanceRequiredError extends Error {
  constructor(featureId: string, revision: number) {
    super(
      `revision ${revision} of ${featureId} has no acceptance criteria, so there is nothing in it to approve — ` +
        'a draft may have none while it is being assembled, but every later story plans against them. Record at ' +
        'least one before approving.',
    )
    this.name = 'AcceptanceRequiredError'
  }
}

/** Superseding a revision nobody has approved. */
export class FeatureNotApprovedError extends Error {
  constructor(featureId: string, revision: number) {
    super(
      `revision ${revision} of ${featureId} is still a draft, so there is nothing to supersede — edit it instead. ` +
        'Superseding exists to leave an approved revision untouched, and an unapproved one has nothing to protect.',
    )
    this.name = 'FeatureNotApprovedError'
  }
}

/**
 * A brief naming a component the project's accepted map does not have.
 *
 * This is the one rule in the record that the schema cannot enforce: the
 * answer lives in `.mjloop/profile/accepted/`, and a schema is given a value
 * rather than a project. All the schema can promise is that each id is the
 * shape every filesystem-bound id in the engine has.
 */
export class UnknownComponentError extends Error {
  constructor(
    readonly unknown: readonly string[],
    readonly known: readonly string[],
  ) {
    super(
      known.length === 0
        ? `this project has no accepted component map, so ${quoted(unknown)} cannot name a component of it. ` +
            'Run `mjloop-cli profile show` and `mjloop-cli profile accept` first, or leave affectedComponents empty ' +
            'until the map exists.'
        : `${quoted(unknown)} is not in this project's accepted component map, which names ${quoted(known)}. ` +
            'Skill selection joins on these ids, so a component nothing has accepted would route work nowhere.',
    )
    this.name = 'UnknownComponentError'
  }
}

/**
 * An approval or a supersede refused because the revision moved under the
 * caller.
 *
 * A subclass of `StalePreconditionError` rather than a fourth
 * `PreconditionSubject`, exactly as `StaleProfileRevisionError` is, and for the
 * mechanical reason that one states: `PreconditionSubject` is the key type of
 * the subject-to-code map in `web/writes.ts`, so widening it obliges that map
 * to grow in the same change. The browser *can* reach this one — approving a
 * displayed draft is the single feature write it is allowed — so the web layer
 * catches this class by name, ahead of the generic branch, the way it already
 * catches `ConfigMutationError`. The subject handed to the base constructor is
 * never read for that reason; `plan` is the nearest neighbour, so a caller that
 * only knows the base class still degrades to a message about the right family
 * of record.
 */
export class StaleFeatureRevisionError extends StalePreconditionError {
  constructor(
    featureId: string,
    readonly actualRevision: number | null,
    readonly expectedRevision: number,
  ) {
    super('plan', featureId, actualRevision === null ? null : String(actualRevision))
    this.name = 'StaleFeatureRevisionError'
    this.message =
      `${featureId} has moved on — this write was built on revision ${expectedRevision}, and the feature is now on ` +
      `${actualRevision === null ? 'no revision at all' : `revision ${actualRevision}`}`
  }
}

/**
 * An approval built on words that changed after they were read.
 *
 * The sibling of the error above, and the one that does the work. A draft keeps
 * its revision number for the whole of its editable life — that is what makes
 * it a draft — so the number alone can never report that a decision was
 * appended or a title rewritten between the screen somebody read and the button
 * they pressed. `briefDigest` can, because it is a fact about the content
 * rather than about the counter beside it.
 *
 * Same base class and same placeholder subject as `StaleFeatureRevisionError`,
 * for the reason stated there: to a caller these are one fact — the state the
 * decision was made from is gone, and nothing was written.
 */
export class StaleFeatureContentError extends StalePreconditionError {
  constructor(
    featureId: string,
    revision: number,
    readonly actualDigest: string,
    readonly expectedDigest: string,
  ) {
    super('plan', featureId, actualDigest)
    this.name = 'StaleFeatureContentError'
    this.message =
      `${featureId} has moved on — revision ${revision} has been rewritten since this write read it, so approving ` +
      'now would freeze words nobody has read. Read the brief again and decide on what it says today.'
  }
}

/**
 * A revision number reaches the filesystem — it *is* the filename — so it goes
 * through a schema rather than an ad-hoc check, for the reason
 * `project-profile-store.ts` gives: `NaN` and `1.5` would otherwise produce
 * `rev-NaN.json` and `rev-1.5.json`, files nothing can ever read back.
 */
const RevisionSchema = z.number().int().positive()

/**
 * The slug is bounded because the whole basename is: a title is free text and
 * `NAME_MAX` is 255 bytes on every filesystem this runs on. The id in front of
 * it is what makes the directory unique, so a truncated slug still identifies
 * it — the same bargain `storyFileName` strikes.
 */
const SLUG_MAX = 60

/**
 * A fingerprint of one revision's content, and the token an approval swaps on.
 *
 * `mutateConfig` takes the same shape of precondition — a sha256 the caller
 * hands back with its write — and here it is load-bearing rather than merely
 * convenient. A draft's *revision number* cannot move for as long as the draft
 * is editable: `updateFeatureDraft` and `appendFeatureDecision` rewrite the same
 * file and leave `revision` alone, and only an already-approved revision can be
 * superseded. A precondition on the number alone would therefore be a guard on
 * a value that is constant for exactly as long as the record it protects is
 * mutable, which is to say no guard at all — an approval could be built on a
 * screen showing one title and land on another.
 *
 * Hashed over `JSON.stringify` of the *parsed* record rather than the bytes on
 * disk. Every record this module hands out comes back through
 * `FeatureBriefSchema`, so the key order is the schema's and a value written
 * here fingerprints identically when it is read again; hashing the file would
 * tie the token to the serialiser's whitespace, which nothing else about a
 * brief depends on.
 */
export function briefDigest(brief: FeatureBrief): string {
  return crypto.createHash('sha256').update(JSON.stringify(brief)).digest('hex')
}

/** What a record read off disk means to a reader, as opposed to what it says. */
export interface FeatureBriefRecord {
  /** The record exactly as it is on disk. Its status is only ever `draft` or `approved`. */
  brief: FeatureBrief
  /**
   * The lifecycle status to *show*: `superseded` when a higher revision of this
   * feature exists, and the stored status otherwise. Derived here because
   * storing it would mean writing to the immutable record it describes.
   */
  status: FeatureBriefStatus
  /** Absolute path to the revision file. */
  file: string
  /**
   * What this revision said when it was read — `briefDigest` of `brief`.
   *
   * Handed out on every read because it is what an approval must hand back: a
   * caller that decided from this record can prove it decided from *this*
   * record and not from whatever the draft has since become.
   */
  digest: string
}

export interface FeatureSummary {
  id: string
  /** The latest revision's title: a retitle is a fact about the feature, not only about one revision. */
  title: string
  /** The latest revision's status, which by construction is never `superseded`. */
  status: FeatureBriefStatus
  latestRevision: number
  /** The highest approved revision — what planning may consume — or null. */
  approvedRevision: number | null
  /** Ascending. */
  revisions: number[]
  /** When the feature was first raised: revision 1's timestamp, not the latest one's. */
  createdAt: string
}

/**
 * `<id>-<slugified title>`, the way a plan directory is `<id>-<slug>`.
 *
 * The id is parsed before it is joined to anything, because this function is
 * where a model-supplied string first becomes a path. A title that slugifies to
 * nothing falls back to a word rather than leaving a trailing dash: `F001-` is
 * a name `findFeatureDir` matches and no person reading a directory listing
 * can make sense of.
 */
export function featureDirName(featureId: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, SLUG_MAX)
    .replace(/^-+|-+$/g, '')
  return `${FeatureIdSchema.parse(featureId)}-${slug.length === 0 ? 'feature' : slug}`
}

/** Zero-padded to three, so a directory listing sorts the way the revisions ran. */
export function featureRevisionFile(featureDir: string, revision: number): string {
  return path.join(featureDir, `rev-${String(RevisionSchema.parse(revision)).padStart(3, '0')}.json`)
}

/* ------------------------------------------------------------------- reads */

/** Feature directories only: a stray file named like a feature is not one. */
async function listFeatureDirs(featuresDir: string): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(featuresDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return []
  }
  // Sorted rather than left in readdir order, which no filesystem guarantees.
  // Two directories can share an id — `F001-auth` beside a hand-renamed
  // `F001-auth.old` — and while that is somebody's mistake either way, the
  // engine resolving it to a different one on different machines would turn a
  // visible mistake into an intermittent one.
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
}

export async function listFeatureIds(projectDir: string): Promise<string[]> {
  const ids = new Set<string>()
  for (const entry of await listFeatureDirs(resolveLoopPaths(projectDir).features)) {
    const id = /^(F\d{3})-/.exec(entry)?.[1]
    // Deduplicated for the reason `listPlanIds` deduplicates: two directories
    // claiming one id must not make the feature appear twice in a list.
    if (id !== undefined) ids.add(id)
  }
  return [...ids].sort()
}

/** The feature's directory, or null when the project has no such feature. */
async function locateFeatureDir(projectDir: string, featureId: string): Promise<string | null> {
  const featuresDir = resolveLoopPaths(projectDir).features
  // Parsed before a path is built from it, never after: an id is a directory
  // name here, and `../..` joined against `.mjloop/features` is a write to
  // somewhere else entirely.
  const id = FeatureIdSchema.parse(featureId)
  const match = (await listFeatureDirs(featuresDir)).find((entry) => entry.startsWith(`${id}-`))
  return match === undefined ? null : path.join(featuresDir, match)
}

/** The feature's directory. Throws when there is none, for callers that need one. */
export async function findFeatureDir(projectDir: string, featureId: string): Promise<string> {
  const dir = await locateFeatureDir(projectDir, featureId)
  if (dir === null) throw new FeatureNotFoundError(featureId, resolveLoopPaths(projectDir).features)
  return dir
}

/**
 * The revision numbers in one feature directory, ascending.
 *
 * Only canonically named regular files count, and the name is reconstructed
 * from the parsed number and compared: `rev-0001.json` beside `rev-001.json`
 * must not present itself as a second revision 1, or `max + 1` would either
 * skip a revision or hand out one that already exists.
 */
async function listRevisionsIn(featureDir: string): Promise<number[]> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(featureDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return []
  }

  const revisions: number[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const match = /^rev-(\d+)\.json$/.exec(entry.name)
    if (match?.[1] === undefined) continue
    const revision = Number(match[1])
    if (!RevisionSchema.safeParse(revision).success) continue
    if (path.basename(featureRevisionFile(featureDir, revision)) !== entry.name) continue
    revisions.push(revision)
  }
  return revisions.sort((a, b) => a - b)
}

export async function listFeatureRevisions(projectDir: string, featureId: string): Promise<number[]> {
  const dir = await locateFeatureDir(projectDir, featureId)
  return dir === null ? [] : listRevisionsIn(dir)
}

/**
 * One revision file, or null when it was never written.
 *
 * A file that exists and does not parse throws, where the profile *proposal*
 * reads as null. The asymmetry is the same one and for the same reason: a
 * proposal is regenerated by the next scan, and a brief is regenerated by
 * nothing. Reporting "there is no such revision" for a record plainly sitting
 * on disk would let planning proceed as though the interview never happened.
 */
async function readRevisionFile(file: string): Promise<FeatureBrief | null> {
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  let data: unknown
  try {
    data = JSON.parse(raw) as unknown
  } catch {
    // Handed to the schema, which refuses it with a message naming the file.
    data = undefined
  }
  const parsed = FeatureBriefSchema.safeParse(data)
  if (!parsed.success) throw new InvalidFeatureRecordError(file, z.prettifyError(parsed.error))
  return parsed.data
}

export async function readFeatureRevision(
  projectDir: string,
  featureId: string,
  revision: number,
): Promise<FeatureBriefRecord | null> {
  const dir = await locateFeatureDir(projectDir, featureId)
  if (dir === null) return null
  const file = featureRevisionFile(dir, revision)
  const brief = await readRevisionFile(file)
  if (brief === null) return null
  const latest = (await listRevisionsIn(dir)).at(-1) ?? revision
  return { brief, status: derivedStatus(brief, latest), file, digest: briefDigest(brief) }
}

/** The latest revision of a feature, or null when the project has no such feature. */
export async function readFeatureBrief(projectDir: string, featureId: string): Promise<FeatureBriefRecord | null> {
  const dir = await locateFeatureDir(projectDir, featureId)
  if (dir === null) return null
  const latest = (await listRevisionsIn(dir)).at(-1)
  if (latest === undefined) return null
  const file = featureRevisionFile(dir, latest)
  const brief = await readRevisionFile(file)
  if (brief === null) return null
  return { brief, status: brief.status, file, digest: briefDigest(brief) }
}

/**
 * `superseded`, and only ever here.
 *
 * The rule is exactly "a higher revision of this feature exists", applied to
 * the record as read rather than inferred from anything this store believes
 * about how the directory got that way — a directory restored by hand may hold
 * a combination no sequence of operations here could produce.
 */
function derivedStatus(brief: FeatureBrief, latestRevision: number): FeatureBriefStatus {
  return brief.revision < latestRevision ? 'superseded' : brief.status
}

export async function listFeatureSummaries(projectDir: string): Promise<FeatureSummary[]> {
  const summaries: FeatureSummary[] = []
  for (const id of await listFeatureIds(projectDir)) {
    const dir = await findFeatureDir(projectDir, id)
    const revisions = await listRevisionsIn(dir)
    const latestRevision = revisions.at(-1)
    if (latestRevision === undefined) continue
    const latest = await readRevisionFile(featureRevisionFile(dir, latestRevision))
    if (latest === null) continue

    // Revision 1 rather than the latest, because a list answers "when was this
    // raised" and the latest revision's timestamp answers "when did somebody
    // last change their mind" — a value that moves every time a brief is
    // superseded.
    const first = latestRevision === 1 ? latest : await readRevisionFile(featureRevisionFile(dir, revisions[0] ?? 1))

    summaries.push({
      id,
      title: latest.title,
      status: latest.status,
      latestRevision,
      approvedRevision: await highestApprovedRevision(dir, revisions),
      revisions,
      createdAt: (first ?? latest).createdAt,
    })
  }
  return summaries
}

/**
 * Walked from the top rather than assumed.
 *
 * Only the latest revision can be a draft *as this store writes them* — a
 * successor is only ever minted from an approved revision — but that is an
 * invariant of this module and not of the filesystem, so the answer is read
 * off the records rather than deduced from them. In practice the walk stops on
 * its first or second step.
 */
async function highestApprovedRevision(featureDir: string, revisions: readonly number[]): Promise<number | null> {
  for (const revision of [...revisions].reverse()) {
    const brief = await readRevisionFile(featureRevisionFile(featureDir, revision))
    if (brief?.status === 'approved') return revision
  }
  return null
}

/* ------------------------------------------------------------------ writes */

export interface CreateFeatureBriefInput {
  title: string
  problem: string
  /**
   * The policy this feature's interview actually runs under — the project
   * default, or the per-feature override that replaced it. The store does not
   * read `.mjloop/config.yaml` for it, because resolving "which of the two
   * applies" is the caller's decision and the record must say what was used
   * rather than what is configured today.
   */
  discovery: Pick<FeatureDiscovery, 'mode' | 'questionBudget'>
  acceptance?: string[]
  affectedComponents?: string[]
}

/**
 * Mint a feature and its first draft revision.
 *
 * Id allocation runs inside the lock for the reason `planCreate`'s does: two
 * overlapping creates that each scanned the directory before either wrote would
 * allocate the same id, and the loser's brief would land in the winner's
 * directory.
 */
export async function createFeatureBrief(
  projectDir: string,
  input: CreateFeatureBriefInput,
  now: Clock = () => new Date(),
): Promise<FeatureBriefRecord> {
  return locked(projectDir, async () => {
    const existing = await listFeatureIds(projectDir)
    const next = existing.length === 0 ? 1 : Math.max(...existing.map((id) => Number(id.slice(1)))) + 1
    // Past F999 this fails in `FeatureIdSchema` rather than silently naming a
    // directory `F1000-…` that no id could ever match again.
    const id = `F${String(next).padStart(3, '0')}`

    const brief = validate(path.join(resolveLoopPaths(projectDir).features, id), {
      schema: 1,
      id,
      revision: 1,
      title: input.title,
      status: 'draft',
      problem: input.problem,
      decisions: [],
      acceptance: input.acceptance ?? [],
      affectedComponents: input.affectedComponents ?? [],
      discovery: { ...input.discovery, completedAt: null },
      approval: null,
      supersedes: null,
      createdAt: now().toISOString(),
    })
    await assertKnownComponents(projectDir, brief.affectedComponents)

    // The directory is named from the *validated* title, so a title the schema
    // would refuse never gets as far as creating a directory for itself.
    const file = featureRevisionFile(path.join(resolveLoopPaths(projectDir).features, featureDirName(id, brief.title)), 1)
    await writeNewRevision(file, brief)
    return { brief, status: brief.status, file, digest: briefDigest(brief) }
  })
}

export interface FeatureDraftPatch {
  title?: string
  problem?: string
  acceptance?: string[]
  affectedComponents?: string[]
  /**
   * The policy the interview behind *this* revision ran under.
   *
   * Patchable rather than fixed at creation, because a successor inherits its
   * predecessor's `discovery` block along with the rest of its content and the
   * second interview is a different interview: it may run under a mode the
   * project has since changed to, or under an override stated for that one
   * request. Without this, every revision above the first would record the
   * policy the revision before it ran under — which is precisely the lie
   * `DiscoverySchema` exists to prevent.
   */
  discoveryMode?: FeatureDiscovery['mode']
  discoveryQuestionBudget?: number
  /** When the interview stopped asking. */
  discoveryCompletedAt?: string | null
}

/**
 * Change a draft.
 *
 * No expected-revision argument, unlike approval below, and the asymmetry is
 * deliberate: this is the interview writing down its own working notes, one
 * caller at a time, where approval is a decision made from a screen that may
 * have been open for minutes.
 *
 * A retitle does not rename the directory. The name is the id's index rather
 * than a display value, and moving it would move a record a run may already
 * have pinned — for a change that is only ever cosmetic. `readPlan` takes the
 * same position from the other direction: the directory is authoritative.
 */
export async function updateFeatureDraft(
  projectDir: string,
  featureId: string,
  patch: FeatureDraftPatch,
): Promise<FeatureBriefRecord> {
  return locked(projectDir, async () => {
    const current = await loadLatestForWrite(projectDir, featureId)
    const brief = validate(current.file, {
      ...current.brief,
      title: patch.title ?? current.brief.title,
      problem: patch.problem ?? current.brief.problem,
      acceptance: patch.acceptance ?? current.brief.acceptance,
      affectedComponents: patch.affectedComponents ?? current.brief.affectedComponents,
      discovery: {
        ...current.brief.discovery,
        mode: patch.discoveryMode ?? current.brief.discovery.mode,
        questionBudget: patch.discoveryQuestionBudget ?? current.brief.discovery.questionBudget,
        // Spelled out rather than folded into the `??` above, because null is a
        // value this field takes: reopening an interview sets it back.
        ...(patch.discoveryCompletedAt === undefined ? {} : { completedAt: patch.discoveryCompletedAt }),
      },
    })
    await assertKnownComponents(projectDir, brief.affectedComponents)
    await writeDraftRevision(current.file, brief)
    return { brief, status: brief.status, file: current.file, digest: briefDigest(brief) }
  })
}

export interface FeatureDecisionInput {
  question: string
  recommendation: string | null
  answer: string | null
}

/** Record one question and what came back. The timestamp is the engine's, not the caller's. */
export async function appendFeatureDecision(
  projectDir: string,
  featureId: string,
  decision: FeatureDecisionInput,
  now: Clock = () => new Date(),
): Promise<FeatureBriefRecord> {
  return locked(projectDir, async () => {
    const current = await loadLatestForWrite(projectDir, featureId)
    const brief = validate(current.file, {
      ...current.brief,
      decisions: [...current.brief.decisions, { ...decision, at: now().toISOString() }],
    })
    await writeDraftRevision(current.file, brief)
    return { brief, status: brief.status, file: current.file, digest: briefDigest(brief) }
  })
}

export interface ApproveFeatureBriefInput {
  id: string
  /**
   * The revision the caller believed was current.
   *
   * Required rather than optional, as `acceptProfile`'s is: an approval with no
   * expectation happily approves whatever happens to be on disk, which is
   * precisely the 800ms-stale-dashboard case `precondition.ts` exists for.
   */
  expectRevision: number
  /**
   * The `digest` of the record the caller read, which is the precondition that
   * actually holds.
   *
   * `expectRevision` alone cannot: a draft carries one revision number for the
   * whole of its editable life, so the number matches by construction right up
   * to the moment it stops mattering. See `briefDigest`. Both are required, and
   * both are checked, because they fail differently and the caller has to be
   * told which happened — the feature moved to another revision, or this
   * revision's words moved underneath it.
   */
  expectDigest: string
  /** Who approved it. Free text; the engine cannot verify it. */
  by: string
  /** The approver's own words, so the record is auditable rather than a flag. */
  note?: string | null
}

/**
 * Approve a draft, in place, as the last write that revision will ever take.
 *
 * Never record an approval nobody gave — the rule `mjloop_gate_set` states, and
 * it applies here for a stronger reason: a plan is written *from* this record,
 * so an approval invented here authorises work no person ever agreed to.
 */
export async function approveFeatureBrief(
  projectDir: string,
  input: ApproveFeatureBriefInput,
  now: Clock = () => new Date(),
): Promise<FeatureBriefRecord> {
  return locked(projectDir, async () => {
    const current = await loadLatestForWrite(projectDir, input.id, {
      revision: input.expectRevision,
      digest: input.expectDigest,
    })
    // Checked here as well as in the schema, so that the caller is told what to
    // do about it rather than handed a validation error about a record it did
    // not assemble.
    if (current.brief.acceptance.length === 0) {
      throw new AcceptanceRequiredError(current.brief.id, current.brief.revision)
    }
    // Re-checked at approval and not only at the write that recorded them,
    // because the accepted map can move in between — `mjloop-cli profile accept`
    // is the shipped way to move it — and this is the last write this revision
    // will ever take. Every other mutator gets to be permissive about a fact
    // that has gone stale, since a draft can still be corrected; sealing one
    // naming a component the project no longer has would leave `UnknownComponentError`'s
    // own reason — skill selection joins on these ids — permanently unfixable
    // in that revision. The way out is `updateFeatureDraft`, which is still open.
    await assertKnownComponents(projectDir, current.brief.affectedComponents)

    const brief = validate(current.file, {
      ...current.brief,
      status: 'approved',
      approval: { by: input.by, at: now().toISOString(), note: input.note ?? null },
    })
    await writeDraftRevision(current.file, brief)
    return { brief, status: brief.status, file: current.file, digest: briefDigest(brief) }
  })
}

export interface SupersedeFeatureBriefInput {
  id: string
  /** The approved revision being replaced. Compare-and-swap, as approval is. */
  expectRevision: number
}

/**
 * Open the next revision as a draft carrying the approved content forward.
 *
 * Revision N is not touched, read for anything other than its content, or
 * marked in any way. That is the whole point: whoever pinned it still has
 * exactly the words they pinned, and `superseded` is derived from the mere
 * existence of N+1.
 *
 * `affectedComponents` is carried forward *unchecked*, unlike at approval, and
 * that is deliberate rather than an oversight. What this produces is a draft,
 * and a draft is correctable; refusing here because the accepted map moved
 * after revision N was approved would leave the brief with no way forward at
 * all — the successor is the only place the ids can be corrected, and it could
 * not be opened. So the check lands one step later, where the record stops
 * being correctable, and `updateFeatureDraft` refuses in between.
 */
export async function supersedeFeatureBrief(
  projectDir: string,
  input: SupersedeFeatureBriefInput,
  now: Clock = () => new Date(),
): Promise<FeatureBriefRecord> {
  return locked(projectDir, async () => {
    const current = await loadLatest(projectDir, input.id)
    if (current.brief.revision !== input.expectRevision) {
      throw new StaleFeatureRevisionError(input.id, current.brief.revision, input.expectRevision)
    }
    if (current.brief.status !== 'approved') {
      throw new FeatureNotApprovedError(current.brief.id, current.brief.revision)
    }

    const revision = current.brief.revision + 1
    const file = featureRevisionFile(current.dir, revision)
    const brief = validate(file, {
      ...current.brief,
      revision,
      status: 'draft',
      approval: null,
      supersedes: { id: current.brief.id, revision: current.brief.revision },
      createdAt: now().toISOString(),
    })
    await writeNewRevision(file, brief)
    return { brief, status: brief.status, file, digest: briefDigest(brief) }
  })
}

/* ----------------------------------------------------------------- plumbing */

/**
 * `withLock` creates its lock directory with a non-recursive `mkdir`, so
 * `.mjloop/` has to exist before the lock can be taken at all. Created here for
 * the reason `acceptProfile` creates it: the writes this guards make their own
 * parents, so refusing purely because the *lock's* parent was missing would be
 * refusing over a directory the very next line would have created.
 */
async function locked<T>(projectDir: string, fn: () => Promise<T>): Promise<T> {
  const paths = resolveLoopPaths(projectDir)
  await fs.mkdir(paths.root, { recursive: true })
  return withLock(paths.lock, fn)
}

interface LocatedRevision {
  dir: string
  file: string
  brief: FeatureBrief
}

/** The latest revision of a feature, for a caller that is about to write. */
async function loadLatest(projectDir: string, featureId: string): Promise<LocatedRevision> {
  const dir = await findFeatureDir(projectDir, featureId)
  const revision = (await listRevisionsIn(dir)).at(-1)
  if (revision === undefined) throw new FeatureNotFoundError(featureId, dir)
  const file = featureRevisionFile(dir, revision)
  const brief = await readRevisionFile(file)
  if (brief === null) throw new FeatureNotFoundError(featureId, dir)
  return { dir, file, brief }
}

/** The state a caller claims to have decided from: which revision, saying what. */
interface RevisionExpectation {
  revision: number
  digest: string
}

/**
 * The latest revision, refused unless it is still a draft.
 *
 * The refusal is here rather than only in `writeDraftRevision` so that the
 * caller gets the error that names superseding *before* anything is assembled.
 * The check inside the write is the invariant; this one is the explanation.
 */
async function loadLatestForWrite(
  projectDir: string,
  featureId: string,
  expect?: RevisionExpectation,
): Promise<LocatedRevision> {
  const current = await loadLatest(projectDir, featureId)
  // Ordered ahead of the immutability check because they answer different
  // questions and only these are about the caller being out of date: an
  // expectation of revision 1 while the feature is on 2 is a stale screen,
  // where an expectation of 1 while 1 is approved is two people approving the
  // same draft and the second arriving late.
  if (expect !== undefined && current.brief.revision !== expect.revision) {
    throw new StaleFeatureRevisionError(featureId, current.brief.revision, expect.revision)
  }
  // The revision matches, so this asks the question the number cannot: is the
  // record still saying what the caller read? Ahead of the immutability check
  // as well, and the ordering has a consequence worth stating — presenting a
  // *current* digest of an approved revision is what reaches
  // `ApprovedRevisionImmutableError`, so "somebody approved this first" is only
  // ever reported to a caller that read the approved record. A caller holding
  // the older draft is told the truer thing: what it read is gone.
  if (expect !== undefined) {
    const digest = briefDigest(current.brief)
    if (digest !== expect.digest) {
      throw new StaleFeatureContentError(featureId, current.brief.revision, digest, expect.digest)
    }
  }
  if (current.brief.status === 'approved') {
    throw new ApprovedRevisionImmutableError(current.brief.id, current.brief.revision)
  }
  return current
}

function validate(file: string, candidate: unknown): FeatureBrief {
  const parsed = FeatureBriefSchema.safeParse(candidate)
  if (!parsed.success) throw new InvalidFeatureRecordError(file, z.prettifyError(parsed.error))
  return parsed.data
}

/**
 * Every id in `affectedComponents` must name a component of the accepted map.
 *
 * An empty list is legal in both directions: a feature may genuinely touch
 * nothing yet, and a project may never have been mapped at all. What is refused
 * is naming a component while no accepted map exists, because then no id is
 * knowable and the value would be a claim nothing can check — later skill
 * selection joins on exactly these ids.
 */
async function assertKnownComponents(projectDir: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  const profile = await readAcceptedProfile(projectDir)
  const known = (profile?.components ?? []).map((component) => component.id)
  const unknown = ids.filter((id) => !known.includes(id))
  if (unknown.length > 0) throw new UnknownComponentError(unknown, known)
}

/**
 * The only write in this module that may land on a file that already exists.
 *
 * It reads back what is there first and refuses if that record is approved.
 * That is the immutability invariant itself — the mutators' own checks are
 * there to produce a better message — and it is stated here so a mutator added
 * later cannot forget it. A file that exists and cannot be parsed is refused
 * too, by `readRevisionFile` throwing: this function cannot tell whether an
 * unreadable record was approved, and overwriting on that ignorance is exactly
 * the failure it exists to prevent.
 *
 * `backup: false`, as `acceptProfile` writes: a `.bak` beside an immutable
 * record is a second, mutable copy of it, and the two can then disagree about
 * what a run pinned.
 */
async function writeDraftRevision(file: string, brief: FeatureBrief): Promise<void> {
  const onDisk = await readRevisionFile(file)
  if (onDisk !== null && onDisk.status === 'approved') {
    throw new ApprovedRevisionImmutableError(onDisk.id, onDisk.revision)
  }
  await writeJsonAtomic(file, brief, { backup: false })
}

/** A revision that must not already exist: the first one, and every successor. */
async function writeNewRevision(file: string, brief: FeatureBrief): Promise<void> {
  // Belt and braces on top of `revision = latest + 1`: `listRevisionsIn` counts
  // canonically named regular files only, so a directory — or a non-canonical
  // duplicate — at that exact path is invisible to the scan and would still be
  // what the atomic rename lands on top of.
  if (await exists(file)) throw new FeatureRevisionExistsError(file)
  await writeJsonAtomic(file, brief, { backup: false })
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file)
    return true
  } catch {
    return false
  }
}

function quoted(ids: readonly string[]): string {
  return ids.map((id) => `"${id}"`).join(', ')
}
