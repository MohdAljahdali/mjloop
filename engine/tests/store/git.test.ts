import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initLoop } from '../../src/ops/init.js'
import { runLog } from '../../src/ops/log.js'
import { runStart } from '../../src/ops/run.js'
import { UNTRACKED_MAX, headSha, worktreeDigest } from '../../src/store/git.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const run = promisify(execFile)

const NOW = new Date('2026-07-28T10:36:00.000Z')
const clock = (): Date => NOW

let project: TmpProject
beforeEach(async () => { project = await makeTmpProject() })
afterEach(async () => { await project.cleanup() })

/**
 * A repository with one commit, configured so `git commit` works with no user
 * identity and no signing key on the machine running the tests.
 */
async function makeRepo(files: Record<string, string> = { 'src/a.ts': 'export const a = 1\n' }): Promise<void> {
  await run('git', ['init', '-q', '-b', 'main'], { cwd: project.dir })
  await write(files)
  await commit('first')
}

async function write(files: Record<string, string>): Promise<void> {
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(project.dir, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, contents, 'utf8')
  }
}

async function commit(message: string): Promise<void> {
  await run('git', ['add', '-A'], { cwd: project.dir })
  await run(
    'git',
    [
      '-c', 'user.email=test@example.com',
      '-c', 'user.name=test',
      '-c', 'commit.gpgsign=false',
      'commit', '-q', '-m', message,
    ],
    { cwd: project.dir },
  )
}

describe('worktreeDigest', () => {
  it('digests a clean repository deterministically across two calls', async () => {
    await makeRepo()
    const first = await worktreeDigest(project.dir)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(await worktreeDigest(project.dir)).toBe(first)
  })

  it('changes when a tracked file changes', async () => {
    await makeRepo()
    const before = await worktreeDigest(project.dir)
    await write({ 'src/a.ts': 'export const a = 2\n' })
    expect(await worktreeDigest(project.dir)).not.toBe(before)
  })

  it('changes when a tracked file is edited twice to different content', async () => {
    // The porcelain-collision test, and the reason the diff is hashed rather
    // than the status: two different edits to one file produce the same status
    // line, and a cache that collided there would reuse a green result for code
    // that changed.
    await makeRepo()
    await write({ 'src/a.ts': 'export const a = 2\n' })
    const first = await worktreeDigest(project.dir)
    await write({ 'src/a.ts': 'export const a = 3\n' })
    expect(await worktreeDigest(project.dir)).not.toBe(first)
  })

  it('changes when a staged edit is committed', async () => {
    await makeRepo()
    await write({ 'src/a.ts': 'export const a = 2\n' })
    const dirty = await worktreeDigest(project.dir)
    await commit('second')
    expect(await worktreeDigest(project.dir)).not.toBe(dirty)
  })

  it('changes when an untracked file appears', async () => {
    // An untracked new module is exactly the shape of a build that must not be
    // skipped.
    await makeRepo()
    const before = await worktreeDigest(project.dir)
    await write({ 'src/b.ts': 'export const b = 1\n' })
    expect(await worktreeDigest(project.dir)).not.toBe(before)
  })

  it('changes when an untracked file is renamed but keeps its content', async () => {
    // hash-object reports blob ids only, so the names go into the digest too.
    await makeRepo()
    await write({ 'src/b.ts': 'export const b = 1\n' })
    const before = await worktreeDigest(project.dir)
    await fs.rename(path.join(project.dir, 'src/b.ts'), path.join(project.dir, 'src/c.ts'))
    expect(await worktreeDigest(project.dir)).not.toBe(before)
  })

  it('ignores a path git is told to ignore', async () => {
    await makeRepo({ 'src/a.ts': 'export const a = 1\n', '.gitignore': 'build/\n' })
    const before = await worktreeDigest(project.dir)
    await write({ 'build/out.js': 'console.log(1)\n' })
    // Stated as a limitation rather than a feature: a cycle that regenerates an
    // ignored artefact can draw a hit on a green from before it, which is why
    // verify_cache is off by default and its comment names the exclusion.
    expect(await worktreeDigest(project.dir)).toBe(before)
  })

  it("ignores the loop's own directory in a project that does not gitignore it", async () => {
    // The test that would have caught a cache that was dead on arrival.
    // initLoop never writes a .gitignore entry, so in a project that has not
    // added one by hand every StateStore.update and every cycle-NN/<agent>.json
    // changes the untracked set — and the fingerprint could never repeat. This
    // plugin's own repository *does* ignore .mjloop/, so a suite run only here
    // would have passed while the feature never fired for a user.
    await makeRepo()
    expect(await gitIgnores('.mjloop/state.json')).toBe(false)

    await initLoop(project.dir, clock)
    await runStart(project.dir, { track: 'build', goal: 'Add it' }, clock)
    await runLog(project.dir, { agent: 'builder', result: pass('one') }, clock)
    const before = await worktreeDigest(project.dir)

    await runLog(project.dir, { agent: 'verifier', result: pass('two') }, clock)
    expect(await worktreeDigest(project.dir)).toBe(before)
  })

  it('digests a diff larger than the default child buffer', async () => {
    // The streaming regression test. execFile's default maxBuffer is 1 MiB, so
    // a buffered `git diff HEAD --binary` throws ENOBUFS on a large working
    // tree — and the cache would switch itself off for exactly the repositories
    // where it would pay.
    await makeRepo({ 'src/big.ts': 'a\n'.repeat(800_000) })
    const before = await worktreeDigest(project.dir)
    await write({ 'src/big.ts': `${'b\n'.repeat(800_000)}` })
    const after = await worktreeDigest(project.dir)
    expect(after).toMatch(/^[0-9a-f]{64}$/)
    expect(after).not.toBe(before)
  })

  it('returns null above the untracked-path bound', async () => {
    // A project mid-npm-install would otherwise spend the caller's whole wait
    // budget on the cache rather than on the suite.
    await makeRepo()
    const dir = path.join(project.dir, 'many')
    await fs.mkdir(dir, { recursive: true })
    await Promise.all(
      Array.from({ length: UNTRACKED_MAX + 1 }, (_unused, index) => fs.writeFile(path.join(dir, `f${index}.txt`), 'x', 'utf8')),
    )
    expect(await worktreeDigest(project.dir)).toBeNull()
  })

  it('returns null outside a git repository', async () => {
    // No proof that the input did not change means no reuse. The cache is then
    // off, not optimistic.
    await write({ 'src/a.ts': 'export const a = 1\n' })
    expect(await worktreeDigest(project.dir)).toBeNull()
  })

  it('returns null on a repository with no commit yet', async () => {
    await run('git', ['init', '-q', '-b', 'main'], { cwd: project.dir })
    await write({ 'src/a.ts': 'export const a = 1\n' })
    expect(await worktreeDigest(project.dir)).toBeNull()
  })

  it('returns null when the caller has already given up', async () => {
    await makeRepo()
    expect(await worktreeDigest(project.dir, AbortSignal.abort())).toBeNull()
  })

  /** True when git would exclude the path — the premise of the .mjloop test. */
  async function gitIgnores(relative: string): Promise<boolean> {
    try {
      await run('git', ['check-ignore', '-q', '--', relative], { cwd: project.dir })
      return true
    } catch {
      return false
    }
  }
})

