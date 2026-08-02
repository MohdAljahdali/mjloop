import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeConfig } from '../../src/store/config-store.js'
import { defaultConfig } from '../../src/schemas/config.js'
import type { SkillSource } from '../../src/schemas/config.js'
import { discoverCandidates, SkillsShTokenMissingError, SkillSourceDisabledError } from '../../src/ops/skill-discovery.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

let project: TmpProject
beforeEach(async () => { project = await makeTmpProject() })
afterEach(async () => { await project.cleanup() })

/** A project whose config allows exactly the sources named. */
async function projectAllowing(sources: SkillSource[]): Promise<string> {
  const config = defaultConfig({ test: null, lint: null, build: null })
  config.orchestration.skills.sources = sources
  await writeConfig(project.dir, config)
  return project.dir
}

const body = {
  data: [
    { id: 1, slug: 'find-skills', name: 'find-skills', source: 'vercel-labs/skills', installs: 2800000,
      sourceType: 'github', installUrl: 'https://skills.sh/install/vercel-labs/skills/find-skills',
      url: '/vercel-labs/skills/find-skills' },
    { id: 2, slug: 'lark-approval', name: 'lark-approval', source: 'site/open.feishu.cn', installs: 12,
      sourceType: 'site', installUrl: 'https://skills.sh/install/site/open.feishu.cn/lark-approval',
      url: 'https://skills.sh/site/open.feishu.cn/lark-approval' },
  ],
  query: 'skills', searchType: 'name', count: 2, durationMs: 4,
}

/** `Response.url` is a getter-only property in this runtime's `Response` — defined, not assigned. */
function answer(payload: unknown, url: string): Response {
  const response = new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  Object.defineProperty(response, 'url', { value: url })
  return response
}

describe('the skills.sh connector', () => {
  it('refuses before any request when the project has not allowed the source', async () => {
    const dir = await projectAllowing(['github'])
    let called = 0
    const fetch = (async () => { called += 1; return new Response('{}') }) as unknown as typeof globalThis.fetch
    await expect(discoverCandidates(dir, { query: 'react', source: 'skills-sh' }, { fetch }))
      .rejects.toBeInstanceOf(SkillSourceDisabledError)
    expect(called).toBe(0)
  })

  it('refuses by name when no token is set, rather than reporting no results', async () => {
    const dir = await projectAllowing(['skills-sh'])
    let called = 0
    const fetch = (async () => { called += 1; return new Response('{}') }) as unknown as typeof globalThis.fetch
    await expect(discoverCandidates(dir, { query: 'react', source: 'skills-sh' }, { fetch, env: {} }))
      .rejects.toBeInstanceOf(SkillsShTokenMissingError)
    expect(called).toBe(0)
  })

  it('sends the token as a bearer header and maps the response to candidates', async () => {
    const dir = await projectAllowing(['skills-sh'])
    const seen: { url: string; init: RequestInit | undefined }[] = []
    const fetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init })
      return answer(body, url)
    }) as unknown as typeof globalThis.fetch

    const candidates = await discoverCandidates(
      dir, { query: 'skills', source: 'skills-sh' }, { fetch, env: { SKILLS_SH_TOKEN: 'tok' } },
    )

    expect(seen[0]?.url).toBe('https://skills.sh/api/v1/skills/search?q=skills&limit=20')
    const headers = seen[0]?.init?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer tok')
    expect(seen[0]?.init?.redirect).toBe('manual')

    expect(candidates).toHaveLength(2)
    expect(candidates[0]).toMatchObject({
      source: 'skills-sh',
      url: 'https://skills.sh/vercel-labs/skills/find-skills',
      repository: 'vercel-labs/skills',
      ref: 'HEAD',
      skillName: 'find-skills',
    })
    expect(candidates[0]?.description).toContain('2800000')
    // Already absolute, and left alone.
    expect(candidates[1]?.url).toBe('https://skills.sh/site/open.feishu.cn/lark-approval')
  })

  it('accepts VERCEL_OIDC_TOKEN as well as SKILLS_SH_TOKEN', async () => {
    const dir = await projectAllowing(['skills-sh'])
    const fetch = (async (url: string) => answer({ data: [] }, url)) as unknown as typeof globalThis.fetch
    await expect(
      discoverCandidates(dir, { query: 'react', source: 'skills-sh' }, { fetch, env: { VERCEL_OIDC_TOKEN: 'tok' } }),
    ).resolves.toEqual([])
  })

  it('drops an item it cannot turn into a candidate rather than failing the search', async () => {
    const dir = await projectAllowing(['skills-sh'])
    const payload = { data: [{ slug: 'ok', source: 'a/b', url: '/a/b/ok' }, { slug: 'broken' }, 'not an object'] }
    const fetch = (async (url: string) => answer(payload, url)) as unknown as typeof globalThis.fetch
    const candidates = await discoverCandidates(
      dir, { query: 'x', source: 'skills-sh' }, { fetch, env: { SKILLS_SH_TOKEN: 'tok' } },
    )
    expect(candidates.map((candidate) => candidate.skillName)).toEqual(['ok'])
  })
})
