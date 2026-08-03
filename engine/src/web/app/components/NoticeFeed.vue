<script setup lang="ts">
/**
 * A pure renderer over `useNotices.ts`'s module state — see that file for
 * where an entry actually gets recorded and from which of its three doors.
 */
import { useI18n } from '../composables/useI18n.js'
import { useNotices } from '../composables/useNotices.js'
import Tx from './Tx.vue'

const { t, tn } = useI18n()
const { open, feed, unread, toggle } = useNotices()
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