describe('headSha', () => {
  it('names the commit the tree is actually at', async () => {
    await makeRepo()
    const { stdout } = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: project.dir })
    expect(await headSha(project.dir)).toBe(stdout.trim())
  })

  it('moves when a commit is made', async () => {
    // The stamp's whole job is telling two map sections apart, so it has to
    // follow HEAD rather than the tree.
    await makeRepo()
    const before = await headSha(project.dir)
    await write({ 'src/a.ts': 'export const a = 2\n' })
    await commit('second')
    expect(await headSha(project.dir)).not.toBe(before)
  })

  it('returns null outside a git repository', async () => {
    // Every unanswerable case is `null`, exactly as worktreeDigest's is: the
    // caller stamps "no git" rather than a sha, and an invented sha would make
    // a map heading claim a tree it cannot name.
    await write({ 'src/a.ts': 'export const a = 1\n' })
    expect(await headSha(project.dir)).toBeNull()
  })

  it('returns null on a repository with no commit yet', async () => {
    await run('git', ['init', '-q', '-b', 'main'], { cwd: project.dir })
    await write({ 'src/a.ts': 'export const a = 1\n' })
    expect(await headSha(project.dir)).toBeNull()
  })

  it('returns null when the caller has already given up', async () => {
    await makeRepo()
    expect(await headSha(project.dir, AbortSignal.abort())).toBeNull()
  })
})

function pass(summary: string): unknown {
  return { status: 'pass', summary, evidence: [], findings: [], files_touched: [], next_hint: null }
}
