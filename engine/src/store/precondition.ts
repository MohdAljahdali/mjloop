/**
 * Conditional writes.
 *
 * A caller that decided on a value it read some time ago must be able to say so
 * and be **refused** rather than obeyed if the value has since moved. That is
 * what makes an 800ms-stale dashboard trustworthy: a stale click cannot clobber
 * a decision the leader made in between.
 *
 * `.mjloop/.lock` already serialises writers. This catches the one thing a lock
 * cannot see — a lost update across two separately-locked writes — so every
 * check below is evaluated *inside* the lock the op already takes, leaving no
 * read-then-write window anywhere above it.
 */
export type PreconditionSubject = 'plan' | 'story' | 'run'

export class StalePreconditionError extends Error {
  constructor(
    readonly subject: PreconditionSubject,
    readonly id: string,
    /** What was actually on record when the write was attempted. */
    readonly actual: string | null,
  ) {
    super(`${subject} ${id} has moved on — it is now ${actual ?? 'unset'}`)
    this.name = 'StalePreconditionError'
  }
}

/**
 * Refuse unless what is on record matches what the caller expected.
 *
 * Callers pass `undefined` to opt out entirely, which is what every existing
 * call site does — the expectation is a trailing option, never a field inside
 * the patch, so nothing that already works has to change.
 *
 * A precondition that threw *after* writing would be worse than none, so this
 * belongs beside the guards an op already runs and before anything it writes.
 * A test asserts the tree is byte-identical after every refusal.
 */
export function expect<T>(
  subject: PreconditionSubject,
  id: string,
  actual: T,
  expected: T | undefined,
): void {
  if (expected === undefined) return
  if (actual === expected) return
  throw new StalePreconditionError(subject, id, actual === null || actual === undefined ? null : String(actual))
}
