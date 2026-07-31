/**
 * Discovery: search-only, metadata-only, and gated by the project's own
 * policy before a single request goes out.
 *
 * `orchestration.skills.sources` (`schemas/config.ts`) is the allowlist —
 * `discoverCandidates` refuses a source the project has not enabled, before
 * any request is made, naming the setting and the file that changes it.
 * General web search is opt-in and off by default: it is not enough for the
 * *caller* to ask for `source: 'web'`, the project's own config has to have
 * added it to `sources` first.
 *
 * A `SkillCandidate` is a search result and nothing more (see
 * `schemas/skill-import.ts`). No candidate is ever written to the library,
 * and no candidate can reach skill selection — the only path from here to
 * something a project can use runs through `inspectCandidate` (S07 phase 2)
 * and a passed sandbox (phase 3). This module's connectors never fetch a
 * package's content; they only ever fetch a search result.
 *
 * Every network call in this module goes through `deps.fetch`, defaulting to
 * `globalThis.fetch` — never a bare `fetch(` call. `tests/ops/skill-discovery.test.ts`
 * injects a fake for every case; nothing here may reach the network under test.
 */
import { loadConfig } from '../store/config-store.js'
import { readBoundedText } from '../util/bounded-body.js'
import type { SkillSource } from '../schemas/config.js'
import { SkillCandidateSchema, type SkillCandidate } from '../schemas/skill-import.js'

export interface SkillDiscoveryDeps {
  fetch: typeof globalThis.fetch
}

const defaultDeps: SkillDiscoveryDeps = { fetch: globalThis.fetch }

export interface DiscoverOptions {
  query: string
  source: SkillSource
}

/** `discoverCandidates` was asked for a source `orchestration.skills.sources` does not list. */
export class SkillSourceDisabledError extends Error {
  constructor(source: SkillSource) {
    super(
      `"${source}" is not in orchestration.skills.sources for this project — add it in .mjloop/config.yaml ` +
        '(orchestration.skills.sources) before searching this source. General web search in particular is ' +
        'opt-in: a project must add "web" itself, it is never enabled by default.',
    )
    this.name = 'SkillSourceDisabledError'
  }
}

/** A connector followed, or was handed, a response from a different host than it requested. */
export class CrossHostRedirectError extends Error {
  constructor(requestedHost: string, actualHost: string) {
    super(
      `refused a redirect from "${requestedHost}" to "${actualHost}" — a discovery connector never follows a ` +
        'redirect to a different host, because that is exactly how a compromised or malicious endpoint would ' +
        'hand back content this project never asked for',
    )
    this.name = 'CrossHostRedirectError'
  }
}

/** A search response exceeded the bound this module enforces on anything crossing the network boundary. */
export class DiscoveryResponseTooLargeError extends Error {
  constructor(url: string, capBytes: number) {
    super(`response from "${url}" exceeded the ${capBytes}-byte discovery response cap — refused, not truncated`)
    this.name = 'DiscoveryResponseTooLargeError'
  }
}

/** No provider is wired up for general web search yet, even once a project opts in. */
export class WebSearchUnavailableError extends Error {
  constructor() {
    super(
      'orchestration.skills.sources allows "web", but no web search provider is configured in this build — ' +
        'only "github" and "registry" (against orchestration.skills.trusted_registries) resolve real candidates today',
    )
    this.name = 'WebSearchUnavailableError'
  }
}

/** No request may hang forever: a slow endpoint is bounded the same way a large one is. */
const REQUEST_TIMEOUT_MS = 30_000
/** An unbounded fetch is a denial of service against the user's own machine — this is the bound on discovery responses. */
const MAX_RESPONSE_BYTES = 1_000_000

/** Every candidate list this module returns is capped: a search result set, never an unbounded feed. */
const MAX_CANDIDATES = 20

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Fetch and parse one JSON response, enforcing the two rules every connector
 * in this module shares: never follow a cross-host redirect, and never
 * accept an unbounded body.
 */
async function fetchJson(url: string, deps: SkillDiscoveryDeps, init?: RequestInit): Promise<unknown> {
  const requestedHost = new URL(url).host
  // `redirect: 'manual'` is what makes "never follows a redirect" true: the
  // default `'follow'` performs the redirected request to the host the
  // response names, leaving the comparison below to regret it afterwards.
  // Bounded in time as well as in size — a slow-loris endpoint hangs the CLI
  // just as effectively as an unbounded body exhausts its memory.
  const response = await deps.fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  const actualHost = new URL(response.url || url).host
  if (actualHost !== requestedHost) throw new CrossHostRedirectError(requestedHost, actualHost)
  if (response.status >= 300 && response.status < 400) {
    throw new CrossHostRedirectError(requestedHost, response.headers.get('location') ?? '(an undisclosed location)')
  }
  if (!response.ok) throw new Error(`request to "${url}" failed: ${response.status} ${response.statusText}`)

  const text = await readBoundedText(response, MAX_RESPONSE_BYTES, () => new DiscoveryResponseTooLargeError(url, MAX_RESPONSE_BYTES))

  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`response from "${url}" is not valid JSON`)
  }
}

