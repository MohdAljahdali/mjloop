/**
 * `.mjloop/profile/` — the project's component map.
 *
 * Two kinds of record with deliberately different lifetimes:
 *
 *   - `proposed.json` is mutable and disposable. Every scan overwrites it, and
 *     nothing routes off it. It is a suggestion waiting to be read.
 *   - `accepted/rev-001.json`, `rev-002.json`, … are immutable. Accepting a
 *     component map activates routing for every later run, so a revision a run
 *     may have pinned must never move under it.
 *
 * **There is no mutable "current" pointer, and that absence is the whole
 * rollback model.** The accepted profile is whichever revision file is highest.
 * Reselecting an earlier component map means accepting its components as a
 * *new* revision that records what it `supersedes` — so history only ever grows
 * and every earlier revision still says exactly what it always said. A
 * `current.json` would be a second place the answer lives, and the two can then
 * disagree about what a run was routed by.
 */
import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import * as z from 'zod'
import {
  ProjectProfileSchema,
  ProposedProfileSchema,
  type ProjectComponent,
  type ProjectProfile,
  type ProposedProfile,
} from '../schemas/project-profile.js'
import { writeJsonAtomic } from './atomic.js'
import { withLock } from './lock.js'
import { resolveLoopPaths } from './paths.js'
import { StalePreconditionError } from './precondition.js'
import type { Clock } from './state-store.js'

export class InvalidProfileRecordError extends Error {
  constructor(file: string, detail: string) {
    super(`${file} is not a valid project profile:\n${detail}`)
    this.name = 'InvalidProfileRecordError'
  }
}

/** A revision file already sits where the next revision would land. */
export class ProfileRevisionExistsError extends Error {
  constructor(file: string) {
    super(`${file} already exists — an accepted profile revision is never rewritten`)
    this.name = 'ProfileRevisionExistsError'
  }
}

/**
 * An acceptance refused because the revision moved under the caller.
 *
 * A subclass of `StalePreconditionError` rather than a fourth
 * `PreconditionSubject`, and the reason is a boundary rather than a taste:
 * `PreconditionSubject` is the key type of the subject-to-code map in
 * `web/writes.ts`, so widening it obliges the browser write path to name a
 * `write.stale.profile` code — and accepting a component map is precisely the
 * class of write that path permanently denies. The base subject it passes up is
 * never read for this error for that same reason: nothing reachable from the
 * browser can produce one.
 *
 * Everything that already catches `StalePreconditionError` catches this
 * unchanged, which is the part of the contract that matters.
 */
export class StaleProfileRevisionError extends StalePreconditionError {
  constructor(
    readonly actualRevision: number | null,
    readonly expectedRevision: number | null,
  ) {
    super('run', 'profile revision', actualRevision === null ? null : String(actualRevision))
    this.name = 'StaleProfileRevisionError'
    this.message =
      `the accepted profile revision has moved on — this acceptance was built on ` +
      `${expectedRevision === null ? 'no revision at all' : `revision ${expectedRevision}`}, ` +
      `and the project is now on ${actualRevision === null ? 'no revision at all' : `revision ${actualRevision}`}`
  }
}

/**
 * A revision number reaches the filesystem — it *is* the filename — so it goes
 * through a schema rather than an ad-hoc check, exactly as `IdSchema` guards
 * every id that names a directory. `NaN` and `1.5` would otherwise produce
 * `rev-NaN.json` and `rev-1.5.json`: files nothing can ever read back.
 */
const RevisionSchema = z.number().int().positive()

export function proposedProfileFile(projectDir: string): string {
  return path.join(resolveLoopPaths(projectDir).profile, 'proposed.json')
}

function acceptedDir(projectDir: string): string {
  return path.join(resolveLoopPaths(projectDir).profile, 'accepted')
}

/** Zero-padded to three, so a directory listing sorts the way the revisions ran. */
function revisionFileName(revision: number): string {
  return `rev-${String(revision).padStart(3, '0')}.json`
}

export function acceptedRevisionFile(projectDir: string, revision: number): string {
  return path.join(acceptedDir(projectDir), revisionFileName(RevisionSchema.parse(revision)))
}

/* ---------------------------------------------------------------- proposal */

/**
 * The current proposal, or null when there is none.
 *
 * A file that exists but no longer parses reads as null rather than throwing,
 * because a proposal is disposable by construction: the next scan rewrites it,
 * and every reader of it is a surface that offers to run one. Failing the
 * dashboard and `mjloop init` over a file the engine can always regenerate
 * would be strictness with nothing on the other side of it. An *accepted*
 * revision is the opposite case and is handled the opposite way below.
 */
export async function readProposedProfile(projectDir: string): Promise<ProposedProfile | null> {
  const file = proposedProfileFile(projectDir)
  for (const candidate of [file, `${file}.bak`]) {
    let raw: string
    try {
      raw = await fs.readFile(candidate, 'utf8')
    } catch {
      continue
    }
    const parsed = ProposedProfileSchema.safeParse(parseJson(raw))
    if (parsed.success) return parsed.data
  }
  return null
}

/**
 * Overwrite the proposal.
 *
 * No lock: this is a whole-document replacement, not a read-modify-write, and
 * `writeJsonAtomic` already makes the landing indivisible. Two scans racing
 * each other produce the same bytes anyway — that is what the schema's
 * sortedness rule is for.
 */
