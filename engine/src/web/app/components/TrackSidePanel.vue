<script setup lang="ts">
/**
 * TrackSidePanel — the control surface beside each `TrackGraph.vue` canvas
 * (Task 4). Two blocks when nothing is selected — track settings (with the
 * run form), and the agents not yet on this track — replaced by a third, the
 * selected card's own detail, the moment a name reaches `props.selected`.
 * Only a click on a card puts one there: `Tracks.vue` owns that state
 * (`selectedByTrack`) and `TrackGraph.vue`'s `select` event is its one
 * writer. This panel's own "+" button is not a second one — `add()` below
 * pushes the name into the track's `available` and stops there, so the panel
 * stays on these two blocks with the added agent simply gone from the
 * Add-agent list. This component only reads the selection and asks to clear
 * it back to `null` through `clear-selection`.
 *
 * Per the approved design spec (`docs/superpowers/specs/2026-08-07-track-
 * graph-redesign-design.md`), this panel is meant to carry "كل ما في نموذج
 * التحرير الحالي لكن مختصرًا في مكانه" — everything the current edit form
 * carries, condensed into this spot — explicitly including "حقل الهدف مع زر
 * Run", the goal field and its Run button. `TrackRunForm` is mounted in the
 * settings block for exactly that reason, fed the real `enabled` this panel
 * itself was given rather than a hardcoded `true`, the same value
 * `TrackEditor.vue:257` feeds its own copy — one enqueue path
 * (`TrackRunForm.vue`'s own header), never a second.
 *
 * The gate, in contrast, stays display-only here on purpose: this panel
 * shows `track.gate`'s `proven_by`/`blocks` as text and never grows a
 * control that edits it, because gate editing already has a home —
 * `TrackEditor.vue`'s own checkbox-and-select in the list view — and this
 * panel is not a second copy of that editor, only of the run affordance the
 * spec calls out by name. See `panel-tracks.test.ts`'s own "never renders a
 * gate editor" guard, which checks for the *absence* of that specific
 * control (`[data-field="gate-enabled"]`/`.track-gate`, the exact markup
 * `TrackEditor.vue` uses for it) rather than counting every input on the
 * panel — a raw count would also forbid the legitimate run-form input above.
 *
 * Same invariant `SpecialistEditor.vue` carries (that file's own header):
 * every control here writes through `props.mutate`, the one function
 * `Tracks.vue` hands down that is allowed to touch the draft, and this
 * component never imports `submit` or `feed` and holds no draft of its own.
 * `onCycles` below mirrors `TrackEditor.vue`'s own `onCyclesChange` bound for
 * bound, including its `@input`/`@change` pair — an empty or non-integer box
 * leaves the draft at its last good value rather than writing `NaN`, on
 * every keystroke, not only on blur. `onRole` and `remove` both drop an
 * agent from whichever of required/available/closing currently holds it
 * through `removeFromBuckets` (`lib/config.ts`) — the same shared helper
 * `Tracks.vue`'s own `onGraphRemove` calls, not a third copy of that loop.
 */
import { computed } from 'vue'
import { useI18n } from '../composables/useI18n.js'
import { cardInfo } from '../lib/agentcard.js'
import { edgeAfter, removeFromBuckets, type Draft } from '../lib/config.js'
import type { AgentsView, Track } from '../types/protocol.js'
import Bdi from './Bdi.vue'
import TrackRunForm from './TrackRunForm.vue'

const props = withDefaults(
  defineProps<{
    track: Track
    name: string
    agents: AgentsView | null
    selected: string | null
    enabled?: boolean
    mutate: (change: (model: Draft) => boolean | void) => void
  }>(),
  { enabled: true },
)

const emit = defineEmits<{ 'clear-selection': [] }>()

const { t } = useI18n()

const card = computed(() => cardInfo(props.selected ?? '', props.agents))

