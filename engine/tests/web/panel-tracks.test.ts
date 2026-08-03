// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import type { Snapshot } from '../../src/web/protocol.js'
import { ConfigSchema } from '../../src/schemas/config.js'
import { emptySnapshot, readLocale } from './helpers/page.js'

/**
 * The Tracks panel — the structured `specialists:`/`tracks:` half of
 * `config.yaml`, split out of `Config.vue` and `panel-config.test.ts`'s own
 * `describe('Config.vue')` in the task that split `collectConfigChanges`
 * into `collectSettingsChanges`/`collectTrackChanges` (`lib/config.ts`'s own
 * header). Every `it` below except the last describe block is moved from
 * `panel-config.test.ts` unchanged in substance — only the mounted
 * component, its form/button ids (`#tracks-*` in place of `#config-*` for
 * the editor chrome the two panels do not share), and the readiness wait
 * (this panel has no plain fields to probe, so readiness is the first
 * `.track-editor` appearing, same as the pre-split file's own convention)
 * moved with it. That every `it` below still passes against `Tracks.vue` is
 * itself half the proof that the editors moved rather than were dropped;
 * `panel-config.test.ts`'s own `'no longer carries the track editors'` is
 * the other half.
 *
 * New here, and nowhere else: `describe('two tabs, one document')` — the
 * write.stale.config refusal the split's own revision guard exists to
 * produce: a save from this tab while `Config.vue` has already moved the
 * revision past what this tab is still holding must be refused, not
 * silently applied. See that `describe`'s own comment.
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

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('fetch', () => Promise.resolve(new Response('null', { status: 200 })))
})

async function boot(snapshot: Snapshot = emptySnapshot()) {
  const freshI18n = await import('../../src/web/app/lib/i18n.ts')
  freshI18n.installForTest({ code: 'en', strings: english })
  const store = await import('../../src/web/app/stores/session.ts')
  store.connect({ token: 'tok', socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket })
  const { default: Tracks } = await import('../../src/web/app/panels/Tracks.vue')
  const { default: Config } = await import('../../src/web/app/panels/Config.vue')
  FakeSocket.last?.deliver({ type: 'snapshot', snapshot })
  await nextTick()
  return { store, Tracks, Config, socket: FakeSocket.last as FakeSocket }
}

const control = (wrapper: ReturnType<typeof mount>, id: string) => wrapper.get(`#${id}`).element as HTMLInputElement & HTMLSelectElement

describe('Tracks.vue', () => {
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
    const { Tracks } = await boot()
    const wrapper = mount(Tracks)
    await vi.waitFor(() => expect(wrapper.get('#tracks-editor-state').text()).toBe(english['config.editorInvalid']))

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

  describe('the save-is-the-only-door invariant', () => {
    it('sends nothing while mutating a specialist rule and a track — only Save reaches the server, and exactly once', async () => {
      serve({
        '/api/config': configView({
          tracks: { build: { required: ['builder'], max_cycles: 5 } },
        }),
      })
      const { Tracks, socket } = await boot()
      const wrapper = mount(Tracks)
      await vi.waitFor(() => expect(wrapper.find('.track-editor').exists()).toBe(true))

      // A structured specialist rule.
      await wrapper.get('#config-specialist-new').setValue('security')
      await wrapper.get('.rule-add button').trigger('click')
      // A structured track mutation: a new required agent.
      const requiredAdd = wrapper.get('.track-list input')
      await requiredAdd.setValue('verifier')
      await wrapper.get('.track-list .rule-add button').trigger('click')

      expect(socket.sent, 'nothing reaches the server before Save').toEqual([])
      expect(control(wrapper, 'tracks-save').disabled).toBe(false)

      // happy-dom does not perform a browser's implicit form submission on a
      // button click, so the form's own `submit` is triggered directly —
      // `panel-skills.test.ts`'s own convention for a `type="submit"` control.
      await wrapper.get('#tracks-editor').trigger('submit')
      expect(socket.sent).toHaveLength(1)
      const write = (socket.sent[0] as { write: { kind: string; changes: unknown[] } }).write
      expect(write.kind).toBe('config.patch')
      expect(write.changes.length).toBeGreaterThan(0)

      // Settling the write is what clears `dirty` — Save stays disabled and
      // nothing sends again on its own.
      socket.deliver({ type: 'receipt', id: (socket.sent[0] as { id: string }).id, ok: true, code: 'write.ok' })
      await nextTick()
      expect(control(wrapper, 'tracks-save').disabled).toBe(true)
      expect(socket.sent).toHaveLength(1)
    })
  })

  describe('a revision moving underneath a dirty draft', () => {
    it('shows the conflict banner, disables Save, enables Reset, and does not clobber the dirty draft', async () => {
      let served: unknown = configView({ tracks: { build: { required: ['builder'], max_cycles: 5 } } })
      vi.stubGlobal('fetch', (url: string) => {
        const isConfig = url.startsWith('/api/config')
        return Promise.resolve(
          new Response(JSON.stringify(isConfig ? served : { error: { code: 'error.notFound' } }), { status: isConfig ? 200 : 404 }),
        )
      })
      const { Tracks, socket } = await boot()
      const wrapper = mount(Tracks)
      await vi.waitFor(() => expect(wrapper.find('.track-editor').exists()).toBe(true))

      await wrapper.get('#config-specialist-new').setValue('security')
      await wrapper.get('.rule-add button').trigger('click')
      expect(control(wrapper, 'tracks-save').disabled).toBe(false)

      served = {
        ...(configView({ tracks: { build: { required: ['builder', 'verifier'], max_cycles: 5 } } }) as object),
        revision: 'b'.repeat(64),
      }
      socket.deliver({
        type: 'snapshot',
        snapshot: emptySnapshot({ revisions: { ...emptySnapshot().revisions, config: 'moved' } }),
      })
      await vi.waitFor(() => expect(wrapper.get('#tracks-editor-state').text()).toBe(english['config.editorChanged']))

      expect(control(wrapper, 'tracks-save').disabled).toBe(true)
      expect(control(wrapper, 'tracks-reset').disabled).toBe(false)
      // The choice this editor was mid-way through survives the conflict.
      expect(wrapper.get('.rule-name').text()).toBe('security')

      await wrapper.get('#tracks-reset').trigger('click')
      // Reset re-seeds from the document that actually landed.
      expect(wrapper.find('.rule').exists()).toBe(false)
      expect(wrapper.find('#tracks-editor-state').exists()).toBe(false)
      expect(socket.sent).toEqual([])
    })
  })

  describe('the specialists: editor', () => {
    it('adds a rule, shows its mode sentence, and removes it — structurally, at the classes 60-panels.css selects', async () => {
      serve({ '/api/config': configView() })
      const { Tracks } = await boot()
      const wrapper = mount(Tracks)
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
      const { Tracks } = await boot()
      const wrapper = mount(Tracks)
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
      const { Tracks } = await boot()
      const wrapper = mount(Tracks)
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
      const { Tracks } = await boot()
      const wrapper = mount(Tracks)
      await vi.waitFor(() => expect(wrapper.find('.track-editor').exists()).toBe(true))

      const list = wrapper.findAll('.track-list')[0]
      const remove = list?.get('.chips button')
      await remove?.trigger('click')

      expect(wrapper.get('.track-problem').text()).toBe(english['config.problem.noRequired'])
      expect(control(wrapper, 'tracks-save').disabled).toBe(true)
    })

    it('names each order edge Save would add and remove in the change preview, and says nothing pending while the draft matches the baseline', async () => {
      serve({
        '/api/config': configView({
          tracks: { build: { required: ['alpha', 'beta', 'gamma'], max_cycles: 5, order: [{ agent: 'alpha', after: ['beta'] }] } },
        }),
      })
      const { Tracks } = await boot()
      const wrapper = mount(Tracks)
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
      const { Tracks } = await boot()
      const wrapper = mount(Tracks)
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
      const { Tracks } = await boot()
      const wrapper = mount(Tracks)
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
      const { Tracks } = await boot()
      const wrapper = mount(Tracks)
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
      const { Tracks } = await boot()
      const wrapper = mount(Tracks)
      await vi.waitFor(() => expect(wrapper.find('.track-editor').exists()).toBe(true))

      const cycles = wrapper.get('.track-cycles input')
      ;(cycles.element as HTMLInputElement).value = '7'
      await cycles.trigger('input')

      const items = wrapper.findAll('.track-preview-item').map((node) => node.text())
      expect(items.some((text) => text.includes('max_cycles'))).toBe(true)
    })

    it('blocks Save while the required max_cycles box is left empty, rather than silently sending the last value it accepted', async () => {
      // `onCyclesChange` (`TrackEditor.vue`) refuses a non-integer or `< 1`
      // and keeps the draft at its last good value — so clearing the box
      // alone never reaches the wire with a bad number. What it does not do
      // is put the box back to that value, so the reader is left staring at
      // an empty required field with Save still enabled unless something
      // gates on the form's own HTML validity, the same way `Config.vue`
      // does for its plain fields.
      serve({ '/api/config': configView({ tracks: { build: { required: ['alpha'], max_cycles: 5 } } }) })
      const { Tracks, socket } = await boot()
      const wrapper = mount(Tracks)
      await vi.waitFor(() => expect(wrapper.find('.track-editor').exists()).toBe(true))

      const cycles = wrapper.get('.track-cycles input').element as HTMLInputElement
      // A valid edit first, so the draft actually differs from the
      // baseline — otherwise `collectTrackChanges` sends nothing regardless
      // of the box's own validity, and the gate below is never reached.
      cycles.value = '7'
      await wrapper.get('.track-cycles input').trigger('input')
      // Then clear it — the draft stays at 7, but the box itself now shows
      // nothing.
      cycles.value = ''
      await wrapper.get('.track-cycles input').trigger('input')

      await wrapper.get('#tracks-editor').trigger('submit')
      expect(socket.sent, 'an invalid required field must block the write').toEqual([])
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
      const { Tracks } = await boot()
      const wrapper = mount(Tracks)
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
      const { Tracks } = await boot()
      const wrapper = mount(Tracks)
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
      const { Tracks } = await boot()
      const wrapper = mount(Tracks)
      await vi.waitFor(() => expect(wrapper.find('.track-editor').exists()).toBe(true))

      const options = wrapper.get('#config-agent-names').findAll('option').map((option) => option.attributes('value'))
      expect(options).toEqual(['alpha', 'beta', 'zeta'])

      // The agent-name inputs point at it, and never at a closed <select>.
      expect(wrapper.get('#config-specialist-new').attributes('list')).toBe('config-agent-names')
    })
  })

  describe('structural assertions — 60-panels.css', () => {
    it('carries the panel root and the track-editor structure at the ids and classes the stylesheet selects', async () => {
      serve({ '/api/config': configView({ tracks: { build: { required: ['alpha'], max_cycles: 5 } } }) })
      const { Tracks } = await boot()
      const wrapper = mount(Tracks)
      await vi.waitFor(() => expect(wrapper.find('.track-editor').exists()).toBe(true))

      const root = wrapper.get('#panel-tracks')
      expect(root.classes()).toContain('panel')
      expect(root.attributes('aria-labelledby')).toBe('panel-tracks-title')
      expect(wrapper.get('#tracks-editor').classes()).toContain('config-editor')
      expect(wrapper.find('.config-editor-head').exists()).toBe(true)
      expect(wrapper.find('.config-editor-actions').exists()).toBe(true)
      expect(wrapper.find('.track-lists').exists()).toBe(true)
      expect(wrapper.find('.track-editor-head').exists()).toBe(true)
    })
  })

  /**
   * Two panels, one document. `Config.vue`'s own header explains why each
   * keeps an independent `baseline`/`editorRevision`/`conflict` rather than
   * sharing one: the two panels read the same `/api/config` feed but mutate
   * disjoint halves of it through disjoint drafts, and only the revision
   * ties the two writes together.
   *
   * A revision landing between two edits is already covered, once, by
   * `panel-config.test.ts`'s and this file's own `'a revision moving
   * underneath a dirty draft'` — a single tab noticing its own document moved
   * out from under it before it saves. This is the different case the split
   * itself introduces: a tab that does not yet know the document moved,
   * because the move was the *other* tab's own save, still in flight or just
   * settled, and this tab's Save reaches the server anyway, carrying the
   * revision it was holding before that. The server's job — refuse it with
   * `write.stale.config` rather than applying it over the other tab's change
   * — is exercised here through the fake socket exactly as the real server
   * would answer it; what this test proves on the client is that a refusal
   * is not silently treated as success: the write that went out still names
   * the stale revision (nothing here rebases it), and settling it with
   * `ok: false` leaves the edit dirty and Save enabled, rather than clearing
   * it as `write.ok` would.
   */
  describe('two tabs, one document', () => {
    it("refuses this tab's save once Config's own save has already moved the revision, rather than applying it", async () => {
      serve({ '/api/config': configView() })
      const { Tracks, Config, socket } = await boot()
      const tracksWrapper = mount(Tracks)
      const configWrapper = mount(Config)
      await vi.waitFor(() => expect(tracksWrapper.find('.track-editor').exists()).toBe(true))
      await vi.waitFor(() => expect(control(configWrapper, 'config-max-parallel-input').disabled).toBe(false))

      // Both tabs start dirty against the same revision — the race the split
      // introduced.
      await tracksWrapper.get('#config-specialist-new').setValue('security')
      await tracksWrapper.get('.rule-add button').trigger('click')
      await configWrapper.get('#config-autonomous-input').setValue(true)

      // Config saves first, and its write settles — the server's own
      // revision has now moved past what Tracks is still holding.
      await configWrapper.get('#config-editor').trigger('submit')
      expect(socket.sent).toHaveLength(1)
      const configWrite = socket.sent[0] as { id: string; write: { revision: string } }
      socket.deliver({ type: 'receipt', id: configWrite.id, ok: true, code: 'write.ok' })
      await nextTick()

      // Tracks saves next, still holding the revision it was seeded with —
      // proof this is genuinely the same stale revision, not something the
      // client silently rebased before sending.
      await tracksWrapper.get('#tracks-editor').trigger('submit')
      expect(socket.sent).toHaveLength(2)
      const tracksWrite = socket.sent[1] as { id: string; write: { revision: string } }
      expect(tracksWrite.write.revision).toBe(configWrite.write.revision)

      // The server refuses it — simulated here exactly as the real one
      // would answer a write against a revision it has already moved past.
      socket.deliver({ type: 'receipt', id: tracksWrite.id, ok: false, code: 'write.stale.config' })
      await nextTick()

      // Not silently applied: the edit is still dirty, Save is still on,
      // and the rule the reader typed is still on screen rather than having
      // been discarded as if it had landed.
      expect(control(tracksWrapper, 'tracks-save').disabled).toBe(false)
      expect(tracksWrapper.find('.rule').exists()).toBe(true)
      expect(tracksWrapper.get('.rule-name').text()).toBe('security')
    })
  })
})
