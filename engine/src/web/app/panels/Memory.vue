<script setup lang="ts">
/**
 * Memory — browse by kind, tag, time and originating run. `panels/memory.js`,
 * ported.
 *
 * Faceting is client-side because it has to be: `memorySearch` supports no
 * filter by kind, tag, time or run, so there is nothing to push to the
 * server. `lib/memory.ts`'s `facet` is the same pure filter, tested there.
 *
 * Writing a memory is **out of scope**. It would be a fourth write, and
 * `writeMemory` uses flag `wx` with no update and no delete anywhere — a UI
 * that looked editable would be lying.
 */
import { computed, ref } from 'vue'
import { useI18n } from '../composables/useI18n.js'
import { useFeed } from '../composables/useFeed.js'
import { useMemoryQuery } from '../composables/useMemoryQuery.js'
import { facet } from '../lib/memory.js'
import type { MemoryView } from '../types/protocol.js'
import MemoryRow from '../components/MemoryRow.vue'

const { t, known } = useI18n()

/** `ui/list.js`'s `reconcile()` own default row cap. */
const MEMORY_LIST_LIMIT = 200

const { query, setQuery } = useMemoryQuery()
/** Never persisted — the kind picker resets to "every kind" on every visit. */
const kindFilter = ref('')

const memoriesFeed = useFeed<MemoryView[]>({
  dep: (state) => state.revisions.memory,
  path: () => '/api/memory',
})
const all = computed(() => memoriesFeed.value.value ?? [])

/** The kinds actually present, so the picker never offers an empty filter. */
const availableKinds = computed(() => [...new Set(all.value.map((memory) => memory.kind))].sort())

/**
 * A kind comes from the engine's own enum, and the page has a word for the
 * ones it knows. The schema is still the engine's to grow, so a kind this
 * dictionary has never heard of renders as it arrived rather than as a
 * dotted key.
 */
function kindWord(kind: string): string {
  const key = `memory.kind.${kind}`
  return known(key) ? t(key) : kind
}

const filtered = computed(() => facet(all.value, query.value, kindFilter.value))
const shown = computed(() => filtered.value.slice(0, MEMORY_LIST_LIMIT))
const more = computed(() => filtered.value.length > shown.value.length)

function onQueryInput(event: Event): void {
  setQuery((event.target as HTMLInputElement).value)
}
</script>

<template>
  <section id="panel-memory" class="panel" aria-labelledby="panel-memory-title">
    <header class="panel-head">
      <div>
        <h1 id="panel-memory-title">{{ t('panel.memory.title') }}</h1>
        <p class="hint">{{ t('panel.memory.help') }}</p>
      </div>
    </header>
    <p v-if="shown.length === 0" id="memory-empty" class="empty">
      {{ all.length === 0 ? t('memory.empty') : t('memory.noMatch') }}
    </p>
    <div class="facets">
      <!-- Faceting is client-side because it has to be: `memorySearch`
           filters by none of kind, tag, time or run, so there is nothing to
           push to the server. -->
      <input
        id="memory-query"
        name="q"
        dir="auto"
        autocomplete="off"
        :placeholder="t('memory.searchHint')"
        :aria-label="t('memory.searchLabel')"
        :value="query"
        @input="onQueryInput"
      />
      <select id="memory-kind" name="kind" :aria-label="t('memory.kindLabel')" v-model="kindFilter">
        <option value="">{{ t('memory.allKinds') }}</option>
        <option v-for="kind in availableKinds" :key="kind" :value="kind">{{ kindWord(kind) }}</option>
      </select>
    </div>
    <ul id="memory-list" class="memories">
      <MemoryRow v-for="memory in shown" :key="memory.id" :memory="memory" />
    </ul>
    <p v-if="more" id="memory-more" class="more">{{ t('memory.more', { shown: shown.length, total: filtered.length }) }}</p>
  </section>
</template>