export async function writeProposedProfile(projectDir: string, proposed: ProposedProfile): Promise<void> {
  const file = proposedProfileFile(projectDir)
  // Validated before it lands rather than trusted from the caller, so a bad
  // proposal is a rejected call instead of a file every later reader silently
  // treats as absent.
  const parsed = ProposedProfileSchema.safeParse(proposed)
  if (!parsed.success) throw new InvalidProfileRecordError(file, z.prettifyError(parsed.error))
  await writeJsonAtomic(file, parsed.data)
}

/* ------------------------------------------------------- accepted revisions */

/**
 * The revision numbers on record, ascending.
 *
 * Only canonically named regular files count. The name is reconstructed from
 * the parsed number and compared, so `rev-0001.json` beside `rev-001.json`
 * cannot present itself as a second revision 1 — two entries claiming one
 * number would make `max + 1` skip a revision or, worse, reuse one.
 */
export async function listAcceptedRevisions(projectDir: string): Promise<number[]> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(acceptedDir(projectDir), { withFileTypes: true })
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
    if (revisionFileName(revision) !== entry.name) continue
    revisions.push(revision)
  }
  return revisions.sort((a, b) => a - b)
}

/**
 * One revision, or null when it was never written.
 *
 * A record that exists and does not parse throws, where the proposal returns
 * null. The asymmetry is the point: this record is immutable and load-bearing,
 * nothing regenerates it, and answering "there is no accepted profile" for a
 * profile that plainly exists would route every later run as though the project
 * had never been mapped — silently, and with the evidence sitting on disk.
 */
export async function readAcceptedRevision(projectDir: string, revision: number): Promise<ProjectProfile | null> {
  const file = acceptedRevisionFile(projectDir, revision)
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const parsed = ProjectProfileSchema.safeParse(parseJson(raw))
  if (!parsed.success) throw new InvalidProfileRecordError(file, z.prettifyError(parsed.error))
  return parsed.data
}

/** The accepted profile: the highest revision on record, or null. */
export async function readAcceptedProfile(projectDir: string): Promise<ProjectProfile | null> {
  const revisions = await listAcceptedRevisions(projectDir)
  const highest = revisions.at(-1)
  if (highest === undefined) return null
  return readAcceptedRevision(projectDir, highest)
}

export interface AcceptProfileInput {
  components: ProjectComponent[]
  /** Who accepted it. Free text; the engine cannot verify it. */
  by: string
  /** When the scan behind these components ran, carried over from the proposal. */
  generatedAt: string
  /**
   * The revision the caller believed was current, `null` when there is none.
   *
   * Required rather than optional, unlike every other precondition in this
   * codebase. Those guard an update to a record the caller just read; this
   * guards an *append*, where a caller with no expectation would happily stack
   * a second acceptance on top of one it never saw — two people accepting two
   * different component maps from two stale screens, and the second silently
   * winning.
   */
  expectRevision: number | null
}

/**
 * Accept a component map as the next immutable revision.
 *
 * Under the state lock and compare-and-swap on `expectRevision`, both for the
 * reason `precondition.ts` states: the lock serialises writers, and the
 * expectation catches the one thing a lock cannot see — a lost update across
 * two separately-locked writes. Everything that can refuse runs before anything
 * is written, so a refusal leaves the tree byte-identical.
 */
export async function acceptProfile(
  projectDir: string,
  input: AcceptProfileInput,
  now: Clock = () => new Date(),
): Promise<ProjectProfile> {
  const paths = resolveLoopPaths(projectDir)
  // `withLock` creates its lock directory non-recursively, so `.mjloop/` has to
  // be there before the lock can be taken at all. Created here rather than
  // demanded of the caller, because the alternative is an arbitrary asymmetry:
  // `writeProposedProfile` lands on a project with no `.mjloop/` quite happily
  // — `writeJsonAtomic` makes its own parents — so an acceptance refused purely
  // because the *lock's* parent was missing would be refusing over a directory
  // the write it guards would have created a line later.
  await fs.mkdir(paths.root, { recursive: true })

  return withLock(paths.lock, async () => {
    const revisions = await listAcceptedRevisions(projectDir)
    const current = revisions.at(-1) ?? null
    // Inside the lock and before anything is written, for the reason
    // `precondition.ts` states: a precondition that threw after writing would
    // be worse than none at all.
    if (current !== input.expectRevision) throw new StaleProfileRevisionError(current, input.expectRevision)

    const next = (current ?? 0) + 1
    const file = acceptedRevisionFile(projectDir, next)
    // Belt and braces on top of `next = max + 1`: `listAcceptedRevisions`
    // counts canonically named regular files only, so a directory — or a
    // non-canonical duplicate — at that exact path is invisible to the scan and
    // would still be the thing the atomic rename lands on top of.
    if (await exists(file)) throw new ProfileRevisionExistsError(file)

    const parsed = ProjectProfileSchema.safeParse({
      schema: 1,
      revision: next,
      generatedAt: input.generatedAt,
      acceptedAt: now().toISOString(),
      acceptedBy: input.by,
      components: input.components,
      supersedes: current,
    })
    if (!parsed.success) throw new InvalidProfileRecordError(file, z.prettifyError(parsed.error))

    // `backup: false`. A `.bak` beside an immutable record is a second, mutable
    // copy of it, and the two can then disagree about what a run pinned — the
    // one thing this whole numbered-revision layout exists to make impossible.
    await writeJsonAtomic(file, parsed.data, { backup: false })
    return parsed.data
  })
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    // Handed to a schema, which rejects it with a message naming the file.
    return undefined
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file)
    return true
  } catch {
    return false
  }
}
