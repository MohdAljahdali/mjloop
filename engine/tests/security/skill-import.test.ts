import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CrossHostRedirectError,
  FileTooLargeError,
  HostilePathError,
  PathDepthExceededError,
  RevisionPinFailedError,
  TotalContentTooLargeError,
  TreeTooLargeError,
  inspectCandidate,
} from '../../src/ops/skill-import.js'
import type { SkillCandidate } from '../../src/schemas/skill-import.js'

/**
 * Every hostile input a real `inspectCandidate` caller could be handed:
 * a malicious or compromised source answering the pinned-revision, tree,
 * or blob request with something engineered to break a cap or a path rule.
 * Every test here injects a fake fetch; none may reach the network, and
 * every one asserts a named refusal rather than a silent truncation.
 */

function fakeFetch(handler: (url: string, init?: RequestInit) => Response): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    return handler(url, init)
  }) as typeof globalThis.fetch
}

function jsonResponse(actualUrl: string, body: unknown, status = 200): Response {
  const response = new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  Object.defineProperty(response, 'url', { value: actualUrl })
  return response
}

const candidate: SkillCandidate = {
  source: 'github',
  url: 'https://github.com/example/widgets',
  repository: 'example/widgets',
  ref: 'main',
  skillName: 'widgets',
  description: 'Shared widget conventions.',
}

const SHA = 'a'.repeat(40)

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64')
}

/** Builds a fetch double that resolves the ref, then serves a fixed tree, then serves blobs by sha. */
function harness(tree: Array<{ path: string; type: string; sha?: string }>, blobs: Record<string, string>): { fetch: typeof globalThis.fetch } {
  return {
    fetch: fakeFetch((url) => {
      if (url.includes('/commits/')) return jsonResponse(url, { sha: SHA })
      if (url.includes('/git/trees/')) return jsonResponse(url, { tree, truncated: false })
      if (url.includes('/git/blobs/')) {
        const blobSha = url.split('/').pop() as string
        const content = blobs[blobSha] ?? ''
        return jsonResponse(url, { content: b64(content), encoding: 'base64', size: content.length })
      }
      throw new Error(`unexpected url in test: ${url}`)
    }),
  }
}

describe('inspectCandidate — hostile paths', () => {
  it('refuses an entry named ../../etc/passwd', async () => {
    const deps = harness([{ path: '../../etc/passwd', type: 'blob', sha: 's1' }], { s1: 'x' })
    await expect(inspectCandidate('/tmp/project', candidate, deps)).rejects.toThrow(HostilePathError)
  })

  it('refuses an absolute entry path', async () => {
    const deps = harness([{ path: '/etc/passwd', type: 'blob', sha: 's1' }], { s1: 'x' })
    await expect(inspectCandidate('/tmp/project', candidate, deps)).rejects.toThrow(HostilePathError)
  })

  it('refuses a path nested past the depth cap, naming the cap', async () => {
    const deep = Array.from({ length: 20 }, (_, i) => `d${i}`).join('/') + '/file.txt'
    const deps = harness([{ path: deep, type: 'blob', sha: 's1' }], { s1: 'x' })
    await expect(inspectCandidate('/tmp/project', candidate, deps)).rejects.toThrow(PathDepthExceededError)
  })
})

