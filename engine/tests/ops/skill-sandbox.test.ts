import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile, spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { detectSandboxBackend, runSkillSandbox, type SkillSandboxDeps } from '../../src/ops/skill-sandbox.js'

/**
 * Every test here injects both `detectBackend` and `spawn`, so nothing below
 * depends on whether this machine actually has `sandbox-exec` or `bwrap` —
 * the same reason `deps.fetch` lets the rest of this pipeline's tests avoid
 * the network. That is deliberate: CI has neither backend, a developer's
 * darwin machine already has `sandbox-exec`, and the required tests must
 * pass identically on both. The one test that calls the *real*
 * `detectSandboxBackend` is gated behind checking its own result first and
 * only asserts the shape of what comes back, never a specific host tool.
 */

/** A minimal stand-in for Node's `ChildProcess`: stdout/stderr emitters, `kill`, and `close`/`error` events. */
class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed = false
  kill(): boolean {
    this.killed = true
    // A killed process reports no exit code — the caller treats `timedOut` as authoritative.
    this.emit('close', null)
    return true
  }
}

/** The detection result a test injects when it wants a backend without depending on this host having one. */
const FAKE_DARWIN_BACKEND = { backend: 'sandbox-exec', bin: '/usr/bin/sandbox-exec' } as const

/** Builds a `spawn` double that resolves immediately with a fixed exit code and optional output, recording every call. */
function scriptedSpawn(script: {
  exitCode?: number
  stdout?: string
  stderr?: string
  hang?: boolean
}): { spawn: SkillSandboxDeps['spawn']; calls: Array<{ command: string; args: string[]; options: unknown }> } {
  const calls: Array<{ command: string; args: string[]; options: unknown }> = []
  const spawn = ((command: string, args: readonly string[] = [], options: unknown) => {
    calls.push({ command, args: [...args], options })
    const child = new FakeChildProcess()
    if (!script.hang) {
      queueMicrotask(() => {
        if (script.stdout !== undefined) child.stdout.emit('data', Buffer.from(script.stdout))
        if (script.stderr !== undefined) child.stderr.emit('data', Buffer.from(script.stderr))
        child.emit('close', script.exitCode ?? 0)
      })
    }
    return child as unknown as ChildProcess
  }) as SkillSandboxDeps['spawn']
  return { spawn, calls }
}

async function snapshot(dir: string): Promise<string[]> {
  return (await fs.readdir(dir)).sort()
}

