<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { installAnnouncer, online, onNotice, snapshot } from './stores/session.js'
import { useI18n } from './composables/useI18n.js'
import { startTabs, useTabs } from './composables/useTabs.js'
import { useToasts } from './composables/useToasts.js'
import { ready } from './lib/stories.js'
import Banners from './components/Banners.vue'
import Bdi from './components/Bdi.vue'
import LanguagePicker from './components/LanguagePicker.vue'
import Rail from './components/Rail.vue'
import Terminal from './components/Terminal.vue'
import Toasts from './components/Toasts.vue'
import { bootPane } from './composables/usePane.js'

const { t, tn } = useI18n()
const { tabs, active, show } = useTabs()
startTabs()
// Applies the pane mode already read from storage, but only once the
// terminal underneath it has mounted into a laid-out box — a child's
// `onMounted` fires before its parent's, so calling this from here rather
// than from setup reproduces `app.js`'s `mountTerminal()` then `mountPane()`
// order. See `index.html`'s comment on `data-pane="docked"` for why that
// order matters.
onMounted(() => {
  bootPane()
})

const { notify } = useToasts()
installAnnouncer(notify)
// Server-pushed notices become toasts too; NoticeFeed keeps its own copy.
onBeforeUnmount(onNotice((message) => notify(message)))

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
    <!-- Unconditional: the offline banner is the one that matters most when
         the server never sent a snapshot at all — down at load, a bad token,
         a refused upgrade. `snapshot` is nullable on `Banners` for exactly
         that; only the banners that need snapshot data gate on having one. -->
    <Banners :snapshot="snapshot" :online="online" />
    <!-- Unconditional for the same reason: `Rail`'s `snapshot` is nullable
         too, so `.rail` — and the notice toggle living inside it — is always
         there, the same as `index.html:47-96`'s static markup. Gating this on
         `snapshot !== null` was the regression finding 5's fix introduced:
         the same defect as the banner above, one component over. -->
    <Rail :snapshot="snapshot" />
  </header>

  <nav class="tabs" :aria-label="t('tabs.label')">
    <a
      v-for="id in tabs"
      :id="`tab-${id}`"
      :key="id"
      :href="`#${id}`"
      :aria-current="active === id ? 'page' : undefined"
      :title="id === 'stories' && readyCount > 0 ? tn('tabs.readyCount', readyCount) : id === 'run' && highCount > 0 ? tn('tabs.highCount', highCount) : undefined"
      @click.prevent="show(id)"
    >
      {{ t(`tabs.${id}`) }}
      <!-- Digits are prose counts, not identifiers — `app.js:362-365`'s own
           `badge()` runs them through `t('tabs.number', { n })` for the same
           reason `tn()` above does: Arabic reads Arabic-Indic digits here. -->
      <span v-if="id === 'stories' && readyCount > 0" class="nav-count" aria-hidden="true">{{ t('tabs.number', { n: readyCount }) }}</span>
      <span v-if="id === 'run' && highCount > 0" class="nav-count warnish" aria-hidden="true">{{ t('tabs.number', { n: highCount }) }}</span>
    </a>
  </nav>

  <!-- Panels arrive in the second plan; the shell must build and ship first. -->
  <main class="panel"></main>

  <!-- The rest of the pane — view tabs, the queue, the command form — arrives
       with the components that drive them; the terminal is the one piece that
       must never be inside a re-rendered container, so it mounts here alone.
       `.pane-body` still has to wrap it: `body[data-pane="collapsed"]
       .pane-body { display: none }` is what hides the terminal on the boot
       state, and without this wrapper an empty terminal box is on screen from
       the first paint. -->
  <section class="pane">
    <div class="pane-body">
      <Terminal />
    </div>
  </section>

  <Toasts />
</template>