describe('inspectCandidate — bounded fetch', () => {
  it('refuses a file over the per-file byte cap, naming the cap', async () => {
    const huge = 'x'.repeat(300_000)
    const deps = harness(
      [
        { path: 'SKILL.md', type: 'blob', sha: 'skillmdsha' },
        { path: 'big.txt', type: 'blob', sha: 'bigsha' },
      ],
      { skillmdsha: '---\nname: widgets\ndescription: d\n---\n', bigsha: huge },
    )
    await expect(inspectCandidate('/tmp/project', candidate, deps)).rejects.toThrow(FileTooLargeError)
  })

  it('refuses a tree whose total content exceeds the total byte cap even though no single file does, naming the cap', async () => {
    const chunk = 'x'.repeat(190_000) // under the per-file cap, over the total cap once repeated
    const tree = Array.from({ length: 30 }, (_, i) => ({ path: `file${i}.txt`, type: 'blob', sha: `s${i}` }))
    const blobs: Record<string, string> = {}
    for (let i = 0; i < 30; i++) blobs[`s${i}`] = chunk
    const deps = harness(tree, blobs)
    await expect(inspectCandidate('/tmp/project', candidate, deps)).rejects.toThrow(TotalContentTooLargeError)
  })

  it('refuses a tree over the entry-count cap, naming the cap', async () => {
    const tree = Array.from({ length: 600 }, (_, i) => ({ path: `file${i}.txt`, type: 'blob', sha: `s${i}` }))
    const blobs: Record<string, string> = {}
    for (let i = 0; i < 600; i++) blobs[`s${i}`] = 'x'
    const deps = harness(tree, blobs)
    await expect(inspectCandidate('/tmp/project', candidate, deps)).rejects.toThrow(TreeTooLargeError)
  })

  it('refuses a zip-bomb-shaped response — declared size is small, decoded content exceeds the per-file cap', async () => {
    const actual = 'x'.repeat(300_000)
    const deps = {
      fetch: fakeFetch((url) => {
        if (url.includes('/commits/')) return jsonResponse(url, { sha: SHA })
        if (url.includes('/git/trees/')) {
          return jsonResponse(url, {
            tree: [
              { path: 'SKILL.md', type: 'blob', sha: 'skillmdsha' },
              { path: 'bomb.txt', type: 'blob', sha: 'bombsha' },
            ],
            truncated: false,
          })
        }
        if (url.includes('/git/blobs/skillmdsha')) {
          return jsonResponse(url, { content: b64('---\nname: widgets\ndescription: d\n---\n') })
        }
        if (url.includes('/git/blobs/bombsha')) {
          // Declares a tiny size, but the actual decoded content is enormous —
          // inspectCandidate must never trust the declared `size` field.
          return jsonResponse(url, { content: b64(actual), size: 4 })
        }
        throw new Error(`unexpected url: ${url}`)
      }),
    }
    await expect(inspectCandidate('/tmp/project', candidate, deps)).rejects.toThrow(FileTooLargeError)
  })
})

describe('inspectCandidate — connector safety', () => {
  it('asks the client not to follow a redirect at all, rather than following one and regretting it', async () => {
    // Comparing `response.url`'s host afterwards only detects a redirect the
    // client has already performed — the attacker-named host was contacted.
    // `redirect: 'manual'` is what makes "never follows a redirect" true.
    let seenInit: RequestInit | undefined
    const deps = {
      fetch: fakeFetch((url, init) => {
        seenInit = init
        return jsonResponse(url, { sha: SHA })
      }),
    }
    await inspectCandidate('/tmp/project', candidate, deps).catch(() => undefined)
    expect(seenInit?.redirect).toBe('manual')
  })

  it('refuses a 3xx response outright instead of resolving where it points', async () => {
    const deps = {
      fetch: fakeFetch((url) => {
        const response = new Response('', { status: 302, headers: { location: 'https://evil.example.com/steal' } })
        Object.defineProperty(response, 'url', { value: url })
        return response
      }),
    }
    await expect(inspectCandidate('/tmp/project', candidate, deps)).rejects.toThrow(/redirect/i)
  })

  it('refuses a "pinned" revision that is not a commit sha, rather than fetching a moving ref under a pinned name', async () => {
    // The whole pipeline's central promise is that content is fetched at an
    // immutable revision. A source answering `{"sha":"main"}` makes every later
    // request target a branch while the report still prints a "revision".
    const requested: string[] = []
    const deps = {
      fetch: fakeFetch((url) => {
        requested.push(url)
        if (url.includes('/commits/')) return jsonResponse(url, { sha: 'main' })
        throw new Error(`must not fetch anything at an unpinned revision: ${url}`)
      }),
    }
    await expect(inspectCandidate('/tmp/project', candidate, deps)).rejects.toThrow(RevisionPinFailedError)
    expect(requested.filter((url) => url.includes('/git/trees/'))).toEqual([])
  })

  it('refuses a "pinned" revision carrying path traversal, rather than interpolating it into the next url', async () => {
    const deps = {
      fetch: fakeFetch((url) => {
        if (url.includes('/commits/')) return jsonResponse(url, { sha: '../../../../gists/abc' })
        throw new Error(`must not fetch a url built from an unvalidated sha: ${url}`)
      }),
    }
    await expect(inspectCandidate('/tmp/project', candidate, deps)).rejects.toThrow(RevisionPinFailedError)
  })

  it('stops reading a hostile body at the cap instead of buffering it whole and measuring afterwards', async () => {
    // A cap checked after `await response.text()` bounds what is *accepted*,
    // not what is *read*: the whole body is already in memory by then, which
    // is the denial of service the cap exists to prevent.
    const CHUNK = 64 * 1024
    const TOTAL_CHUNKS = 200 // ~13 MB, far past the 2 MB cap
    let delivered = 0
    const deps = {
      fetch: fakeFetch(() => {
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (delivered >= CHUNK * TOTAL_CHUNKS) {
              controller.close()
              return
            }
            delivered += CHUNK
            controller.enqueue(new Uint8Array(CHUNK))
          },
        })
        const response = new Response(stream, { status: 200 })
        Object.defineProperty(response, 'url', { value: 'https://api.github.com/x' })
        return response
      }),
    }

    await expect(inspectCandidate('/tmp/project', candidate, deps)).rejects.toThrow(/2000000-byte/)
    // Refused near the cap, not after the whole 13 MB crossed the boundary.
    expect(delivered).toBeLessThan(4_000_000)
  })

  it('refuses a cross-host redirect on the commit-pin request rather than following it', async () => {
    const deps = {
      fetch: fakeFetch(() => {
        const response = new Response(JSON.stringify({ sha: SHA }), { status: 200 })
        Object.defineProperty(response, 'url', { value: 'https://evil.example.com/steal' })
        return response
      }),
    }
    await expect(inspectCandidate('/tmp/project', candidate, deps)).rejects.toThrow(CrossHostRedirectError)
  })
})

