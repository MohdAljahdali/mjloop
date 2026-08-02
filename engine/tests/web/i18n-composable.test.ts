// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { installForTest } from '../../src/web/app/lib/i18n.ts'
import { applyLocale, useI18n } from '../../src/web/app/composables/useI18n.ts'
import Bdi from '../../src/web/app/components/Bdi.vue'

const Probe = defineComponent({
  setup() {
    const { t, direction } = useI18n()
    return { t, direction }
  },
  template: `<p :dir="direction">{{ t('rail.track') }}</p>`,
})

// Reads only `t(...)` — no `direction`, no other reactive binding — so a pass
// here proves `t` itself is a reactive dependency of the render, rather than
// riding along on some other binding's re-run.
const TextOnlyProbe = defineComponent({
  setup() {
    const { t } = useI18n()
    return { t }
  },
  template: `<p>{{ t('rail.track') }}</p>`,
})

beforeEach(() => {
  installForTest({ code: 'en', strings: { 'rail.track': 'Track' }, fallback: { 'rail.track': 'Track' } })
})

describe('useI18n', () => {
  it('renders the string for the current locale', () => {
    expect(mount(Probe).text()).toBe('Track')
  })

  it('repaints every subscriber when the locale changes', async () => {
    const probe = mount(Probe)
    installForTest({ code: 'ar', strings: { 'rail.track': 'المسار' } })
    await applyLocale('ar')
    // No snapshot field moved. Under the old page this needed translateStatic()
    // plus a manual draw(); here the ref does it.
    expect(probe.text()).toBe('المسار')
    expect(probe.get('p').attributes('dir')).toBe('rtl')
  })

  it('repaints a subscriber whose only reactive read is t() itself', async () => {
    const probe = mount(TextOnlyProbe)
    installForTest({ code: 'ar', strings: { 'rail.track': 'المسار' } })
    await applyLocale('ar')
    expect(probe.text()).toBe('المسار')
  })

  it('resolves the correct plural category across a locale change', async () => {
    installForTest({
      code: 'en',
      strings: { 'rail.track.one': 'Track', 'rail.track.other': 'Tracks' },
      registry: { en: { name: 'English', dir: 'ltr' }, ar: { name: 'العربية', dir: 'rtl' } },
    })
    const Plural = defineComponent({
      setup() {
        const { tn } = useI18n()
        return { tn }
      },
      template: `<p>{{ tn('rail.track', 2) }}</p>`,
    })
    const probe = mount(Plural)
    expect(probe.text()).toBe('Tracks')

    installForTest({
      code: 'ar',
      strings: {
        'rail.track.zero': 'لا مسارات',
        'rail.track.one': 'مسار واحد',
        'rail.track.two': 'مساران',
        'rail.track.few': 'مسارات قليلة',
        'rail.track.many': 'مسارات كثيرة',
        'rail.track.other': 'مسارات',
      },
    })
    await applyLocale('ar')
    expect(probe.text()).toBe('مساران')
  })
})

describe('Bdi', () => {
  it('isolates an identifier and pins it left-to-right', () => {
    const wrapper = mount(Bdi, { props: { value: 'P001-S02' } })
    // Intl would render this P٠٠١-S٠٢ in Arabic, and an unisolated Latin run
    // inside an Arabic sentence drags the punctuation around it.
    expect(wrapper.element.tagName).toBe('BDI')
    expect(wrapper.attributes('dir')).toBe('ltr')
    expect(wrapper.text()).toBe('P001-S02')
  })
})

import fs from 'node:fs/promises'
import path from 'node:path'

describe('the locale registry', () => {
  it('registers exactly the locale files that ship', async () => {
    const dir = path.resolve(process.cwd(), 'src', 'web', 'app', 'locales')
    const shipped = (await fs.readdir(dir)).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5))
    const { LOCALES } = await import('../../src/web/app/composables/useI18n.ts')
    expect(Object.keys(LOCALES).sort()).toEqual(shipped.sort())
  })
})
