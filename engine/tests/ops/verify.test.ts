import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initLoop } from '../../src/ops/init.js'
import { runDirPath, runStart } from '../../src/ops/run.js'
import {
  InvalidVerifyLabelError,
  NoRunToVerifyError,
  PinnedVerifyInvalidError,
  PinnedVerifyMissingError,
  readVerifyLedger,
  verifyRun,
} from '../../src/ops/verify.js'
import type { Config } from '../../src/schemas/config.js'
import { loadConfig, writeConfig } from '../../src/store/config-store.js'
import { resolveLoopPaths } from '../../src/store/paths.js'
import { StateStore } from '../../src/store/state-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const git = promisify(execFile)

const NOW = new Date('2026-07-28T10:36:00.000Z')
const clock = (): Date => NOW

const FIXTURES = fileURLToPath(new URL('../fixtures/verify/', import.meta.url))
const SOURCE = fileURLToPath(new URL('../../src/ops/verify.ts', import.meta.url))

let project: TmpProject
/**
 * Somewhere for a verify command to write a counter without moving the
 * worktree. A marker file inside the project would be an untracked file, so
 * every cache test would fail its own post-exit re-digest for the wrong reason.
 */
let scratch: string

beforeEach(async () => {
  project = await makeTmpProject()
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'loop-verify-'))
})
afterEach(async () => {
  await project.cleanup()
  await fs.rm(scratch, { recursive: true, force: true })
})

/* ── setup ────────────────────────────────────────────────────────────────── */

async function configure(mutate: (config: Config) => void): Promise<void> {
  const config = await loadConfig(project.dir)
  mutate(config)
  await writeConfig(project.dir, config)
}

async function state(): Promise<Awaited<ReturnType<StateStore['get']>>> {
  return await new StateStore(project.dir).get()
}

async function runDir(): Promise<string> {
  return runDirPath(project.dir, await state())
}

/**
 * The pin `runStart` writes, written by hand here.
 *
 * `verifyRun` must never write this file — a reader that could create the file
 * it validates against would be validating against itself — so the test writes
 * it, exactly as the run would have.
 */
async function writePin(overrides: Partial<Config['verify']> = {}): Promise<void> {
  const config = await loadConfig(project.dir)
  await fs.writeFile(
    path.join(await runDir(), 'verify-pinned.json'),
    `${JSON.stringify({ version: 1, pinned_at: NOW.toISOString(), verify: { ...config.verify, ...overrides } }, null, 2)}\n`,
    'utf8',
  )
  // A run that carries a pin is a run `runStart` opened after the pin existed.
  await new StateStore(project.dir, clock).update((draft) => {
    draft.started_at = NOW.toISOString()
  })
}

interface BeginOptions {
  /** Rewind the run to before the pin existed: no pin, and `started_at` null. */
  pin?: boolean
  cache?: boolean
}

async function begin(verify: Partial<Config['verify']>, options: BeginOptions = {}): Promise<void> {
  await initLoop(project.dir, clock)
  await configure((config) => {
    Object.assign(config.verify, verify)
    if (options.cache === true) config.verify_cache = true
  })
  await runStart(project.dir, { track: 'edit', goal: 'Verify things' }, clock)
  if (options.pin === false) {
    // What a run started before this milestone looks like: `runStart` is
    // `started_at`'s only writer and it landed with the pin, so the two absences
    // always travel together.
    await fs.rm(path.join(await runDir(), 'verify-pinned.json'), { force: true })
    await new StateStore(project.dir, clock).update((draft) => {
      draft.started_at = null
    })
    return
  }
  await writePin()
}

/** A shell command that appends one line to a file outside the project. */
function counts(name: string, tail = ''): string {
  return `printf 'x\\n' >> '${path.join(scratch, name)}'${tail}`
}

async function countOf(name: string): Promise<number> {
  const raw = await fs.readFile(path.join(scratch, name), 'utf8').catch(() => '')
  return raw.split('\n').filter((line) => line !== '').length
}

/**
 * A grandchild that records its own pid where the test can see it.
 *
 * The engine's child is `/bin/sh`; the thing `timeout_ms` is supposed to bound
 * is the process the shell forks. A test that asserts only on the digest cannot
 * tell "the group was killed" from "the shell died and the drain gave up two
 * seconds later" — both produce `timed_out: true` and a released lock — so the
 * descendant is made to say its own pid and the test asks the OS about it.
 *
 * `&& true` after it is deliberate: it is the shell's *last* command that a
 * shell may `exec` in place, and a descendant that is really the child pid
 * would be killed by `child.kill` alone, quietly turning the assertion into one
 * about nothing.
 */
