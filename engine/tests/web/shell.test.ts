// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { installForTest } from '../../src/web/app/lib/i18n.ts'
import Rail from '../../src/web/app/components/Rail.vue'
import Banners from '../../src/web/app/components/Banners.vue'
import { emptySnapshot, readLocale } from './helpers/page.js'

const english = await readLocale('en')

beforeEach(() => {
  installForTest({ code: 'en', strings: english })
})

describe('Rail', () => {
  it('shows the run detail only once a run is open', () => {
    const idle = mount(Rail, { props: { snapshot: emptySnapshot({ state: { ...emptySnapshot().state, run_id: null } }) } })
    expect(idle.find('.rail-detail').exists()).toBe(false)

    const running = emptySnapshot()
    running.state = { ...running.state, status: 'running', run_id: 'run-1', track: 'build', cycle: 2 }
    const live = mount(Rail, { props: { snapshot: running } })
    expect(live.find('.rail-detail').exists()).toBe(true)
    expect(live.text()).toContain('build')
  })

  it('renders the run id verbatim, never through Intl', () => {
    const running = emptySnapshot()
    running.state = { ...running.state, status: 'running', run_id: '20260803-1' }
    const live = mount(Rail, { props: { snapshot: running } })
    // An id inside a translated sentence must be a <bdi dir=ltr>, or Arabic
    // renders it with Arabic-Indic digits and reorders the hyphen.
    expect(live.find('bdi[dir="ltr"]').text()).toContain('20260803-1')
  })

  it('shows the strike counter only when strikes have been taken', () => {
    const clean = mount(Rail, { props: { snapshot: emptySnapshot({ guards: { strikes: 0, strikesAllowed: 3, cycleErrors: [], errorArmed: null } }) } })
    expect(clean.find('[data-test="strikes"]').exists()).toBe(false)
    const struck = mount(Rail, { props: { snapshot: emptySnapshot({ guards: { strikes: 2, strikesAllowed: 3, cycleErrors: [], errorArmed: null } }) } })
    expect(struck.find('[data-test="strikes"]').text()).toContain('2')
  })
})

describe('Banners', () => {
  it('says the page is offline when the socket is down', () => {
    const wrapper = mount(Banners, { props: { snapshot: emptySnapshot(), online: false } })
    expect(wrapper.find('.banner.offline').exists()).toBe(true)
  })

  it('says nothing when everything is fine', () => {
    const wrapper = mount(Banners, { props: { snapshot: emptySnapshot(), online: true } })
    expect(wrapper.findAll('.banner')).toHaveLength(0)
  })

  it('warns when the project has no design system', () => {
    const snap = emptySnapshot()
    snap.state = { ...snap.state, design_system: false }
    const wrapper = mount(Banners, { props: { snapshot: snap, online: true } })
    expect(wrapper.find('.banner.note').exists()).toBe(true)
  })
})
