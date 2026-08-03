<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { installAnnouncer, online, onNotice, snapshot } from './stores/session.js'
import { useI18n } from './composables/useI18n.js'
import { startTabs, useTabs } from './composables/useTabs.js'
import { useToasts } from './composables/useToasts.js'
import { ready } from './lib/stories.js'
import Banners from './components/Banners.vue'
import Bdi from './components/Bdi.vue'
import HaltDialog from './components/HaltDialog.vue'
import LanguagePicker from './components/LanguagePicker.vue'
import Pane from './components/Pane.vue'
import Rail from './components/Rail.vue'
import Toasts from './components/Toasts.vue'
import Plans from './panels/Plans.vue'
import Run from './panels/Run.vue'
import { bootPane } from './composables/usePane.js'
import { useHalt } from './composables/useHalt.js'

const { t, tn } = useI18n()
const { tabs, active, show } = useTabs()
startTabs()
// The dialog itself is a sibling of `<main>`, not inside it — see
// `useHalt.ts` for why it cannot live inside a kept-alive panel.
const { open: haltOpen, closeHalt } = useHalt()
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

  <!-- One panel mounted at a time, and kept alive rather than torn down when
       another tab opens — the same reason `Pane`'s own terminal is never
       remounted: a feed re-fetching from scratch on every tab switch is not
       what "the open tab is the subscription" (`lib/api.ts`) means. Panels
       arrive one task at a time; Run and Plans exist so far.

       `class="panel"` (`10-layout.css:100-108`: the capped, centred column
       and the `panel-in` fade) belongs on the panel *section* itself, the
       same as `index.html:136`'s `<section class="panel" id="panel-run">` —
       never on `<main>`, which is only the `overflow-y: auto` scroller
       (`10-layout.css:83-88`). `<main>` is mounted once, at boot; a class
       on it animates once, ever, and its own layout properties (padding,
       overflow) would otherwise double up with `.panel`'s margin/max-width
       in a way the old page never had to reconcile. Each panel component
       carries the class on its own root instead — see `Run.vue`. -->
  <main>
    <KeepAlive>
      <Run v-if="active === 'run'" />
      <Plans v-else-if="active === 'plans'" />
    </KeepAlive>
  </main>

  <Pane />

  <Toasts />

  <!-- Outside the `<KeepAlive>` on purpose — see `useHalt.ts`. -->
  <HaltDialog :open="haltOpen" :run-id="snapshot?.state.run_id ?? null" @close="closeHalt()" />
</template>