async function sleeper(options: { ignoresTerm?: boolean; lives?: number } = {}): Promise<{
  command: string
  /** The pid the grandchild wrote, once it exists. */
  pid: () => Promise<number>
}> {
  const script = path.join(scratch, 'sleeper.cjs')
  const pidFile = path.join(scratch, 'sleeper.pid')
  await fs.writeFile(
    script,
    [
      "const fs = require('node:fs')",
      'const [, , file, mode, ms] = process.argv',
      // Installed before the pid is published, so the pid is never visible to
      // the test in a state where the handler is not yet in place.
      "if (mode === 'ignore') process.on('SIGTERM', () => {})",
      'fs.writeFileSync(file, String(process.pid))',
      'setTimeout(() => {}, Number(ms))',
      '',
    ].join('\n'),
    'utf8',
  )
  const mode = options.ignoresTerm === true ? 'ignore' : 'exit'
  return {
    command: `node '${script}' '${pidFile}' ${mode} ${options.lives ?? 20_000}`,
    pid: async () => {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        const raw = await fs.readFile(pidFile, 'utf8').catch(() => '')
        if (raw !== '') return Number(raw)
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error('the grandchild never published its pid')
    },
  }
}

/**
 * Whether a pid is gone, waited for rather than sampled.
 *
 * A signal is delivered asynchronously and the process it reaches has to be
 * reaped after it: sampling immediately after the digest settles would be a
 * flake in one direction. The wait is bounded well under the 20 s the
 * grandchild would otherwise live, so a survivor still fails.
 */
