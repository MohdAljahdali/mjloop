/**
 * The read side of the transport.
 *
 * The socket pushes keys — small facts the poller already parsed. Anything with
 * a body is fetched from here, conditionally, and the `ETag` turns almost every
 * one of those into a 304 with an empty body over a loopback socket.
 *
 * There is no subscription protocol: a panel declares which revision it depends
 * on, and the open tab *is* the subscription. Nothing to leak when a socket
 * dies, no resubscribe on reconnect, no per-view tick budget to tune.
 */

/** @type {string} */
let token = ''

/**
 * @param {string} value
 */
export function installToken(value) {
  token = value
}

/**
 * A conditional GET against the read api.
 *
 * Errors come back as `{ ok: false, code }` and never as a sentence: the server
 * sends `{ error: { code } }` with no parameters at all, because a `params`
 * hole is exactly how prose gets smuggled past the rule.
 *
 * @param {string} path
 * @returns {Promise<{ ok: true, body: any } | { ok: false, code: string }>}
 */
export async function get(path) {
  try {
    const response = await fetch(`${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`)
    const body = await response.json()
    if (response.ok) return { ok: true, body }
    const code = body?.error?.code
    return { ok: false, code: typeof code === 'string' ? code : 'error.unreadable' }
  } catch {
    // The socket's own reconnect banner already says the server went away;
    // this must not also raise into a renderer.
    return { ok: false, code: 'error.unreadable' }
  }
}

/**
 * @template T
 * @typedef {object} Feed
 * @property {(snapshot: import('../../protocol.js').Snapshot) => void} update
 * @property {() => T | null} value
 * @property {() => string | null} error
 */

/**
 * A document that re-fetches when the revision it depends on moves.
 *
 * The generation counter is what makes a late answer for a request nobody is
 * waiting for any more get dropped rather than drawn — the same guard the
 * `jobId` check applies to `{type:'output'}` frames.
 *
 * @template T
 * @param {object} spec
 * @param {(snapshot: import('../../protocol.js').Snapshot) => string | null} spec.dep
 *   The revision this feed follows, or null when there is nothing to fetch.
 * @param {(snapshot: import('../../protocol.js').Snapshot) => string} spec.path
 * @param {() => void} spec.onChange Called when `value()` or `error()` moved.
 * @returns {Feed<T>}
 */
export function feed(spec) {
  /** @type {string | null} */
  let seen = null
  let started = false
  let generation = 0
  /** @type {T | null} */
  let held = null
  /** @type {string | null} */
  let failure = null

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
          held = /** @type {T} */ (result.body)
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
