/**
 * The shared, user-local skill library: one content-addressed directory per
 * package digest, under `resolveLibraryRoot` and never under any project.
 *
 * Everything in this module is careful about two things and nothing else:
 *
 *   - No digest is ever joined into a path before `DigestSchema` has
 *     validated it. A 64-character lower-case hex string cannot contain a
 *     path separator or a `.`, which is what makes that check the entire
 *     traversal guard — the same argument `schemas/state.ts` makes for
 *     `IdSchema` applies here verbatim, one level down, for digests.
 *   - This module never reads a byte out of a package's `content/` in order
 *     to *run* it. Listing, reading, and writing the record are filesystem
 *     operations on a directory the module happens to also own; executing
 *     anything found inside `content/` is S07's sandboxed problem, and it
 *     stays that way by this module simply never opening that door.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import * as z from 'zod'
import { DigestSchema, SkillPackageSchema, type SkillPackage } from '../schemas/skill-library.js'
import { packagesDir } from './library-paths.js'
import { writeJsonAtomic } from './atomic.js'

export class InvalidSkillPackageError extends Error {
  constructor(file: string, detail: string) {
    super(`${file} is not a valid skill package:\n${detail}`)
    this.name = 'InvalidSkillPackageError'
  }
}

/** A digest string that is not 64 lower-case hex characters — never joined into a path. */
export class InvalidDigestError extends Error {
  constructor(digest: string) {
    super(`"${digest}" is not a valid package digest — a digest is 64 lower-case hex characters`)
    this.name = 'InvalidDigestError'
  }
}

/**
 * `writePackage` was handed content containing a symlink.
 *
 * Refused rather than copied, for two independent reasons. A link pointing
 * outside the staged content would make the library serve a file outside its
 * own root — the package's bytes would not be the package's bytes. And an
 * ordinary *intra*-package relative link does not survive the copy either:
 * `fs.cp` re-resolves relative links against the source, so the stored link
 * would point into a staging directory the importer deletes moments later,
 * leaving a digest directory that no longer contains the content it is named
 * after. Content-addressing rests on that directory being self-contained, so
 * neither case may be stored.
 */
export class InvalidPackageContentError extends Error {
  constructor(entry: string) {
    super(
      `package content contains a symlink at "${entry}" — a package directory must be self-contained bytes, ` +
        'because its digest names its content and a link names something outside it',
    )
    this.name = 'InvalidPackageContentError'
  }
}

/** `writePackage` was asked to write a digest directory that already exists. */
export class PackageAlreadyExistsError extends Error {
  constructor(digest: string) {
    super(
      `a package already exists at digest "${digest}" — content-addressing means identical digests are identical ` +
        'bytes, so a second write of the same digest is either a no-op that need not happen or a corruption that ' +
        'must be noticed, and refusing is how the second case gets noticed',
    )
    this.name = 'PackageAlreadyExistsError'
  }
}

/** `removePackage` was asked to delete a package a project acceptance still references. */
export class PackageInUseError extends Error {
  constructor(digest: string, skillIds: string[]) {
    super(
      `package "${digest}" is still referenced by this project's acceptance(s) ${skillIds.map((id) => `"${id}"`).join(', ')} ` +
        '— deleting a package another acceptance pins is exactly the cross-project interference this library ' +
        'exists to prevent, and removing the acceptance first is what makes deleting the package safe',
    )
    this.name = 'PackageInUseError'
  }
}

/** Parse and validate a digest before it is ever joined into a path. Throws `InvalidDigestError` otherwise. */
function validateDigest(digest: string): string {
  const parsed = DigestSchema.safeParse(digest)
  if (!parsed.success) throw new InvalidDigestError(digest)
  return parsed.data
}

function packageDirFor(projectDir: string, digest: string): string {
  return path.join(packagesDir(projectDir), validateDigest(digest))
}

function packageRecordFileFor(projectDir: string, digest: string): string {
  return path.join(packageDirFor(projectDir, digest), 'package.json')
}

/** A digest directory this walk could not turn into a record, and why. */
export interface UnreadablePackage {
  digest: string
  reason: string
}

export interface SkillLibraryListing {
  /** Every package on record in this machine's library, by ascending digest. */
  packages: SkillPackage[]
  /**
   * The entries this walk skipped, reported rather than dropped.
   *
   * A caller must be able to say "one entry is unreadable" without being
   * unable to say anything at all.
   */
  unreadable: UnreadablePackage[]
}

/**
 * Every package on record in this machine's library, ascending. Only
 * canonically-shaped directory names count.
 *
 * A single unreadable entry does **not** fail this walk, unlike `readPackage`,
 * which is asked about one digest an acceptance names and must not answer
 * "absent" for it. The library is machine-*wide*: the corrupt entry here can
 * belong to a project this one has never heard of, and letting it abort the
 * walk would make one project's damaged import take out every other project's
 * `skills list`. Skipping non-digest names and record-less directories is
 * already this function's policy; an entry whose record does not parse is the
 * same kind of thing, and it is collected in `unreadable` so nothing is lost.
 */
