/**
 * The sandbox phase, and the one place in S07 an implementation is most
 * tempted to claim a boundary it does not have.
 *
 * A bare `child_process.spawn` with a scrubbed environment is NOT a sandbox —
 * the child can still read the filesystem, open sockets, and write anywhere
 * the user can. This module only ever runs a package's declared smoke checks
 * inside a *real* isolation mechanism it can actually detect on the host:
 * `sandbox-exec` on darwin, `bwrap` (bubblewrap) on linux. Nothing else
 * counts, and when neither is present the result is `'unavailable'` — the
 * package is refused, never run unsandboxed and never called sandboxed
 * anyway. Silently downgrading to a plain `spawn` here would be exactly the
 * false claim the master plan forbids.
 *
 * An instruction-only package (no executable content, the common case — most
 * skills are markdown) skips the sandbox entirely and is acceptable with no
 * backend at all. `audit.state` may become `'passed'` only when this
 * module's result is `'passed'` or `'skipped'` — never `'unavailable'`.
 *
 * Both backend detection and process creation go through `deps`
 * (`detectBackend`, `spawn`), the same injection seam `deps.fetch` is
 * elsewhere in this pipeline — so every test here is fully deterministic on
 * a machine that has neither backend (CI) and on one that has both (a
 * developer's darwin machine), without ever depending on which host tools
 * happen to be installed.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { existsSync, accessSync, constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SandboxResultSchema, SANDBOX_OUTPUT_CAP, type SandboxResult, type SandboxCheckResult } from '../schemas/skill-import.js'

export type SandboxBackend = 'sandbox-exec' | 'bwrap'

export interface DetectedSandbox {
  /** Which real isolation mechanism this is. */
  backend: SandboxBackend
  /**
   * The absolute path detection actually verified, and the only thing
   * execution may put at argv[0].
   *
   * Spawning the bare name instead (`spawn('sandbox-exec', ...)`) resolves it
   * through the inherited `PATH`, so any file called `sandbox-exec` sitting in
   * an earlier `PATH` directory (`/usr/local/bin`, `~/.local/bin`, a project's
   * `node_modules/.bin`) would be executed in place of the binary detection
   * checked — silently turning the whole isolation claim into a plain
   * unsandboxed spawn whose result still says `'passed'`. Verifying one file
   * and executing another is the bug, so detection carries the resolved path
   * to the call site rather than throwing it away.
   */
  bin: string
}

export interface SkillSandboxDeps {
  detectBackend: () => DetectedSandbox | null
  spawn: typeof nodeSpawn
  /**
   * Overridable only so `tests/ops/skill-sandbox.test.ts` can exercise the
   * timeout-and-kill path in milliseconds instead of the real 30s bound —
   * the same reason `deps.fetch` exists, applied to a value that would
   * otherwise force every timeout test to actually wait 30 seconds.
   * Defaults to `SMOKE_CHECK_TIMEOUT_MS` for every real caller.
   */
  timeoutMs?: number
  /** The whole-run wall-clock bound, overridable for the same reason. Defaults to `SANDBOX_TOTAL_TIMEOUT_MS`. */
  totalTimeoutMs?: number
}

/** One file's content, staged into the disposable temp cwd the sandbox runs in. */
export interface SandboxPackageFile {
  path: string
  content: Buffer
}

export interface RunSandboxInput {
  files: SandboxPackageFile[]
  /** Paths `inspectCandidate` classified as executable — never re-derived here. */
  executableFiles: string[]
  /** The raw `mjloop.smoke` value from `SKILL.md` frontmatter, unvalidated until this module parses it. */
  smokeChecks: unknown
}

/** A hard timeout kills a smoke check rather than awaiting it — a hung check is reported failed, not left running. */
const SMOKE_CHECK_TIMEOUT_MS = 30_000

/**
 * The whole sandbox phase's wall-clock bound, across every declared check.
 * A per-check timeout alone is not a bound on the pipeline: a package may
 * declare many checks, and n checks each sitting out the per-check timeout is
 * n times the runtime the caller was promised.
 */
const SANDBOX_TOTAL_TIMEOUT_MS = 120_000

/**
 * How long a check may keep flushing stdio after it has already exited.
 *
 * `'close'` fires only once every inherited stdio pipe is closed, and a check
 * that backgrounds anything (`sleep 30 & echo started`) leaves that process
 * holding the stdout fd after the direct child exits — so waiting for
 * `'close'` alone is an unbounded wait, not a 30-second one. Settling on
 * `'exit'` plus this short flush window bounds it.
 */
