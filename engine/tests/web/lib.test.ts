import { describe, expect, it } from 'vitest'
import { installForTest, parts, pluralKey, t, tn } from '../../src/web/public/lib/i18n.js'
import { duration, time } from '../../src/web/public/lib/fmt.js'
import { installStorage, read, write } from '../../src/web/public/lib/local.js'
import { routeFrom } from '../../src/web/public/lib/router.js'

/**
 * `lib/` is DOM-free so it is testable here, under the suite's existing
 * `environment: 'node'`, with no new dependency. That is the whole reason the
 * layer rule exists: the plural and bidi decisions are the ones a translator
 * will lean on, and they must be assertable without a browser.
 */

const english = {
  'a.plain': 'Nothing to fill',
  'a.hole': 'Waits on {ids}',
  'a.count': 'Cycle {n}',
  'p.one': '{count} job',
  'p.other': '{count} jobs',
}

describe('t', () => {
  it('falls back to english per key, then to the key itself', () => {
    installForTest({ code: 'ar', strings: { 'a.plain': 'لا شيء' }, fallback: english })
    expect(t('a.plain')).toBe('لا شيء')
    expect(t('a.hole', { ids: 'P001-S01' })).toBe('Waits on P001-S01')
    // A readable identifier beats a blank line, and it is what makes a
    // user-configured agent or track name safe to look up undeclared.
    expect(t('agent.some-custom-agent')).toBe('agent.some-custom-agent')
  })

  it('leaves an unfilled hole visible', () => {
    installForTest({ code: 'en', strings: english })
    expect(t('a.hole', {})).toBe('Waits on {ids}')
  })
})

describe('parts', () => {
  it('splits at the holes so each one can be isolated', () => {
    installForTest({ code: 'en', strings: english })
    expect(parts('a.hole', { ids: 'P001-S01' })).toEqual([
      { kind: 'text', value: 'Waits on ' },
      { kind: 'param', value: 'P001-S01' },
    ])
  })

  it('formats a numeric parameter for the language', () => {
    // `ar-EG` rather than `ar`, because that is where the hazard is real:
    // `Intl.NumberFormat('ar-EG')` renders Arabic-Indic digits. Prose counts,
    // and only prose counts, come through here. Ids, paths and cycle numbers go
    // through `verbatim()` — `P001-S02` must never become `P٠٠١-S٠٢`.
    installForTest({ code: 'ar-EG', strings: english, fallback: english })
    expect(parts('a.count', { n: 3 })).toEqual([
      { kind: 'text', value: 'Cycle ' },
      { kind: 'param', value: '٣' },
    ])
  })
})

describe('plurals', () => {
  it('resolves against english categories', () => {
    installForTest({ code: 'en', strings: english })
    expect(pluralKey('p', 1)).toBe('p.one')
    expect(pluralKey('p', 5)).toBe('p.other')
    expect(tn('p', 1)).toBe('1 job')
  })

  it('resolves against arabic categories', () => {
    installForTest({
      code: 'ar',
      strings: { 'p.zero': 'لا مهامّ', 'p.two': 'مهمّتان', 'p.few': '{count} مهامّ', 'p.other': '{count} مهمّة' },
      fallback: english,
    })
    expect(pluralKey('p', 0)).toBe('p.zero')
    expect(pluralKey('p', 2)).toBe('p.two')
    expect(pluralKey('p', 3)).toBe('p.few')
    expect(pluralKey('p', 100)).toBe('p.other')
  })

  it('falls back to .other for a category the language file does not carry', () => {
    installForTest({ code: 'ar', strings: { 'p.other': '{count} مهمّة' }, fallback: english })
    expect(pluralKey('p', 2)).toBe('p.other')
  })
})

describe('fmt', () => {
  it('renders a duration compactly', () => {
    expect(duration('2026-07-28T12:00:00Z', '2026-07-28T12:00:09Z')).toBe('9s')
    expect(duration('2026-07-28T12:00:00Z', '2026-07-28T12:03:12Z')).toBe('3m 12s')
    expect(duration('2026-07-28T12:00:00Z', '2026-07-28T13:04:00Z')).toBe('1h 04m')
  })

  it('returns nothing rather than Invalid Date', () => {
    // These arrive from files a person may have hand-edited.
    expect(time('not a date')).toBe('')
    expect(time(null)).toBe('')
    expect(duration(null, null)).toBe('')
    expect(duration('2026-07-28T12:03:00Z', '2026-07-28T12:00:00Z')).toBe('')
  })
})

describe('local', () => {
  it('survives storage that is disabled, corrupt or holding an unknown value', () => {
    installStorage({
      getItem: () => {
        throw new Error('disabled')
      },
      setItem: () => {
        throw new Error('disabled')
      },
    })
    expect(read().pane).toBe('collapsed')
    expect(write({ pane: 'full' }).pane).toBe('full')

    installStorage({ getItem: () => '{ not json', setItem: () => {} })
    expect(read().pane).toBe('collapsed')

    installStorage({ getItem: () => JSON.stringify({ pane: 'enormous', lang: 5 }), setItem: () => {} })
    expect(read().pane).toBe('collapsed')
    expect(read().lang).toBe(null)
  })
})

describe('router', () => {
  it('normalises a fragment to a known route', () => {
    expect(routeFrom('#plans', ['run', 'plans'], 'run')).toBe('plans')
    expect(routeFrom('', ['run', 'plans'], 'run')).toBe('run')
    expect(routeFrom('#nope', ['run', 'plans'], 'run')).toBe('run')
  })
})
