import { createHash } from 'node:crypto'
import path from 'node:path'
import type { Evidence } from '../schemas/contract.js'
import type { Finding, Result } from '../schemas/state.js'

/** `(severity, file, claim)` — what makes one piece of remaining work itself. */
type FindingIdentity = [Finding['severity'], string, string]

/**
 * A deterministic identity for the work still remaining after a cycle.
 *
 * The guard answers one question — is this the same work as last cycle? — so
 * everything that varies between cycles without the work changing is left out.
 * Every omission below is a case where keeping the field would silently
 * disable the guard rather than loosen it:
 *
 * - **Arrival order.** Agents are dispatched concurrently, so the order
 *   findings land in `state.findings` varies between otherwise identical
 *   cycles. Identities are sorted.
 * - **Duplicates.** One defect reported by two agents must hash the same as
 *   the same defect reported by one, or adding `critic` to a stuck cycle —
 *   exactly what a leader does when a cycle stalls — would reset the counter
 *   it should be driving. Identities are deduplicated.
 * - **`line`.** The builder writes to the file its findings point at, so a
 *   defect that survives a cycle usually shifts a line or two. Hashing the
 *   line would let a flailing loop escape every strike and halt on the cycle
 *   cap instead, telling the operator "out of budget" about a run that was
 *   stuck from cycle 1. The cost is that two distinct defects sharing a
 *   severity, a file and a claim collapse into one; a claim specific enough to
 *   be a finding rarely repeats verbatim within a file.
 * - **`./` and separator noise in `file`.** `./src/a.ts` and `src/a.ts` are one
 *   file, and an agent is free to write either.
 * - **Evidence.** Excerpts carry durations and counts that differ between runs
 *   of the same failing command.
 *
 * `files_touched` is absent for the opposite reason: including it would make
 * the guard *more* permissive, letting a loop that flails at a different file
 * each cycle escape every strike.
 */
export function cycleFingerprint(findings: Finding[], result: Result): string {
  const sorted = findings.map(identify).sort(compareIdentities)
  const distinct = sorted.filter((identity, index) => {
    const previous = sorted[index - 1]
    return previous === undefined || compareIdentities(identity, previous) !== 0
  })
  const payload = JSON.stringify({ result, findings: distinct })
  return createHash('sha256').update(payload).digest('hex')
}

function identify(finding: Finding): FindingIdentity {
  return [finding.severity, normaliseFile(finding.file), finding.claim]
}

/**
 * `./src/a.ts` and `src\a.ts` both become `src/a.ts`. An absolute path is left
 * as it is: without the project root there is nothing to make it relative to.
 */
function normaliseFile(file: string): string {
  return path.posix.normalize(file.replaceAll('\\', '/'))
}

function compareIdentities(a: FindingIdentity, b: FindingIdentity): number {
  return a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2])
}

/**
 * Normalised identities for the failures a result reports.
 *
 * Milestone 2 established that raw excerpts cannot be hashed — they carry
 * durations and counts that differ between runs of the same failing command,
 * so hashing them makes every cycle look new and silently disables the guard.
 * These are normalised first: the headline only, with digit runs collapsed, so
 * `1 failing` and `2 failing` are one failure recurring rather than two.
 *
 * Only a `fail` produces signatures. A `blocked` result says the agent could
 * not run the check at all — a missing command, no network, a container that
 * was never started — which is a different state of the world, not a
 * verification failure that recurred. `cycleFingerprint` already keeps the two
 * apart, and a guard whose reason reads "the same verification failure
 * recurred" must not fire on a cycle where nothing was verified.
 */
export function errorSignature(evidence: Evidence[], result: Result): string[] {
  if (result !== 'fail') return []
  const signatures = evidence
    .filter((entry) => entry.kind === 'command' || entry.kind === 'test')
    .map((entry) => `${entry.ref} :: ${headline(entry.excerpt)}`)
  return [...new Set(signatures)].sort()
}

export function errorFingerprint(signatures: string[]): string {
  return createHash('sha256').update(JSON.stringify([...signatures].sort())).digest('hex')
}

/** The first line, with digit runs collapsed. Error output leads with the headline. */
function headline(excerpt: string): string {
  return (excerpt.split('\n')[0] ?? '').trim().replace(/\d+/g, 'N')
}
