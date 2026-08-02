<script setup lang="ts">
import { computed } from 'vue'
import { online, snapshot } from './stores/session.js'
import { useI18n } from './composables/useI18n.js'
import { startTabs, useTabs } from './composables/useTabs.js'
import { ready } from './lib/stories.js'
import Banners from './components/Banners.vue'
import Bdi from './components/Bdi.vue'
import LanguagePicker from './components/LanguagePicker.vue'
import Rail from './components/Rail.vue'

const { t, tn } = useI18n()
const { tabs, active, show } = useTabs()
startTabs()

/**
 * The two navigation counts.
 *
 * Computed here rather than inside a panel: a count that lives in a panel stops
 * updating the moment that panel's tab is closed, which is most of the time.
 */
const readyCount = computed(() => (snapshot.value === null ? 0 : ready(snapshot.value.plans).length))
const highCount = computed(() => snapshot.value?.state.findings.high ?? 0)
</script>

<template>
  <header class="top">
    <div class="brand">
      <h1>{{ t('app.title') }}</h1>
      <span class="project"><Bdi :value="snapshot?.project ?? ''" /></span>
      <LanguagePicker />
    </div>
    <Banners v-if="snapshot !== null" :snapshot="snapshot" :online="online" />
    <Rail v-if="snapshot !== null" :snapshot="snapshot" />
  </header>

  <nav class="tabs" :aria-label="t('tabs.label')">
    <a
      v-for="id in tabs"
      :key="id"
      :href="`#${id}`"
      :aria-current="active === id ? 'page' : undefined"
      :title="id === 'stories' && readyCount > 0 ? tn('tabs.readyCount', readyCount) : id === 'run' && highCount > 0 ? tn('tabs.highCount', highCount) : undefined"
      @click.prevent="show(id)"
    >
      {{ t(`tabs.${id}`) }}
      <span v-if="id === 'stories' && readyCount > 0" class="badge" aria-hidden="true">{{ readyCount }}</span>
      <span v-if="id === 'run' && highCount > 0" class="badge" aria-hidden="true">{{ highCount }}</span>
    </a>
  </nav>

  <!-- Panels arrive in the second plan; the shell must build and ship first. -->
  <main class="panel"></main>
</template>
