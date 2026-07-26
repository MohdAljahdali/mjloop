import { createHash } from 'node:crypto'
import type { Finding, Result } from '../schemas/state.js'

/**
 * A deterministic identity for the work still remaining after a cycle.
 *
 * Findings are sorted before hashing: agents are dispatched concurrently, so
 * the order findings land in `state.findings` varies between otherwise
 * identical cycles, and an unsorted hash would make every cycle look new —
 * silently disabling the stagnation guard rather than loosening it.
 *
 * Evidence is absent by design. Excerpts carry durations and counts that
 * differ between runs of the same failing command, which would produce a
 * unique fingerprint every cycle. `files_touched` is absent too: including it
 * would make the guard *more* permissive, letting a loop that flails at a
 * different file each cycle escape every strike.
 */
export function cycleFingerprint(findings: Finding[], result: Result): string {
  const sorted = [...findings].sort(compareFindings)
  const payload = JSON.stringify({
    result,
    findings: sorted.map((finding) => [finding.severity, finding.file, finding.line, finding.claim]),
  })
  return createHash('sha256').update(payload).digest('hex')
}

function compareFindings(a: Finding, b: Finding): number {
  return (
    a.severity.localeCompare(b.severity) ||
    a.file.localeCompare(b.file) ||
    a.line - b.line ||
    a.claim.localeCompare(b.claim)
  )
}
