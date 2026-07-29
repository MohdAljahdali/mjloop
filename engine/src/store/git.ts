import { spawn } from 'node:child_process'
import { createHash, type Hash } from 'node:crypto'

/**
 * Everywhere `engine/src` shells out to git.
 *
 * Two questions are asked of the repository and both answer by the same rules:
 * `worktreeDigest`, for the verify cache, which may only ever assert that *an
 * identical command was run against an identical repository and exited 0*; and
 * `headSha`, for the run map's provenance stamp. Everything here is either
 * making a claim like that true or refusing to make it — `null` is a legitimate,
 * common answer, and it switches the cache off (and the stamp to "no git")
 * rather than making either of them optimistic.
 *
 * Being the only door matters as much as the rules do. A second
 * `spawn('git', …)` anywhere else in `engine/src` is a second set of answers to
 * missing git, an aborted signal and a non-zero exit, kept in step with these
 * by hand. `headSha` lived in `ops/log.ts` as its own `spawn` for exactly one
 * batch and already differed: it honoured no `AbortSignal` at all, so a caller
 * that had given up still forked a child. `ops/fingerprint.ts` stays pure
 * precisely so this file can be the impure half.
 */

/**
 * Above this many untracked paths, the digest gives up.
 *
 * A project mid-`npm install`, or one with no `.gitignore` for its dependency
 * directory, produces tens of thousands of untracked paths; hashing them all
 * inside the caller's wait budget would spend the budget on the cache rather
 * than on the suite. The bound is documented rather than discovered.
 */
export const UNTRACKED_MAX = 5_000

/**
 * The loop's own directory, excluded from every source below.
 *
 * **This exclusion is the difference between a working cache and one that is
 * dead on arrival.** `initLoop` creates `.mjloop/` and never writes a
 * `.gitignore` entry, so in any project that has not added one by hand the
 * directory is untracked-but-not-ignored — and every `StateStore.update`, every
 * `cycle-NN/<agent>.json`, every `roster.json` and every verify log changes the
 * untracked set between cycle 1's `test` and cycle 2's. The fingerprint could
 * essentially never repeat. This plugin's own repository *does* ignore
 * `.mjloop/`, so a test suite run only here would have passed while the feature
 * never fired for a user.
 */
const EXCLUDE_LOOP = ':(exclude).mjloop/'

/**
 * A digest of exactly what the working tree contains, without touching the
 * index. `null` when this is not a git repository, when git is unavailable, or
 * when any of the three commands fails.
 *
 * `git write-tree` and `git stash create` would have been shorter and are
 * rejected: both mutate the index, and a verification tool that alters the
 * repository it verifies is the same category of mistake as a verifier that
 * edits its subject.
 *
 * What it deliberately does **not** see, because the safety argument leans on
 * completeness and the gaps belong beside it: anything `--exclude-standard`
 * omits (`.gitignore`, `.git/info/exclude`, `core.excludesFile` — so `.env`,
 * generated code, ignored build output), and anything outside the repository at
 * all (`node_modules`, the Node version, a running database, the clock). A
 * project whose build inputs live outside git must leave `verify_cache` off.
 */
