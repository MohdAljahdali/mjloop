<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import type { Message } from './types/protocol.js'
import { installAnnouncer, online, onNotice, snapshot } from './stores/session.js'
import { useI18n } from './composables/useI18n.js'
import { useNotices } from './composables/useNotices.js'
import { useSelection } from './composables/useSelection.js'
import { startTabs, useTabs } from './composables/useTabs.js'
import { useToasts } from './composables/useToasts.js'
import { mountPlanDoc } from './lib/plandoc.js'
import { mountFeatureDoc, opened as openedFeature } from './lib/featuredoc.js'
import { ready } from './lib/stories.js'
import Banners from './components/Banners.vue'
import Bdi from './components/Bdi.vue'
import FeatureApproveDialog from './components/FeatureApproveDialog.vue'
import HaltDialog from './components/HaltDialog.vue'
import LanguagePicker from './components/LanguagePicker.vue'
import Pane from './components/Pane.vue'
import Rail from './components/Rail.vue'
import Toasts from './components/Toasts.vue'
import Config from './panels/Config.vue'
import Evidence from './panels/Evidence.vue'
import Features from './panels/Features.vue'
import Memory from './panels/Memory.vue'
import Plans from './panels/Plans.vue'
import Run from './panels/Run.vue'
import Skills from './panels/Skills.vue'
import Stories from './panels/Stories.vue'
import { bootPane } from './composables/usePane.js'
import { useHalt } from './composables/useHalt.js'
import { useFeatureApprove } from './composables/useFeatureApprove.js'

const { t, tn } = useI18n()
const { tabs, active, show } = useTabs()
startTabs()
// The dialog itself is a sibling of `<main>`, not inside it — see
// `useHalt.ts` for why it cannot live inside a kept-alive panel.
const { open: haltOpen, closeHalt } = useHalt()
// Same shape, for the one other write on this page a stale click must not
// land on — see `useFeatureApprove.ts`.
const { open: featureApproveOpen, closeApprove } = useFeatureApprove()
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
// `record` is `useNotices.ts`'s module-level door, shared with `NoticeFeed`.
// Installed here, alongside the toast, for every write receipt — the one
// door restored, the same guarantee `ui/notifications.js:15` names: "the
// ephemeral toast and the durable log can never disagree".
const { record } = useNotices()
function announceAndLog(message: Message, action?: { code: string; run: () => void }): void {
  notify(message, action)
  record(message)
}
installAnnouncer(announceAndLog)
// Server-pushed notices become toasts too; `useNotices.ts` logs them itself
// through its own `onNotice` subscription, so this stays toast-only.
onBeforeUnmount(onNotice((message) => notify(message)))

/**
 * The open plan's document — `PLAN.md`, `REVIEW.md`, the decision, and its
 * stories' own frontmatter — pumped from here rather than from `Plans.vue`.
 *
 * `lib/plandoc.ts`'s own comment says "who pumps it is the caller's problem",
 * and a panel is the wrong owner: Plans and Stories both read it, a panel
 * only exists behind `v-if` while its own tab is open, and `mountPlanDoc()`
 * resets the module's listener set on every call — a second panel calling it
 * after the first would silently drop the first panel's own subscription
 * (`plandoc.ts:47-52`'s own warning). `App.vue`'s `setup` runs once, before
 * any panel is ever instantiated, which is what the ordering that comment
 * asks for actually requires. Panels only `subscribe()` and read `value()`.
 */
const { activePlan } = useSelection()
const planDocFeed = mountPlanDoc()
watch(
  [snapshot, activePlan],
  ([current]) => {
    if (current !== null) planDocFeed.update(current)
  },
  { immediate: true },
)

/**
 * The open feature's brief — `lib/featuredoc.ts`'s own document, pumped from
 * here for the same reason `planDocFeed` above is: `Features.vue` and
 * `FeatureApproveDialog.vue` both read it, and a feed ticked from inside a
 * panel that only exists behind `v-if` would stop moving the moment that
 * panel's tab is not the one on screen — exactly what would let a stale
 * confirmation dialog approve a brief nobody can see any more.
 */
const featureDocFeed = mountFeatureDoc()
watch(
  [snapshot, openedFeature],
  ([current]) => {
    if (current !== null) featureDocFeed.update(current)
  },
  { immediate: true },
)

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
      :aria-controls="`panel-${id}`"
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
       arrive one task at a time; Run, Plans and Stories exist so far.

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
      <Stories v-else-if="active === 'stories'" />
      <Features v-else-if="active === 'features'" />
      <Skills v-else-if="active === 'skills'" />
      <Evidence v-else-if="active === 'evidence'" />
      <Memory v-else-if="active === 'memory'" />
      <Config v-else-if="active === 'config'" />
    </KeepAlive>
  </main>

  <Pane />

  <Toasts />

  <!-- Outside the `<KeepAlive>` on purpose — see `useHalt.ts`. -->
  <HaltDialog :open="haltOpen" :run-id="snapshot?.state.run_id ?? null" @close="closeHalt()" />
  <!-- Same reason — see `useFeatureApprove.ts`. -->
  <FeatureApproveDialog :open="featureApproveOpen" @close="closeApprove()" />
</template>