/**
 * The selected agent's own "runs after" constraints — the seventh of the
 * seven facts the design spec asks this detail view for, read through
 * `edgeAfter` (`lib/config.ts`) rather than by walking `track.order` here, so
 * the "every edge that names this agent, not just the first" rule has one
 * implementation. Display only: an order edge is added and removed on the
 * canvas (`TrackGraph.vue`'s drag, `Tracks.vue`'s `onGraphConnect`), the same
 * way the gate above is shown here but edited in the list view.
 */
const after = computed(() => (props.selected === null ? [] : edgeAfter(props.track.order ?? [], props.selected)))

/** Every agent this track already names, across all three buckets — the set `unused` below is drawn against. */
const known = computed(() => new Set([...props.track.required, ...props.track.available, ...props.track.closing]))

/**
 * Every agent definition not already on this track, deduped project-over-
 * plugin: a name that exists in both only offers once, project first, the
 * same shadowing order `cardInfo` itself resolves (`lib/agentcard.ts`'s own
 * header).
 */
const unused = computed(() => {
  const seen = new Set<string>()
  const all = [...(props.agents?.project ?? []), ...(props.agents?.plugin ?? [])]
  return all.filter((agent) => !known.value.has(agent.name) && !seen.has(agent.name) && (seen.add(agent.name), true))
})

/** An unused agent, added straight into `available` — the same bucket a fresh track name always lands in from the list editor's own add box. */
function add(agentName: string): void {
  props.mutate((model) => {
    const entry = model.tracks[props.name]
    if (entry === undefined || !Array.isArray(entry.available)) return false
    entry.available.push(agentName)
  })
}

function roleOf(agentName: string): 'required' | 'available' | 'closing' {
  if (props.track.required.includes(agentName)) return 'required'
  if (props.track.closing.includes(agentName)) return 'closing'
  return 'available'
}

/** The selected card's role, moved to whichever bucket the role select now names — spliced out of every bucket first (`removeFromBuckets`), so an agent is never left in two at once. */
function onRole(event: Event): void {
  const next = (event.target as HTMLSelectElement).value as 'required' | 'available' | 'closing'
  const agentName = props.selected
  if (agentName === null) return
  props.mutate((model) => {
    const entry = model.tracks[props.name]
    // The same `Array.isArray` guard `add()` above and `removeFromBuckets`
    // (`lib/config.ts`) both apply to these buckets, for the same reason:
    // `Draft` is seeded from a parsed document, and a hand-edited
    // `config.yaml` can put anything under `required:`/`available:`/
    // `closing:`. All three writers of these three lists agree on it.
    if (entry === undefined || !Array.isArray(entry[next])) return false
    removeFromBuckets(entry, agentName)
    entry[next].push(agentName)
  })
}

/**
 * `TrackEditor.vue:53`'s own `onCyclesChange`, copied bound for bound: an
 * empty or half-typed box is not a number yet, so the draft is left at its
 * last good value rather than writing `NaN` the moment the field is cleared
 * to retype it.
 */
function onCycles(event: Event): void {
  const next = Number((event.target as HTMLInputElement).value)
  props.mutate((model) => {
    const entry = model.tracks[props.name]
    if (entry === undefined) return false
    if (!Number.isInteger(next) || next < 1) return false
    entry.max_cycles = next
  })
}

/**
 * The same removal `Tracks.vue`'s own `onGraphRemove` performs for a node
 * dragged off the canvas — `removeFromBuckets` again, not a third copy of
 * that loop. Selection is cleared afterward regardless of whether the agent
 * was actually found in a bucket: the card this detail view was showing is
 * gone from the track either way.
 */
function remove(): void {
  const agentName = props.selected
  if (agentName === null) return
  props.mutate((model) => {
    const entry = model.tracks[props.name]
    if (entry === undefined) return false
    return removeFromBuckets(entry, agentName)
  })
  emit('clear-selection')
}
</script>