const STDIO_FLUSH_GRACE_MS = 200

/** After a SIGKILL, settle regardless — a pipe another process still holds must never keep this promise pending. */
const KILL_SETTLE_MS = 500

/** The darwin isolation binary, verified by absolute path and executed by that same absolute path. */
const SANDBOX_EXEC_BIN = '/usr/bin/sandbox-exec'

/** Search `PATH` for an executable named `bin`, the same way a shell's own lookup works, without ever invoking a shell. */
function which(bin: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter((dir) => dir.length > 0)
  for (const dir of dirs) {
    const candidate = path.join(dir, bin)
    try {
      accessSync(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      continue
    }
  }
  return null
}

/**
 * Look for a real isolation mechanism, and only a real one. `sandbox-exec` on
 * darwin, `bwrap` on linux. Any other platform, or either platform without
 * its tool present, is honestly `null` — there is no fallback backend.
 */
export function detectSandboxBackend(): DetectedSandbox | null {
  if (process.platform === 'darwin') {
    return existsSync(SANDBOX_EXEC_BIN) ? { backend: 'sandbox-exec', bin: SANDBOX_EXEC_BIN } : null
  }
  if (process.platform === 'linux') {
    const bin = which('bwrap')
    return bin === null ? null : { backend: 'bwrap', bin }
  }
  return null
}

const defaultDeps: SkillSandboxDeps = { detectBackend: detectSandboxBackend, spawn: nodeSpawn }

/**
 * A seatbelt profile denying everything by default: no network rule of any
 * kind, writes only inside the disposable temp root, and — the part a blanket
 * `(allow file-read*)` used to give away — reads only of the temp root and the
 * fixed system paths an executable needs to launch at all.
 *
 * Reads must be scoped, not merely writes. A smoke check is untrusted content
 * fetched from a stranger's repository, and its stdout is captured into the
 * report `skills inspect --json` prints; with unrestricted reads it can print
 * the user's project checkout, `~/.ssh`, or a credentials file, which is the
 * opposite of the "no project checkout, credentials, secrets" this phase
 * claims. The linux `bwrap` branch below already confines reads through
 * `--unshare-all` plus explicit read-only binds; this mirrors it.
 *
 * `tempRoot` must already be canonical: seatbelt evaluates `subpath` against
 * the real path, and on macOS `os.tmpdir()` is `/var/folders/…`, a symlink to
 * `/private/var/folders/…`, so an uncanonicalised root would match nothing and
 * every writing check would fail for a reason that has nothing to do with the
 * package.
 */
function sandboxExecProfile(tempRoot: string): string {
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-fork)',
    '(allow process-exec)',
    // Metadata reads (stat/lstat/path resolution) expose no file content and
    // every loader and shell needs them to resolve a path at all.
    '(allow file-read-metadata)',
    // The root directory itself, not its children: dyld cannot start a process
    // at all without it, and `(subpath "/usr")` does not cover `/`.
    '(allow file-read* (literal "/"))',
    `(allow file-read* (subpath "${tempRoot}"))`,
    '(allow file-read* (subpath "/usr"))',
    '(allow file-read* (subpath "/bin"))',
    '(allow file-read* (subpath "/sbin"))',
    // Where an interpreter a check names on PATH actually lives on this
    // platform (`/usr/local` is already covered by `/usr`); a package prefix,
    // never a credential store.
    '(allow file-read* (subpath "/opt"))',
    '(allow file-read* (subpath "/System"))',
    '(allow file-read* (subpath "/dev"))',
    '(allow file-read* (subpath "/private/var/db/dyld"))',
    `(allow file-write* (subpath "${tempRoot}"))`,
    '(allow file-write* (subpath "/dev"))',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
  ].join('\n')
}

/**
 * Wrap the declared argv in the detected backend's own isolation invocation —
 * still a bare argv array, never a shell string.
 *
 * argv[0] is `detected.bin`, the absolute path detection verified, never the
 * bare backend name: see `DetectedSandbox.bin`.
 */
function buildSandboxedArgv(detected: DetectedSandbox, argv: string[], tempRoot: string, workDir: string): string[] {
  if (detected.backend === 'sandbox-exec') return [detected.bin, '-p', sandboxExecProfile(tempRoot), '--', ...argv]
  return [
    detected.bin,
    '--unshare-all',
    '--die-with-parent',
    '--ro-bind',
    '/usr',
    '/usr',
    '--ro-bind',
    '/bin',
    '/bin',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--bind',
    tempRoot,
    tempRoot,
    '--chdir',
    workDir,
    '--',
    ...argv,
  ]
}