async function died(pid: number, within = 4_000): Promise<boolean> {
  const deadline = Date.now() + within
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

async function ledger(cycle = 'cycle-01'): Promise<Awaited<ReturnType<typeof readVerifyLedger>>> {
  return await readVerifyLedger(path.join(await runDir(), cycle))
}

async function logBody(name = 'test.log', cycle = 'cycle-01'): Promise<string> {
  return await fs.readFile(path.join(await runDir(), cycle, 'verify', name), 'utf8').catch(() => '')
}

/* ── execution ────────────────────────────────────────────────────────────── */

describe('verifyRun', () => {
  it('writes the full output to the cycle verify directory and returns a bounded digest', async () => {
    await begin({ test: "printf 'hello\\nworld\\n'" })

    const digest = await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)

    expect(digest.phase).toBe('complete')
    expect(digest.exit_code).toBe(0)
    expect(digest.log).toBe(path.join('.mjloop', 'runs', path.basename(await runDir()), 'cycle-01', 'verify', 'test.log'))
    expect(await logBody()).toBe('hello\nworld\n')
    expect(digest.lines).toBe(2)
    expect(digest.bytes).toBe(12)
    expect(digest.headline).toBe('hello')
    expect(digest.failures).toEqual([])
  })

  it('returns the exit code without turning it into a verdict', async () => {
    await begin({ test: 'exit 3' })

    const digest = await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)

    expect(digest.exit_code).toBe(3)
    // The engine executes and reports; a verdict is the verifying agent's, and
    // no field here may be mistaken for one.
    for (const verdict of ['pass', 'fail', 'blocked']) {
      expect(Object.values(digest)).not.toContain(verdict)
    }
    expect(Object.keys(digest)).not.toContain('status')
  })

  it('writes nothing to state', async () => {
    await begin({ test: 'exit 1' })
    const file = resolveLoopPaths(project.dir).state
    const before = createHash('sha256').update(await fs.readFile(file)).digest('hex')

    await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)

    expect(createHash('sha256').update(await fs.readFile(file)).digest('hex')).toBe(before)
  })

  it('refuses to run when there is no run at all', async () => {
    await initLoop(project.dir, clock)
    await expect(verifyRun(project.dir, { slot: 'test' }, clock)).rejects.toBeInstanceOf(NoRunToVerifyError)
  })

  it('reports a null slot as absent by design rather than as an error', async () => {
    await begin({ test: 'exit 0', build: null })

    const digest = await verifyRun(project.dir, { slot: 'build', wait_ms: 4000 }, clock)

    expect(digest.phase).toBe('complete')
    expect(digest.exit_code).toBeNull()
    expect(digest.headline).toBe('slot is null in config — nothing to run')
    expect(digest.log).toBe('')
    // No log, and no ledger row either: a `LedgerEntry` needs a non-empty
    // command, and inventing one to record that nothing ran would be the
    // ledger's first false row.
    expect(await ledger()).toEqual([])
  })

  it('refuses a label that would write outside the cycle directory', async () => {
    await begin({ test: 'exit 0' })

    await expect(
      verifyRun(project.dir, { slot: 'test', label: '../../../state' }, clock),
    ).rejects.toBeInstanceOf(InvalidVerifyLabelError)

    expect(await fs.readdir(path.join(await runDir(), 'cycle-01')).catch(() => [])).toEqual([])
  })

  it('kills a command that outruns the configured ceiling and says it was killed', async () => {
    await begin({ test: 'sleep 5' })
    await writePin({ timeout_ms: 200 })

    const digest = await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)

    expect(digest.timed_out).toBe(true)
    expect(digest.exit_code).toBeNull()
    expect(digest.phase).toBe('complete')
  })

  it('kills a compound command that outruns the ceiling, not just its shell', async () => {
    // `cd engine && npm test` is the shape `mjloop:init` detects, the shape this
    // project's own config carries, and the shape the plain `sleep 5` case above
    // does not cover: `/bin/sh` execs a *simple* command in place, so the shell
    // pid is the command pid and one `child.kill()` is enough. It cannot exec a
    // compound one — it forks — and a signal addressed to the shell alone leaves
    // the real command running, holding the log pipes. `close` then waits on the
    // orphan rather than on the ceiling: the digest never settles, the in-flight
    // entry is never pruned, and `.mjloop/.verify-lock` is held for the
    // command's full uncapped runtime, which is precisely the two-suites-on-one-
    // port state the lock exists to prevent.
    const grandchild = await sleeper()
    await begin({ test: `cd . && ${grandchild.command} && true` })
    await writePin({ timeout_ms: 200 })

    const started = Date.now()
    const pending = verifyRun(project.dir, { slot: 'test', wait_ms: 12_000 }, clock)
    const pid = await grandchild.pid()
    const digest = await pending

    expect(digest.phase).toBe('complete')
    expect(digest.timed_out).toBe(true)
    // **The assertion the digest cannot make.** Every field above is satisfied
    // by the shell alone dying and the drain settling two seconds later, which
    // is exactly what happens with `detached` and the group kill reverted — so
    // without this line the half of the ceiling that reaches the real command
    // is defended by nothing.
    expect(await died(pid), `pid ${pid} outlived the ceiling`).toBe(true)
    // The ceiling is 200ms and the SIGKILL grace is 5s: anything near the
    // command's own 20s is the ceiling bounding nothing.
    expect(Date.now() - started).toBeLessThan(10_000)
    // Released, rather than held until it goes stale.
    await expect(fs.stat(resolveLoopPaths(project.dir).verifyLock)).rejects.toThrow()
  })

  it('escalates to SIGKILL for a descendant that ignores the SIGTERM and holds the pipes', async () => {
    // The path the drain was written for, and the one it can cancel. A suite
    // whose teardown traps SIGTERM and hangs — a stuck worker pool, a spawned
    // dev server — outlives the group SIGTERM, the shell does not, so `exit`
    // fires and arms a 2s drain. `finish` clears the 5s SIGKILL escalation, so
    // unless the drain escalates itself the engine reports `timed_out: true`,
    // releases `.mjloop/.verify-lock`, and abandons the thing that outran the
    // ceiling three seconds before the kill it scheduled was due.
    const grandchild = await sleeper({ ignoresTerm: true })
    await begin({ test: `cd . && ${grandchild.command} && true` })
    await writePin({ timeout_ms: 200 })

    const pending = verifyRun(project.dir, { slot: 'test', wait_ms: 12_000 }, clock)
    const pid = await grandchild.pid()
    const digest = await pending

    expect(digest.timed_out).toBe(true)
    expect(await died(pid), `pid ${pid} ignored SIGTERM and was never escalated on`).toBe(true)
  })

  it('does not call a command that exited in time timed out because the ceiling landed in the drain', async () => {
    // The command finished, green, with a real exit code — but it left a
    // background process holding the log pipes, so `close` never comes and the
    // settle is the 2s drain. A ceiling left armed across that window flips the
    // outcome after the fact: `timed_out: true, exit_code: null` beside a
    // headline reading `0 failed`, which `agents/verifier.md` turns into
    // `blocked` and re-runs a suite that already passed.
    const holder = await sleeper({ lives: 6_000 })
    await begin({ test: `${holder.command} & printf 'Tests  0 failed | 781 passed\\n'; exit 0` })
    // Landing inside the drain window: the shell exits within milliseconds and
    // the drain runs to ~2s, so a 1s ceiling fires while it is draining.
    await writePin({ timeout_ms: 1_000 })

    const digest = await verifyRun(project.dir, { slot: 'test', wait_ms: 12_000 }, clock)

    expect(digest.timed_out).toBe(false)
    expect(digest.exit_code).toBe(0)
    expect(digest.headline).toContain('781 passed')
  })

  it('does not lose a child that settles while the ledger is being written', async () => {
    // `spawn` returns before the process runs, and `close`, `exit` and `error`
    // are not replayed for a listener that attaches later. An `await` between
    // the spawn and the listeners — the ledger amendment used to sit exactly
    // there — is a window in which a fast command's `close` is emitted with
    // nobody watching: the completion promise never settles, the verify lock is
    // held until it goes stale, and an `error` with no listener is rethrown as
    // an uncaught exception that ends the server.
    await begin({ test: 'exit 3' })

    const realRename = fs.rename.bind(fs)
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await realRename(from, to)
      if (String(to).endsWith(path.join('verify', 'index.json'))) {
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    })

    try {
      const digest = await verifyRun(project.dir, { slot: 'test', wait_ms: 8000 }, clock)

      expect(digest.phase).toBe('complete')
      expect(digest.exit_code).toBe(3)
    } finally {
      spy.mockRestore()
    }
    await expect(fs.stat(resolveLoopPaths(project.dir).verifyLock)).rejects.toThrow()
  })

  it('returns phase running rather than blocking past the client timeout', async () => {
    await begin({ test: 'sleep 0.5' })

    const interim = await verifyRun(project.dir, { slot: 'test', wait_ms: 30 }, clock)
    expect(interim.phase).toBe('running')
    expect(interim.exit_code).toBeNull()

    const settled = await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)
    expect(settled.phase).toBe('complete')
  })

  it('a second call after the wait learns the exit code', async () => {
    await begin({ test: 'sleep 0.3; exit 7' })

    expect((await verifyRun(project.dir, { slot: 'test', wait_ms: 30 }, clock)).exit_code).toBeNull()
    expect((await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)).exit_code).toBe(7)
  })

  it('a request abort stops the wait and leaves the child running', async () => {
    await begin({ test: "printf 'a\\n'; sleep 0.4; printf 'b\\n'" })
    const aborter = new AbortController()
    setTimeout(() => aborter.abort(), 120)

    const interim = await verifyRun(project.dir, { slot: 'test', wait_ms: 60_000 }, clock, aborter.signal)

    expect(interim.phase).toBe('running')
    expect(await logBody()).not.toContain('b')

    // The child was never signalled — only `verify.timeout_ms` kills one — so
    // the log keeps growing and the next call learns the exit code.
    const settled = await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)
    expect(settled.exit_code).toBe(0)
    expect(await logBody()).toBe('a\nb\n')
  })

  it('never inherits stdio', async () => {
    // A source-level assertion, in the same spirit as tests/web/boundary.test.ts:
    // `StdioServerTransport` binds `process.stdout` as the JSON-RPC channel, so
    // one byte of a suite's output on that stream corrupts the session's
    // protocol irrecoverably.
    expect(await fs.readFile(SOURCE, 'utf8')).not.toMatch(/inherit/i)
  })

  it('writes a closing verify log outside every cycle directory when the run is done', async () => {
    await begin({ test: 'exit 0' })
    await new StateStore(project.dir, clock).update((draft) => {
      draft.status = 'done'
    })

    const digest = await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)

    expect(digest.phase).toBe('complete')
    expect(digest.log).toContain(path.join('closing', 'verify', 'test.log'))
    expect(await fs.readdir(path.join(await runDir(), 'cycle-01')).catch(() => [])).toEqual([])
    expect(await readVerifyLedger(path.join(await runDir(), 'closing'))).toHaveLength(1)
  })
})

