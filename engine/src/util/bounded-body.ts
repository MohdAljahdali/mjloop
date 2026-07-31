/**
 * Reading a response body under a hard byte cap — the one mechanism every
 * fetch in the skill discovery/import pipeline shares.
 *
 * Measuring `await response.text()` afterwards bounds what is *accepted*, not
 * what is *read*: by the time that check runs the whole hostile body is
 * already in memory, and past ~512 MB the process dies on V8's string-length
 * limit before the cap line executes at all. Rule 5 — "an unbounded fetch is a
 * denial of service against the user's own machine" — is only satisfied by
 * stopping the read, which is what this does.
 *
 * The cap itself stays the caller's: discovery, inspection and staging each
 * name their own, and each raises its own named refusal, so the three phases
 * remain free to move their bounds independently of one another. This module
 * owns only the mechanism, and never opens a network connection itself.
 */

/** Read `response`'s body, refusing the moment the running total crosses `capBytes`. */
export async function readBoundedText(response: Response, capBytes: number, tooLarge: () => Error): Promise<string> {
  // A declared `content-length` above the cap is refused before a single byte
  // is pulled. It is never trusted when it is *small* — only the bytes are.
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > capBytes) throw tooLarge()

  const body = response.body
  if (body === null) return ''

  const reader = body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > capBytes) throw tooLarge()
      chunks.push(Buffer.from(value))
    }
  } finally {
    // Cancel rather than drain: a hostile endpoint's remaining bytes must
    // never keep crossing the boundary after the refusal.
    await reader.cancel().catch(() => undefined)
  }
  return Buffer.concat(chunks).toString('utf8')
}