describe('runSkillSandbox', () => {
  it('skips an instruction-only package and records why — acceptable with no backend at all', async () => {
    const detectBackend = vi.fn(() => null)
    const { spawn } = scriptedSpawn({})
    const result = await runSkillSandbox({ files: [], executableFiles: [], smokeChecks: undefined }, { detectBackend, spawn })

    expect(result).toEqual({ state: 'skipped', reason: 'no executable content' })
    // Skipping must not even ask whether a backend exists — there is nothing to run.
    expect(detectBackend).not.toHaveBeenCalled()
  })

  it('reports unavailable and spawns nothing when no backend is detected', async () => {
    const detectBackend = vi.fn((): null => null)
    const { spawn, calls } = scriptedSpawn({ exitCode: 0 })
    const result = await runSkillSandbox(
      { files: [], executableFiles: ['run.sh'], smokeChecks: [['./run.sh']] },
      { detectBackend, spawn },
    )

    expect(result.state).toBe('unavailable')
    if (result.state === 'unavailable') expect(result.reason).toMatch(/sandbox-exec|bwrap/)
    expect(calls).toHaveLength(0)
  })

  it('cannot pass a package with executable content but no declared smoke checks', async () => {
    const detectBackend = () => FAKE_DARWIN_BACKEND
    const { spawn, calls } = scriptedSpawn({ exitCode: 0 })
    const result = await runSkillSandbox({ files: [], executableFiles: ['run.sh'], smokeChecks: [] }, { detectBackend, spawn })

    expect(result.state).toBe('failed')
    expect(calls).toHaveLength(0)
  })

  it('refuses a smoke check declared as a shell string instead of an argv array', async () => {
    const detectBackend = () => FAKE_DARWIN_BACKEND
    const { spawn, calls } = scriptedSpawn({ exitCode: 0 })
    const result = await runSkillSandbox(
      { files: [], executableFiles: ['run.sh'], smokeChecks: ['./run.sh --danger'] },
      { detectBackend, spawn },
    )

    expect(result.state).toBe('failed')
    if (result.state === 'failed') expect(result.output.text).toMatch(/argv array/)
    expect(calls).toHaveLength(0)
  })

  it('hands the check a fixed environment allowlist — nothing else from the parent environment leaks through', async () => {
    const originalSecret = process.env.MJLOOP_TEST_SECRET
    process.env.MJLOOP_TEST_SECRET = 'super-secret-token-do-not-leak'
    try {
      const detectBackend = () => FAKE_DARWIN_BACKEND
      const { spawn, calls } = scriptedSpawn({ exitCode: 0 })
      await runSkillSandbox({ files: [], executableFiles: ['run.sh'], smokeChecks: [['echo', 'hi']] }, { detectBackend, spawn })

      expect(calls).toHaveLength(1)
      const env = (calls[0]?.options as { env: NodeJS.ProcessEnv }).env
      expect(Object.keys(env).sort()).toEqual(['HOME', 'LANG', 'PATH'])
      expect(JSON.stringify(env)).not.toContain('super-secret-token-do-not-leak')
    } finally {
      if (originalSecret === undefined) delete process.env.MJLOOP_TEST_SECRET
      else process.env.MJLOOP_TEST_SECRET = originalSecret
    }
  })

  it('never puts a project path in cwd, env, or argv', async () => {
    const projectMarker = '/Volumes/SSD/Projects/loop-marker-that-must-never-leak'
    const detectBackend = () => FAKE_DARWIN_BACKEND
    const { spawn, calls } = scriptedSpawn({ exitCode: 0 })
    await runSkillSandbox({ files: [], executableFiles: ['run.sh'], smokeChecks: [['echo', 'hi']] }, { detectBackend, spawn })

    const call = calls[0] as { command: string; args: string[]; options: { cwd: string; env: NodeJS.ProcessEnv } }
    const serialized = JSON.stringify(call)
    expect(serialized).not.toContain(projectMarker)
    expect(call.options.cwd).not.toContain(projectMarker)
  })

  it('kills a check that exceeds the timeout and reports it failed, not awaited', async () => {
    // `timeoutMs` is injected here purely so this test does not have to wait
    // out the real 30s bound — every real caller gets `SMOKE_CHECK_TIMEOUT_MS`.
    const detectBackend = () => FAKE_DARWIN_BACKEND
    const { spawn } = scriptedSpawn({ hang: true })
    const result = await runSkillSandbox(
      { files: [], executableFiles: ['run.sh'], smokeChecks: [['sleep', '999']] },
      { detectBackend, spawn, timeoutMs: 20 },
    )

    expect(result.state).toBe('failed')
    if (result.state === 'failed') {
      expect(result.checks).toHaveLength(1)
      expect(result.checks[0]?.timedOut).toBe(true)
      expect(result.checks[0]?.exitCode).toBeNull()
    }
  })

  it('bounds captured output and never prints the parent environment', async () => {
    const originalSecret = process.env.MJLOOP_TEST_SECRET
    process.env.MJLOOP_TEST_SECRET = 'must-not-appear-in-output'
    try {
      const detectBackend = () => FAKE_DARWIN_BACKEND
      const hugeOutput = 'x'.repeat(50_000)
      const { spawn } = scriptedSpawn({ exitCode: 0, stdout: hugeOutput })
      const result = await runSkillSandbox({ files: [], executableFiles: ['run.sh'], smokeChecks: [['echo', 'hi']] }, { detectBackend, spawn })

      expect(result.state).toBe('passed')
      if (result.state === 'passed') {
        expect(result.output.text.length).toBeLessThanOrEqual(20_000)
        expect(result.output.truncated).toBe(true)
        expect(result.output.text).not.toContain('must-not-appear-in-output')
      }
    } finally {
      if (originalSecret === undefined) delete process.env.MJLOOP_TEST_SECRET
      else process.env.MJLOOP_TEST_SECRET = originalSecret
    }
  })

  it('spawns the absolute backend path detection verified, never a bare name PATH could resolve elsewhere', async () => {
    // A bare `sandbox-exec` at argv[0] is resolved through the inherited PATH,
    // so any file of that name in an earlier PATH directory would run instead
    // of the binary detection checked — an unsandboxed spawn still reporting
    // `passed`. argv[0] must be the path detection returned, and absolute.
    const detectBackend = () => ({ backend: 'sandbox-exec', bin: '/usr/bin/sandbox-exec' }) as const
    const { spawn, calls } = scriptedSpawn({ exitCode: 0 })
    await runSkillSandbox({ files: [], executableFiles: ['run.sh'], smokeChecks: [['./run.sh']] }, { detectBackend, spawn })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe('/usr/bin/sandbox-exec')
    expect(path.isAbsolute(calls[0]?.command as string)).toBe(true)
    // ...and never as a mere argument either.
    expect(calls[0]?.args).not.toContain('sandbox-exec')
  })

  it('gives the check its own process group so a timeout can kill everything it started', async () => {
    const detectBackend = () => FAKE_DARWIN_BACKEND
    const { spawn, calls } = scriptedSpawn({ exitCode: 0 })
    await runSkillSandbox({ files: [], executableFiles: ['run.sh'], smokeChecks: [['./run.sh']] }, { detectBackend, spawn })

    expect((calls[0]?.options as { detached: boolean }).detached).toBe(true)
    expect((calls[0]?.options as { shell: boolean }).shell).toBe(false)
  })

  it('settles on a check that exits without ever closing its inherited stdio pipes', async () => {
    // A check that backgrounds anything (`sleep 30 & echo started`) leaves that
    // process holding the stdout fd, so `'close'` never arrives. Waiting for it
    // alone hangs the pipeline forever and leaks the temp root with it.
    const exitOnly = ((command: string, args: readonly string[] = [], options: unknown) => {
      void command
      void args
      void options
      const child = new FakeChildProcess()
      queueMicrotask(() => child.emit('exit', 0))
      return child as unknown as ChildProcess
    }) as SkillSandboxDeps['spawn']

    const result = await runSkillSandbox(
      { files: [], executableFiles: ['run.sh'], smokeChecks: [['./run.sh']] },
      { detectBackend: () => FAKE_DARWIN_BACKEND, spawn: exitOnly, timeoutMs: 5_000 },
    )
    expect(result.state).toBe('passed')
    if (result.state === 'passed') expect(result.checks[0]?.exitCode).toBe(0)
  }, 3_000)

  it('bounds the whole phase, not just each check — a package cannot multiply its runtime by declaring more checks', async () => {
    const detectBackend = () => FAKE_DARWIN_BACKEND
    const { spawn, calls } = scriptedSpawn({ hang: true })
    const result = await runSkillSandbox(
      { files: [], executableFiles: ['run.sh'], smokeChecks: [['./a'], ['./b'], ['./c']] },
      { detectBackend, spawn, timeoutMs: 30, totalTimeoutMs: 40 },
    )

    expect(result.state).toBe('failed')
    if (result.state === 'failed') {
      expect(result.checks).toHaveLength(3)
      expect(result.checks.every((check) => check.timedOut)).toBe(true)
      // The budget was spent before the last check, so it was never spawned at all.
      expect(calls.length).toBeLessThan(3)
      expect(result.output.text).toContain('total wall-clock budget')
    }
  })

  describe('filesystem footprint', () => {
    let tmpBefore: string[]
    let repoBefore: string[]
    const repoRoot = path.resolve(new URL('../../', import.meta.url).pathname)

    /**
     * Only this module's own temp roots. Snapshotting all of `os.tmpdir()`
     * measured "did anything on this machine touch tmp during this test" —
     * vitest runs test files in parallel workers and eleven of them create
     * temp directories there — so it failed for reasons that had nothing to do
     * with the sandbox, and could equally mask a real regression.
     */
    async function sandboxTempRoots(): Promise<string[]> {
      return (await snapshot(os.tmpdir())).filter((entry) => entry.startsWith('mjloop-skill-sandbox-'))
    }

    beforeEach(async () => {
      tmpBefore = await sandboxTempRoots()
      repoBefore = await snapshot(repoRoot)
    })

    afterEach(async () => {
      const tmpAfter = await sandboxTempRoots()
      const repoAfter = await snapshot(repoRoot)
      expect(tmpAfter).toEqual(tmpBefore)
      expect(repoAfter).toEqual(repoBefore)
    })

    it('creates no file outside its own disposable temp directory, and cleans it up', async () => {
      const detectBackend = () => FAKE_DARWIN_BACKEND
      const { spawn } = scriptedSpawn({ exitCode: 0 })
      const result = await runSkillSandbox(
        { files: [{ path: 'run.sh', content: Buffer.from('#!/bin/sh\necho hi\n') }], executableFiles: ['run.sh'], smokeChecks: [['./run.sh']] },
        { detectBackend, spawn },
      )
      expect(result.state).toBe('passed')
    })
  })

  it('detects only a real isolation mechanism — never a bare spawn called a sandbox', () => {
    const detected = detectSandboxBackend()
    // No assertion on *which* backend (or none) this host has — only that the
    // detector never invents a value outside the two honest possibilities, and
    // that what it reports is an absolute path it actually verified.
    expect([null, 'sandbox-exec', 'bwrap']).toContain(detected === null ? null : detected.backend)
    if (detected !== null) {
      expect(path.isAbsolute(detected.bin)).toBe(true)
      expect(existsSync(detected.bin)).toBe(true)
    }
  })
})

