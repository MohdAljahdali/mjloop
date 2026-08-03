// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import type { Snapshot } from '../../src/web/protocol.js'
import type { Telemetry } from '../../src/ops/telemetry.js'
import { ConfigSchema } from '../../src/schemas/config.js'
import { emptySnapshot, readLocale } from './helpers/page.js'

/**
 * The Config panel — `panels/config.js` (1,838 lines), `describe('config')`
 * at `panels.test.ts:2023`, and the `panel-config` section of `index.html` —
 * ported to `Config.vue` plus its child SFCs. The pure diff/refusal logic is
 * covered separately, DOM-free, in `lib.test.ts`'s `describe('lib/config')`;
 * this file is what drives it and what it draws.
 *
 * The structured `specialists:`/`tracks:` editors moved to `Tracks.vue` —
 * see `panel-tracks.test.ts` for behaviours 8-10 the pre-split version of
 * this file used to cover: the `specialists:` editor, the `tracks:` editor,
 * the `#config-agent-names` datalist, and the track-side structural
 * assertions. This file keeps only the plain-field half.
 *
 * Behaviours from the three artefacts, each covered below:
 *  1. The plain fields seed from the parsed document, and an untouched form
 *     emits nothing (`lib.test.ts`) — here, that the *inputs themselves* show
 *     the seeded values.
 *  2. The editor is disabled with an explanatory banner while the document is
 *     missing or fails to parse, and re-enables once one arrives.
 *  3. `verify:`'s own commands render as one block and everything else
 *     (`timeout_ms`, `lock_timeout_ms`, `failure_patterns`) as a second,
 *     unset shown as a phrase rather than a blank cell.
 *  4. The specialist telemetry table: rows, the "nothing to report" state
 *     (only once the report has actually arrived), the truncated/flagged
 *     lines.
 *  5. **The save-is-the-only-door invariant**: mutating a plain control sends
 *     nothing; pressing Save sends exactly one `config.patch` write, and
 *     nothing more until the next Save.
 *  6. The two whole-document orchestration refusals (`auto-plan`+`off`,
 *     `registry`+untrusted) disable Save and show their own banner, and lift
 *     the moment the pair is completed.
 *  7. A revision that moves while the form is dirty shows the conflict
 *     banner, disables Save, enables Reset, and does not clobber the dirty
 *     form; Reset re-seeds from the newly arrived document.
 *  8. This panel no longer carries the track editors at all.
 *  9. Structural assertions at the ids and classes `60-panels.css` selects:
 *     `.config-editor`, `.grid-telemetry`.
 *
 * Deferred, with reason: `config.editorStructuredInvalid` (a malformed
 * `specialists_json`/`tracks_json` value) is unreachable here by
 * construction — the draft is a live reactive object, never a JSON string
 * round-tripped through a hidden field, so there is no parse step left to
 * fail. The `config_error` banner this panel's task also owns is covered in
 * `shell.test.ts`'s `describe('Banners')`, since it is page-level and lives
 * in `Banners.vue`.
 */

const english = await readLocale('en')

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

function serve(routes: Record<string, unknown>): void {
  vi.stubGlobal('fetch', (url: string) => {
    const body = routes[url.split('?')[0] ?? '']
    return Promise.resolve(
      new Response(JSON.stringify(body ?? { error: { code: 'error.notFound' } }), {
        status: body === undefined ? 404 : 200,
      }),
    )
  })
}

/** A parsed config, through the engine's own schema so every default is real. */
function configView(patch: Record<string, unknown> = {}): unknown {
  return {
    raw: 'version: 1\n',
    revision: 'a'.repeat(64),
    parsed: ConfigSchema.parse({
      version: 1,
      tracks: { build: { required: ['builder'], max_cycles: 5 }, edit: { required: ['builder'], max_cycles: 2 } },
      ...patch,
    }),
    invalid: false,
  }
}

const telemetry = (patch: Partial<Telemetry> = {}): Telemetry => ({
  runs: 0,
  cycles: 0,
  specialists: [],
  truncated: 0,
  flagged: [],
  ...patch,
})

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('fetch', () => Promise.resolve(new Response('null', { status: 200 })))
})

