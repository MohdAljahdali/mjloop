/**
 * The reactive skin over `lib/i18n.ts`.
 *
 * The module underneath stays exactly as it was — plural categories, per-key
 * fallback, the bidi split. All this adds is an epoch ref that every `t()` call
 * reads, so a locale change invalidates every render that used a string. The
 * old page had to walk the document and repaint by hand.
 */
import { computed, ref } from 'vue'
import {
  direction as currentDirection,
  installLocales,
  known as knownKey,
  loadFallback,
  locale as currentLocale,
  localeEpoch,
  parts as translateParts,
  pickLocale,
  setLocale,
  t as translate,
  tn as translatePlural,
  type LocaleRegistry,
  type Params,
} from '../lib/i18n.js'
import { read as prefs, write as remember } from '../lib/local.js'

/**
 * Adding a language: drop `locales/<code>.json` beside the others, add a line.
 *
 * Kept as a literal with two-space keys and a closing brace at column 0,
 * because `locales.test.ts` reads it as source text — a locale file nobody
 * registered is a translation the user cannot pick.
 */
export const LOCALES: LocaleRegistry = {
  en: { name: 'English', dir: 'ltr' },
  ar: { name: 'العربية', dir: 'rtl' },
}
export const FALLBACK = 'en'

/**
 * Mirrors `lib/i18n.ts`'s own `localeEpoch()` rather than keeping a second,
 * independent counter — `setLocale` bumps the lib's epoch, not this one, so a
 * caller that reaches past `applyLocale` and calls `setLocale` directly must
 * still repaint. Do not call `setLocale` directly from a component: `applyLocale`
 * is the only door, because it is what refreshes this ref.
 */
const epoch = ref(0)

export function useI18n() {
  return {
    t: (key: string, params?: Params) => (epoch.value, translate(key, params)),
    tn: (stem: string, count: number, params?: Params) => (epoch.value, translatePlural(stem, count, params)),
    // The content-position counterpart to `t()` — `Tx.vue` is built on this,
    // for the same reason `t` itself is wrapped rather than imported
    // directly: a locale switch must invalidate every render that read it.
    parts: (key: string, params?: Params) => (epoch.value, translateParts(key, params)),
    known: (key: string) => (epoch.value, knownKey(key)),
    locale: computed(() => (epoch.value, currentLocale())),
    direction: computed(() => (epoch.value, currentDirection())),
  }
}

/** Wire the loader. Called once, from `main.ts`, before the app mounts. */
export function bootLocales(token: string): void {
  installLocales(LOCALES, FALLBACK, {
    load: async (code) => {
      const response = await fetch(`locales/${code}.json?t=${encodeURIComponent(token)}`, { cache: 'no-store' })
      if (!response.ok) throw new Error(String(response.status))
      return response.json()
    },
    saved: () => prefs().lang,
    save: (code) => void remember({ lang: code }),
    preferred: () => navigator.languages ?? [],
    forced: () => new URLSearchParams(location.search).get('lang'),
  })
}

export async function applyLocale(code: string): Promise<void> {
  await setLocale(code)
  document.documentElement.lang = currentLocale()
  document.documentElement.dir = currentDirection()
  epoch.value = localeEpoch()
}

/** The opening locale: `?lang=`, then the remembered choice, then the browser. */
export async function startLocale(): Promise<void> {
  await loadFallback()
  await applyLocale(pickLocale())
}