describe('inspectCandidate — moving ref is pinned to a sha before fetching', () => {
  it('refuses when the API cannot resolve the ref to a sha, rather than fetching an unpinned tree', async () => {
    const deps = {
      fetch: fakeFetch((url) => {
        if (url.includes('/commits/')) return jsonResponse(url, { message: 'no commit found for ref' }, 422)
        throw new Error(`must not fetch a tree before a revision is pinned: ${url}`)
      }),
    }
    await expect(inspectCandidate('/tmp/project', candidate, deps)).rejects.toThrow(RevisionPinFailedError)
  })
})

describe('the network boundary in source text', () => {
  /**
   * The whole directory, not one hard-coded file. Scanning only
   * `skill-import.ts` left `skill-discovery.ts` — the other genuinely
   * network-capable module, whose own doc comment promises it never calls a
   * bare `fetch(` — completely unguarded, along with any `skill-*.ts` added
   * later. Walked the way `tests/web/boundary.test.ts` walks its directory.
   */
  it('never calls a bare fetch( in any ops/skill-*.ts — every network call goes through deps.fetch', async () => {
    const opsDir = fileURLToPath(new URL('../../src/ops/', import.meta.url))
    const modules = (await fs.readdir(opsDir)).filter((name) => /^skill-.*\.ts$/.test(name)).sort()
    // A directory scan that silently matched nothing would be a green test
    // guarding nothing at all.
    expect(modules.length).toBeGreaterThan(1)

    const offenders: Array<{ module: string; calls: string[] }> = []
    for (const module of modules) {
      const source = await fs.readFile(path.join(opsDir, module), 'utf8')
      // Strip comments before scanning code for a bare call — these files' own
      // doc comments say "fetch" often, and a `//` or `/* */` mention of
      // "fetch(" is not a call.
      const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      const bareFetchCalls = withoutComments.match(/(?<!deps\.)(?<!globalThis\.)\bfetch\(/g) ?? []
      if (bareFetchCalls.length > 0) offenders.push({ module, calls: bareFetchCalls })
    }
    expect(offenders).toEqual([])
  })

  /**
   * `exec` and `execSync` run their argument through a shell, so a
   * metacharacter in any value derived from fetched package content becomes
   * command injection. Every child process in this pipeline goes through
   * `spawn`/`execFile` with an argv array and `shell: false`.
   */
  it('never runs a child process through a shell in any ops/skill-*.ts', async () => {
    const opsDir = fileURLToPath(new URL('../../src/ops/', import.meta.url))
    const modules = (await fs.readdir(opsDir)).filter((name) => /^skill-.*\.ts$/.test(name)).sort()

    const offenders: Array<{ module: string; calls: string[] }> = []
    for (const module of modules) {
      const source = await fs.readFile(path.join(opsDir, module), 'utf8')
      const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      // `(?<!\.)` so a `RegExp.prototype.exec` call is not mistaken for
      // `child_process.exec` — the shell-running one is never a method call.
      const shellCalls = withoutComments.match(/(?<!\.)\b(execSync|exec)\(|shell:\s*true/g) ?? []
      if (shellCalls.length > 0) offenders.push({ module, calls: shellCalls })
    }
    expect(offenders).toEqual([])
  })
})
