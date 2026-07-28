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

  /* the read api — a diagnosis goes to the terminal the server was launched
     from, never onto the wire. There is no `params` on any of these, because a
     `params` hole is exactly how a sentence gets smuggled past the rule. */
  'error.notFound',
  'error.unreadable',
  'error.badRequest',
] as const

export type WebCode = (typeof WEB_CODES)[number]

/** A code with no parameters, which is every error this server can report. */
export interface ErrorBody {
  error: { code: WebCode }
}
