<script setup lang="ts">
/**
 * Tracks — the structured half of `config.yaml`: `specialists:` and
 * `tracks:`. Split out of `Config.vue` in the task that split
 * `collectConfigChanges` into `collectSettingsChanges`/`collectTrackChanges`
 * — see `lib/config.ts`'s own header for why the split line runs exactly
 * where `draft` stops being read alongside `form`.
 *
 * This panel reads the same `/api/config` feed and the same revision
 * `Config.vue` does, and seeds its own independent `baseline`/`draft`/
 * `editorRevision`/`conflict` from it — two editors, one document. That is
 * also why this panel cannot skip the revision-conflict machinery `Config.vue`
 * already carries just because its own half of the document "only" touches
 * `specialists:`/`tracks:`: a save from this tab still carries the revision
 * the *other* tab's edits might have already moved past, and the server's
 * own `write.stale.config` refusal is what stops either tab's write from
 * silently clobbering a change the other tab made first. See
 * `panel-tracks.test.ts`'s own two-tab test for the write this protects.
 *
 * **The invariant this panel exists to protect**: every control on this page
 * writes to `draft` and nothing else. `mutate()` below is the one function
 * allowed to touch `draft`; `save()` is the one function that ever calls
 * `submit()`, and it is the only place `collectTrackChanges` is called
 * outside a test. No child component imports `submit` or `feed` —
 * `SpecialistEditor.vue` and every track-card component only ever receive
 * `mutate` as a prop and call it.
 *
 * `specialists:` and `tracks:` were two JSON textareas before the Vue
 * rewrite. The DOM seam that needed — hidden `*_json` fields feeding the
 * collector — does not exist here: `draft` below is already the object
 * `collectTrackChanges` reads, because Vue's own reactivity is the seam.
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from '../composables/useI18n.js'
import { useFeed } from '../composables/useFeed.js'
import { submit } from '../stores/session.js'
import { addOrderEdge, broken, collectTrackChanges, knownAgents, removeOrderEdge, seedDraft, trackNames, type Draft } from '../lib/config.js'
import { wouldCycle } from '../lib/trackgraph.js'
import type { AgentsView, Config, ConfigView } from '../types/protocol.js'
import SpecialistEditor from '../components/SpecialistEditor.vue'
import Tx from '../components/Tx.vue'
import TrackEditors from '../components/TrackEditors.vue'
import TrackGraph from '../components/TrackGraph.vue'
import TrackSidePanel from '../components/TrackSidePanel.vue'

const { t } = useI18n()

const configFeed = useFeed<ConfigView>({ dep: (state) => state.revisions.config, path: () => '/api/config' })
const view = computed(() => configFeed.value.value)
const parsed = computed(() => view.value?.parsed ?? null)
const enabled = computed(() => parsed.value !== null && view.value?.revision != null)

// The same `/api/agents` feed `Agents.vue` reads (that panel's own header on
// why the two directories ride one feed rather than two) — read again here,
// not lifted and passed down from a shared ancestor, because `useFeed`
// already dedups a repeated subscription to one path (`AgentCard.vue`'s own
// comment makes the identical call for `/api/skills`). `TrackGraph`'s own
// `cardInfo` call is what actually needs this; this panel only carries it
// through as a prop, the same read-only pass-through `Tracks.vue` already is
// for `draft` itself.
const agentsFeed = useFeed<AgentsView>({ dep: (state) => state.revisions.agents, path: () => '/api/agents' })
const agentsView = computed(() => agentsFeed.value.value)

/** The document this editor was last seeded from, and its own revision hash. */
const baseline = ref<Config | null>(null)
const editorRevision = ref<string | null>(null)
/** `config.yaml`'s own text for that same revision — see `trackCommentLoss`'s only caller, `TrackEditor.vue`. */
const rawText = ref<string | null>(null)

const dirty = ref(false)
const saving = ref(false)
const conflict = ref(false)

const draft = ref<Draft | null>(null)