/**
 * `mjloop.smoke` must be an array of non-empty argv arrays. A bare string
 * anywhere in it — the shape a shell command would take — is refused, not
 * coerced: rule 7 exists because a shell string is exactly how a value
 * derived from fetched content becomes command injection.
 */
function parseSmokeChecks(raw: unknown): string[][] | null {
  if (!Array.isArray(raw)) return null
  const checks: string[][] = []
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length === 0) return null
    if (!entry.every((item) => typeof item === 'string' && item.length > 0)) return null
    checks.push(entry as string[])
  }
  return checks
}

interface CheckOutcome {
  result: SandboxCheckResult
  stdout: string
  stderr: string
}

/**
 * Kill everything a timed-out check started, not just the process it started
 * directly.
 *
 * The child is spawned `detached`, so it leads its own process group and a
 * negative pid signals that whole group. Signalling only the direct child
 * leaves anything it backgrounded (`sleep 30 & …`) running on the host after
 * the sandbox that was meant to bound it has returned — `--die-with-parent`
 * covers this on the bwrap/linux path, and nothing covers it on darwin.
 */
function killProcessTree(child: ChildProcess): void {
  const pid = child.pid
  if (typeof pid === 'number' && pid > 0) {
    try {
      process.kill(-pid, 'SIGKILL')
      return
    } catch {
      // The group may already be gone, or this child never became a real
      // process (an injected double) — fall through to the direct kill.
    }
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // Nothing left to kill.
  }
}

/** Run one check to completion or the hard timeout, whichever comes first — captured output bounded as it arrives. */
function runOneCheck(
  declaredArgv: string[],
  spawnArgv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  deps: SkillSandboxDeps,
  timeoutMs: number,
): Promise<CheckOutcome> {
  return new Promise((resolve) => {
    // `detached: true` gives the check its own process group, which is what
    // makes the timeout below able to kill everything it started.
    const child: ChildProcess = deps.spawn(spawnArgv[0] as string, spawnArgv.slice(1), { cwd, env, shell: false, detached: true })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let graceTimer: NodeJS.Timeout | null = null

    const finish = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (graceTimer !== null) clearTimeout(graceTimer)
      resolve({ result: { argv: declaredArgv, exitCode: timedOut ? null : exitCode, timedOut }, stdout, stderr })
    }

    const timer = setTimeout(() => {
      timedOut = true
      if (graceTimer !== null) clearTimeout(graceTimer)
      killProcessTree(child)
      // Settle even if a pipe some other process still holds keeps `'exit'`
      // and `'close'` from ever arriving: a bound that can be waited out
      // forever is not a bound.
      graceTimer = setTimeout(() => finish(null), KILL_SETTLE_MS)
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (stdout.length < SANDBOX_OUTPUT_CAP) stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderr.length < SANDBOX_OUTPUT_CAP) stderr += chunk.toString()
    })

    child.on('error', () => finish(null))
    // `'exit'` fires when the check itself is gone; `'close'` waits for every
    // inherited stdio pipe, which a backgrounded process can hold open
    // indefinitely. Settle on `'close'` when it arrives promptly, and on
    // `'exit'` plus a short flush window when it does not.
    child.on('exit', (code) => {
      if (settled || graceTimer !== null) return
      graceTimer = setTimeout(() => finish(code), STDIO_FLUSH_GRACE_MS)
    })
    child.on('close', (code) => finish(code))
  })
}

/** Append one check's transcript to the running output, truncating (and recording that fact) once the cap is hit. */
function appendOutput(existing: { text: string; truncated: boolean }, addition: string): { text: string; truncated: boolean } {
  if (existing.truncated) return existing
  const combined = existing.text + addition
  if (combined.length <= SANDBOX_OUTPUT_CAP) return { text: combined, truncated: false }
  return { text: combined.slice(0, SANDBOX_OUTPUT_CAP), truncated: true }
}

