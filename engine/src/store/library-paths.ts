/**
 * The user-local data root the shared skill library lives under, and the
 * layout inside it.
 *
 * This root is deliberately *not* part of `.mjloop/` and deliberately not
 * resolved relative to any project. `.mjloop/` is per-project and travels in
 * a repository; the library is per-*machine* and shared by every project on
 * it, because the whole point of S06 is that downloading a package once
 * serves every project that later accepts it. A library nested inside a
 * project would eventually be committed by somebody, and a package two
 * projects share would then live inside one of them — exactly the
 * cross-project interference this store exists to prevent.
 *
 * One layout on every platform, on purpose. A real per-OS resolver (macOS
 * `~/Library/Application Support`, Windows `%LOCALAPPDATA%`, XDG on Linux)
 * would be three branches, and this repository's authors — and its
 * contributors — only ever run two of the three. A path nobody here can run
 * is a path nobody here can test, so it stays a single XDG-flavoured layout
 * everywhere, with `MJLOOP_DATA_HOME` as the one full override a test (or an
 * unusual host) actually needs.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/**
 * The resolved library root would land inside the project directory, or
 * inside a `.mjloop/` directory anywhere. Thrown rather than silently
 * corrected, because either collision is exactly the failure this module
 * exists to rule out: a shared, per-machine library that a project's own
 * checkout — or its `.mjloop/` state — could end up containing.
 */
export class LibraryRootCollisionError extends Error {
  constructor(root: string, projectDir: string) {
    super(
      `the resolved skill library root "${root}" is inside the project directory "${projectDir}" ` +
        'or inside a ".mjloop" directory — the library is shared across every project on this machine ' +
        'and must never live inside one project\'s checkout or its .mjloop state',
    )
    this.name = 'LibraryRootCollisionError'
  }
}

/**
 * Resolve the shared library root, in this order:
 *
 * 1. `MJLOOP_DATA_HOME`, if set and absolute — the override every test in
 *    this story uses to point at a throwaway directory, and the escape hatch
 *    for a host where `~/.local/share` is not writable.
 * 2. `XDG_DATA_HOME/mjloop`, if `XDG_DATA_HOME` is set and absolute — the
 *    standard Linux override, honoured without requiring a whole per-OS
 *    resolver.
 * 3. `~/.local/share/mjloop` — the one default this module ships, everywhere.
 *
 * `projectDir` is taken purely so the collision check below has something to
 * check against; nothing here derives the root *from* it.
 */
export function resolveLibraryRoot(projectDir: string): string {
  const root = pickRoot()

  const resolvedRoot = path.resolve(root)
  const resolvedProject = path.resolve(projectDir)

  // Compared *canonically*, never as the two strings the caller happened to
  // spell. `path.resolve` never touches the filesystem, so a symlink on either
  // side makes two spellings of one physical directory disagree — and this
  // check would then allow exactly the collision it exists to forbid. It is not
  // a contrived case: on macOS `os.tmpdir()` is `/var/folders/…`, a symlink to
  // `/private/var/folders/…`, and a checkout reached through `~/Projects ->
  // /Volumes/…` has the same two spellings.
  const canonicalRoot = canonicalize(resolvedRoot)
  const canonicalProject = canonicalize(resolvedProject)

  const insideProject =
    canonicalRoot === canonicalProject || canonicalRoot.startsWith(canonicalProject + path.sep)
  const insideDotMjloop = canonicalRoot
    .split(path.sep)
    .some((segment) => segment === '.mjloop')

  if (insideProject || insideDotMjloop) throw new LibraryRootCollisionError(resolvedRoot, resolvedProject)

  // The *resolved* root is returned, not the canonical one. Canonicalising is
  // how the collision is detected; it is not how the library is addressed —
  // handing back a path the caller never named would make every path this
  // module produces depend on which links happen to exist today.
  return resolvedRoot
}

/**
 * The physical path behind `target`, as far as it exists.
 *
 * `fs.realpathSync` refuses a path whose final segments are not on disk, and
 * the library root very often is not: the first run on a machine resolves a
 * root before anything has created it. So this walks up to the nearest
 * ancestor that does exist, canonicalises that, and re-joins the segments
 * below it — which is enough, because a segment that does not exist cannot be
 * a symlink.
 */
function canonicalize(target: string): string {
  const trailing: string[] = []
  let existing = target
  for (;;) {
    try {
      return path.join(fs.realpathSync(existing), ...trailing)
    } catch {
      const parent = path.dirname(existing)
      // Reached the filesystem root without finding anything readable — there
      // is nothing to canonicalise against, so the lexical path stands.
      if (parent === existing) return target
      trailing.unshift(path.basename(existing))
      existing = parent
    }
  }
}

function pickRoot(): string {
  const dataHome = process.env.MJLOOP_DATA_HOME
  if (dataHome !== undefined && dataHome !== '' && path.isAbsolute(dataHome)) return dataHome

  const xdgDataHome = process.env.XDG_DATA_HOME
  if (xdgDataHome !== undefined && xdgDataHome !== '' && path.isAbsolute(xdgDataHome)) {
    return path.join(xdgDataHome, 'mjloop')
  }

  return path.join(os.homedir(), '.local', 'share', 'mjloop')
}

/**
 * `<root>/packages/` — every digest directory lives directly under here.
 *
 * Deliberately the only path this module builds past the root. Joining a
 * *digest* onto a path is `skill-library-store.ts`'s job and nowhere else's,
 * because that join is exactly the step that must never happen before
 * `DigestSchema` has validated the string doing the joining — a helper here
 * that took a raw digest would be a second place that rule could be
 * forgotten.
 */
export function packagesDir(projectDir: string): string {
  return path.join(resolveLibraryRoot(projectDir), 'packages')
}
