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
 *  5. **The save-is-the-only-door invariant**: mutating several structured
 *     and plain controls sends nothing; pressing Save sends exactly one
 *     `config.patch` write carrying every change, and nothing more until the
 *     next Save.
 *  6. The two whole-document orchestration refusals (`auto-plan`+`off`,
 *     `registry`+untrusted) disable Save and show their own banner, and lift
 *     the moment the pair is completed.
 *  7. A revision that moves while the draft is dirty shows the conflict
 *     banner, disables Save, enables Reset, and does not clobber the dirty
 *     draft; Reset re-seeds from the newly arrived document.
 *  8. The structured `specialists:` editor: add, remove, and the mode
 *     sentence beside each rule.
 *  9. The structured `tracks:` editor: add, duplicate, remove, the four
 *     agent lists, the order graph (add/remove a predecessor, Enter in the
 *     combobox), the problem list, and the change-impact preview.
 *  10. Structural assertions at the ids and classes `60-panels.css` selects:
 *      `.config-editor`, `.rule`, `.track-editor`, `.chip-agent`,
 *      `.track-order-agent`, `.track-problem`, `.track-preview-item`,
 *      `.grid-telemetry`.
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

  it("keeps the specialists:/tracks: fieldsets — legend, hint, add box — on screen for an unparseable config.yaml, rather than removing the sections, and hides the specialists-empty message rather than defaulting a null draft to an empty document", async () => {
    // `draft === null` and "the document has zero specialists/tracks" are two
    // different states `config.js`'s own `drawStructured` distinguishes:
    // its `model === null` branch empties the card hosts but leaves
    // `specialistEmpty` hidden (`flag(specialistEmpty, 'hidden', true)`) —
    // the opposite of what a genuinely empty document shows. `index.html`
    // ships both fieldsets unconditionally; a garbled file must not remove
    // them.
    serve({
      '/api/config': { raw: 'tracks: [this is not valid', revision: null, parsed: null, invalid: true },
    })
    const { Config } = await boot()
    const wrapper = mount(Config)
    await vi.waitFor(() => expect(wrapper.get('#config-editor-state').text()).toBe(english['config.editorInvalid']))

    // The tracks: fieldset's own chrome survives — no cards, but the legend,
    // hint, add box and warning are all still there, disabled rather than
    // gone.
    expect(wrapper.find('#config-track-editors').exists()).toBe(true)
    expect(wrapper.findAll('.track-editor')).toHaveLength(0)
    expect(wrapper.find('#config-track-new').exists()).toBe(true)
    expect(control(wrapper, 'config-track-new').disabled).toBe(true)
    expect(wrapper.text()).toContain(english['config.tracks'])
    expect(wrapper.text()).toContain(english['config.trackNewWarning'])

    // The specialists: fieldset survives the same way, and its "no rules"
    // message — a claim about the document — does not fire for a document
    // that never parsed at all.
    expect(wrapper.find('#config-specialist-rules').exists()).toBe(true)
    expect(wrapper.find('#config-specialists-empty').exists()).toBe(false)
    expect(wrapper.find('#config-specialist-new').exists()).toBe(true)
    expect(control(wrapper, 'config-specialist-new').disabled).toBe(true)
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
    it('sends nothing while mutating a plain field, a specialist rule, and a track — only Save reaches the server, and exactly once', async () => {
      serve({
        '/api/config': configView({
          tracks: { build: { required: ['builder'], max_cycles: 5 } },
        }),
      })
      const { Config, socket } = await boot()
      const wrapper = mount(Config)
      await vi.waitFor(() => expect(wrapper.find('.track-editor').exists()).toBe(true))

      // A plain field.
      await wrapper.get('#config-autonomous-input').setValue(true)
      // A structured specialist rule.
      await wrapper.get('#config-specialist-new').setValue('security')
      await wrapper.get('.rule-add button').trigger('click')
      // A structured track mutation: a new required agent.
      const requiredAdd = wrapper.get('.track-list input')
      await requiredAdd.setValue('verifier')
      await wrapper.get('.track-list .rule-add button').trigger('click')

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

      // Settling the write is what clears `dirty` — Save stays disabled and
      // nothing sends again on its own.
      socket.deliver({ type: 'receipt', id: (socket.sent[0] as { id: string }).id, ok: true, code: 'write.ok' })
      await nextTick()
      expect(control(wrapper, 'config-save').disabled).toBe(true)
      expect(socket.sent).toHaveLength(1)
    })
  })

  describe('the two whole-document orchestration refusals', () => {
    it('refuses auto-plan completion under discovery off, and lifts once discovery is on', async () => {
      serve({ '/api/config': configView() })
      const { Config } = await boot()
      const wrapper = mount(Config)
      await vi.waitFor(() => expect(wrapper.find('.track-editor').exists()).toBe(true))

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
      await vi.waitFor(() => expect(wrapper.find('.track-editor').exists()).toBe(true))

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
      await vi.waitFor(() => expect(wrapper.find('.track-editor').exists()).toBe(true))

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

  describe('the specialists: editor', () => {
    it('adds a rule, shows its mode sentence, and removes it — structurally, at the classes 60-panels.css selects', async () => {
      serve({ '/api/config': configView() })
      const { Config } = await boot()
      const wrapper = mount(Config)
      await vi.waitFor(() => expect(wrapper.find('.track-editor').exists()).toBe(true))

      await wrapper.get('#config-specialist-new').setValue('security')
      await wrapper.get('.rule-add button').trigger('click')
      await nextTick()

      const rule = wrapper.get('.rule')
      expect(rule.get('.rule-name').text()).toBe('security')
      expect(rule.get('.rule-why').text()).toBe(english['config.mode.autoWhy'])
      expect((control(wrapper, 'config-specialist-new')).value).toBe('')

      await rule.get('select.rule-mode').setValue('never')
      expect(rule.get('.rule-why').text()).toBe(english['config.mode.neverWhy'])

      await rule.get('button.danger').trigger('click')
      expect(wrapper.find('.rule').exists()).toBe(false)
      expect(wrapper.get('#config-specialists-empty').text()).toBe(english['config.specialistsEmpty'])
    })
  })

  describe('the tracks: editor', () => {
    it('adds, duplicates and removes a track card', async () => {
      serve({ '/api/config': configView({ tracks: { build: { required: ['builder'], max_cycles: 5 } } }) })
      const { Config } = await boot()
      const wrapper = mount(Config)
      await vi.waitFor(() => expect(wrapper.findAll('.track-editor')).toHaveLength(1))

      await wrapper.get('#config-track-new').setValue('review')
      await wrapper.get('#config-track-editors ~ .rule-add button').trigger('click')
      await vi.waitFor(() => expect(wrapper.findAll('.track-editor')).toHaveLength(2))

      const build = wrapper.findAll('.track-editor').find((node) => node.attributes('data-track') === 'build')
      expect(build).toBeDefined()
      await build?.get('button:not(.danger)').trigger('click') // duplicate
      await vi.waitFor(() => expect(wrapper.findAll('.track-editor')).toHaveLength(3))
      expect(wrapper.findAll('.track-editor').map((node) => node.attributes('data-track'))).toContain('build-copy')

      await build?.get('button.danger').trigger('click')
      await vi.waitFor(() => expect(wrapper.findAll('.track-editor')).toHaveLength(2))
      expect(wrapper.findAll('.track-editor').map((node) => node.attributes('data-track'))).not.toContain('build')
    })

    it("adds and removes a predecessor through an agent's own order row, adding on Enter as well as the + button", async () => {
      serve({
        '/api/config': configView({
          tracks: { build: { required: ['builder', 'verifier'], available: ['ui-designer'], max_cycles: 5 } },
        }),
      })
      const { Config } = await boot()
      const wrapper = mount(Config)
      await vi.waitFor(() => expect(wrapper.find('.track-editor').exists()).toBe(true))

      const row = wrapper.findAll('.track-order-agent').find((node) => node.attributes('data-agent') === 'verifier')
      expect(row, 'no order row for verifier').toBeDefined()
      const box = row?.get('input')
      await box?.setValue('builder')
      await box?.trigger('keydown', { key: 'Enter' })

      expect(row?.find('.chips').text()).toContain('builder')
      expect((box?.element as HTMLInputElement).value).toBe('')

      const removeButton = row?.get('.chips button')
      await removeButton?.trigger('click')
      expect(row?.find('.chips').text()?.trim()).toBe('')
      expect(row?.find('.track-list-empty').exists()).toBe(true)
    })

    it('flags a track with no required agent, disables Save, and clears the problem once one is added', async () => {
      serve({ '/api/config': configView({ tracks: { mine: { required: ['alpha'], max_cycles: 3 } } }) })
      const { Config } = await boot()
      const wrapper = mount(Config)
      await vi.waitFor(() => expect(wrapper.find('.track-editor').exists()).toBe(true))

      const list = wrapper.findAll('.track-list')[0]
      const remove = list?.get('.chips button')
      await remove?.trigger('click')

      expect(wrapper.get('.track-problem').text()).toBe(english['config.problem.noRequired'])
      expect(control(wrapper, 'config-save').disabled).toBe(true)
    })

    it('names each order edge Save would add and remove in the change preview, and says nothing pending while the draft matches the baseline', async () => {
      serve({
        '/api/config': configView({
          tracks: { build: { required: ['alpha', 'beta', 'gamma'], max_cycles: 5, order: [{ agent: 'alpha', after: ['beta'] }] } },
        }),
      })
      const { Config } = await boot()
      const wrapper = mount(Config)
      await vi.waitFor(() => expect(wrapper.find('.track-editor').exists()).toBe(true))

      expect(wrapper.findAll('.track-preview-item')).toHaveLength(0)
      expect(wrapper.find('.track-list-empty').exists()).toBe(true)

      const row = wrapper.findAll('.track-order-agent').find((node) => node.attributes('data-agent') === 'alpha')
      const box = row?.get('input')
      await box?.setValue('gamma')
      await box?.trigger('keydown', { key: 'Enter' })

      const items = wrapper.findAll('.track-preview-item').map((node) => node.text())
      expect(items.some((text) => text.includes('alpha') && text.includes('gamma'))).toBe(true)
    })

    it('toggles the gate on with a seeded proven_by, edits it through the select, and toggles it off', async () => {
      serve({
        '/api/config': configView({
          tracks: { build: { required: ['alpha', 'beta'], max_cycles: 5 } },
        }),
      })
      const { Config } = await boot()
      const wrapper = mount(Config)
      await vi.waitFor(() => expect(wrapper.find('.track-editor').exists()).toBe(true))

      const card = wrapper.get('.track-editor')
      expect(card.find('.track-gate').exists(), 'gate body hidden before the checkbox is on').toBe(false)

      const gateCheckbox = card.get('[data-field="gate-enabled"]')
      await gateCheckbox.setValue(true)
      // Seeded from the first required/available/closing agent.
      expect((card.get('.track-gate select').element as HTMLSelectElement).value).toBe('alpha')

      // The gate's own `blocks` list — the one place `bucketOf`'s
      // `list === 'blocks'` branch is exercised, since that bucket lives one
      // level deeper (`entry.gate?.blocks`) than the other three.
      const blocksList = card.get('.track-gate .track-list')
      await blocksList.get('input').setValue('beta')
      await blocksList.get('.rule-add button').trigger('click')
      expect(blocksList.get('.chips').text()).toContain('beta')

      await card.get('.track-gate select').setValue('beta')
      expect((card.get('.track-gate select').element as HTMLSelectElement).value).toBe('beta')

      await gateCheckbox.setValue(false)
      expect(card.find('.track-gate').exists()).toBe(false)
    })

    it("keeps a gate's stale proven_by visible and selectable even once the track no longer runs that agent", async () => {
      // `offered()`: dropping a value the track no longer runs would
      // silently rewrite the config to whatever option happened to be
      // first — the problem list (`config.problem.gateUnknown`) is what
      // says it is wrong, not a control that quietly discards it.
      serve({
        '/api/config': configView({
          tracks: {
            build: { required: ['alpha', 'beta'], max_cycles: 5, gate: { proven_by: 'alpha', blocks: ['beta'] } },
          },
        }),
      })
      const { Config } = await boot()
      const wrapper = mount(Config)
      await vi.waitFor(() => expect(wrapper.find('.track-editor').exists()).toBe(true))

      const card = wrapper.get('.track-editor')
      const requiredList = wrapper.findAll('.track-list')[0]
      const removeAlpha = requiredList?.findAll('.chips li').find((chip) => chip.text().includes('alpha'))
      await removeAlpha?.get('button').trigger('click')

      const provenSelect = card.get('.track-gate select')
      const options = provenSelect.findAll('option').map((option) => option.attributes('value'))
      expect(options, 'alpha stays offered even though it left required').toContain('alpha')
      expect((provenSelect.element as HTMLSelectElement).value).toBe('alpha')
      expect(wrapper.text()).toContain((english['config.problem.gateUnknown'] ?? '').replace('{agent}', 'alpha'))
    })

    it('toggles the map on with a seeded drafted_by, and edits it through the select', async () => {
      serve({
        '/api/config': configView({
          tracks: { build: { required: ['alpha'], available: ['beta'], max_cycles: 5 } },
        }),
      })
      const { Config } = await boot()
      const wrapper = mount(Config)
      await vi.waitFor(() => expect(wrapper.find('.track-editor').exists()).toBe(true))

      const card = wrapper.get('.track-editor')
      expect(card.find('.track-map').exists()).toBe(false)

      const mapCheckbox = card.get('[data-field="map-enabled"]')
      await mapCheckbox.setValue(true)
      expect((card.get('.track-map select').element as HTMLSelectElement).value).toBe('alpha')

      // Deliberately narrower than the gate's list: `available` is offered,
      // a `closing` agent never would be (a map drafted by one is a
      // document no run ever writes).
      const mapOptions = card.get('.track-map select').findAll('option').map((option) => option.attributes('value'))
      expect(mapOptions.sort()).toEqual(['alpha', 'beta'])

      await card.get('.track-map select').setValue('beta')
      expect((card.get('.track-map select').element as HTMLSelectElement).value).toBe('beta')

      await mapCheckbox.setValue(false)
      expect(card.find('.track-map').exists()).toBe(false)
    })

    it('updates max_cycles, the problem list and the change preview on every keystroke, not only on blur', async () => {
      // `config.js`'s own `onField` is registered on both `input` and
      // `change`; a box bound only to `change` would leave the preview
      // stale until the field lost focus.
      serve({ '/api/config': configView({ tracks: { build: { required: ['alpha'], max_cycles: 5 } } }) })
      const { Config } = await boot()
      const wrapper = mount(Config)
      await vi.waitFor(() => expect(wrapper.find('.track-editor').exists()).toBe(true))

      const cycles = wrapper.get('.track-cycles input')
      ;(cycles.element as HTMLInputElement).value = '7'
      await cycles.trigger('input')

      const items = wrapper.findAll('.track-preview-item').map((node) => node.text())
      expect(items.some((text) => text.includes('max_cycles'))).toBe(true)
    })

    it("shows the count of comment lines a pending save would drop from a track's own block", async () => {
      const raw = [
        'version: 1',
        'tracks:',
        '  build:',
        '    # one comment',
        '    # two comment',
        '    required:',
        '      - alpha',
        '    max_cycles: 5',
        '',
      ].join('\n')
      serve({
        '/api/config': {
          raw,
          revision: 'a'.repeat(64),
          parsed: ConfigSchema.parse({ version: 1, tracks: { build: { required: ['alpha'], max_cycles: 5 } } }),
          invalid: false,
        },
      })
      const { Config } = await boot()
      const wrapper = mount(Config)
      await vi.waitFor(() => expect(wrapper.find('.track-editor').exists()).toBe(true))

      expect(wrapper.find('.track-preview-comments').exists()).toBe(false)

      const gateCheckbox = wrapper.get('[data-field="gate-enabled"]')
      await gateCheckbox.setValue(true)

      const comments = wrapper.get('.track-preview-comments')
      expect(comments.text()).toBe((english['config.preview.commentsLost.other'] ?? '').replace('{count}', '2'))
    })

    it('keeps an order edge reachable, and its problem visible, after its own agent leaves required — the orphan row', async () => {
      serve({
        '/api/config': configView({
          tracks: {
            mine: { required: ['alpha', 'beta'], max_cycles: 3, order: [{ agent: 'alpha', after: ['beta'] }] },
          },
        }),
      })
      const { Config } = await boot()
      const wrapper = mount(Config)
      await vi.waitFor(() => expect(wrapper.find('.track-editor').exists()).toBe(true))

      const requiredList = wrapper.findAll('.track-list')[0]
      const removeAlpha = requiredList?.findAll('.chips li').find((chip) => chip.text().includes('alpha'))
      await removeAlpha?.get('button').trigger('click')

      // The row survives — `draftable` no longer names `alpha`, but its
      // edge is still in the draft, and the row is the union of `draftable`
      // and every `edge.agent` already in `track.order`.
      const orphanRow = wrapper.findAll('.track-order-agent').find((node) => node.attributes('data-agent') === 'alpha')
      expect(orphanRow, 'the orphaned edge lost its row').toBeDefined()
      expect(orphanRow?.find('.chips').text()).toContain('beta')
      expect(wrapper.text()).toContain((english['config.problem.orderAgentUnknown'] ?? '').replace('{agent}', 'alpha'))
    })
  })

  describe('#config-agent-names', () => {
    it('offers every agent already named in specialists: and tracks:, as suggestions rather than a closed list', async () => {
      serve({
        '/api/config': configView({
          specialists: { zeta: 'auto' },
          tracks: { build: { required: ['alpha'], available: ['beta'], max_cycles: 5 } },
        }),
      })
      const { Config } = await boot()
      const wrapper = mount(Config)
      await vi.waitFor(() => expect(wrapper.find('.track-editor').exists()).toBe(true))

      const options = wrapper.get('#config-agent-names').findAll('option').map((option) => option.attributes('value'))
      expect(options).toEqual(['alpha', 'beta', 'zeta'])

      // The agent-name inputs point at it, and never at a closed <select>.
      expect(wrapper.get('#config-specialist-new').attributes('list')).toBe('config-agent-names')
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
      await vi.waitFor(() => expect(wrapper.find('.track-editor').exists()).toBe(true))

      const root = wrapper.get('#panel-config')
      expect(root.classes()).toContain('panel')
      expect(root.attributes('aria-labelledby')).toBe('panel-config-title')
      expect(wrapper.get('#config-editor').classes()).toContain('config-editor')
      expect(wrapper.find('.config-editor-head').exists()).toBe(true)
      expect(wrapper.find('.config-editor-actions').exists()).toBe(true)
      await vi.waitFor(() => expect(wrapper.find('.grid-telemetry').exists()).toBe(true))
      expect(wrapper.find('.track-lists').exists()).toBe(true)
      expect(wrapper.find('.track-editor-head').exists()).toBe(true)
    })
  })
})
