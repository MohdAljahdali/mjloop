/**
 * Which tab is open, kept in the hash so a tab is a link somebody can send.
 *
 * `lib/router.ts` owns the parsing; this owns the reactive cell it writes into.
 */
import { ref, type Ref } from 'vue'
import { startRouter } from '../lib/router.js'

// 'tracks' is not added here yet — Tracks.vue does not exist until its own
// task, and a tab link that opens an empty <main> is a broken page shipped
// for however long it would sit unfinished. It lands beside its own panel.
export type TabId = 'run' | 'plans' | 'stories' | 'features' | 'skills' | 'agents' | 'evidence' | 'memory' | 'config'

export const TABS: readonly TabId[] = ['run', 'plans', 'stories', 'features', 'skills', 'agents', 'evidence', 'memory', 'config']

const active = ref<TabId>('run') as Ref<TabId>

export function useTabs() {
  return { tabs: TABS, active, show: (id: TabId) => void (location.hash = `#${id}`) }
}

/** Called once from `App.vue`'s setup. */
export function startTabs(): void {
  startRouter(
    {
      hash: () => location.hash,
      setHash: (hash) => void (location.hash = hash),
      onChange: (fn) => addEventListener('hashchange', fn),
    },
    [...TABS],
    'run',
    (id) => (active.value = id as TabId),
  )
}