// Same reseed guard `Config.vue` carries, and the same reason an epoch
// counter is not needed beside it — see that file's own comment. A revision
// that moves while this tab is dirty shows the conflict banner rather than
// clobbering the draft, exactly the same as it does there; the two panels
// share the rule because they share the document.
watch(
  view,
  (current) => {
    if (!enabled.value) return
    const revision = current?.revision ?? null
    const config = current?.parsed
    if (revision === editorRevision.value || config === null || config === undefined) return

    // Decided before `editorRevision` moves: the question is about the *old*
    // baseline a dirty draft was diffing against, not the one this frame is
    // about to install.
    const conflicting = editorRevision.value !== null && dirty.value && !saving.value

    baseline.value = config
    editorRevision.value = revision
    rawText.value = current?.raw ?? null

    if (conflicting) {
      conflict.value = true
      return
    }
    conflict.value = false
    dirty.value = false
    draft.value = seedDraft(config)
    // A refusal describes an edge that was never drawn against a track this
    // fresh `draft` may no longer even carry the same way — a reseed (a
    // clean revision landing, not a conflict) starts the graph clean too.
    graphRefusal.value = null
  },
  { immediate: true },
)

function markDirty(): void {
  if (!enabled.value) return
  dirty.value = true
}

/**
 * A draft mutation: apply it and mark dirty. Every structured editor action
 * goes through here — the one place "the draft moved" and "the tab is
 * dirty" cannot disagree. See this file's own header.
 */
function mutate(change: (model: Draft) => boolean | void): void {
  if (!enabled.value || draft.value === null) return
  if (change(draft.value) === false) return
  markDirty()
}

const agentNames = computed(() => (draft.value === null ? [] : knownAgents(draft.value)))

/**
 * Graph or list — a second lens on the same `tracks:` half of the draft, not
 * a second editor. Switching does not touch `draft` itself, only which
 * component reads it, which is why `#config-track-editors` reappears intact
 * the moment this flips to `'list'`: nothing here ever unmounts the list's
 * own state, `Tracks.vue`'s draft it reads.
 *
 * The panel opens on the graph because a track *is* a graph — layers, order
 * edges and a gate — and a reader answering "what shape is this track" gets
 * it in one look rather than from three chip rows. The graph itself still
 * has no keyboard path; a drag canvas cannot get one the way a button or a
 * combobox can. What makes that acceptable as a default is the tablist
 * below: it is the first focusable control in this region, it carries
 * `role="tab"` so a screen reader announces both views, and one arrow key
 * from it reaches the list, which remains the complete editor. See
 * `discipline.test.ts`'s own "keyboard before pointer" describe block.
 *
 * Held in the component, not the hash: `App.vue` keeps every panel under
 * `<KeepAlive>`, so the reader's choice survives a trip through another tab
 * without a router entry that would make "which lens" as linkable as "which
 * tab", which it is not.
 */
const trackView = ref<'graph' | 'list'>('graph')
const viewToggleEl = ref<HTMLElement | null>(null)
function setView(next: typeof trackView.value): void {
  trackView.value = next
  graphRefusal.value = null
}

const VIEWS = ['graph', 'list'] as const

/**
 * Arrow, Home and End across the two view tabs — the pattern `Stories.vue`'s
 * own `onStripKeydown` already uses for the work-tab strip, on a fixed pair
 * instead of a live list.
 *
 * The arrows are read through `dir` rather than mapped to fixed views: the
 * strip is laid out by the document's direction, so in Arabic the tab that
 * is physically to the right of the graph is the one *before* it. A handler
 * that hard-coded `ArrowRight -> list` would move the selection away from
 * the key the reader pressed on half the locales this page ships in.
 *
 * Activation follows focus, as it does in `Stories.vue`: with two panels and
 * no fetch behind either, there is nothing for a deferred activation to
 * save.
 */
