<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import type { Message } from '../../protocol.js'
import { onNotice } from '../stores/session.js'
import { useI18n } from '../composables/useI18n.js'

/** Bounded: this is a feed, not a log, and it is rendered. */
const LIMIT = 50

const { t } = useI18n()
const open = ref(false)
const feed = ref<{ id: number; message: Message }[]>([])
let counter = 0

const off = onNotice((message) => {
  feed.value = [{ id: ++counter, message }, ...feed.value].slice(0, LIMIT)
})
onBeforeUnmount(off)
</script>

<template>
  <button
    type="button"
    class="notice-toggle"
    id="notice-toggle"
    aria-haspopup="true"
    :aria-expanded="open"
    aria-controls="notice-panel"
    @click="open = !open"
  >
    <span>{{ t('notice.toggle') }}</span>
    <span v-if="feed.length > 0" class="nav-count" aria-hidden="true">{{ feed.length }}</span>
  </button>
  <section v-if="open" class="notice-panel" id="notice-panel" aria-labelledby="notice-panel-title">
    <header class="panel-head">
      <div>
        <h2 id="notice-panel-title">{{ t('notice.title') }}</h2>
        <p class="hint">{{ t('notice.hint') }}</p>
      </div>
      <button type="button" @click="open = false">{{ t('notice.close') }}</button>
    </header>
    <p v-if="feed.length === 0" class="empty">{{ t('notice.empty') }}</p>
    <ul v-else id="notice-list">
      <li v-for="entry in feed" :key="entry.id" class="notice-row">
        <span>{{ t(entry.message.code, entry.message.params) }}</span>
      </li>
    </ul>
  </section>
</template>
