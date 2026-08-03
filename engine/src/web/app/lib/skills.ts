/**
 * The pure derivations `panels/skills.js` carried: how much of a digest is
 * worth showing, and the client-side join between an acceptance and the
 * library package it names.
 *
 * Both ported unchanged. `joinAcceptances`'s null case is the point: an
 * acceptance stores a digest and never a path, so that a project's record
 * survives being cloned onto another machine — and the cost of that is
 * precisely the case this function has to represent, a repository naming a
 * package the library on *this* machine has never imported.
 */
import type { ProjectSkillAcceptance, SkillPackage, SkillsView } from '../types/protocol.js'

/** Enough of a digest to recognise, and not so much that it wraps a column. */
const DIGEST_SHOWN = 12

export function shortDigest(digest: string): string {
  return digest.slice(0, DIGEST_SHOWN)
}

export function joinAcceptances(
  view: SkillsView | null,
): { acceptance: ProjectSkillAcceptance; pkg: SkillPackage | null }[] {
  if (view === null) return []
  const byDigest = new Map(view.packages.map((pkg) => [pkg.digest, pkg]))
  return view.acceptances.map((acceptance) => ({
    acceptance,
    pkg: byDigest.get(acceptance.digest) ?? null,
  }))
}