export async function worktreeDigest(projectDir: string, signal?: AbortSignal): Promise<string | null> {
  const hash = createHash('sha256')

  // The committed baseline.
  const head = await capture(['rev-parse', 'HEAD'], projectDir, signal)
  if (head === null) return null
  hash.update('head\0').update(head.trim()).update('\0')

  // The exact content of every tracked modification, streamed rather than
  // buffered. A status line is not enough: two different edits to one file
  // produce the same porcelain line, and a cache that collided there would
  // reuse a green result for code that changed. `--no-textconv` because a
  // `.gitattributes` textconv or custom diff driver can make two different file
  // contents produce identical diff bytes. The submodule flags because
  // `git diff HEAD` otherwise sees only the gitlink commit, so a run that
  // touched a submodule's working tree would cache straight across it.
  hash.update('diff\0')
  const diffed = await stream(
    [
      'diff',
      'HEAD',
      '--binary',
      '--no-textconv',
      '--ignore-submodules=none',
      '--submodule=diff',
      '--',
      '.',
      EXCLUDE_LOOP,
    ],
    projectDir,
    hash,
    signal,
  )
  if (!diffed) return null
  hash.update('\0')

  // Untracked files are code too, and an untracked new module is exactly the
  // shape of a build that must not be skipped.
  // `-z` so git emits raw path bytes rather than its quoted form, which would
  // otherwise have to be unescaped before `hash-object` could be given it. A
  // path that is not valid UTF-8 decodes to replacement characters here, and
  // `hash-object` then fails to find it — so the digest is `null` and the cache
  // is off, which is the direction this whole file fails in.
  const listed = await capture(['ls-files', '--others', '--exclude-standard', '-z', '--', '.', EXCLUDE_LOOP], projectDir, signal)
  if (listed === null) return null
  const untracked = listed.split('\0').filter((entry) => entry.length > 0).sort()
  if (untracked.length > UNTRACKED_MAX) return null

  // The names go into the hash as well as the contents. `hash-object` reports
  // blob ids only, so renaming an untracked file — or swapping two of them —
  // would otherwise leave the digest unmoved.
  hash.update('untracked\0')
  for (const file of untracked) hash.update(file).update('\0')

  if (untracked.length > 0) {
    // `--stdin-paths` reads newline-separated paths, so a path containing a
    // newline cannot be expressed. Refusing is the only safe answer: sending it
    // anyway would hash one file under two names and silently under-report the
    // tree.
    if (untracked.some((file) => file.includes('\n'))) return null
    // One process for the whole list, not one per file: forking thousands of
    // children inside the caller's wait budget is how this ends up costing more
    // than the suite it was meant to skip.
    const hashed = await stream(['hash-object', '--stdin-paths'], projectDir, hash, signal, `${untracked.join('\n')}\n`)
    if (!hashed) return null
  }

  return hash.digest('hex')
}

/**
 * The abbreviated sha of `HEAD`, or `null` when the repository cannot answer:
 * not a git repository, no commit yet, git unavailable, or a caller that has
 * already aborted.
 *
 * `--short`, unlike `worktreeDigest`'s full `rev-parse HEAD`, because this one
 * is stamped into prose a person reads rather than into a hash.
 *
 * The `null` is load-bearing at the call site: a map section's heading claims
 * *this paragraph describes that tree*, so a stamp invented from a failed
 * command would make two contradicting sections look resolvable when they are
 * not. The caller renders the absence as "no git" and the map is still written —
 * a project without a repository gets its map, it simply cannot stamp one.
 */
export async function headSha(projectDir: string, signal?: AbortSignal): Promise<string | null> {
  const out = await capture(['rev-parse', '--short', 'HEAD'], projectDir, signal)
  if (out === null) return null
  // Exit 0 with an empty stdout is not a sha. Passing `''` on would stamp
  // `(HEAD )` into the document, which reads as an answer rather than as the
  // absence of one.
  const sha = out.trim()
  return sha === '' ? null : sha
}

/**
 * Run git and hand every stdout chunk to `sink` as it arrives.
 *
 * Streamed, never buffered: `execFile`/`exec` default `maxBuffer` is 1 MiB, so
 * a buffered `git diff HEAD --binary` throws `ENOBUFS` on a large working tree
 * and the cache silently switches off for exactly the repositories where it
 * would pay.
 */
async function run(
  args: string[],
  cwd: string,
  sink: (chunk: Buffer) => void,
  signal: AbortSignal | undefined,
  stdin?: string,
): Promise<boolean> {
  return await new Promise((resolve) => {
    let child
    try {
      child = spawn('git', args, { cwd, signal, stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'] })
    } catch {
      // git missing, or an already-aborted signal. Neither is an error to
      // report: the contract is that an unanswerable question turns the cache
      // off, and a throw here would take the verify invocation down with it.
      return resolve(false)
    }
    child.stdout?.on('data', sink)
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
    if (stdin !== undefined) {
      // An EPIPE here means git exited early, which the `close` handler above
      // already reports — so the write error is absorbed rather than thrown
      // from a callback nobody is awaiting.
      child.stdin?.on('error', () => {})
      child.stdin?.end(stdin)
    }
  })
}

/** Stream straight into the digest. */
async function stream(args: string[], cwd: string, hash: Hash, signal: AbortSignal | undefined, stdin?: string): Promise<boolean> {
  return await run(args, cwd, (chunk) => hash.update(chunk), signal, stdin)
}

/** The same runner for the commands whose output is small and needed whole. */
async function capture(args: string[], cwd: string, signal: AbortSignal | undefined): Promise<string | null> {
  const chunks: Buffer[] = []
  const ok = await run(args, cwd, (chunk) => chunks.push(chunk), signal)
  return ok ? Buffer.concat(chunks).toString('utf8') : null
}
