<script setup lang="ts">
/**
 * The one line that says what the loop is doing, on screen in every tab.
 *
 * Nothing here is a sentence: every label is a key, and every value that is an
 * identifier goes through `Bdi`. Cycle and strike counts are `n/m` pairs, not
 * prose counts — like a run id, they must never pass through `t()`'s `Intl`
 * number formatting (`3/5` must not become `٣/٥`), so they are built as plain
 * strings and isolated with `Bdi` the same way `state.run_id` is.
 *
 * A direct port of the old `ui/rail.js` + `index.html`'s `.rail` markup: the
 * detail block, the strike counter, and the layout order below all mirror it,
 * so the shipped CSS (`20-rail.css`, keyed off `.pill[data-status]`,
 * `.rail-detail`, `.bit`, `.warnish`) keeps applying unchanged.
 */
import { computed } from 'vue'
import type { Snapshot } from '../types/protocol.js'
import { useI18n } from '../composables/useI18n.js'
import { useHalt } from '../composables/useHalt.js'
import { send } from '../stores/session.js'
import Bdi from './Bdi.vue'
import NoticeFeed from './NoticeFeed.vue'

// `snapshot` is nullable, the same reason `Banners`' is: `index.html:47-96`
// and `ui/rail.js` — the `.rail` element, its pill and the notice toggle are
// static markup that exists before any snapshot ever arrives (mountRail()
// happens at boot; drawRail() is only ever called once a snapshot is in
// hand). Only the values inside — the pill's status and the whole detail
// block — depend on having one; the structure itself does not.
const props = defineProps<{ snapshot: Snapshot | null }>()
const { t } = useI18n()

const state = computed(() => props.snapshot?.state ?? null)
// `rail.js:36-37` — the whole detail block, not just the run bit, is gated on
// status, not on `run_id`.
const running = computed(() => state.value !== null && state.value.status !== 'idle' && state.value.status !== 'uninitialised')

const target = computed(() => state.value?.story ?? state.value?.plan ?? null)
const cycleText = computed(() => `${state.value?.cycle ?? 0}/${state.value?.max_cycles ?? '?'}`)

const findings = computed(() => state.value?.findings ?? { high: 0, medium: 0, low: 0 })
const findingsTotal = computed(() => findings.value.high + findings.value.medium + findings.value.low)

const guards = computed(() => props.snapshot?.guards ?? null)
const strikes = computed(() => guards.value?.strikes ?? 0)
const strikesText = computed(() => `${strikes.value}/${guards.value?.strikesAllowed ?? '?'}`)

const reproduction = computed(() => state.value?.reproduction ?? null)

const session = computed(() => props.snapshot?.session ?? null)
const { openHalt } = useHalt()
</script>

<template>
  <div class="rail">
    <span class="pill" :data-status="state?.status">{{ state !== null ? t(`status.${state.status}`) : '' }}</span>
    <span v-if="running && state !== null" class="rail-detail">
      <span class="bit">
        <span class="k">{{ t('rail.track') }}</span>
        <span class="v"><Bdi :value="state.track ?? '—'" /></span>
      </span>
      <span class="bit">
        <span class="k">{{ t('rail.cycle') }}</span>
        <span class="v"><Bdi :value="cycleText" /></span>
      </span>
      <span class="bit">
        <span class="k">{{ t('rail.stage') }}</span>
        <span class="v">{{ t(`stage.${state.stage}`) }}</span>
      </span>
      <span v-if="target !== null" class="bit"><Bdi :value="target" /></span>
      <span v-if="state.run_id !== null" class="bit" data-rail="run"><Bdi :value="state.run_id" /></span>
      <span v-if="findingsTotal > 0" class="bit">
        {{ t('rail.findings', { high: findings.high, medium: findings.medium, low: findings.low }) }}
      </span>
      <span v-if="strikes > 0" class="bit warnish" data-test="strikes">
        <span class="k">{{ t('rail.strikes') }}</span>
        <span class="v"><Bdi :value="strikesText" /></span>
      </span>
      <span v-if="reproduction !== null" class="bit">{{ t(reproduction.proven ? 'rail.gate.open' : 'rail.gate.shut') }}</span>
    </span>
    <!-- `index.html:69-96`: the notice toggle and its panel are the rail's own
         trailing controls, siblings of the detail block, not the brand line's.
         `LanguagePicker`'s `margin-inline-start: auto` (`10-layout.css:76`)
         pushes anything after it in `.brand` to the far right — putting this
         button there visibly moves it to a different row than the shipped
         page, at both sides of the 900px breakpoint. Unconditional, like the
         old page's static toggle: a dead server or a bad token at load must
         not also take away the reader's way to open their notice history. -->
    <NoticeFeed />
    <!-- Halt and Stop, side by side and labelled distinctly — `rail.js:99,103`.
         Conflating them is the obvious mistake: Stop kills the pty and leaves
         `state.json` saying `running` with no `HALT.md`, which is not a halt.
         Halt opens `HaltDialog`, hosted in `App.vue` outside the panels'
         `<KeepAlive>` — see `useHalt.ts` for why it cannot live here or on
         the Run panel. Stop reaches the pty directly through `send()`, the
         same door `PaneHead.vue`'s own Stop button (`#pane-stop`) uses. -->
    <button v-if="state?.status === 'running'" type="button" class="danger" @click="openHalt()">{{ t('controls.halt') }}</button>
    <button v-if="session?.jobId !== null && session !== null" type="button" :disabled="session.closing" @click="send({ type: 'stop' })">
      {{ t('controls.stop') }}
    </button>
  </div>
</template>
