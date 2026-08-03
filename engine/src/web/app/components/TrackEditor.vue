<script setup lang="ts">
/**
 * One track, as a card — `tpl-track-editor`, ported. Every list on it is the
 * same shape (chips plus a combobox), so `required`, `available`, `closing`
 * and a gate's `blocks` are all `TrackAgentList.vue` rather than four
 * templates.
 *
 * Every control here writes through `mutate` — the one function `Config.vue`
 * hands down that is allowed to touch the draft — and nothing here ever
 * calls `submit()`. That is the invariant this whole panel exists to
 * protect; see `Config.vue`'s own comment on `save()`.
 */
import { computed } from 'vue'
import { useI18n } from '../composables/useI18n.js'
import {
  edgeAfter,
  orderEdgeChanges,
  trackCommentLoss,
  trackFieldChanges,
  trackPending,
  trackProblems,
  type Draft,
} from '../lib/config.js'
import type { Config } from '../types/protocol.js'
import Bdi from './Bdi.vue'
import Tx from './Tx.vue'
import TrackAgentList from './TrackAgentList.vue'
import TrackOrderRow from './TrackOrderRow.vue'

const props = defineProps<{
  name: string
  draft: Draft
  baseline: Config | null
  rawText: string | null
  enabled: boolean
  mutate: (change: (model: Draft) => boolean | void) => void
}>()
const { t, tn } = useI18n()

const track = computed(() => props.draft.tracks[props.name])

function mutateTrack(change: (entry: NonNullable<Draft['tracks'][string]>) => boolean | void): void {
  props.mutate((model) => {
    const entry = model.tracks[props.name]
    if (entry === undefined) return false
    return change(entry)
  })
}

function onCyclesChange(event: Event): void {
  const next = Number((event.target as HTMLInputElement).value)
  mutateTrack((entry) => {
    // An empty or half-typed box is not a number yet. Leaving the draft alone
    // keeps the last good value rather than writing `NaN` the moment the
    // field is cleared to retype it.
    if (!Number.isInteger(next) || next < 1) return false
    entry.max_cycles = next
  })
}

function duplicate(): void {
  props.mutate((model) => {
    const source = model.tracks[props.name]
    if (source === undefined) return false
    let copy = `${props.name}-copy`
    let n = 2
    while (copy in model.tracks) copy = `${props.name}-copy-${n++}`
    model.tracks[copy] = JSON.parse(JSON.stringify(source))
  })
}
function remove(): void {
  props.mutate((model) => {
    if (!(props.name in model.tracks)) return false
    delete model.tracks[props.name]
  })
}

/* ── the four plain lists ─────────────────────────────────────────────── */

function bucketOf(entry: NonNullable<Draft['tracks'][string]>, list: 'required' | 'available' | 'closing' | 'blocks'): string[] | undefined {
  return list === 'blocks' ? entry.gate?.blocks : entry[list]
}
function addAgent(list: 'required' | 'available' | 'closing' | 'blocks', agent: string): void {
  mutateTrack((entry) => {
    const bucket = bucketOf(entry, list)
    if (!Array.isArray(bucket) || bucket.includes(agent)) return false
    bucket.push(agent)
  })
}
function removeAgent(list: 'required' | 'available' | 'closing' | 'blocks', agent: string): void {
  mutateTrack((entry) => {
    const bucket = bucketOf(entry, list)
    if (!Array.isArray(bucket)) return false
    const at = bucket.indexOf(agent)
    if (at < 0) return false
    bucket.splice(at, 1)
  })
}

/* ── gate ──────────────────────────────────────────────────────────────── */

const gateOn = computed(() => track.value?.gate !== undefined)
const known = computed(() => {
  const entry = track.value
  return entry === undefined ? [] : [...entry.required, ...(entry.available ?? []), ...(entry.closing ?? [])]
})
const draftable = computed(() => {
  const entry = track.value
  return entry === undefined ? [] : [...entry.required, ...(entry.available ?? [])]
})
/** The current value always appears, even naming an agent the track no longer has — dropping it would silently rewrite the config, and the problem list is what says it is wrong. */
function offered(names: string[], value: string): string[] {
  return [...new Set(value === '' ? names : [value, ...names])].sort()
}
const gateProvenOptions = computed(() => offered(known.value, track.value?.gate?.proven_by ?? ''))

