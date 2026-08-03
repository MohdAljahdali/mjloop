// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import type { Snapshot } from '../../src/web/protocol.js'
import { ConfigSchema } from '../../src/schemas/config.js'
import { emptySnapshot, readLocale } from './helpers/page.js'

/**
 * The Agents tab — `panels/Skills.vue`'s sibling, narrowed to what a run can
 * draft rather than what a project has accepted. Read-only: no editor, no
 * delete, no copy — those are later tasks, and `AgentCard.vue`'s own header
 * explains why its buttons are inert here.
 *
 * Four cases, by ruling: project/plugin drawn apart, a track's usage shown
 * on the card it names, no delete offered for a plugin agent, and an
 * unreadable file reported rather than silently dropped.
 */

const english = await readLocale('en')

function serve(routes: Record<string, unknown>): void {
  vi.stubGlobal('fetch', (url: string) => {
    const body = routes[url.split('?')[0] ?? '']
    return Promise.resolve(
      new Response(JSON.stringify(body ?? { error: { code: 'error.notFound' } }), { status: body === undefined ? 404 : 200 }),
    )
  })
}

class FakeSocket {
  static last: FakeSocket | null = null
  readyState = 1
  listeners = new Map<string, (event: unknown) => void>()
  sent: unknown[] = []
  constructor(public url: string) {
    FakeSocket.last = this
  }
  addEventListener(type: string, fn: (event: unknown) => void) {
    this.listeners.set(type, fn)
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }
  deliver(message: unknown): void {
    this.listeners.get('message')?.({ data: JSON.stringify(message) })
  }
}

async function boot(snapshot: Snapshot) {
  vi.resetModules()
  const freshI18n = await import('../../src/web/app/lib/i18n.ts')
  freshI18n.installForTest({ code: 'en', strings: english })
  const store = await import('../../src/web/app/stores/session.ts')
  store.connect({ token: 'tok', socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket })
  const { default: Agents } = await import('../../src/web/app/panels/Agents.vue')
  FakeSocket.last?.deliver({ type: 'snapshot', snapshot })
  await nextTick()
  return mount(Agents)
}

const agent = (patch: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  name: 'scribe',
  source: 'project',
  description: 'Writes notes.',
  tools: null,
  model: null,
  extra: {},
  body: 'x',
  digest: 'a'.repeat(64),
  ...patch,
})

const AGENTS = {
  project: [agent()],
  plugin: [agent({ name: 'verifier', source: 'plugin', description: 'Judges.', digest: 'b'.repeat(64) })],
  unreadable: [],
}

/** A parsed config, through the engine's own schema so every default is real. */
function configView(patch: Record<string, unknown> = {}): unknown {
  return {
    raw: 'version: 1\n',
    revision: 'a'.repeat(64),
    parsed: ConfigSchema.parse({
      version: 1,
      tracks: { build: { required: ['scribe'], max_cycles: 5 } },
      ...patch,
    }),
    invalid: false,
  }
}

const snapshotWith = (patch: Partial<Snapshot['revisions']> = {}): Snapshot =>
  emptySnapshot({ revisions: { ...emptySnapshot().revisions, agents: 'r1', ...patch } })

describe('Agents.vue', () => {
  it('draws the project agents and the plugin agents apart', async () => {
    serve({ '/api/agents': AGENTS })
    const page = await boot(snapshotWith())
    await flushPromises()
    expect(page.get('#agents-project').text()).toContain('scribe')
    expect(page.get('#agents-plugin').text()).toContain('verifier')
    expect(page.get('#agents-project').text()).not.toContain('verifier')
    expect(page.get('#agents-plugin').text()).not.toContain('scribe')
  })

  it('says which tracks name an agent', async () => {
    serve({ '/api/agents': AGENTS, '/api/config': configView() })
    const page = await boot(snapshotWith({ config: 'c1' }))
    await flushPromises()
    expect(page.get('[data-agent="scribe"] .agent-usage').text()).toContain('build')
  })

  it('offers no delete for a plugin agent', async () => {
    serve({ '/api/agents': AGENTS })
    const page = await boot(snapshotWith())
    await flushPromises()
    expect(page.find('[data-agent="verifier"] .danger').exists()).toBe(false)
  })

  it('reports an unreadable agent file rather than hiding it', async () => {
    serve({ '/api/agents': { project: [], plugin: [], unreadable: [{ path: 'broken.md' }] } })
    const page = await boot(snapshotWith())
    await flushPromises()
    expect(page.get('#agents-unreadable').text()).toContain('broken.md')
  })
})