/* ── the in-flight de-duplicator ──────────────────────────────────────────── */

describe('verifyRun in-flight de-duplication', () => {
  it('attaches to an in-flight command instead of spawning a second one', async () => {
    await begin({ test: counts('runs', '; sleep 0.3') })

    const both = await Promise.allSettled([
      verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock),
      verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock),
    ])

    expect(both.map((entry) => entry.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(await countOf('runs')).toBe(1)
  })

  it('forgets a completed command so the next call re-runs it', async () => {
    await begin({ test: counts('runs') })

    await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)
    await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)

    expect(await countOf('runs')).toBe(2)
  })

  it('does not attach a lint call to an in-flight test call', async () => {
    await begin({ test: counts('test-runs', '; sleep 0.2'), lint: counts('lint-runs') })

    await Promise.all([
      verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock),
      verifyRun(project.dir, { slot: 'lint', wait_ms: 4000 }, clock),
    ])

    expect(await countOf('test-runs')).toBe(1)
    expect(await countOf('lint-runs')).toBe(1)
  })
})

/* ── the ledger ───────────────────────────────────────────────────────────── */

describe('verifyRun ledger', () => {
  it('appends one ledger entry per invocation', async () => {
    await begin({ test: 'exit 0' })

    await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)
    await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)

    expect(await ledger()).toHaveLength(2)
  })

  it('amends the ledger entry when the child finally exits', async () => {
    await begin({ test: 'sleep 0.3; exit 1' })

    await verifyRun(project.dir, { slot: 'test', wait_ms: 30 }, clock)
    const midway = await ledger()
    expect(midway).toHaveLength(1)
    expect(midway[0]?.phase).toBe('running')
    expect(midway[0]?.exit_code).toBeNull()

    await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)

    // Rewritten in place, not appended beside: without the amendment a suite
    // that ultimately exits 1 leaves a ledger reading null forever, and the
    // contradiction check is inert against it.
    const after = await ledger()
    expect(after).toHaveLength(1)
    expect(after[0]?.phase).toBe('complete')
    expect(after[0]?.exit_code).toBe(1)
    expect(after[0]?.duration_ms).not.toBeNull()
  })

  it('reads an absent ledger as an empty one', async () => {
    await begin({ test: 'exit 0' })
    expect(await ledger('cycle-09')).toEqual([])
  })
})

/* ── the run's pinned verify block ────────────────────────────────────────── */