function onViewKeydown(event: KeyboardEvent): void {
  const rtl = document.documentElement.dir === 'rtl'
  const forward = rtl ? 'ArrowLeft' : 'ArrowRight'
  const back = rtl ? 'ArrowRight' : 'ArrowLeft'
  const at = VIEWS.indexOf(trackView.value)

  let next: (typeof VIEWS)[number] | undefined
  if (event.key === forward) next = VIEWS[(at + 1) % VIEWS.length]
  else if (event.key === back) next = VIEWS[(at - 1 + VIEWS.length) % VIEWS.length]
  else if (event.key === 'Home') next = VIEWS[0]
  else if (event.key === 'End') next = VIEWS[VIEWS.length - 1]
  else return

  event.preventDefault()
  if (next === undefined) return
  const target = next
  setView(target)
  void nextTick(() => {
    const node = viewToggleEl.value?.querySelector(`#tracks-view-${target}`)
    if (node instanceof HTMLElement) node.focus()
  })
}

// `Draft['tracks']` indexes as `Track | undefined` under
// `noUncheckedIndexedAccess` even though every name here came from
// `Object.keys(draft.tracks)` a moment ago — pairing name and track once,
// here, is what lets the template below hand `TrackGraph` a real `Track`
// rather than repeating an `undefined` check inside a `v-for`.
const graphEntries = computed(() => {
  const model = draft.value
  if (model === null) return []
  return trackNames(model)
    .map((name) => ({ name, track: model.tracks[name] }))
    .filter((entry): entry is { name: string; track: NonNullable<(typeof entry)['track']> } => entry.track !== undefined)
})

/**
 * Task 4: which card, if any, each track's own `TrackSidePanel.vue` is
 * showing the detail view for — one entry per track name, so switching the
 * selection on one track's canvas never touches another's. `TrackGraph`'s
 * own `select` event (its own header) is the only writer; `clear-selection`
 * from the panel and a fresh removal both write `null` back the same way.
 */
const selectedByTrack = ref<Record<string, string | null>>({})

/**
 * Why the last drag on the graph was refused, or `null` once the graph is
 * clean again — a key and its params, not a rendered string:
 * `lib/i18n.ts`'s own `t()` docstring is explicit that `t()` is for
 * attributes only, because it does not wrap a hole in `<bdi>` the way
 * `tx()`/`Tx.vue` does, and this refusal's holes (`from`/`to`) are Latin
 * agent names sitting inside what is otherwise Arabic content — exactly the
 * case that isolation exists for. Holding the key also means a locale
 * switch repaints this the same way every other translated string on the
 * page does, instead of leaving whatever language it was in when the drag
 * happened.
 */
const graphRefusal = ref<{ key: string; params: Record<string, string> } | null>(null)

/**
 * A drag's own end, from whichever `TrackGraph` card emitted it. `wouldCycle`
 * (`lib/trackgraph.ts`) folds the track's own gate in beside its `order`
 * edges, so a connection that closes a cycle through the gate is refused
 * here exactly as one that closes it through `order` alone is — the same
 * fold `layersOf` and `dispatchWaves` both apply, for the reason `wouldCycle`'s
 * own comment gives. A refusal never reaches `mutate`: the draft only moves
 * on the branch below that calls it.
 */
function onGraphConnect(name: string, params: { source: string; target: string }): void {
  const entry = draft.value?.tracks[name]
  if (entry === undefined) return
  if (wouldCycle(entry, params.source, params.target)) {
    graphRefusal.value = { key: 'config.graph.refusalCycle', params: { from: params.source, to: params.target } }
    return
  }
  graphRefusal.value = null
  mutate((model) => {
    const target = model.tracks[name]
    if (target === undefined) return false
    return addOrderEdge(target, params.target, params.source)
  })
}

/** An order edge coming off on the canvas — never reachable for a gate edge, whose own `selectable: false` keeps it out of `TrackGraph.vue`'s removal path in the first place. */
function onGraphDisconnect(name: string, params: { source: string; target: string }): void {
  mutate((model) => {
    const target = model.tracks[name]
    if (target === undefined) return false
    return removeOrderEdge(target, params.target, params.source)
  })
}

/**
 * A node coming off the canvas — dropping that agent out of whichever of
 * `required`/`available`/`closing` it is currently drawn from, the same
 * three lists `TrackAgentList.vue`'s own remove chip writes to. Only those
 * three: a graph node is never drawn for a gate's `blocks` entry on its own
 * (a gate is an edge over an existing node, not a second node), so there is
 * no fourth bucket to check here the way `TrackEditor.vue`'s `bucketOf` has
 * to.
 */
