import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeConfig } from '../../src/store/config-store.js'
import { defaultConfig } from '../../src/schemas/config.js'
import {
  CrossHostRedirectError,
  DiscoveryResponseTooLargeError,
  SkillSourceDisabledError,
  discoverCandidates,
} from '../../src/ops/skill-discovery.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

let project: TmpProject
beforeEach(async () => { project = await makeTmpProject() })
afterEach(async () => { await project.cleanup() })

/** A fetch double that never touches the network — every test in this file injects one. */
function fakeFetch(handler: (url: string, init?: RequestInit) => Response): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    return handler(url, init)
  }) as typeof globalThis.fetch
}

/** Builds a `Response` whose `.url` reports a different host than the caller requested. */
function redirectedResponse(actualUrl: string, body: unknown): Response {
  const response = new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  Object.defineProperty(response, 'url', { value: actualUrl })
  return response
}

function sameHostResponse(requestedUrl: string, body: unknown): Response {
  const response = new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  Object.defineProperty(response, 'url', { value: requestedUrl })
  return response
}

const githubRepoItem = (overrides: Record<string, unknown> = {}) => ({
  html_url: 'https://github.com/example/widgets',
  full_name: 'example/widgets',
  default_branch: 'main',
  name: 'widgets',
  description: 'Shared widget conventions.',
  stargazers_count: 12,
  ...overrides,
})

describe('discoverCandidates — source policy', () => {
  it('refuses web search by default, before any request is made', async () => {
    await writeConfig(project.dir, defaultConfig({ test: null, lint: null, build: null }))
    let called = false
    const deps = { fetch: fakeFetch(() => { called = true; return sameHostResponse('https://example.com', {}) }) }

    await expect(discoverCandidates(project.dir, { query: 'anything', source: 'web' }, deps)).rejects.toThrow(
      SkillSourceDisabledError,
    )
    expect(called).toBe(false)
  })

  it('names the setting and where to change it in the refusal message', async () => {
    await writeConfig(project.dir, defaultConfig({ test: null, lint: null, build: null }))
    const deps = { fetch: fakeFetch(() => sameHostResponse('https://example.com', {})) }

    await expect(discoverCandidates(project.dir, { query: 'q', source: 'web' }, deps)).rejects.toThrow(
      /orchestration\.skills\.sources/,
    )
  })

  it('allows github by default', async () => {
    const config = defaultConfig({ test: null, lint: null, build: null })
    await writeConfig(project.dir, config)
    const deps = {
      fetch: fakeFetch((url) => sameHostResponse(url, { items: [githubRepoItem()] })),
    }

    const candidates = await discoverCandidates(project.dir, { query: 'widgets', source: 'github' }, deps)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      source: 'github',
      url: 'https://github.com/example/widgets',
      repository: 'example/widgets',
      ref: 'main',
      skillName: 'widgets',
      description: 'Shared widget conventions.',
      stars: 12,
    })
  })

  it('refuses registry search when the project has not enabled it', async () => {
    const config = defaultConfig({ test: null, lint: null, build: null })
    await writeConfig(project.dir, config)
    const deps = { fetch: fakeFetch(() => sameHostResponse('https://example.com', {})) }

    await expect(discoverCandidates(project.dir, { query: 'q', source: 'registry' }, deps)).rejects.toThrow(
      SkillSourceDisabledError,
    )
  })

  it('searches every trusted registry once the project enables the source', async () => {
    const config = defaultConfig({ test: null, lint: null, build: null })
    config.orchestration.skills.sources = ['github', 'registry']
    config.orchestration.skills.trusted_registries = ['https://registry.example.com']
    await writeConfig(project.dir, config)
    const deps = {
      fetch: fakeFetch((url) =>
        sameHostResponse(url, {
          candidates: [
            {
              url: 'https://registry.example.com/pkg/widgets',
              repository: 'widgets',
              ref: 'v1.0.0',
              skillName: 'widgets',
              description: 'A registry package.',
            },
          ],
        }),
      ),
    }

    const candidates = await discoverCandidates(project.dir, { query: 'widgets', source: 'registry' }, deps)
    expect(candidates).toEqual([
      {
        source: 'registry',
        url: 'https://registry.example.com/pkg/widgets',
        repository: 'widgets',
        ref: 'v1.0.0',
        skillName: 'widgets',
        description: 'A registry package.',
      },
    ])
  })
})

describe('discoverCandidates — candidates are metadata only', () => {
  it('never returns anything beyond the fixed candidate shape (no content, no writable path)', async () => {
    await writeConfig(project.dir, defaultConfig({ test: null, lint: null, build: null }))
    const deps = {
      fetch: fakeFetch((url) => sameHostResponse(url, { items: [githubRepoItem({ content: 'should be dropped' })] })),
    }
    const candidates = await discoverCandidates(project.dir, { query: 'widgets', source: 'github' }, deps)
    expect(Object.keys(candidates[0])).toEqual(['source', 'url', 'repository', 'ref', 'skillName', 'description', 'stars'])
  })

  it('skips a malformed search item rather than returning a partial candidate', async () => {
    await writeConfig(project.dir, defaultConfig({ test: null, lint: null, build: null }))
    const deps = {
      fetch: fakeFetch((url) =>
        sameHostResponse(url, { items: [githubRepoItem(), { html_url: 'https://github.com/x/y' }] }),
      ),
    }
    const candidates = await discoverCandidates(project.dir, { query: 'widgets', source: 'github' }, deps)
    expect(candidates).toHaveLength(1)
  })
})

describe('discoverCandidates — connector safety', () => {
  it('refuses a cross-host redirect rather than following it', async () => {
    await writeConfig(project.dir, defaultConfig({ test: null, lint: null, build: null }))
    const deps = {
      fetch: fakeFetch(() => redirectedResponse('https://evil.example.com/steal', { items: [githubRepoItem()] })),
    }

    await expect(discoverCandidates(project.dir, { query: 'widgets', source: 'github' }, deps)).rejects.toThrow(
      CrossHostRedirectError,
    )
  })

  it('refuses a response over the discovery response cap, naming the cap', async () => {
    await writeConfig(project.dir, defaultConfig({ test: null, lint: null, build: null }))
    const huge = 'x'.repeat(2_000_000)
    const deps = {
      fetch: fakeFetch((url) => sameHostResponse(url, { items: [githubRepoItem({ description: huge })] })),
    }

    await expect(discoverCandidates(project.dir, { query: 'widgets', source: 'github' }, deps)).rejects.toThrow(
      DiscoveryResponseTooLargeError,
    )
  })
})
