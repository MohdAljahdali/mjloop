import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The boundary between the browser and the engine, asserted from source text.
 *
 * The write path bypasses the `PreToolUse` state guard entirely — it is the
 * server process, not a `claude` tool call — so this boundary has to be
 * structural rather than a hook. Two of its four layers are compile-time
 * (`HANDLERS` is a mapped type over `Write['kind']`, and every wire schema is
 * `strictObject`); the other two are here.
 *
 * These are not style rules. Each entry below names a specific way a browser
 * could be made to claim work nobody performed.
 */

const WEB_DIR = fileURLToPath(new URL('../../src/web/', import.meta.url))

async function walk(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    // Task 12 deleted `src/web/public/` from source — it no longer exists to
    // walk into on a clean checkout, and `vitest.config.ts`'s
    // `serverPublicDirForTests` plugin means a test run never writes one back
    // either. The skip stays anyway, defensively: nothing that could ever
    // land at this path — a stray local build artifact, a leftover directory
    // from before that plugin existed — is TypeScript the engine imports, so
    // descending into it is never useful and would only be a way for
    // something irrelevant to be walked by accident.
    if (entry.isDirectory()) {
      if (entry.name !== 'public') out.push(...(await walk(path.join(dir, entry.name), relative)))
      continue
    }
    if (entry.name.endsWith('.ts')) out.push(relative)
  }
  return out
}

const files = await walk(WEB_DIR)
const source = new Map<string, string>()
for (const name of files) source.set(name, await fs.readFile(path.join(WEB_DIR, name), 'utf8'))

const read = (name: string): string => source.get(name) ?? ''

/**
 * Each entry is a name and the reason it may not appear anywhere under
 * `src/web/`. The reason is part of the test on purpose: a future reader
 * deleting one of these should have to argue with the sentence, not just the
 * identifier.
 */
const FORBIDDEN: [string, string][] = [
  ['runLog', 'opens a gated track\'s gate from the payload\'s evidence array alone — a click could "prove" a reproduction nobody ran'],
  ['runStart', 'wipes findings, history, guard counters and the reproduction'],
  ['cycleAdvance', 'is the only writer of terminal status'],
  ['rosterSet', 'declares which agents ran, which is the loop reporting what it did'],
  ['planCreate', 'is a command — /mjloop:plan — and the page composes commands'],
  ['storyAdd', 'is a command for the same reason'],
  ['memoryAdd', 'would be a fourth write, and writeMemory has no update and no delete'],
  ['initLoop', 'provisions a project; /mjloop:init does that'],
  ['renderIndex', 'derives INDEX.md from state the engine owns'],
  ['renderManifest', 'derives manifest.json for the same reason'],
  ['writeConfig', 'serialises the whole document back to YAML, dropping every comment, and takes no lock'],
  ['writeJsonAtomic', 'is the raw state writer, underneath every guard there is'],
  ['readPlan', 'repairs clobbered frontmatter by rewriting the file, and the read side must never write'],
  ['createFeatureBrief', 'raises a feature, and the discovery interview is what raises one — a page that could author a brief would be a second, weaker discovery flow beside the skill that exists to run one'],
  ['updateFeatureDraft', 'edits a brief, which is the interview writing down its own working notes'],
  ['appendFeatureDecision', 'records a question and the answer to it, and the browser asked nobody'],
  ['supersedeFeatureBrief', 'mints a successor draft carrying an approved brief forward, which is authoring under another name'],
  ['verifyRun', 'spawns a shell command from the run pin and takes the project verify lock; the read side executes nothing'],
  ['worktreeDigest', 'shells out to git in the project directory, and the read side never runs a subprocess'],
]

describe('the engine surface the browser can reach', () => {
  it.each(FORBIDDEN)('never calls %s — it %s', (name) => {
    const offenders = files.filter((file) => new RegExp(`\\b${name}\\b`).test(stripComments(read(file))))
    expect(offenders).toEqual([])
  })

  it('never asks a StateStore to update', () => {
    // Reading one is fine and `snapshot.ts` does — `atomic.ts:55-59` says in so
    // many words that a read performs no repair write. Updating one is the
    // thing every guard in the engine sits on top of.
    for (const file of files) {
      expect(stripComments(read(file)), file).not.toMatch(/StateStore\([^)]*\)\s*\.update|store\.update/)
    }
  })

  it('reaches the four operational writes from exactly one file', () => {
    // `approveFeatureBrief` is the fourth, and it is the only one of the feature
    // store's mutators that appears anywhere under `src/web/` at all — the other
    // four are in `FORBIDDEN` above. That pairing is the whole boundary for a
    // feature brief: the browser may say a person approved what the interview
    // wrote, and may not write a word of it.
    for (const op of ['gateSet', 'storyUpdate', 'halt', 'approveFeatureBrief']) {
      const importers = files.filter((file) => imported(read(file)).has(op))
      expect(importers, op).toEqual(['writes.ts'])
    }
  })

  it('reaches the guarded config mutator from exactly one file', () => {
    const importers = files.filter((file) => imported(read(file)).has('mutateConfig'))
    expect(importers).toEqual(['writes.ts'])
  })

  it('keeps the server itself unable to write', () => {
    // `server.ts` routes a frame to `applyWrite` and holds no engine write of
    // its own, so widening the door means editing the file whose whole header
    // is about not widening it.
    const server = stripComments(read('server.ts'))
    expect(server).not.toMatch(/from '\.\.\/ops\//)
    expect(server).not.toMatch(/from '\.\.\/store\//)
  })

  it('leaves the queue alone', () => {
    // Any diff to `queue.ts` is a signal the design has gone wrong: the cockpit
    // adds tabs and a read api, and changes nothing about how a job runs.
    expect(read('queue.ts')).not.toContain('applyWrite')
    expect(read('queue.ts')).not.toContain('/api')
  })
})

/**
 * The names a file imports.
 *
 * Parsed rather than grepped: this codebase writes no semicolons, so a lazy
 * `import[^;]*X` matches the whole file and every assertion below it passes for
 * the wrong reason.
 */
function imported(body: string): Set<string> {
  const names = new Set<string>()
  for (const match of body.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from/g)) {
    for (const part of (match[1] ?? '').split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim() ?? ''
      if (name.length > 0) names.add(name)
    }
  }
  return names
}

/** Comments name the forbidden identifiers on purpose; only code counts. */
function stripComments(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}