const GITHUB_SEARCH_URL = 'https://api.github.com/search/repositories'

/** GitHub is a data-only client of `api.github.com`'s repository search — never a clone, never an install command. */
async function searchGithub(query: string, deps: SkillDiscoveryDeps): Promise<SkillCandidate[]> {
  const url = `${GITHUB_SEARCH_URL}?q=${encodeURIComponent(query)}&per_page=${MAX_CANDIDATES}`
  const body = await fetchJson(url, deps, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'mjloop-skill-discovery' },
  })
  const items = isRecord(body) && Array.isArray(body.items) ? body.items : []

  const candidates: SkillCandidate[] = []
  for (const item of items.slice(0, MAX_CANDIDATES)) {
    if (!isRecord(item)) continue
    const htmlUrl = typeof item.html_url === 'string' ? item.html_url : null
    const fullName = typeof item.full_name === 'string' ? item.full_name : null
    const ref = typeof item.default_branch === 'string' ? item.default_branch : null
    const name = typeof item.name === 'string' ? item.name : null
    if (htmlUrl === null || fullName === null || ref === null || name === null) continue

    const parsed = SkillCandidateSchema.safeParse({
      source: 'github',
      url: htmlUrl,
      repository: fullName,
      ref,
      skillName: name,
      description: typeof item.description === 'string' && item.description.length > 0 ? item.description : 'No description provided.',
      ...(typeof item.stargazers_count === 'number' ? { stars: item.stargazers_count } : {}),
    })
    if (parsed.success) candidates.push(parsed.data)
  }
  return candidates
}

/**
 * A trusted registry's own https endpoint. The contract this module expects
 * of a registry is deliberately small — `{ candidates: [{ url, repository,
 * ref, skillName, description, stars? }] }` — because a registry is
 * something *this project's own config* named as trusted
 * (`orchestration.skills.trusted_registries`), not a public API this module
 * has to be defensive against the shape of.
 */
async function searchOneRegistry(registry: string, query: string, deps: SkillDiscoveryDeps): Promise<SkillCandidate[]> {
  const url = `${registry.replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}`
  const body = await fetchJson(url, deps, { headers: { Accept: 'application/json' } })
  const items = isRecord(body) && Array.isArray(body.candidates) ? body.candidates : []

  const candidates: SkillCandidate[] = []
  for (const item of items.slice(0, MAX_CANDIDATES)) {
    if (!isRecord(item)) continue
    const parsed = SkillCandidateSchema.safeParse({ ...item, source: 'registry' })
    if (parsed.success) candidates.push(parsed.data)
  }
  return candidates
}

async function searchRegistries(query: string, trustedRegistries: string[], deps: SkillDiscoveryDeps): Promise<SkillCandidate[]> {
  const results: SkillCandidate[] = []
  for (const registry of trustedRegistries) {
    results.push(...(await searchOneRegistry(registry, query, deps)))
  }
  return results.slice(0, MAX_CANDIDATES)
}

/**
 * Metadata-only search candidates for one source, refused up front if this
 * project has not enabled that source.
 *
 * `deps.fetch` is the only door to the network this function or anything it
 * calls opens; every connector below is a data-only client that never
 * follows a cross-host redirect and never accepts an unbounded response.
 */
export async function discoverCandidates(
  projectDir: string,
  options: DiscoverOptions,
  deps: SkillDiscoveryDeps = defaultDeps,
): Promise<SkillCandidate[]> {
  const config = await loadConfig(projectDir)
  if (!config.orchestration.skills.sources.includes(options.source)) {
    throw new SkillSourceDisabledError(options.source)
  }

  switch (options.source) {
    case 'github':
      return searchGithub(options.query, deps)
    case 'registry':
      return searchRegistries(options.query, config.orchestration.skills.trusted_registries, deps)
    case 'web':
      // Enabled by policy, but no provider is wired up yet — refusing here is
      // the honest outcome the sandbox section of this story asks for
      // elsewhere: never claim a capability this build does not have.
      throw new WebSearchUnavailableError()
  }
}
