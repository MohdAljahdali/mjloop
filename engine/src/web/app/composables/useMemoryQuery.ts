/**
 * The Memory panel's own search box, backed by `lib/local.ts`'s
 * `memoryQuery` — the one preference this panel persists.
 *
 * Not `useSelection()`: that composable's own header restricts itself to
 * state more than one panel reads (`activePlan`, `storyFilter`, the story
 * work-tabs). `memoryQuery` has exactly one reader, `Memory.vue`, so it gets
 * its own small composable instead of a new field on a module built for
 * sharing.
 *
 * `prefs()` is read from inside this function's own body, not at module
 * scope: `main.ts`'s `import App from './App.vue'` pulls this module in
 * through `Memory.vue`'s import graph before `main.ts` reaches
 * `installStorage(localStorage)` — a module-scope `ref(prefs().memoryQuery)`
 * would read `lib/local.ts`'s `DEFAULTS` and never see a returning reader's
 * remembered query. `tests/web/typeguard.test.ts` guards exactly this.
 */
import { ref, type Ref } from 'vue'
import { read as prefs, write as remember } from '../lib/local.js'

export interface UseMemoryQuery {
  query: Ref<string>
  setQuery(value: string): void
}

export function useMemoryQuery(): UseMemoryQuery {
  const query = ref(prefs().memoryQuery)
  return {
    query,
    setQuery(value: string) {
      query.value = value
      remember({ memoryQuery: value })
    },
  }
}