function toggleGate(event: Event): void {
  const checked = (event.target as HTMLInputElement).checked
  mutateTrack((entry) => {
    if (checked) {
      const first = entry.required[0] ?? entry.available[0] ?? entry.closing[0] ?? ''
      entry.gate = { proven_by: first, blocks: [] }
    } else delete entry.gate
  })
}
function setGateProven(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  mutateTrack((entry) => {
    if (entry.gate === undefined) return false
    entry.gate.proven_by = value
  })
}

/* ── map ───────────────────────────────────────────────────────────────── */

const mapOn = computed(() => track.value?.map !== undefined)
// Deliberately narrower than the gate's list: a map drafted by a closing
// agent is a document no run ever writes.
const mapDraftedOptions = computed(() => offered(draftable.value, track.value?.map?.drafted_by ?? ''))

function toggleMap(event: Event): void {
  const checked = (event.target as HTMLInputElement).checked
  mutateTrack((entry) => {
    if (checked) entry.map = { drafted_by: entry.required[0] ?? entry.available[0] ?? '' }
    else delete entry.map
  })
}
function setMapDrafted(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  mutateTrack((entry) => {
    if (entry.map === undefined) return false
    entry.map.drafted_by = value
  })
}

/* ── order graph ───────────────────────────────────────────────────────── */

// One row per required/available agent, plus any orphan whose edge survived
// its own agent leaving `required`/`available` — kept reachable so it can be
// undone without a Reset. See `config.js`'s own comment on `orderAgents`.
const orderRows = computed(() => {
  const entry = track.value
  if (entry === undefined) return []
  const order = entry.order ?? []
  const orphans = [...new Set(order.map((edge) => edge.agent))].filter((agent) => !draftable.value.includes(agent))
  return [...draftable.value, ...orphans].map((agent) => ({ agent, after: edgeAfter(order, agent) }))
})

function edgeAdd(agent: string, pred: string): void {
  if (pred === agent) return
  mutateTrack((entry) => {
    const order = Array.isArray(entry.order) ? entry.order : (entry.order = [])
    const edges = order.filter((candidate) => candidate.agent === agent)
    if (edges.some((edge) => edge.after.includes(pred))) return false
    let edge = edges[0]
    if (edge === undefined) {
      edge = { agent, after: [] }
      order.push(edge)
    }
    edge.after.push(pred)
  })
}
function edgeRemove(agent: string, pred: string): void {
  mutateTrack((entry) => {
    if (!Array.isArray(entry.order)) return false
    const order = entry.order
    let removed = false
    for (let i = order.length - 1; i >= 0; i--) {
      const edge = order[i]
      if (edge === undefined || edge.agent !== agent) continue
      const at = edge.after.indexOf(pred)
      if (at < 0) continue
      edge.after.splice(at, 1)
      removed = true
      if (edge.after.length === 0) order.splice(i, 1)
    }
    if (!removed) return false
  })
}

/* ── C1: why this track would be refused ──────────────────────────────── */

const problems = computed(() => trackProblems(props.draft, props.name))

/* ── C6: change-impact preview ────────────────────────────────────────── */

const baselineTrack = computed(() => props.baseline?.tracks?.[props.name])
const pending = computed(() => (track.value === undefined ? false : trackPending(baselineTrack.value, track.value)))
const previewItems = computed(() => {
  const entry = track.value
  if (entry === undefined) return []
  return [
    ...trackFieldChanges(baselineTrack.value, entry),
    ...(baselineTrack.value === undefined ? [] : orderEdgeChanges(baselineTrack.value, entry)),
  ]
})
const commentsLost = computed(() => {
  if (!pending.value || baselineTrack.value === undefined) return null
  return trackCommentLoss(props.rawText, props.name)
})
</script>

