/**
 * The read side of the transport.
 *
 * The socket pushes keys — small facts the poller already parsed. Anything with
 * a body is fetched from here, and only when the revision it rides has actually
 * moved (`feed()` below) — that gating is the whole economy of this transport,
 * because every fetch it does issue comes back in full. There is no
 * revalidation to lean on: `get()` sends no `if-none-match`, and the api
 * answers `cache-control: no-store` (`web/api.ts`), so the browser has no
 * stored response to revalidate either. The server does compute an `ETag` and
 * does honour `if-none-match` when a client sends one (`web/api.ts`'s own 304
 * branch) — this client never sends one, so no request from this file is ever
 * answered `304`. `revision.ts`'s own `plans` comment turns on this same fact;
 * the two must not drift.
 *
 * There is no subscription protocol: a panel declares which revision it depends
 * on, and the open tab *is* the subscription. Nothing to leak when a socket
 * dies, no resubscribe on reconnect, no per-view tick budget to tune.
 */
import type { Snapshot } from '../types/protocol.js'

let token = ''

export function installToken(value: string): void {
  token = value
}

/**
 * A GET against the read api. Plain, not HTTP-conditional — see this file's
 * own header: no `if-none-match` goes out, so a full body always comes back.
 *
 * Errors come back as `{ ok: false, code }` and never as a sentence: the server
 * sends `{ error: { code } }` with no parameters at all, because a `params`
 * hole is exactly how prose gets smuggled past the rule.
 */
export async function get(path: string): Promise<{ ok: true; body: any } | { ok: false; code: string }> {
  try {
    const response = await fetch(`${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`)
    // `Body.json()` types as `Promise<unknown>` under Node's fetch typings (no
    // DOM lib here) — annotated `any` because the shape genuinely is: the
    // server can send `{ error: { code } }` or the caller's own body type.
    const body: any = await response.json()
    if (response.ok) return { ok: true, body }
    const code = body?.error?.code
    return { ok: false, code: typeof code === 'string' ? code : 'error.unreadable' }
  } catch {
    // The socket's own reconnect banner already says the server went away;
    // this must not also raise into a renderer.
    return { ok: false, code: 'error.unreadable' }
  }
}

export interface Feed<T> {
  update: (snapshot: Snapshot) => void
  value: () => T | null
  error: () => string | null
}

/**
 * A document that re-fetches when the revision it depends on moves.
 *
 * The generation counter is what makes a late answer for a request nobody is
 * waiting for any more get dropped rather than drawn — the same guard the
 * `jobId` check applies to `{type:'output'}` frames.
 */
export function feed<T>(spec: {
  /** The revision this feed follows, or null when there is nothing to fetch. */
  dep: (snapshot: Snapshot) => string | null
  path: (snapshot: Snapshot) => string
  /** Called when `value()` or `error()` moved. */
  onChange: () => void
}): Feed<T> {
  let seen: string | null = null
  let started = false
  let generation = 0
  let held: T | null = null
  let failure: string | null = null

  return {
    update(snapshot) {
      const next = spec.dep(snapshot)
      if (next === null) {
        if (held !== null || failure !== null) {
          held = null
          failure = null
          spec.onChange()
        }
        seen = null
        started = false
        return
      }
      if (started && next === seen) return
      seen = next
      started = true

      const mine = ++generation
      void get(spec.path(snapshot)).then((result) => {
        if (mine !== generation) return
        if (result.ok) {
          held = result.body as T
          failure = null
        } else {
          failure = result.code
        }
        spec.onChange()
      })
    },
    value: () => held,
    error: () => failure,
  }
}