describe('verifyRun and the run pin', () => {
  it('executes the pinned command after config.yaml is rewritten mid-run', async () => {
    const marker = path.join(scratch, 'attacker')
    await begin({ test: "printf 'pinned\\n'" })
    await configure((config) => {
      config.verify.test = `printf 'live\\n' > '${marker}'`
    })

    const digest = await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)

    expect(digest.command).toBe("printf 'pinned\\n'")
    expect(digest.source).toBe('pinned')
    expect(await logBody()).toBe('pinned\n')
    await expect(fs.stat(marker)).rejects.toThrow()
  })

  it('honours the pinned ceiling rather than a rewritten one', async () => {
    await begin({ test: 'sleep 5' })
    await writePin({ timeout_ms: 200 })
    await configure((config) => {
      config.verify.timeout_ms = 600_000
    })

    const digest = await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)

    expect(digest.timed_out).toBe(true)
  })

  it('reports the live command beside the pinned one when they disagree', async () => {
    await begin({ test: 'exit 0' })
    await configure((config) => {
      config.verify.test = 'exit 1'
    })

    const digest = await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)

    // Drift is durable and refuses nothing: a rule that halted a run on drift
    // would hand any agent holding Write a way to stop the run.
    expect(digest.live_command).toBe('exit 1')
    expect(digest.exit_code).toBe(0)
    expect((await ledger())[0]?.live_command).toBe('exit 1')
  })

  it('records which copy it executed in the ledger', async () => {
    await begin({ test: 'exit 0' })

    await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)

    expect((await ledger())[0]?.source).toBe('pinned')
    expect((await ledger())[0]?.live_command).toBeNull()
  })

  it('falls back to the live config for a run that predates the pin', async () => {
    await begin({ test: 'exit 0' }, { pin: false })
    expect((await state()).started_at).toBeNull()

    const digest = await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)

    expect(digest.source).toBe('live')
    expect(digest.live_command).toBeNull()
    expect(digest.exit_code).toBe(0)
  })

  it('refuses to run when a pin that must exist has been removed', async () => {
    await begin({ test: 'exit 0' })
    await fs.rm(path.join(await runDir(), 'verify-pinned.json'))

    await expect(verifyRun(project.dir, { slot: 'test' }, clock)).rejects.toBeInstanceOf(PinnedVerifyMissingError)
    await expect(verifyRun(project.dir, { slot: 'test' }, clock)).rejects.toThrow(/verify-pinned\.json/)
  })

  it('refuses a pin it cannot parse rather than falling back to the live config', async () => {
    await begin({ test: 'exit 0' })
    await fs.writeFile(path.join(await runDir(), 'verify-pinned.json'), '{"version":2}', 'utf8')

    await expect(verifyRun(project.dir, { slot: 'test' }, clock)).rejects.toBeInstanceOf(PinnedVerifyInvalidError)
  })

  it('derives the run directory exactly as ops/run.ts does', async () => {
    // `runDir()` is `ops/run.ts`'s `runDirPath`, which is now also what
    // `verifyRun` calls — so this asserts the rest of the path: a log lands at
    // `cycle-NN/verify/<slot>.log` under the run directory and nowhere else.
    await begin({ test: 'exit 0' })

    const digest = await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)

    expect(path.resolve(project.dir, digest.log)).toBe(
      path.join(await runDir(), 'cycle-01', 'verify', 'test.log'),
    )
  })
})

/* ── the project verify lock ──────────────────────────────────────────────── */

