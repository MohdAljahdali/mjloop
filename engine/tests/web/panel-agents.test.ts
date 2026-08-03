// @vitest-environment happy-dom
import { defineComponent, h, nextTick } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { Snapshot } from '../../src/web/protocol.js'
import { ConfigSchema } from '../../src/schemas/config.js'
import { emptySnapshot, readLocale } from './helpers/page.js'

/**
 * The Agents tab — `panels/Skills.vue`'s sibling, narrowed to what a run can
 * draft rather than what a project has accepted.
 *
 * Four read-only cases (project/plugin drawn apart, a track's usage shown on
 * the card it names, no delete offered for a plugin agent, an unreadable
 * file reported rather than silently dropped), plus the four the editor and
 * the delete confirmation are held to: the update write carries the exact
 * digest the card showed — including through a delete confirmation left open
 * across a concurrent snapshot, the defect a round-1 review found — the
 * contract warning appears and disappears with the body, deriving a plugin
 * agent's copy sends `agent.create` under a free name, and a whitespace-only
 * description sends nothing at all.
 *
 * `AgentEditor.vue` and `AgentDeleteDialog.vue` are hosted in `App.vue`,
 * outside its `<KeepAlive>` — see `useAgentEditor.ts`'s own header — so the
 * four dialog-driving tests below mount `Agents` alongside both dialogs in
 * one `AgentsHost`, the same shape `panel-run.test.ts`'s `HaltHost` and
 * `panel-features.test.ts`'s `FeaturesHost` use for their own dialogs.
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

/**
 * `boot()`, plus `AgentEditor.vue`/`AgentDeleteDialog.vue` mounted alongside
 * `Agents` in one host component, wired through the same module-level
 * `useAgentEditor.ts`/`useAgentDelete.ts` refs production wires them through
 * — `panel-run.test.ts`'s `HaltHost`, ported. Every frame the page sends is
 * captured into the returned `sent` array, `store.test.ts`'s own way of
 * watching a write leave the page rather than a `fetch` stub: these are
 * socket frames (`{ type: 'write', … }`), not HTTP requests.
 */
async function bootWithHost(snapshot: Snapshot) {
  vi.resetModules()
  const freshI18n = await import('../../src/web/app/lib/i18n.ts')
  freshI18n.installForTest({ code: 'en', strings: english })
  const store = await import('../../src/web/app/stores/session.ts')
  store.connect({ token: 'tok', socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket })
  const { default: Agents } = await import('../../src/web/app/panels/Agents.vue')
  const { default: AgentEditor } = await import('../../src/web/app/components/AgentEditor.vue')
  const { default: AgentDeleteDialog } = await import('../../src/web/app/components/AgentDeleteDialog.vue')
  const { useAgentEditor } = await import('../../src/web/app/composables/useAgentEditor.ts')
  const { useAgentDelete } = await import('../../src/web/app/composables/useAgentDelete.ts')

  const sent: unknown[] = []
  const socket = FakeSocket.last
  if (socket !== null) socket.send = (data: string) => sent.push(JSON.parse(data))

  const editor = useAgentEditor()
  const del = useAgentDelete()
  const AgentsHost = defineComponent({
    setup: () => () =>
      h('div', [
        h(Agents),
        h(AgentEditor, { open: editor.open.value, subject: editor.subject.value, onClose: editor.closeEditor }),
        h(AgentDeleteDialog, { open: del.open.value, subject: del.subject.value, onClose: del.closeDelete }),
      ]),
  })

  FakeSocket.last?.deliver({ type: 'snapshot', snapshot })
  await nextTick()
  const page = mount(AgentsHost, { attachTo: document.body })
  return { page, sent }
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

  it('sends the digest it was shown, and nothing else — including through a delete left open across a concurrent snapshot', async () => {
    serve({ '/api/agents': AGENTS })
    const { page, sent } = await bootWithHost(snapshotWith())
    await flushPromises()
    await page.get('[data-agent="scribe"] .agent-edit').trigger('click')
    await nextTick()
    await page.get('#agent-description').setValue('Writes better notes.')
    await page.get('#agent-form').trigger('submit')
    await nextTick()
    expect(sent).toContainEqual(
      expect.objectContaining({
        write: expect.objectContaining({ kind: 'agent.update', name: 'scribe', digest: 'a'.repeat(64) }),
      }),
    )

    // C1 (round 1): the delete confirmation must send the digest the card
    // showed *when the button was pressed*, not whatever `/api/agents`
    // answers with by the time confirm is actually clicked. `scribe`'s
    // digest changes underneath the still-open dialog here — a snapshot
    // arriving from a concurrent edit, exactly the sequence the review
    // described — and the write below must still carry the old one.
    await page.get('[data-agent="scribe"] .agent-delete').trigger('click')
    await nextTick()
    expect(page.get('.agent-delete-dialog').text()).toContain('scribe')
    serve({ '/api/agents': { project: [agent({ digest: 'c'.repeat(64) })], plugin: AGENTS.plugin, unreadable: [] } })
    FakeSocket.last?.deliver({ type: 'snapshot', snapshot: snapshotWith({ agents: 'r2' }) })
    await flushPromises()
    await page.get('.agent-delete-dialog .danger').trigger('click')
    expect(sent).toContainEqual(
      expect.objectContaining({ write: expect.objectContaining({ kind: 'agent.delete', name: 'scribe', digest: 'a'.repeat(64) }) }),
    )
    page.unmount()
  })

  it('warns when the body carries no output contract, and not when it does', async () => {
    serve({
      '/api/agents': {
        project: [agent(), agent({ name: 'contracted', body: '```json\n{"status": "ok"}\n```' })],
        plugin: [],
        unreadable: [],
      },
    })
    const { page } = await bootWithHost(snapshotWith())
    await flushPromises()
    await page.get('[data-agent="scribe"] .agent-edit').trigger('click')
    await nextTick()
    expect(page.find('#agent-contract-warning').exists()).toBe(true)
    await page.get('#agent-editor-cancel').trigger('click')
    await nextTick()
    await page.get('[data-agent="contracted"] .agent-edit').trigger('click')
    await nextTick()
    expect(page.find('#agent-contract-warning').exists()).toBe(false)
    page.unmount()
  })

  it('derives a copy of a plugin agent under a free name', async () => {
    serve({ '/api/agents': AGENTS })
    const { page, sent } = await bootWithHost(snapshotWith())
    await flushPromises()
    await page.get('[data-agent="verifier"] .agent-derive').trigger('click')
    await nextTick()
    await page.get('#agent-form').trigger('submit')
    expect(sent).toContainEqual(
      expect.objectContaining({ write: expect.objectContaining({ kind: 'agent.create', name: 'verifier-copy' }) }),
    )
    page.unmount()
  })

  it('refuses to submit an empty description', async () => {
    serve({ '/api/agents': AGENTS })
    const { page, sent } = await bootWithHost(snapshotWith())
    await flushPromises()
    await page.get('[data-agent="scribe"] .agent-edit').trigger('click')
    await nextTick()
    await page.get('#agent-description').setValue('   ')
    await page.get('#agent-form').trigger('submit')
    expect(sent).toEqual([])
    page.unmount()
  })
})