/**
 * The only tests here that use the real backend and the real `spawn`. They are
 * skipped on a machine with neither `sandbox-exec` nor `bwrap`, because there
 * is nothing to assert about a boundary that is honestly unavailable — but
 * where one exists, an injected `spawn` can never show whether the profile the
 * module builds actually confines anything, and that is the whole claim.
 */
describe.skipIf(detectSandboxBackend() === null)('runSkillSandbox against the real backend', () => {
  const realDeps: SkillSandboxDeps = { detectBackend: detectSandboxBackend, spawn: nodeSpawn }

  function input(smokeChecks: string[][]): Parameters<typeof runSkillSandbox>[0] {
    return {
      files: [{ path: 'SKILL.md', content: Buffer.from('# x\n') }, { path: 'run.sh', content: Buffer.from('#!/bin/sh\necho hi\n') }],
      executableFiles: ['run.sh'],
      smokeChecks,
    }
  }

  it('lets a declared check write inside its own disposable cwd', async () => {
    // The seatbelt `subpath` rule is matched against the *canonical* path, and
    // on macOS `os.tmpdir()` is a symlink — an uncanonicalised root makes every
    // writing check fail for a reason that has nothing to do with the package.
    const result = await runSkillSandbox(input([['/usr/bin/touch', 'probe.txt']]), realDeps)
    expect(result.state).toBe('passed')
  }, 20_000)

  it('denies a declared check any read of the project checkout or the user\'s home', async () => {
    const projectFile = fileURLToPath(new URL('../../package.json', import.meta.url))
    const result = await runSkillSandbox(input([['/bin/cat', projectFile]]), realDeps)

    expect(result.state).toBe('failed')
    if (result.state === 'failed') {
      expect(result.output.text).not.toContain('@mjloop/engine')
      expect(result.output.text).toMatch(/not permitted|Operation not permitted/i)
    }
  }, 20_000)

  it('denies a declared check any write outside its own disposable cwd', async () => {
    const canary = path.join(os.homedir(), 'mjloop-sandbox-canary-must-never-exist')
    const result = await runSkillSandbox(input([['/usr/bin/touch', canary]]), realDeps)

    expect(result.state).toBe('failed')
    expect(existsSync(canary)).toBe(false)
  }, 20_000)

  it('bounds a check that backgrounds a process — it neither hangs nor leaves the process running', async () => {
    // A distinctive duration so the survivor check below can only ever match
    // this test's own processes.
    const marker = `88.${process.pid}`
    const started = Date.now()
    const result = await runSkillSandbox(
      // The backgrounded `sleep` keeps holding the stdout pipe after `sh`
      // exits, so a run that settles only on `'close'` waits for it forever,
      // and a kill aimed at the direct child alone never reaches it.
      input([['/bin/sh', '-c', `sleep ${marker} & sleep ${marker}`]]),
      { ...realDeps, timeoutMs: 700 },
    )
    const elapsed = Date.now() - started

    expect(result.state).toBe('failed')
    expect(elapsed).toBeLessThan(10_000)

    await new Promise((resolve) => setTimeout(resolve, 1_000))
    // `execFile` with an argv array, never a shell — the same rule this whole story runs on.
    const survivors = await new Promise<string>((resolve) => {
      execFile('/bin/ps', ['-Ao', 'command'], (_error, stdout) => resolve(stdout ?? ''))
    })
    expect(survivors).not.toContain(`sleep ${marker}`)
  }, 20_000)
})