describe('verifyRun and the project verify lock', () => {
  it('does not run two verify commands at once, even for different slots', async () => {
    const file = path.join(scratch, 'order')
    const span = (name: string): string =>
      `printf '${name}-start\\n' >> '${file}'; sleep 0.25; printf '${name}-end\\n' >> '${file}'`
    await begin({ test: span('test'), lint: span('lint') })

    await Promise.all([
      verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock),
      verifyRun(project.dir, { slot: 'lint', wait_ms: 4000 }, clock),
    ])

    // Different slots is the case that proves the lock rather than the
    // de-duplicator: the contended resource is the machine, not the slot.
    const lines = (await fs.readFile(file, 'utf8')).split('\n').filter((line) => line !== '')
    expect(lines).toHaveLength(4)
    expect(lines[0]?.replace('-start', '')).toBe(lines[1]?.replace('-end', ''))
    expect(lines[2]?.replace('-start', '')).toBe(lines[3]?.replace('-end', ''))
  })

  it('reports phase queued rather than blocking while another command holds the lock', async () => {
    await begin({ test: counts('runs') })
    const lock = resolveLoopPaths(project.dir).verifyLock
    await fs.mkdir(lock)

    const queued = await verifyRun(project.dir, { slot: 'test', wait_ms: 120 }, clock)

    // Not `running`: no child of this call exists, and a digest that said
    // otherwise is the one lie this design is built to avoid.
    expect(queued.phase).toBe('queued')
    expect(queued.log).toBe('')
    expect(queued.exit_code).toBeNull()
    expect(queued.headline).toContain('another verify command is running')
    expect(await countOf('runs')).toBe(0)

    await fs.rmdir(lock)
    expect((await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)).phase).toBe('complete')
  })

  it('does not blame the lock for its own pre-spawn work', async () => {
    await begin({ test: 'exit 0' })

    // Nothing holds the lock. The window before the spawn is the engine's own:
    // the cache lookup, the worktree digests (three git invocations each), the
    // ledger append, the mkdir and the log open — hundreds of milliseconds on a
    // real repository, and stretched here to a definite one. A digest that
    // reported contention for it would be asserting something that never
    // happened, and two consecutive `queued` digests make the cycle `blocked`.
    const realRename = fs.rename.bind(fs)
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await realRename(from, to)
      // The queued row is written before the lock is contested, so this delay
      // lands squarely in the pre-spawn window.
      if (String(to).endsWith(path.join('verify', 'index.json'))) {
        await new Promise((resolve) => setTimeout(resolve, 400))
      }
    })

    try {
      const queued = await verifyRun(project.dir, { slot: 'test', wait_ms: 50 }, clock)

      expect(queued.phase).toBe('queued')
      expect(queued.headline).toBe('the command has not started yet — call again')
    } finally {
      spy.mockRestore()
    }
    expect((await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)).exit_code).toBe(0)
  })

  it('writes a queued ledger entry and amends it once the lock is won', async () => {
    await begin({ test: 'exit 0' })
    const lock = resolveLoopPaths(project.dir).verifyLock
    await fs.mkdir(lock)

    await verifyRun(project.dir, { slot: 'test', wait_ms: 120 }, clock)

    // Without the entry a verifier could log `pass` citing a command that only
    // ever queued, and the contradiction check would have nothing to read.
    const queued = await ledger()
    expect(queued).toHaveLength(1)
    expect(queued[0]?.phase).toBe('queued')

    await fs.rmdir(lock)
    await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)

    const done = await ledger()
    expect(done).toHaveLength(1)
    expect(done[0]?.phase).toBe('complete')
    expect(done[0]?.exit_code).toBe(0)
  })

  it('reclaims a verify lock left behind by a killed process', async () => {
    await begin({ test: 'exit 0' })
    await writePin({ timeout_ms: 1_000 })
    const lock = resolveLoopPaths(project.dir).verifyLock
    await fs.mkdir(lock)
    // Older than timeout_ms + VERIFY_LOCK_STALE_MARGIN_MS, the derived
    // threshold — the technique tests/store/lock.test.ts already uses.
    const aged = new Date(Date.now() - 600_000)
    await fs.utimes(lock, aged, aged)

    expect((await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)).phase).toBe('complete')
  })

  it('attaches to an in-flight command instead of queueing behind its own lock', async () => {
    await begin({ test: counts('runs', '; sleep 0.2') })

    const both = await Promise.all([
      verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock),
      verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock),
    ])

    // The map is consulted first. Reversed, the second call would queue behind
    // a lock this process already holds — `withLock` is not reentrant — and
    // stall for `lock_timeout_ms` for an answer already in flight.
    expect(both.map((digest) => digest.phase)).toEqual(['complete', 'complete'])
    expect(await countOf('runs')).toBe(1)
  })

  it('does not hold the state lock while a command runs', async () => {
    await begin({ test: 'sleep 0.5' })

    expect((await verifyRun(project.dir, { slot: 'test', wait_ms: 40 }, clock)).phase).toBe('running')

    // `withLock`'s default acquire timeout is 5 000 ms, so a subprocess held
    // inside `.mjloop/.lock` would make this throw.
    await new StateStore(project.dir, clock).update((draft) => {
      draft.goal = 'still writable'
    })
    expect((await state()).goal).toBe('still writable')

    await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)
  })
})

/* ── what a digest extracts ───────────────────────────────────────────────── */

describe('verifyRun digest extraction', () => {
  const replay = (name: string): string => `cat '${path.join(FIXTURES, name)}'`

  it('skips the npm script echo and the runner banner', async () => {
    await begin({ test: replay('npm-green.log') })

    const digest = await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)

    // A banner must never become a signature: `errorSignature` hashes the first
    // line of an excerpt, and npm's echo is identical on green and on red.
    expect(digest.headline).not.toMatch(/^>/)
    expect(digest.headline).not.toMatch(/^RUN\s/)
    expect(digest.failures).toEqual([])
  })

  it("reports the runner's own count line as the headline", async () => {
    await begin({ test: replay('vitest-fail.log') })

    const digest = await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)

    expect(digest.headline).toBe('Tests  17 failed | 764 passed (781)')
  })

  it('falls back to the first failure line when there is no count line', async () => {
    await begin({ lint: replay('tsc-fail.log') })

    const digest = await verifyRun(project.dir, { slot: 'lint', wait_ms: 4000 }, clock)

    expect(digest.headline).toBe(
      "src/ops/index-render.ts(59,25): error TS2339: Property 'lock' does not exist on type 'LoopPaths'.",
    )
  })

  it('caps failures at twenty and reports how many there were', async () => {
    await begin({ test: replay('vitest-fail.log') })

    const digest = await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)

    expect(digest.failures).toHaveLength(20)
    expect(digest.failures_total).toBe(51)
    expect(digest.failures[0]).toEqual({ line: '× runs init then reports a summary 19ms', at: 10 })
  })

  it('falls back to the default patterns when a configured pattern will not compile', async () => {
    await begin({ test: replay('vitest-fail.log') })
    await writePin({ failure_patterns: { test: ['('], lint: [], build: [] } })

    const digest = await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)

    // A typo in a regex must not stop a project verifying, so it is reported
    // rather than thrown — and the documented defaults still find the failures.
    expect(digest.headline).toContain('will not compile')
    expect(digest.failures_total).toBe(51)
  })

  it('honours a configured pattern that does compile', async () => {
    await begin({ test: replay('vitest-fail.log') })
    await writePin({ failure_patterns: { test: ['^ FAIL '], lint: [], build: [] } })

    const digest = await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)

    expect(digest.headline).not.toContain('will not compile')
    expect(digest.failures_total).toBe(17)
  })
})