function onGraphRemove(name: string, params: { agent: string }): void {
  mutate((model) => {
    const entry = model.tracks[name]
    if (entry === undefined) return false
    for (const list of ['required', 'available', 'closing'] as const) {
      const bucket = entry[list]
      if (!Array.isArray(bucket)) continue
      const at = bucket.indexOf(params.agent)
      if (at >= 0) {
        bucket.splice(at, 1)
        return
      }
    }
    return false
  })
  // A dragged-off node the side panel is currently showing the detail view
  // for no longer exists on this track — same reason `TrackSidePanel.vue`'s
  // own `remove()` clears the selection after its own removal, applied here
  // for the canvas's own removal path (a node dragged off, not the panel's
  // button).
  if (selectedByTrack.value[name] === params.agent) selectedByTrack.value[name] = null
}

/** Why the editor banner is showing — unavailable/invalid first, then a conflicting revision, mirroring `Config.vue`'s own `stateKey` priority minus the orchestration refusals, which are that panel's own half. */
const stateKey = computed<string | null>(() => {
  if (!enabled.value) return view.value?.invalid === true ? 'config.editorInvalid' : 'config.editorUnavailable'
  if (conflict.value) return 'config.editorChanged'
  return null
})

const saveDisabled = computed(() => !enabled.value || !dirty.value || saving.value || conflict.value || broken(draft.value))
const resetDisabled = computed(() => !enabled.value || (!dirty.value && !conflict.value) || saving.value)

const formEl = ref<HTMLFormElement | null>(null)

function save(): void {
  if (!enabled.value || baseline.value === null || editorRevision.value === null || saving.value || conflict.value) return
  // `TrackEditor.vue`'s `max_cycles` box is `required min="1"` — the one
  // native-validated control this half of the document carries. `Config.vue`
  // gates on this same check; a form with no such gate lets an empty or
  // out-of-range required box sit on screen with Save enabled, silently
  // sending whatever `onCyclesChange` last accepted rather than the value
  // the box currently (and visibly) shows.
  if (formEl.value !== null && !formEl.value.reportValidity()) return
  if (draft.value === null) return
  const changes = collectTrackChanges(draft.value, baseline.value)
  if (changes.length === 0) {
    dirty.value = false
    return
  }
  saving.value = true
  submit(
    { kind: 'config.patch', revision: editorRevision.value, changes },
    {
      settled(receipt) {
        saving.value = false
        if (receipt.ok) dirty.value = false
      },
    },
  )
}

function reset(): void {
  if (!enabled.value || baseline.value === null) return
  draft.value = seedDraft(baseline.value)
  dirty.value = false
  conflict.value = false
  graphRefusal.value = null
}
</script>