export async function listPackages(projectDir: string): Promise<SkillLibraryListing> {
  let entries: string[]
  try {
    entries = await fs.readdir(packagesDir(projectDir))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // No library has been created on this machine yet — the state every
    // machine starts in, and not an error.
    return { packages: [], unreadable: [] }
  }

  const packages: SkillPackage[] = []
  const unreadable: UnreadablePackage[] = []
  for (const entry of entries.sort()) {
    if (!DigestSchema.safeParse(entry).success) continue
    try {
      const record = await readPackage(projectDir, entry)
      if (record !== null) packages.push(record)
    } catch (error) {
      unreadable.push({ digest: entry, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { packages, unreadable }
}

/**
 * One package record, or `null` when no directory exists at that digest.
 *
 * A record that exists but fails to parse throws rather than reading as
 * `null`, unlike the disposable proposal in `project-profile-store.ts` — a
 * package record is immutable and load-bearing: an acceptance elsewhere
 * references it by digest, and silently treating a corrupt record as
 * "absent" would make that acceptance's join to library content resolve to
 * nothing without ever saying why.
 */
export async function readPackage(projectDir: string, digest: string): Promise<SkillPackage | null> {
  const file = packageRecordFileFor(projectDir, digest)
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (error) {
    // ENOTDIR alongside ENOENT: a plain file sitting where a digest directory
    // belongs is an absence of a package record just as much as nothing at all
    // is, and it must read as one rather than escaping as a raw errno error
    // that no caller in this codebase is written to interpret.
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw error
  }
  const parsed = SkillPackageSchema.safeParse(parseJson(raw))
  if (!parsed.success) throw new InvalidSkillPackageError(file, z.prettifyError(parsed.error))
  return parsed.data
}

/**
 * Write a new package's record and content directory.
 *
 * Refuses when the digest directory already exists (`PackageAlreadyExistsError`)
 * — content-addressing means the only two possibilities for a repeat write of
 * one digest are "identical content, nothing to do" and "a corrupt or
 * mismatched write", and this module cannot tell those apart from the
 * outside, so it refuses either way rather than guessing.
 *
 * `record.digest` is where this call lands — the digest *is* the directory
 * name — so a record built with a different digest than intended still
 * writes to the directory its own field names, which is the one thing this
 * function trusts the caller to have gotten right; the schema parse below
 * only checks that the field is a well-shaped digest, not that it is *the*
 * digest the caller meant.
 *
 * `contentDir` is copied in as the package's `content/` — fetching those
 * files onto disk in the first place is S07's job (discovery/import), not
 * this module's; this module only ever receives a directory that already
 * exists and places it where the library expects package content to live.
 *
 * Takes `projectDir` first, ahead of `record`, to match every other function
 * in this module — `resolveLibraryRoot` needs it to perform its collision
 * check, so every path-touching function here resolves against a project
 * directory rather than a bare digest.
 */
export async function writePackage(projectDir: string, record: SkillPackage, contentDir: string): Promise<void> {
  const parsed = SkillPackageSchema.parse(record)
  const digest = validateDigest(parsed.digest)
  const dir = packageDirFor(projectDir, digest)

  if (await exists(dir)) throw new PackageAlreadyExistsError(digest)

  // Checked before anything is created, so a refusal leaves no half-written
  // digest directory for `PackageAlreadyExistsError` to trip over on the retry.
  await assertNoSymlinks(contentDir)

  await fs.mkdir(dir, { recursive: true })
  // `verbatimSymlinks: true` even though the walk above just refused every
  // symlink: without it `fs.cp` rewrites a relative link against the *source*
  // directory, so should a link appear between that check and this copy, the
  // stored tree would hold an absolute path into the caller's staging
  // directory rather than anything self-contained.
  await fs.cp(contentDir, path.join(dir, 'content'), { recursive: true, verbatimSymlinks: true })
  // `backup: false`: a `.bak` beside an immutable, content-addressed record
  // is a second, mutable copy of it, and nothing here ever writes to this
  // digest again to make that backup meaningful.
  await writeJsonAtomic(path.join(dir, 'package.json'), parsed, { backup: false })
}

/**
 * Remove a package from the library.
 *
 * Refuses (`PackageInUseError`) while `referencingSkillIds` — the ids of
 * this *project's* acceptances that reference this digest — is non-empty.
 * The engine can only see the current project's acceptances, so this guard
 * protects the common case (this project still wants it) honestly, and
 * makes no claim about acceptances recorded by other projects on other
 * machines: cross-project protection there rests on the fact that no
 * project ever deletes a package it does not itself reference, not on this
 * function being able to see everyone else's records.
 */
export async function removePackage(projectDir: string, digest: string, referencingSkillIds: string[]): Promise<void> {
  const validated = validateDigest(digest)
  if (referencingSkillIds.length > 0) throw new PackageInUseError(validated, referencingSkillIds)
  const dir = packageDirFor(projectDir, validated)
  await fs.rm(dir, { recursive: true, force: true })
}

/**
 * Refuse staged content containing a symlink anywhere, the directory itself
 * included.
 *
 * `lstat`, never `stat`: the whole point is to see the link rather than what
 * it points at. This walk reads directory entries and link *types* only — it
 * opens no file and follows no link, so nothing here can be made to read a
 * byte the package should not have handed over.
 */
async function assertNoSymlinks(contentDir: string, relative = ''): Promise<void> {
  const stats = await fs.lstat(contentDir)
  if (stats.isSymbolicLink()) throw new InvalidPackageContentError(relative === '' ? contentDir : relative)
  if (!stats.isDirectory()) return

  for (const entry of await fs.readdir(contentDir, { withFileTypes: true })) {
    const child = path.join(relative, entry.name)
    if (entry.isSymbolicLink()) throw new InvalidPackageContentError(child)
    if (entry.isDirectory()) await assertNoSymlinks(path.join(contentDir, entry.name), child)
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
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