/* ── the verify-result cache ──────────────────────────────────────────────── */

describe('verifyRun cache', () => {
  async function makeRepo(): Promise<void> {
    await git('git', ['init', '-q', '-b', 'main'], { cwd: project.dir })
    await fs.writeFile(path.join(project.dir, 'src.ts'), 'export const a = 1\n', 'utf8')
    await git('git', ['add', '-A'], { cwd: project.dir })
    await git(
      'git',
      ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'first'],
      { cwd: project.dir },
    )
  }

  async function nextCycle(): Promise<void> {
    await new StateStore(project.dir, clock).update((draft) => {
      draft.cycle += 1
    })
  }

  async function cacheFile(): Promise<unknown[] | null> {
    const raw = await fs.readFile(path.join(await runDir(), 'verify-cache.json'), 'utf8').catch(() => null)
    return raw === null ? null : (JSON.parse(raw) as unknown[])
  }

  it('reuses a green result when the worktree has not moved', async () => {
    await makeRepo()
    await begin({ test: counts('runs') }, { cache: true })

    const first = await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)
    expect(first.cached).toBe(false)
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/)

    await nextCycle()
    const second = await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)

    expect(second.cached).toBe(true)
    expect(second.exit_code).toBe(0)
    expect(await countOf('runs')).toBe(1)
  })

  it('says which cycle a reused result came from', async () => {
    await makeRepo()
    await begin({ test: counts('runs') }, { cache: true })
    await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)
    await nextCycle()

    const digest = await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)

    expect(digest.cached_from_cycle).toBe(1)
    // The output is never copied — the digest points at the original log — and
    // the headline is deliberately not prefixed, because a sentence on the one
    // field that reaches an excerpt would cost more than the run it replaced.
    expect(digest.log).toContain(path.join('cycle-01', 'verify', 'test.log'))
    expect(digest.headline).not.toMatch(/reused/i)
    // A cached invocation still writes a ledger row, so the cycle's record of
    // what its verification rested on stays complete.
    expect((await ledger('cycle-02'))[0]?.cached_from_cycle).toBe(1)
  })

  it('takes no lock for a cache hit', async () => {
    await makeRepo()
    await begin({ test: counts('runs') }, { cache: true })
    await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)
    await nextCycle()
    await fs.mkdir(resolveLoopPaths(project.dir).verifyLock)

    // A hit executes nothing and needs exclusion from nothing.
    const digest = await verifyRun(project.dir, { slot: 'test', wait_ms: 500 }, clock)

    expect(digest.phase).toBe('complete')
    expect(digest.cached).toBe(true)
  })

  it('never reuses a failing result', async () => {
    await makeRepo()
    await begin({ test: counts('runs', '; exit 1') }, { cache: true })

    await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)
    await nextCycle()
    const second = await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)

    // Reusing a red result would let the repeated-error guard fire on output
    // nobody re-produced, halting a run over a defect already fixed.
    expect(second.cached).toBe(false)
    expect(await countOf('runs')).toBe(2)
    expect(await cacheFile()).toBeNull()
  })

  it('never reuses a killed result', async () => {
    await makeRepo()
    await begin({ test: 'sleep 5' }, { cache: true })
    await writePin({ timeout_ms: 200 })

    const digest = await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)

    expect(digest.timed_out).toBe(true)
    expect(await cacheFile()).toBeNull()
  })

  it('re-runs after a single character changes', async () => {
    await makeRepo()
    await begin({ test: counts('runs') }, { cache: true })
    await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)

    await fs.writeFile(path.join(project.dir, 'src.ts'), 'export const a = 2\n', 'utf8')
    await nextCycle()
    const second = await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)

    expect(second.cached).toBe(false)
    expect(await countOf('runs')).toBe(2)
  })

  it('records no cache entry when the command itself wrote a tracked file', async () => {
    await makeRepo()
    await begin({ test: `printf 'x\\n' >> '${path.join('src.ts')}'` }, { cache: true })

    const digest = await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)

    // The pre-spawn digest asserts green at D0 while the process observed the
    // tree move from D0 to D1. Without the post-exit re-digest the reuse bites
    // the moment a later cycle reverts the change.
    expect(digest.exit_code).toBe(0)
    expect(await cacheFile()).toBeNull()
  })

  it('records no cache entry when the tree moved while the command ran', async () => {
    await makeRepo()
    await begin({ test: 'sleep 3' }, { cache: true })

    // Polled rather than guessed. With the cache on, two `worktreeDigest` calls
    // — three git invocations each — precede the spawn, so any single wait
    // small enough to be an interim is also small enough to expire before the
    // child exists on a loaded machine, and the test then reports `queued`.
    let interim = await verifyRun(project.dir, { slot: 'test', wait_ms: 400 }, clock)
    for (let attempt = 0; interim.phase === 'queued' && attempt < 20; attempt += 1) {
      interim = await verifyRun(project.dir, { slot: 'test', wait_ms: 400 }, clock)
    }
    expect(interim.phase).toBe('running')

    await fs.writeFile(path.join(project.dir, 'concurrent.ts'), 'export const b = 2\n', 'utf8')
    const settled = await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)

    expect(settled.exit_code).toBe(0)
    expect(await cacheFile()).toBeNull()
  })

  it('does not reuse an entry whose log a later run of the same slot overwrote', async () => {
    await makeRepo()
    // Green at D0; red once the marker outside the project exists.
    const red = path.join(scratch, 'red')
    await begin(
      {
        test: `${counts('runs')}; if [ -f '${red}' ]; then printf ' FAIL  src/a.test.ts\\n'; exit 1; fi; printf 'ok\\n'`,
      },
      { cache: true },
    )

    const green = await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)
    expect(green.exit_code).toBe(0)
    expect(await cacheFile()).toHaveLength(1)

    // A second invocation of the same slot in the same cycle — the case `label`
    // exists for, and the case `ops/log.ts` bakes into its own error text —
    // truncates and rewrites the very log the green entry points at.
    await fs.writeFile(red, '', 'utf8')
    await fs.writeFile(path.join(project.dir, 'edit.ts'), 'export const b = 2\n', 'utf8')
    expect((await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)).exit_code).toBe(1)
    expect(await logBody()).toContain('FAIL')

    // The tree goes back to D0, which is where the green entry's fingerprint
    // matches — the exact revert the post-exit re-digest exists for.
    await fs.rm(red)
    await fs.rm(path.join(project.dir, 'edit.ts'))
    await nextCycle()
    const third = await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)

    // Existence is not identity. Reusing that log would return `exit_code: 0`
    // and `cached: true` beside a headline and failures extracted from a
    // failing run — and those stale excerpts feed the repeated-error guard,
    // halting a run over a defect that does not exist.
    expect(third.cached).toBe(false)
    expect(third.exit_code).toBe(0)
    expect(third.failures_total).toBe(0)
    expect(third.headline).not.toContain('FAIL')
    expect(await countOf('runs')).toBe(3)
  })

  it('re-runs when the recorded log has been deleted', async () => {
    await makeRepo()
    await begin({ test: counts('runs') }, { cache: true })
    await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)
    await fs.rm(path.join(await runDir(), 'cycle-01', 'verify', 'test.log'))
    await nextCycle()

    // A digest must be able to point the reader at real output.
    const second = await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)

    expect(second.cached).toBe(false)
    expect(await countOf('runs')).toBe(2)
  })

  it('starts a new run with an empty cache', async () => {
    await makeRepo()
    await begin({ test: counts('runs') }, { cache: true })
    await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)

    await runStart(project.dir, { track: 'edit', goal: 'A second run' }, clock)
    await writePin()
    const digest = await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)

    // A fingerprint proves the repository is identical. It proves nothing about
    // node_modules, the Node version or a running database, so the unit of
    // trust is the run.
    expect(digest.cached).toBe(false)
    expect(await countOf('runs')).toBe(2)
    expect(await cacheFile()).toHaveLength(1)
  })

  it('does not cache when the worktree cannot be digested', async () => {
    // No `git init` — the cache is then off, not optimistic.
    await begin({ test: counts('runs') }, { cache: true })

    const digest = await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)

    expect(digest.fingerprint).toBeNull()
    expect(await cacheFile()).toBeNull()
  })

  it('is off unless the config turns it on', async () => {
    await makeRepo()
    await begin({ test: counts('runs') })

    await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)
    await nextCycle()
    const second = await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)

    expect(second.cached).toBe(false)
    expect(await countOf('runs')).toBe(2)
    expect(await cacheFile()).toBeNull()
  })

  it('computes no fingerprint when the cache is off', async () => {
    await makeRepo()
    // A `git` earlier on PATH than the real one, so the probe is observable: a
    // disabled feature must cost nothing at all, not merely return null.
    const bin = path.join(scratch, 'bin')
    await fs.mkdir(bin, { recursive: true })
    await fs.writeFile(path.join(bin, 'git'), `#!/bin/sh\nprintf 'x\\n' >> '${path.join(scratch, 'git-calls')}'\nexit 1\n`, {
      mode: 0o755,
    })
    const realPath = process.env.PATH
    process.env.PATH = `${bin}${path.delimiter}${realPath ?? ''}`
    try {
      await begin({ test: 'exit 0' })
      await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)
      expect(await countOf('git-calls')).toBe(0)

      await configure((config) => {
        config.verify_cache = true
      })
      await writePin()
      await verifyRun(project.dir, { slot: 'test', label: 'again', wait_ms: 4000 }, clock)
      expect(await countOf('git-calls')).toBeGreaterThan(0)
    } finally {
      process.env.PATH = realPath
    }
  })
})