<template>
  <section v-if="track !== undefined" class="track-editor" :data-track="props.name">
    <header class="track-editor-head">
      <code class="track-name"><Bdi :value="props.name" /></code>
      <label class="track-cycles">
        <span>{{ t('config.maxCycles') }}</span>
        <input
          type="number"
          min="1"
          step="1"
          required
          :value="track.max_cycles"
          :disabled="!props.enabled"
          :aria-label="t('config.maxCycles')"
          @change="onCyclesChange"
        />
      </label>
      <button type="button" :disabled="!props.enabled" @click="duplicate">{{ t('config.duplicate') }}</button>
      <button type="button" class="danger" :disabled="!props.enabled" @click="remove">{{ t('config.delete') }}</button>
    </header>

    <div class="track-lists">
      <TrackAgentList
        list="required"
        :track="props.name"
        :agents="track.required"
        :enabled="props.enabled"
        @add="(agent) => addAgent('required', agent)"
        @remove="(agent) => removeAgent('required', agent)"
      />
      <TrackAgentList
        list="available"
        :track="props.name"
        :agents="track.available ?? []"
        :enabled="props.enabled"
        @add="(agent) => addAgent('available', agent)"
        @remove="(agent) => removeAgent('available', agent)"
      />
      <TrackAgentList
        list="closing"
        :track="props.name"
        :agents="track.closing ?? []"
        :enabled="props.enabled"
        @add="(agent) => addAgent('closing', agent)"
        @remove="(agent) => removeAgent('closing', agent)"
      />
    </div>

    <div class="track-optional">
      <label class="check-field">
        <input type="checkbox" data-field="gate-enabled" :checked="gateOn" :disabled="!props.enabled" @change="toggleGate" />
        <span>{{ t('config.gate') }}</span>
      </label>
      <div v-if="gateOn" class="track-gate">
        <label>
          <span>{{ t('config.gateProvenBy') }}</span>
          <select :disabled="!props.enabled" :value="track.gate?.proven_by ?? ''" @change="setGateProven">
            <option v-for="name in gateProvenOptions" :key="name" :value="name">{{ name }}</option>
          </select>
        </label>
        <TrackAgentList
          list="blocks"
          :track="props.name"
          :agents="track.gate?.blocks ?? []"
          :enabled="props.enabled"
          @add="(agent) => addAgent('blocks', agent)"
          @remove="(agent) => removeAgent('blocks', agent)"
        />
      </div>
    </div>

    <div class="track-optional">
      <label class="check-field">
        <input type="checkbox" data-field="map-enabled" :checked="mapOn" :disabled="!props.enabled" @change="toggleMap" />
        <span>{{ t('config.map') }}</span>
      </label>
      <div v-if="mapOn" class="track-map">
        <label>
          <span>{{ t('config.mapDraftedBy') }}</span>
          <select :disabled="!props.enabled" :value="track.map?.drafted_by ?? ''" @change="setMapDrafted">
            <option v-for="name in mapDraftedOptions" :key="name" :value="name">{{ name }}</option>
          </select>
        </label>
      </div>
    </div>

    <!-- One row per required/available agent: which agents it runs after. -->
    <div class="track-optional">
      <span class="track-list-label">{{ t('config.order') }}</span>
      <p class="rule-why">{{ t('config.orderWhy') }}</p>
      <div class="track-order-agents">
        <TrackOrderRow
          v-for="row in orderRows"
          :key="row.agent"
          :track="props.name"
          :agent="row.agent"
          :after="row.after"
          :enabled="props.enabled"
          @add="(pred) => edgeAdd(row.agent, pred)"
          @remove="(pred) => edgeRemove(row.agent, pred)"
        />
      </div>
    </div>

    <ul class="track-problems">
      <li v-for="problem in problems" :key="problem.id" class="track-problem">
        <Tx :key-name="problem.key" :params="problem.params" />
      </li>
    </ul>

    <!-- C6: what Save on this card would actually do — not a diff of the
         file, but this track's own before and after, from state the panel
         already holds. -->
    <div class="track-optional">
      <span class="track-list-label">{{ t('config.preview.title') }}</span>
      <p class="rule-why">{{ t('config.preview.why') }}</p>
      <ul class="track-preview-list">
        <li v-for="item in previewItems" :key="item.id" class="track-preview-item">
          <Tx :key-name="item.key" :params="item.params" />
        </li>
      </ul>
      <p v-if="!pending" class="track-list-empty">{{ t('config.preview.noChanges') }}</p>
      <p v-if="commentsLost !== null && commentsLost > 0" class="track-preview-comments">
        {{ tn('config.preview.commentsLost', commentsLost) }}
      </p>
    </div>
  </section>
</template>
