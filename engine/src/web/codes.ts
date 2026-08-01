/**
 * Every message code the server can send, as a closed union.
 *
 * The server emits `{ code, params }` and never prose — that is what makes a
 * fifteenth language one JSON file instead of an audit of this directory. The
 * discipline only holds if a new code cannot be invented at a call site: with
 * `WebCode` closed, an untranslated code is a compile error rather than a raw
 * identifier on somebody's screen.
 *
 * `locales.test.ts` imports `WEB_CODES` and asserts every entry has an
 * `en.json` key, which is the other half of the same guarantee.
 */
export const WEB_CODES = [
  /* the queue */
  'job.failed.exit',
  'job.failed.early',
  'job.abandoned',
  'job.cancelled.stopped',
  'job.cancelled.cleared',
  'queue.blocked',
  /* A failure with nothing left behind it. The queue is not holding anything —
     saying that it is would be a lie the user then goes looking for. */
  'queue.failed',

  /* the read api — a diagnosis goes to the terminal the server was launched
     from, never onto the wire. There is no `params` on any of these, because a
     `params` hole is exactly how a sentence gets smuggled past the rule. */
  'error.notFound',
  'error.unreadable',
  'error.badRequest',

  /* the guarded writes. A refusal names what moved, and nothing else — the codes
     carry no parameters, so there is no hole for a sentence to arrive in. */
  'write.stale.plan',
  'write.stale.story',
  'write.stale.run',
  /* One code for both ways an approval can arrive too late — the revision moved,
     or somebody else approved the very draft on screen. The store separates them
     because it has to name the way forward; the page only has to say that the
     screen is out of date and nothing was changed. */
  'write.stale.feature',
  'write.stale.config',
  'write.invalid.config',
  'write.failed',
  'write.ok.gate',
  'write.ok.story',
  'write.ok.halt',
  'write.ok.config',
  'write.ok.feature',

  /* the roster's own rules. `ops/roster.ts`'s `rosterViolations` returns seven
     of these — everything a candidate composition can get wrong about a track
     — and `cycleRosterSet` adds the eighth, `roster.cycle`, for the one thing
     that is not a fact about the composition: whether it arrived for the
     cycle a run is actually on. `readRosterValidity` (`web/read.ts`) is the
     only one of the two that can put any of these on the wire — `rosterSet`
     itself stays refused to the browser (`web/writes.ts`,
     `tests/web/boundary.test.ts`'s `FORBIDDEN` list) — but the MCP caller's
     thrown message is built from the same seven-or-eight plus `params`, so a
     code and its English cannot drift apart. */
  'roster.cycle',
  'roster.required',
  'roster.forced',
  'roster.forbidden',
  'roster.closing',
  'roster.unknown',
  'roster.contradiction',
  'roster.unexplained',
] as const

export type WebCode = (typeof WEB_CODES)[number]

/** A code with no parameters, which is every error this server can report. */
export interface ErrorBody {
  error: { code: WebCode }
}
