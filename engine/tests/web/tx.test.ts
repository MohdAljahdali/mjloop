// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { installForTest } from '../../src/web/app/lib/i18n.ts'
import { useI18n } from '../../src/web/app/composables/useI18n.ts'
import Tx from '../../src/web/app/components/Tx.vue'

// `notice.story.done` in Arabic: `اكتملت {id}.` — a Latin id right before a
// neutral `.` is exactly the shape `tx()` isolates and plain `t()` does not.
const AR = {
  'notice.story.done': 'اكتملت {id}.',
  'features.record.draft': '{id}، المراجعة {revision} — مسوّدة.',
}

beforeEach(() => {
  installForTest({ code: 'ar', strings: AR, fallback: AR })
})

// `Tx`'s root is a `<template v-for>` — a fragment of sibling nodes, exactly
// as every real call site uses it (inside a `<p>`, a `<span>`). Mounting the
// fragment directly is a vue-test-utils artifact, not how the component is
// ever actually used: `wrapper.text()`/`.html()` read each root-level node
// separately and trim it on its own, which drops the space a text segment
// that abuts a hole legitimately carries. Every assertion below mounts `Tx`
// through a wrapping element, matching every real call site in the app.
function mountInParent(keyName: string, params?: Record<string, string | number>) {
  const Wrap = defineComponent({
    render: () => h('p', [h(Tx, { keyName, params })]),
  })
  return mount(Wrap)
}

describe('Tx', () => {
  it('wraps a single hole in exactly one bare <bdi>, with no dir attribute', () => {
    const wrapper = mountInParent('notice.story.done', { id: 'P001-S02' })
    const bdis = wrapper.findAll('bdi')
    expect(bdis).toHaveLength(1)
    expect(bdis[0]?.text()).toBe('P001-S02')
    expect(bdis[0]?.attributes('dir')).toBeUndefined()
    // The surrounding text is plain — not itself wrapped — and the hole sits
    // between the verb and the final full stop, not floated to either end.
    expect(wrapper.text()).toBe('اكتملت P001-S02.')
  })

  it('wraps two holes in two separate <bdi> elements, each holding only its own value', () => {
    // `ar-EG` rather than `ar` — `tests/web/lib.test.ts`'s own `parts()` suite
    // notes why: this is where `Intl.NumberFormat` actually renders
    // Arabic-Indic digits, and bare `ar` does not on this ICU.
    installForTest({ code: 'ar-EG', strings: AR, fallback: AR })
    const wrapper = mountInParent('features.record.draft', { id: 'F007', revision: 3 })
    const bdis = wrapper.findAll('bdi')
    expect(bdis).toHaveLength(2)
    expect(bdis.map((b) => b.text())).toEqual(['F007', '٣'])
    for (const bdi of bdis) expect(bdi.attributes('dir')).toBeUndefined()
  })

  /**
   * Proof this test discriminates: the same content rendered through plain
   * `t()` — what the pre-Task-14 port did at every one of the 25 sites — is
   * indistinguishable from correct prose text-only, so a naive "contains the
   * id" assertion would pass against both. Only counting `<bdi>` elements
   * fails against `t()` and passes against `Tx`.
   */
  it('discriminates from plain t(): rendering the same key through t() alone yields zero <bdi> elements', () => {
    const Plain = defineComponent({
      setup() {
        const { t } = useI18n()
        return { t }
      },
      template: `<span>{{ t('notice.story.done', { id: 'P001-S02' }) }}</span>`,
    })
    const wrapper = mount(Plain)
    expect(wrapper.text()).toBe('اكتملت P001-S02.')
    expect(wrapper.findAll('bdi')).toHaveLength(0)
  })
})
