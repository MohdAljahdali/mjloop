<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import type { Message } from '../types/protocol.js'
import { onNotice } from '../stores/session.js'
import { useI18n } from '../composables/useI18n.js'
import Tx from './Tx.vue'

/** Bounded: this is a feed, not a log, and it is rendered. */
const LIMIT = 50

const { t, tn } = useI18n()
const open = ref(false)
const feed = ref<{ id: number; message: Message }[]>([])
/** `notifications.js:130-131`: unread, not total — and it resets to zero on open. */
const unread = ref(0)
let counter = 0

const off = onNotice((message) => {
  feed.value = [{ id: ++counter, message }, ...feed.value].slice(0, LIMIT)
  if (!open.value) unread.value += 1
})
onBeforeUnmount(off)

function toggle(): void {
  open.value = !open.value
  if (open.value) unread.value = 0
}
</script>

<template>
  <button
    type="button"
    class="notice-toggle"
    id="notice-toggle"
    aria-haspopup="true"
    :aria-expanded="open"
    aria-controls="notice-panel"
    :title="unread > 0 ? tn('notice.unreadCount', unread) : undefined"
    @click="toggle"
  >
    <span>{{ t('notice.toggle') }}</span>
    <span v-if="unread > 0" class="nav-count" aria-hidden="true">{{ t('tabs.number', { n: unread }) }}</span>
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
        <!-- Server-sent `{code, params}` — 45 locale keys here carry ids,
             agent names, tracks, paths and digests, so this is `Tx`, not
             `t()`, unconditionally. -->
        <span><Tx :key-name="entry.message.code" :params="entry.message.params" /></span>
      </li>
    </ul>
  </section>
</template>
