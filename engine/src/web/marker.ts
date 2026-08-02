import fs from 'node:fs/promises'
import path from 'node:path'
import * as z from 'zod'
import { resolveLoopPaths } from '../store/paths.js'

/**
 * What a running cockpit leaves behind, so a second session can find it.
 *
 * The `SessionStart` hook needs three things to reuse a server instead of
 * racing it for the port: where it is listening, the token its url carries —
 * minted fresh on every start, so it cannot be guessed — and enough to tell a
 * live server from a file left behind by one that crashed.
 *
 * Deliberately not a lock. It grants nothing and guards nothing: two servers on
 * one project are prevented by the port, not by this. It is a signpost, and
 * every read of it is allowed to conclude "nothing is there".
 */
export const ServerMarkerSchema = z.strictObject({
  port: z.number().int().positive(),
  token: z.string().min(1),
  pid: z.number().int().positive(),
})

export type ServerMarker = z.infer<typeof ServerMarkerSchema>

/**
 * Best effort, always. A project whose `.mjloop` cannot be written still gets a
 * working dashboard — it just cannot be found by a later session, which is a
 * missing convenience and not a failure worth refusing to serve over.
 */
export async function writeServerMarker(projectDir: string, marker: ServerMarker): Promise<void> {
  const file = resolveLoopPaths(projectDir).webServer
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
  } catch {
    /* the url is printed either way */
  }
}

export async function clearServerMarker(projectDir: string): Promise<void> {
  try {
    await fs.rm(resolveLoopPaths(projectDir).webServer, { force: true })
  } catch {
    /* a marker that outlives its server is handled on the read side */
  }
}

/**
 * The url of a cockpit already serving this project, or null.
 *
 * Null covers every way this can go wrong and they are all the same answer to
 * the caller: no file, unreadable, not JSON, the wrong shape, or a pid that is
 * gone. That last one is why the probe exists — `close()` removes the marker,
 * but a killed process removes nothing, and a stale port and token would send
 * the reader's browser to a connection refused.
 *
 * `process.kill(pid, 0)` sends no signal; it only asks whether the pid can be
 * signalled. It throws `ESRCH` when there is no such process, and `EPERM` when
 * there is one this user may not signal — which still means *something* is
 * alive on that pid, so it is not treated as dead.
 */
export async function readServerMarker(projectDir: string): Promise<{ url: string } | null> {
  let raw: string
  try {
    raw = await fs.readFile(resolveLoopPaths(projectDir).webServer, 'utf8')
  } catch {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  const marker = ServerMarkerSchema.safeParse(parsed)
  if (!marker.success) return null
  if (!alive(marker.data.pid)) return null

  return { url: `http://127.0.0.1:${marker.data.port}/?t=${marker.data.token}` }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