async function boot(snapshot: Snapshot = emptySnapshot()) {
  const freshI18n = await import('../../src/web/app/lib/i18n.ts')
  freshI18n.installForTest({ code: 'en', strings: english })
  const store = await import('../../src/web/app/stores/session.ts')
  store.connect({ token: 'tok', socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket })
  const { default: Config } = await import('../../src/web/app/panels/Config.vue')
  FakeSocket.last?.deliver({ type: 'snapshot', snapshot })
  await nextTick()
  return { store, Config, socket: FakeSocket.last as FakeSocket }
}

const control = (wrapper: ReturnType<typeof mount>, id: string) => wrapper.get(`#${id}`).element as HTMLInputElement & HTMLSelectElement

describe('Config.vue', () => {
  it('seeds the plain fields from the parsed document', async () => {
    serve({
      '/api/config': configView({
        autonomous: false,
        limits: { max_parallel_agents: 4, no_progress_strikes: 2 },
        verify: { test: 'npm test', lint: null, build: 'npm run build' },
      }),
    })
    const { Config } = await boot()
    const wrapper = mount(Config)
    await vi.waitFor(() => expect(control(wrapper, 'config-max-parallel-input').value).toBe('4'))

    expect(control(wrapper, 'config-strikes-input').value).toBe('2')
    expect(control(wrapper, 'config-autonomous-input').checked).toBe(false)
    expect(control(wrapper, 'config-test-input').value).toBe('npm test')
    expect(control(wrapper, 'config-lint-input').value).toBe('')
    expect(control(wrapper, 'config-question-budget-input').value).toBe('8')
  })

  it('disables the editor with an explanatory banner while the document is missing, and clears it once one arrives', async () => {
    serve({})
    const { Config } = await boot()
    const wrapper = mount(Config)
    await vi.waitFor(() => expect(wrapper.find('#config-editor-state').exists()).toBe(true))

    expect(wrapper.get('#config-editor-state').text()).toBe(english['config.editorUnavailable'])
    expect(control(wrapper, 'config-save').disabled).toBe(true)
    expect(control(wrapper, 'config-reset').disabled).toBe(true)
    expect(control(wrapper, 'config-max-parallel-input').disabled).toBe(true)
  })

  it('shows the invalid-document banner for a config.yaml that failed to parse', async () => {
    // `Config.vue`'s `stateKey` still carries this branch verbatim
    // (`view.value?.invalid === true ? 'config.editorInvalid' : …`) even
    // though the fieldset-survival test that used to exercise it moved to
    // `panel-tracks.test.ts` along with the track editors — the branch
    // itself did not move, and needs its own assertion here.
    serve({ '/api/config': { raw: 'tracks: [this is not valid', revision: null, parsed: null, invalid: true } })
    const { Config } = await boot()
    const wrapper = mount(Config)
    await vi.waitFor(() => expect(wrapper.get('#config-editor-state').text()).toBe(english['config.editorInvalid']))
  })

  it('no longer carries the track editors', async () => {
    serve({ '/api/config': configView() })
    const { Config } = await boot()
    const wrapper = mount(Config)
    await vi.waitFor(() => expect(control(wrapper, 'config-max-parallel-input').disabled).toBe(false))

    expect(wrapper.find('#config-track-editors').exists()).toBe(false)
    expect(wrapper.find('#config-specialist-rules').exists()).toBe(false)
    expect(wrapper.find('#config-agent-names').exists()).toBe(false)
  })

  it('renders one row per verify command and the rest of the block as policy, with unset shown as a phrase', async () => {
    serve({
      '/api/config': configView({
        verify: { test: 'npm test', build: 'npm run build', failure_patterns: { test: ['^FAIL'] } },
      }),
    })
    const { Config } = await boot()
    const wrapper = mount(Config)
    await vi.waitFor(() => expect(wrapper.findAll('#config-verify .fact')).toHaveLength(3))

    const verifyValues = wrapper.findAll('#config-verify .fact dd').map((node) => node.text())
    expect(verifyValues).toEqual(['npm test', english['config.verifyUnset'], 'npm run build'])

    const policyKeys = wrapper.findAll('#config-verify-policy .fact dt').map((node) => node.text())
    expect(policyKeys).toEqual(['verify.timeout_ms', 'verify.lock_timeout_ms', 'verify.failure_patterns.test'])
    expect(wrapper.text()).not.toContain('[object Object]')
  })

  it('reports the specialist telemetry, and says nothing to report only once the report has arrived', async () => {
    serve({
      '/api/config': configView(),
      '/api/telemetry': telemetry({
        specialists: [
          {
            agent: 'security',
            mode: 'auto',
            drafted: 6,
            skipped: 1,
            landed: 5,
            results: { pass: 4, fail: 1, blocked: 0 },
            findings: { high: 0, medium: 0, low: 2 },
            runs: 3,
            last_seen: '2026-07-28-002--adhoc--build',
          },
        ],
        truncated: 2,
        flagged: ['security'],
      }),
    })
    const { Config } = await boot()
    const wrapper = mount(Config)
    await vi.waitFor(() => expect(wrapper.findAll('#telemetry-list .grid-row')).toHaveLength(1))

    const row = wrapper.get('#telemetry-list .grid-row')
    expect(row.get('[data-slot="agent"]').text()).toBe('security')
    expect(row.get('[data-slot="results"]').text()).toBe('4/1/0')
    expect(row.get('[data-slot="findings"]').text()).toBe('0/0/2')
    expect(wrapper.find('#telemetry-empty').exists()).toBe(false)
    expect(wrapper.get('#telemetry-more').text()).toContain('2')
    expect(wrapper.get('#telemetry-flagged').text()).toContain('security')
  })

  it('says nothing to report for a project with an empty history, once the report has actually arrived', async () => {
    serve({ '/api/config': configView(), '/api/telemetry': telemetry() })
    const { Config } = await boot()
    const wrapper = mount(Config)
    await vi.waitFor(() => expect(wrapper.find('#telemetry-empty').exists()).toBe(true))
    expect(wrapper.get('#telemetry-empty').text()).toBe(english['telemetry.empty'])
    expect(wrapper.find('#telemetry-table').exists()).toBe(false)
  })

  describe('the save-is-the-only-door invariant', () => {
    it('sends nothing while mutating a plain field — only Save reaches the server, and exactly once', async () => {
      serve({ '/api/config': configView() })
      const { Config, socket } = await boot()
      const wrapper = mount(Config)
      await vi.waitFor(() => expect(control(wrapper, 'config-max-parallel-input').disabled).toBe(false))

      // A plain field.
      await wrapper.get('#config-autonomous-input').setValue(true)

      expect(socket.sent, 'nothing reaches the server before Save').toEqual([])
      expect(control(wrapper, 'config-save').disabled).toBe(false)

      // happy-dom does not perform a browser's implicit form submission on a
      // button click, so the form's own `submit` is triggered directly —
      // `panel-skills.test.ts`'s own convention for a `type="submit"` control.
      await wrapper.get('#config-editor').trigger('submit')
      expect(socket.sent).toHaveLength(1)
      const write = (socket.sent[0] as { write: { kind: string; changes: unknown[] } }).write
      expect(write.kind).toBe('config.patch')
      expect(write.changes.length).toBeGreaterThan(0)

      // A refusal is not silently treated as success — the identical bug
      // `panel-tracks.test.ts`'s own two-tab test catches in `Tracks.vue`
      // is checked here too: `dirty` stays true and Save stays enabled.
      socket.deliver({ type: 'receipt', id: (socket.sent[0] as { id: string }).id, ok: false, code: 'write.stale.config' })
      await nextTick()
      expect(control(wrapper, 'config-save').disabled).toBe(false)

      // Only settling the write with `ok: true` clears `dirty` — Save stays
      // disabled after that, and nothing sends again on its own.
      await wrapper.get('#config-editor').trigger('submit')
      expect(socket.sent).toHaveLength(2)
      socket.deliver({ type: 'receipt', id: (socket.sent[1] as { id: string }).id, ok: true, code: 'write.ok' })
      await nextTick()
      expect(control(wrapper, 'config-save').disabled).toBe(true)
      expect(socket.sent).toHaveLength(2)
    })
  })

  describe('the two whole-document orchestration refusals', () => {
    it('refuses auto-plan completion under discovery off, and lifts once discovery is on', async () => {
      serve({ '/api/config': configView() })
      const { Config } = await boot()
      const wrapper = mount(Config)
      await vi.waitFor(() => expect(control(wrapper, 'config-max-parallel-input').disabled).toBe(false))

      await wrapper.get('#config-discovery-completion-input').setValue('auto-plan')
      expect(control(wrapper, 'config-save').disabled).toBe(true)
      expect(wrapper.get('#config-editor-state').text()).toBe(english['config.problem.autoPlanOff'])

      await wrapper.get('#config-discovery-mode-input').setValue('always')
      expect(control(wrapper, 'config-save').disabled).toBe(false)
      expect(wrapper.find('#config-editor-state').exists()).toBe(false)
    })

    it('refuses a registry source with nothing trusted, and a trusted registry that is not https', async () => {
      serve({ '/api/config': configView() })
      const { Config } = await boot()
      const wrapper = mount(Config)
      await vi.waitFor(() => expect(control(wrapper, 'config-max-parallel-input').disabled).toBe(false))

      await wrapper.get('#config-source-registry-input').setValue(true)
      expect(control(wrapper, 'config-save').disabled).toBe(true)
      expect(wrapper.get('#config-editor-state').text()).toBe(english['config.problem.registryUntrusted'])

      await wrapper.get('#config-registries-input').setValue('http://registry.internal')
      expect(wrapper.get('#config-editor-state').text()).toBe(english['config.problem.registryNotHttps'])

      await wrapper.get('#config-registries-input').setValue('https://skills.example.com')
      expect(control(wrapper, 'config-save').disabled).toBe(false)
      expect(wrapper.find('#config-editor-state').exists()).toBe(false)
    })
  })

  describe('a revision moving underneath a dirty draft', () => {
    it('shows the conflict banner, disables Save, enables Reset, and does not clobber the dirty draft', async () => {
      let served: unknown = configView()
      vi.stubGlobal('fetch', (url: string) => {
        const isConfig = url.startsWith('/api/config')
        return Promise.resolve(
          new Response(JSON.stringify(isConfig ? served : { error: { code: 'error.notFound' } }), { status: isConfig ? 200 : 404 }),
        )
      })
      const { Config, socket } = await boot()
      const wrapper = mount(Config)
      await vi.waitFor(() => expect(control(wrapper, 'config-max-parallel-input').disabled).toBe(false))

      await wrapper.get('#config-discovery-mode-input').setValue('always')
      expect(control(wrapper, 'config-save').disabled).toBe(false)

      served = { ...(configView({ orchestration: { discovery: { mode: 'ask' } } }) as object), revision: 'b'.repeat(64) }
      socket.deliver({
        type: 'snapshot',
        snapshot: emptySnapshot({ revisions: { ...emptySnapshot().revisions, config: 'moved' } }),
      })
      await vi.waitFor(() => expect(wrapper.get('#config-editor-state').text()).toBe(english['config.editorChanged']))

      expect(control(wrapper, 'config-save').disabled).toBe(true)
      expect(control(wrapper, 'config-reset').disabled).toBe(false)
      // The choice this editor was mid-way through survives the conflict.
      expect(control(wrapper, 'config-discovery-mode-input').value).toBe('always')

      await wrapper.get('#config-reset').trigger('click')
      // Reset re-seeds from the document that actually landed.
      expect(control(wrapper, 'config-discovery-mode-input').value).toBe('ask')
      expect(wrapper.find('#config-editor-state').exists()).toBe(false)
      expect(socket.sent).toEqual([])
    })
  })

  describe('structural assertions — 60-panels.css', () => {
    it('carries the panel root, the editor card, and the telemetry grid at the classes the stylesheet selects', async () => {
      serve({
        '/api/config': configView(),
        '/api/telemetry': telemetry({
          specialists: [
            {
              agent: 'security',
              mode: 'auto',
              drafted: 1,
              skipped: 0,
              landed: 1,
              results: { pass: 1, fail: 0, blocked: 0 },
              findings: { high: 0, medium: 0, low: 0 },
              runs: 1,
              last_seen: null,
            },
          ],
        }),
      })
      const { Config } = await boot()
      const wrapper = mount(Config)
      await vi.waitFor(() => expect(control(wrapper, 'config-max-parallel-input').disabled).toBe(false))

      const root = wrapper.get('#panel-config')
      expect(root.classes()).toContain('panel')
      expect(root.attributes('aria-labelledby')).toBe('panel-config-title')
      expect(wrapper.get('#config-editor').classes()).toContain('config-editor')
      expect(wrapper.find('.config-editor-head').exists()).toBe(true)
      expect(wrapper.find('.config-editor-actions').exists()).toBe(true)
      await vi.waitFor(() => expect(wrapper.find('.grid-telemetry').exists()).toBe(true))
    })
  })
})