/**
 * Run the sandbox phase for one inspected package.
 *
 * - No executable content: skipped, acceptable with no backend at all.
 * - Executable content, no backend detected: `unavailable`, and nothing is
 *   spawned — this package cannot be accepted on this machine.
 * - Executable content, no declared (or malformed) `mjloop.smoke` checks:
 *   `failed` — a package that carries executable content cannot pass without
 *   at least one declared, argv-array smoke check.
 * - Executable content, backend present, checks declared: each check runs in
 *   a disposable temp cwd holding only the package content, with an
 *   environment scrubbed to `{ PATH, HOME, LANG }` and nothing else
 *   inherited, no project path anywhere in cwd/env/argv, no network (the
 *   backend's own isolation denies it), a hard timeout, and bounded output.
 */
export async function runSkillSandbox(input: RunSandboxInput, deps: SkillSandboxDeps = defaultDeps): Promise<SandboxResult> {
  if (input.executableFiles.length === 0) {
    return SandboxResultSchema.parse({ state: 'skipped', reason: 'no executable content' })
  }

  const detected = deps.detectBackend()
  if (detected === null) {
    return SandboxResultSchema.parse({
      state: 'unavailable',
      reason:
        'no sandbox backend detected on this machine — install sandbox-exec (darwin) or bwrap/bubblewrap (linux) to ' +
        'verify a package with executable content; this machine cannot verify it, and running it unsandboxed is never ' +
        'an acceptable substitute',
    })
  }

  const checks = parseSmokeChecks(input.smokeChecks)
  if (checks === null) {
    return SandboxResultSchema.parse({
      state: 'failed',
      checks: [],
      output: {
        text:
          'mjloop.smoke in SKILL.md frontmatter must be an array of argv arrays, each a non-empty array of strings — ' +
          'a bare string (a shell command) is refused, not coerced',
        truncated: false,
      },
    })
  }
  if (checks.length === 0) {
    return SandboxResultSchema.parse({
      state: 'failed',
      checks: [],
      output: {
        text: 'this package carries executable content but declares no mjloop.smoke checks in SKILL.md frontmatter — it cannot pass without at least one',
        truncated: false,
      },
    })
  }

  // A disposable temp cwd holding only the package content — never the
  // project directory, never anything inherited from it.
  //
  // Canonicalised immediately: the seatbelt profile below matches `subpath`
  // against the real path, and on macOS `os.tmpdir()` is `/var/folders/…`, a
  // symlink to `/private/var/folders/…` (the same hazard `store/library-paths.ts`
  // documents), so the uncanonicalised path would match nothing at all.
  const tempRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mjloop-skill-sandbox-')))
  try {
    const packageDir = path.join(tempRoot, 'pkg')
    const homeDir = path.join(tempRoot, 'home')
    await fs.mkdir(packageDir, { recursive: true })
    await fs.mkdir(homeDir, { recursive: true })
    for (const file of input.files) {
      const dest = path.join(packageDir, file.path)
      await fs.mkdir(path.dirname(dest), { recursive: true })
      await fs.writeFile(dest, file.content)
    }

    // The fixed allowlist: nothing from the parent environment is inherited
    // beyond these three keys, so a secret sitting anywhere else in
    // `process.env` never reaches the check.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: homeDir,
      LANG: process.env.LANG ?? 'C',
    }

    const results: SandboxCheckResult[] = []
    let output = { text: '', truncated: false }
    let allPassed = true

    const perCheckMs = deps.timeoutMs ?? SMOKE_CHECK_TIMEOUT_MS
    const totalMs = deps.totalTimeoutMs ?? SANDBOX_TOTAL_TIMEOUT_MS
    const startedAt = Date.now()

    for (const argv of checks) {
      // The whole phase is bounded, not just each check: a package declaring
      // many checks must not be able to multiply the runtime it was granted.
      const remaining = totalMs - (Date.now() - startedAt)
      if (remaining <= 0) {
        results.push({ argv, exitCode: null, timedOut: true })
        allPassed = false
        output = appendOutput(output, `$ ${argv.join(' ')}\nnot run: the sandbox's ${totalMs}ms total wall-clock budget was already spent\n`)
        continue
      }
      const spawnArgv = buildSandboxedArgv(detected, argv, tempRoot, packageDir)
      const outcome = await runOneCheck(argv, spawnArgv, packageDir, env, deps, Math.min(perCheckMs, remaining))
      results.push(outcome.result)
      if (outcome.result.exitCode !== 0 || outcome.result.timedOut) allPassed = false
      output = appendOutput(output, `$ ${argv.join(' ')}\n${outcome.stdout}${outcome.stderr}\n`)
    }

    return SandboxResultSchema.parse({ state: allPassed ? 'passed' : 'failed', checks: results, output })
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
}