<template>
  <aside class="track-side" :data-track-side="name">
    <template v-if="selected === null">
      <section class="side-block">
        <h3>{{ t('config.side.settings') }}</h3>
        <label class="track-cycles">
          <span>{{ t('config.maxCycles') }}</span>
          <input
            type="number"
            min="1"
            step="1"
            required
            :value="track.max_cycles"
            :disabled="!enabled"
            :aria-label="t('config.maxCycles')"
            @input="onCycles"
            @change="onCycles"
          />
        </label>
        <p class="hint" v-if="track.gate !== undefined">
          {{ t('config.side.gate') }}: <Bdi :value="track.gate.proven_by" /> → <Bdi :value="track.gate.blocks.join(', ')" />
        </p>
        <p class="hint" v-else>{{ t('config.side.noGate') }}</p>
        <p class="hint" v-if="track.map !== undefined">{{ t('config.side.map') }}: <Bdi :value="track.map.drafted_by" /></p>
        <p class="hint" v-else>{{ t('config.side.noMap') }}</p>
        <!-- The same enqueue path `TrackEditor.vue:257` uses — no second
             submit path, only a second place this one form is mounted. -->
        <TrackRunForm :track="name" :enabled="enabled" />
      </section>
      <section class="side-block">
        <h3>{{ t('config.side.addAgent') }}</h3>
        <button v-for="agent in unused" :key="agent.name" type="button" class="side-add" :disabled="!enabled" @click="add(agent.name)">
          <!-- `agent.description` is model-authored text, not translated UI
               copy — the same split `TrackGraph.vue`'s own card body draws,
               so it goes through `Bdi`/`dir="auto"` rather than sitting bare
               in an otherwise-Arabic sentence. -->
          + <Bdi :value="agent.name" /> <span class="hint" dir="auto"><Bdi :value="agent.description" /></span>
        </button>
        <p v-if="unused.length === 0" class="hint">{{ t('config.side.noneLeft') }}</p>
      </section>
    </template>
    <section v-else class="side-block side-detail">
      <h3><Bdi :value="card.name" /></h3>
      <!-- The same split `TrackGraph.vue`'s own card body draws: a
           description is model-authored text and goes through `Bdi`, the
           "no definition file" message is translated UI copy and does not. -->
      <p v-if="card.description !== null" dir="auto"><Bdi :value="card.description" /></p>
      <p v-else>{{ t('config.graph.missingAgent') }}</p>
      <div class="graph-node-tools">
        <span v-for="tool in card.tools" :key="tool" class="graph-node-tool"><Bdi :value="tool" /></span>
      </div>
      <p class="hint" v-if="card.model !== null">{{ t('config.side.model') }}: <Bdi :value="card.model" /></p>
      <!-- Which directory this definition came from. Only drawn when there
           is one: `cardInfo` answers `null` for an agent no definition file
           provides, and the "no definition file" line above already says so —
           a "Source: —" row under it would be a second way of saying the
           same absence. -->
      <p class="hint" v-if="card.source !== null">{{ t('config.side.source') }}: {{ t(`config.side.source.${card.source}`) }}</p>
      <!-- The order constraints this agent waits on, isolated as one Latin
           run the same way the gate's own `blocks` list above is — these are
           agent ids inside otherwise-Arabic copy in the `ar` locale. -->
      <p class="hint" v-if="after.length > 0">{{ t('config.side.after') }}: <Bdi :value="after.join(', ')" /></p>
      <p class="hint" v-else>{{ t('config.side.afterNone') }}</p>
      <label>
        {{ t('config.side.role') }}
        <select :value="roleOf(selected)" :disabled="!enabled" @change="onRole">
          <option value="required">{{ t('config.graph.role.required') }}</option>
          <option value="available">{{ t('config.graph.role.available') }}</option>
          <option value="closing">{{ t('config.graph.role.closing') }}</option>
        </select>
      </label>
      <button type="button" :disabled="!enabled" @click="remove">{{ t('config.side.remove') }}</button>
      <button type="button" @click="emit('clear-selection')">{{ t('config.side.back') }}</button>
    </section>
  </aside>
</template>