<template>
  <section id="panel-tracks" class="panel" aria-labelledby="panel-tracks-title">
    <header class="panel-head">
      <div>
        <h1 id="panel-tracks-title">{{ t('panel.tracks.title') }}</h1>
        <p class="hint">{{ t('panel.tracks.help') }}</p>
      </div>
    </header>

    <form id="tracks-editor" ref="formEl" class="config-editor" @submit.prevent="save" @input="markDirty" @change="markDirty">
      <div class="config-editor-head">
        <div>
          <h2>{{ t('config.tracksEditorTitle') }}</h2>
          <p class="hint">{{ t('config.tracksEditorHelp') }}</p>
        </div>
        <div class="config-editor-actions">
          <button type="button" id="tracks-reset" :disabled="resetDisabled" @click="reset">{{ t('config.reset') }}</button>
          <button type="submit" class="primary" id="tracks-save" :disabled="saveDisabled">{{ t('config.save') }}</button>
        </div>
      </div>
      <p v-if="stateKey !== null" id="tracks-editor-state" class="banner warn">{{ t(stateKey) }}</p>

      <!-- `draft` is passed through as-is, not defaulted to an empty
           document: `null` and "the document has zero specialists/tracks"
           are two different states `config.js` distinguishes on purpose, and
           collapsing them here would make an unparseable `config.yaml` read
           as a project with no rules at all. See `SpecialistEditor.vue`'s
           and `TrackEditors.vue`'s own comments. -->
      <SpecialistEditor :draft="draft" :agent-names="agentNames" :enabled="enabled" :mutate="mutate" />

      <!-- A tablist, not two toggle buttons: these switch which of two
           panels is rendered, which is what `role="tab"` means and what
           `aria-pressed` does not. Graph first, because it is the view the
           panel opens in and source order is what both a Tab press and a
           screen reader follow. `aria-controls` is conditional, not static:
           only one panel is ever mounted (`v-if`/`v-else` below, not a
           visibility toggle), so the unselected tab omits the attribute
           rather than pointing at an id that is briefly absent from the
           document. List and graph both read the same draft, and switching
           never unmounts either's state — `TrackEditors.vue` owns
           `#config-track-editors` and keeps it exactly as complete on a
           round trip back from the graph as it was on the way in; see
           `trackView`'s own comment for why the graph is what a reader lands
           on first. -->
      <div class="track-view-toggle" ref="viewToggleEl" role="tablist" :aria-label="t('config.trackView')" @keydown="onViewKeydown">
        <button
          type="button"
          id="tracks-view-graph"
          role="tab"
          :aria-selected="trackView === 'graph'"
          :aria-controls="trackView === 'graph' ? 'tracks-graph-view' : undefined"
          :tabindex="trackView === 'graph' ? 0 : -1"
          @click="setView('graph')"
        >
          {{ t('config.viewGraph') }}
        </button>
        <button
          type="button"
          id="tracks-view-list"
          role="tab"
          :aria-selected="trackView === 'list'"
          :aria-controls="trackView === 'list' ? 'config-track-editors' : undefined"
          :tabindex="trackView === 'list' ? 0 : -1"
          @click="setView('list')"
        >
          {{ t('config.viewList') }}
        </button>
      </div>

      <TrackEditors v-if="trackView === 'list'" :draft="draft" :baseline="baseline" :raw-text="rawText" :enabled="enabled" :mutate="mutate" />

      <section
        v-else
        id="tracks-graph-view"
        class="track-graphs"
        role="tabpanel"
        tabindex="0"
        aria-labelledby="tracks-view-graph"
      >
        <!-- Deliberately no live-region role or aria-live attribute here —
             #tracks-editor-state above (this same panel) is a banner
             without one too, and the page already keeps exactly two live
             regions on purpose (Toasts.vue, Banners.vue;
             discipline.test.ts's own "keeps one live region for notices and
             one for banners"). A third would double-announce, and a region
             that appears at the same moment its own text does is frequently
             missed by a screen reader anyway — the visible banner is what
             actually carries this. -->
        <p v-if="graphRefusal !== null" id="tracks-graph-refusal" class="banner warn">
          <Tx :key-name="graphRefusal.key" :params="graphRefusal.params" />
        </p>
        <!-- Task 4: canvas and side panel side by side, one row per track —
             `.track-canvas-row` is the pairing `70-graph.css`'s own comment
             on the class lays out; `TrackSidePanel` reads `mutate` straight
             from this panel (this file's own header — the one function
             allowed to touch `draft`) the same way `SpecialistEditor` above
             already does, and never a draft of its own. -->
        <div v-for="entry in graphEntries" :key="entry.name" class="track-canvas-row">
          <TrackSidePanel
            :track="entry.track"
            :name="entry.name"
            :agents="agentsView"
            :selected="selectedByTrack[entry.name] ?? null"
            :enabled="enabled"
            :mutate="mutate"
            @clear-selection="selectedByTrack[entry.name] = null"
          />
          <TrackGraph
            :track="entry.track"
            :name="entry.name"
            :agents="agentsView"
            @select="(params) => (selectedByTrack[entry.name] = params.agent)"
            @connect="(params) => onGraphConnect(entry.name, params)"
            @disconnect="(params) => onGraphDisconnect(entry.name, params)"
            @remove="(params) => onGraphRemove(entry.name, params)"
          />
        </div>
      </section>

      <datalist id="config-agent-names">
        <option v-for="name in agentNames" :key="name" :value="name"></option>
      </datalist>
    </form>
  </section>
</template>
