<script setup lang="ts">
/**
 * Run — what is happening now, without reading the terminal.
 *
 * A person running a plan's worth of stories used to read the terminal to
 * learn things the engine had already written down. Whether a halt is two
 * cycles away, which agent in this cycle has landed, what the critic
 * actually found, what the gate is waiting on — all of it was on disk, in
 * schemas the engine owns, and none of it was on the screen.
 *
 * Two sources, and the split is the whole transport rule: counts and
 * rosters are keys and ride the snapshot; findings, history, gate excerpts
 * and the halt report are bodies and are fetched — `panels/run.js`, ported.
 *
 * The halt control and its dialog live in `Rail.vue`/`App.vue` instead of
 * here, even though the run id they name comes off this same snapshot:
 * `ui/rail.js:106` shows Halt on every tab a run is `running` on, not only
 * this one, and `HaltDialog` has to sit outside the panels' `<KeepAlive>`
 * to survive a tab switch — see `useHalt.ts`. The stalled banner and its
 * nudge button are in `Banners.vue` for the same reason: page-level, not
 * panel-scoped.
 */
import { computed, ref, watch } from 'vue'
import { snapshot } from '../stores/session.js'
import { useI18n } from '../composables/useI18n.js'
import { useFeed } from '../composables/useFeed.js'
import {
  preflightFacts,
  preflightPast,
  qualityBudgetRows,
  qualityComparisons,
  qualityDoors,
  qualityLedgerRows,
  qualityTelemetryRows,
  qualityViewFor,
  runDirName,
} from '../composables/useRun.js'
import { useQualityDialogs } from '../composables/useQualityDialogs.js'
import { stamp } from '../lib/fmt.js'
import type { ConfigView, Preflight, QualityRunView, RunDetail, SkillManifest, Snapshot, StateView } from '../types/protocol.js'
import Bdi from '../components/Bdi.vue'
import Tx from '../components/Tx.vue'
import FactRow from '../components/FactRow.vue'
import Chip from '../components/Chip.vue'
import RosterAgentChip from '../components/RosterAgentChip.vue'
import CycleErrorChip from '../components/CycleErrorChip.vue'
import FindingRow from '../components/FindingRow.vue'
import CycleRow from '../components/CycleRow.vue'
import ManifestSelection from '../components/ManifestSelection.vue'
import QualityLedgerRow from '../components/QualityLedgerRow.vue'

const { t, tn } = useI18n()

/**
 * Whether the estimate is the thing to show: a project that exists, with
 * nothing running in it. Every preflight feed is gated on this, so a live
 * run costs no request for a document about a run that has not started.
 */
function waiting(snap: Snapshot): boolean {
  return snap.state.initialised && snap.state.status === 'idle'
}

const summary = computed(() => snapshot.value?.state ?? null)
const idle = computed(() => summary.value === null || !summary.value.initialised || summary.value.status === 'idle')

/**
 * Which track the estimate is for.
 *
 * The engine's route takes a track rather than a state, because
 * `status === 'idle'` is exactly when it is asked and an idle state names no
 * track at all. So the page has to name one, and a picker is the only honest
 * way: tracks are configuration, and hard-coding `build` here would be the
 * first place in the cockpit that knew a track name.
 */
const chosen = ref('')
/** The track list currently in the picker, so it is rebuilt only when it moves. */
let offered = ''

const configFeed = useFeed<ConfigView>({
  dep: (snap) => (waiting(snap) ? snap.revisions.config : null),
  path: () => '/api/config',
})

const tracks = computed(() => Object.keys(configFeed.value.value?.parsed?.tracks ?? {}))

// Rebuilt only when the configured tracks change, and never while a person is
// using the picker: `chosen` opens on the track the state names — a project
// that has run before is usually about to run the same track again — and
// falls back to the first one the config declares.
watch(
  tracks,
  (list) => {
    const key = list.join(',')
    if (key === offered) return
    offered = key
    const preferred = summary.value?.track ?? null
    chosen.value = preferred !== null && list.includes(preferred) ? preferred : (list[0] ?? '')
  },
  { immediate: true },
)

/**
 * The estimate follows both revisions it rests on: `revisions.config`
 * because the track's shape is the whole ceiling, and `revisions.runs`
 * because the comparable half is a walk over finished runs.
 */
const preflightFeed = useFeed<Preflight>({
  dep: (snap) => (!waiting(snap) || chosen.value === '' ? null : `${chosen.value}:${snap.revisions.config}:${snap.revisions.runs}`),
  path: () => `/api/preflight/${encodeURIComponent(chosen.value)}`,
})
const estimate = computed(() => preflightFeed.value.value)
const preflightFactRows = computed(() => (estimate.value === null ? [] : preflightFacts(estimate.value)))
const comparable = computed(() => estimate.value?.comparable ?? null)
const preflightPastRows = computed(() => (comparable.value === null ? [] : preflightPast(comparable.value)))

/**
 * The whole state file — findings, history, `cycle_errors`, the
 * reproduction with its excerpt. Followed on `revisions.cycle` as well as
 * `revisions.state` because `ops/log.ts:175` only touches `state.json` when
 * an agent result carries findings, a gate proof or error signatures: a
 * clean pass writes `cycle-NN/<agent>.json` and moves nothing else.
 */
const stateFeed = useFeed<StateView>({
  dep: (snap) => (snap.state.initialised ? `${snap.revisions.state}:${snap.revisions.cycle}` : null),
  path: () => '/api/state',
})
const full = computed(() => stateFeed.value.value?.state ?? null)
/**
 * `summary.reproduction` is null when the *track* has no gate; the full
 * state's is null merely because nothing has been proven yet. Only the
 * summary can tell those two apart.
 */
const hasGate = computed(() => summary.value?.reproduction !== null && summary.value !== null)
const gateProof = computed(() => full.value?.reproduction ?? null)

/** `HALT.md`, verbatim. */
const runFeed = useFeed<RunDetail>({
  dep: (snap) => (snap.state.run_id === null ? null : `${snap.state.run_id}:${snap.revisions.runs}`),
  path: (snap) => `/api/runs/${encodeURIComponent(runDirName(snap.state))}`,
})
const haltReport = computed(() => runFeed.value.value?.halt ?? null)

/**
 * The routing decision this run was pinned to, before dispatch. Rides
 * `revisions.runs` and not `revisions.cycle`: a manifest is written once,
 * before the first dispatch, and is never rewritten by a profile or a brief
 * that moved afterwards.
 */
const manifestFeed = useFeed<SkillManifest | null>({
  dep: (snap) => (snap.state.run_id === null ? null : `${snap.state.run_id}:${snap.revisions.runs}`),
  path: (snap) => `/api/runs/${encodeURIComponent(runDirName(snap.state))}/skills`,
})
const manifest = computed(() => manifestFeed.value.value)

/**
 * Which agents this cycle drafted, and which have landed.
 *
 * `roster.selected` diffed against the `cycle-NN/<agent>.json` files that
 * exist — the only real intra-cycle progress signal there is, and the
 * engine's own record of it: unlike `lib/stories.ts`'s `draftedAgents` (a
 * track's *configured* required/available set, used where no cycle is open
 * yet), `snapshot.roster` already names this cycle's actual draft, so there
 * is nothing here to re-derive.
 */
const roster = computed(() => snapshot.value?.roster ?? null)
const rosterRows = computed(() => {
  const current = roster.value
  if (current === null) return []
  const landed = new Set(current.landed)
  return current.selected.map((agent) => ({ agent, landed: landed.has(agent) }))
})

/**
 * The pinned quality policy, its ledger, its ceilings and the operation — if
 * any — this run is stopped waiting for a person to answer.
 *
 * Asked for only while this panel is mounted, which is what `useFeed` already
 * guarantees: it stops its effect on `onDeactivated`, so a reader on another
 * tab costs no request. Gated on `state.quality`, so a run that pinned no
 * policy — every run before this milestone — never asks at all.
 *
 * Follows `revisions.state` beside `revisions.quality`: the quality documents
 * stamp the pin, the ledger and the amendments, while the telemetry riding the
 * same response is measured from the run's own state transitions. A suspension
 * moves the state and not one quality file, and a screen that missed it would
 * show a working run that has been waiting for an hour.
 */
const qualityFeed = useFeed<QualityRunView>({
  dep: (snap) => (snap.state.quality === null || snap.state.run_id === null ? null : `${snap.state.run_id}:${snap.revisions.quality}:${snap.revisions.state}`),
  path: (snap) => `/api/runs/${encodeURIComponent(runDirName(snap.state))}/quality`,
})
const quality = computed(() => qualityViewFor(qualityFeed.value.value, qualityFeed.error.value))
const ledgerRows = computed(() => (quality.value === null ? [] : qualityLedgerRows(quality.value.ledger)))
const telemetryRows = computed(() => (quality.value === null ? [] : qualityTelemetryRows(quality.value.telemetry)))
const budgetRows = computed(() => (quality.value === null ? [] : qualityBudgetRows(quality.value.effectiveBudget)))
const doors = computed(() => qualityDoors(summary.value, quality.value))
// `quality` is checked rather than assumed: a preflight served by a server
// older than this milestone carries every other field and not this one.
const comparisons = computed(() => {
  const preview = estimate.value?.quality
  return preview === undefined || preview === null ? [] : qualityComparisons(preview)
})

const { askDecision, askBudget } = useQualityDialogs()

/**
 * Both dialogs are opened with a *copy* of what is on screen right now, taken
 * at the moment of the click — see `useQualityDialogs.ts` for why a reference
 * to the live feed's own object would not do.
 */
function openDecision(event: MouseEvent): void {
  focusOpener(event)
  const request = quality.value?.pendingRequest
  if (request === undefined || request === null) return
  askDecision({
    run: request.run,
    fingerprint: request.fingerprint,
    kind: request.candidate.kind,
    targets: request.candidate.targets,
    operation: request.candidate.operation,
    rollback: request.candidate.rollback,
    applied: request.applied,
  })
}

/**
 * The dialogs give focus back to whatever held it when they opened, and a
 * pointer click does not reliably focus a `<button>` — Safari famously does
 * not. Focusing it here is what makes "focus returns to the button you pressed"
 * true for a mouse as well as for a keyboard, where it already was.
 */
function focusOpener(event: MouseEvent): void {
  const target = event.currentTarget
  if (target instanceof HTMLElement) target.focus()
}

function openBudget(event: MouseEvent): void {
  focusOpener(event)
  const view = quality.value
  const run = summary.value?.run_id ?? null
  if (view === null || run === null) return
  askBudget({ run, budget: view.effectiveBudget })
}

const guards = computed(() => snapshot.value?.guards ?? null)
const strikesText = computed(() => `${guards.value?.strikes ?? 0}/${guards.value?.strikesAllowed ?? '?'}`)

const lastCycle = computed(() => summary.value?.last_cycle ?? null)
</script>

<template>
  <section id="panel-run" class="panel" aria-labelledby="panel-run-title">
    <header class="panel-head">
      <div>
        <h1 id="panel-run-title">{{ t('panel.run.title') }}</h1>
        <p class="hint">{{ t('panel.run.help') }}</p>
      </div>
    </header>

    <p v-if="idle" class="empty">{{ t(summary?.initialised ? 'run.idle' : 'run.uninitialised') }}</p>

    <!-- The estimate, and the only thing on this page that describes a run
         nobody has started. It sits beside the empty line because that is
         the one moment it can still change a decision. -->
    <section v-if="idle && estimate !== null" id="run-preflight" class="block">
      <h2>{{ t('preflight.title') }}</h2>
      <p class="hint">{{ t('preflight.why') }}</p>
      <label class="picker">
        <span>{{ t('preflight.track') }}</span>
        <select id="preflight-track" v-model="chosen" name="track" :aria-label="t('preflight.track')">
          <option v-for="trackName in tracks" :key="trackName" :value="trackName">{{ trackName }}</option>
        </select>
      </label>
      <dl id="preflight-facts" class="facts">
        <FactRow v-for="fact in preflightFactRows" :key="fact.key" :label="fact.key" :value="fact.value" />
      </dl>
      <p id="preflight-basis" class="hint">
        {{ comparable === null ? t('preflight.noBasis') : tn('preflight.basis', comparable.runs, { count: comparable.runs }) }}
      </p>
      <dl id="preflight-past" class="facts">
        <FactRow v-for="fact in preflightPastRows" :key="fact.key" :label="fact.key" :value="fact.value" />
      </dl>

      <!-- What each mode would cost for this same run. Three peers, in the
           schema's own order — least review first — with the project's own
           mode marked rather than moved: the comparison is the point, and a
           reordered list is a recommendation wearing a table's clothes. -->
      <section v-if="comparisons.length > 0" id="preflight-quality" class="block">
        <h3>{{ t('quality.compareTitle') }}</h3>
        <div class="quality-compare">
          <div v-for="row in comparisons" :key="row.mode" class="quality-compare-mode" :data-compare-mode="row.mode">
            <span class="quality-card-name">{{ t(`quality.mode.${row.mode}`) }}</span>
            <span v-if="row.selected" class="tag recommended">{{ t('quality.compareSelected') }}</span>
            <span><Tx key-name="quality.compareCeiling" :params="{ dispatches: row.dispatches, cycles: row.cycles }" /></span>
            <span class="hint">
              <template v-if="row.cost.value === null">{{ t(row.cost.unavailable) }}</template>
              <Tx v-else-if="row.cost.kind === 'estimated'" key-name="quality.estimatedValue" :params="{ value: row.cost.value }" />
              <Bdi v-else :value="row.cost.value" />
            </span>
          </div>
        </div>
      </section>
    </section>

    <!-- What the run *is* down the main column; what is happening to it
         right now — this cycle's roster, the guards, how the last cycle
         ended — in the aside. -->
    <div v-if="!idle && summary !== null" id="run-body" class="panel-grid">
      <div class="panel-main">
        <dl class="facts">
          <div class="fact"><dt>{{ t('run.goal') }}</dt><dd><Bdi :value="summary.goal ?? '—'" /></dd></div>
          <div v-if="summary.story !== null" id="run-story-fact" class="fact"><dt>{{ t('run.story') }}</dt><dd><Bdi :value="summary.story" /></dd></div>
          <div v-if="summary.plan !== null" id="run-plan-fact" class="fact"><dt>{{ t('run.plan') }}</dt><dd><Bdi :value="summary.plan" /></dd></div>
          <div v-if="summary.run_id !== null" id="run-runid-fact" class="fact"><dt>{{ t('run.runId') }}</dt><dd><Bdi :value="summary.run_id" /></dd></div>
          <div class="fact">
            <dt>{{ t('run.findings') }}</dt>
            <dd>{{ t('run.findingsCounts', { high: summary.findings.high, medium: summary.findings.medium, low: summary.findings.low }) }}</dd>
          </div>
          <div v-if="summary.reproduction !== null" id="run-gate-fact" class="fact">
            <dt>{{ t('run.gate') }}</dt>
            <dd>{{ t(summary.reproduction.proven ? 'run.gateState.open' : 'run.gateState.shut') }}</dd>
          </div>
          <div v-if="summary.halt_reason !== null" id="run-halt-fact" class="fact"><dt>{{ t('run.halted') }}</dt><dd><Bdi :value="summary.halt_reason" /></dd></div>
        </dl>

        <section v-if="full !== null && full.findings.length > 0" id="run-findings-block" class="block">
          <h2>{{ t('run.findingsTitle') }}</h2>
          <div class="scroller">
            <div class="grid grid-findings" role="table">
              <div class="grid-head" role="row">
                <span role="columnheader">{{ t('run.finding.severity') }}</span>
                <span role="columnheader">{{ t('run.finding.where') }}</span>
                <span role="columnheader">{{ t('run.finding.claim') }}</span>
              </div>
              <div id="run-findings-list" role="rowgroup" class="grid-body">
                <FindingRow v-for="finding in full.findings" :key="`${finding.file}:${finding.line}:${finding.claim}`" :finding="finding" />
              </div>
            </div>
          </div>
        </section>

        <section v-if="full !== null && hasGate" id="run-gate-block" class="block">
          <h2>{{ t('run.gatePanel') }}</h2>
          <p id="run-gate-state">
            <!-- `agent` is a Latin agent name; `cycle` is a prose count, but
                 `tx()` wraps every hole regardless — matched here rather than
                 hand-picking which one actually needs it. -->
            <template v-if="gateProof === null">{{ t('run.gateState.shut') }}</template>
            <Tx v-else key-name="run.gateState.provenBy" :params="{ agent: gateProof.agent, cycle: gateProof.cycle }" />
          </p>
          <!-- The `<p>` always renders; only the `<code>` inside it hides —
               `run.js:469` hides `run-gate-ref` itself, not its wrapper, and
               an always-present `<p>` here is what keeps the two states
               (shut, proven with no excerpt) from collapsing their margins
               into each other differently than the old page did. -->
          <p><code v-if="gateProof !== null" id="run-gate-ref"><Bdi :value="gateProof.ref" /></code></p>
          <pre v-if="gateProof !== null && gateProof.excerpt.length > 0" id="run-gate-excerpt" class="excerpt"><Bdi :value="gateProof.excerpt" /></pre>
        </section>

        <section v-if="full !== null && full.history.length > 0" id="run-timeline" class="block">
          <h2>{{ t('run.timeline') }}</h2>
          <div class="scroller">
            <div class="grid grid-cycles" role="table">
              <div class="grid-head" role="row">
                <span role="columnheader">{{ t('run.cycle.number') }}</span>
                <span role="columnheader">{{ t('run.cycle.agents') }}</span>
                <span role="columnheader">{{ t('run.cycle.result') }}</span>
                <span role="columnheader">{{ t('run.cycle.ref') }}</span>
              </div>
              <div id="run-timeline-list" role="rowgroup" class="grid-body">
                <CycleRow v-for="entry in full.history" :key="`${entry.cycle}:${entry.ref}`" :entry="entry" />
              </div>
            </div>
          </div>
        </section>

        <section v-if="haltReport !== null" id="run-haltreport" class="block">
          <h2>{{ t('run.haltReport') }}</h2>
          <pre id="run-halt-report" class="excerpt"><Bdi :value="haltReport" /></pre>
        </section>

        <!-- The policy this run is pinned to. Drawn from the run's own record
             and never from the project's saved mode: a mode saved while a run
             is in flight is the *next* run's mode, and showing it here would
             describe a run that never existed. -->
        <section v-if="quality !== null" id="run-quality" class="block">
          <h2>{{ t('quality.title') }}</h2>
          <p id="run-quality-mode" :data-quality-mode="quality.policy.mode">
            <span class="quality-card-name">{{ t(`quality.mode.${quality.policy.mode}`) }}</span>
            <span class="tag">{{ t('quality.pinned') }}</span>
          </p>
          <!-- Shadow is not gating. A run whose policy was inferred rather than
               chosen reads as a report about what would have happened, which is
               what `enforcement: shadow` means. -->
          <p id="run-quality-enforcement" class="hint" :data-enforcement="quality.policy.enforcement">
            {{ t(`quality.enforcement.${quality.policy.enforcement}`) }} — {{ t(`quality.source.${quality.policy.source}`) }}
          </p>

          <div v-if="doors.decision || doors.budget" id="run-quality-doors" class="dialog-actions">
            <button v-if="doors.decision" id="run-quality-decide" type="button" class="danger" @click="openDecision($event)">
              {{ t('quality.decisionOpen') }}
            </button>
            <button v-if="doors.budget" id="run-quality-amend" type="button" @click="openBudget($event)">
              {{ t('quality.budgetOpen') }}
            </button>
          </div>

          <dl id="run-quality-telemetry" class="facts">
            <div v-for="row in telemetryRows" :key="row.key" class="fact" :data-telemetry="row.key" :data-kind="row.kind">
              <dt>{{ t(row.label) }}</dt>
              <dd>
                <template v-if="row.value === null">{{ t(row.unavailable) }}</template>
                <Tx v-else-if="row.kind === 'estimated'" key-name="quality.estimatedValue" :params="{ value: row.value }" />
                <Bdi v-else :value="row.value" />
              </dd>
            </div>
          </dl>

          <dl id="run-quality-budget" class="facts">
            <div v-for="row in budgetRows" :key="row.field" class="fact" :data-budget="row.field">
              <dt>{{ t(`quality.budgetField.${row.field}`) }}</dt>
              <dd><Bdi :value="row.value" /></dd>
            </div>
          </dl>

          <div v-if="quality.amendments.length > 0" id="run-quality-amendments">
            <h3>{{ t('quality.amendments') }}</h3>
            <p v-for="(amendment, index) in quality.amendments" :key="index" class="quality-amendment">
              <span>{{ t(`quality.budgetField.${amendment.field}`) }}</span>
              <Tx key-name="quality.amendmentChange" :params="{ from: amendment.from, to: amendment.to }" />
              <span class="hint"><Bdi :value="amendment.reason" /></span>
            </p>
          </div>

          <ul id="run-quality-ledger" class="quality-ledger">
            <QualityLedgerRow v-for="row in ledgerRows" :key="row.dimension" :dimension="row.dimension" :entry="row.entry" />
          </ul>
        </section>

        <!-- What this run was actually routed by, pinned before dispatch and
             never rewritten by a profile or a brief that moved afterwards.
             Hidden entirely when the run pinned no manifest: "no manifest"
             and "a manifest that selected nothing" are two different facts. -->
        <section v-if="manifest !== null" id="run-manifest" class="block">
          <h2>{{ t('manifest.title') }}</h2>
          <dl class="facts">
            <div class="fact"><dt>{{ t('manifest.brief') }}</dt><dd><code><Bdi :value="`${manifest.sourceBrief.id}@${manifest.sourceBrief.revision}`" /></code></dd></div>
            <div class="fact"><dt>{{ t('manifest.profile') }}</dt><dd><code><Bdi :value="String(manifest.profileRevision)" /></code></dd></div>
            <!-- The mode is the engine's enum and the reason is engine-authored
                 prose the page does not own, so one is translated and one is
                 passed through. -->
            <div class="fact">
              <dt>{{ t('manifest.concurrency') }}</dt>
              <dd><span>{{ t(`manifest.mode.${manifest.concurrency.mode}`) }}</span> <span class="hint"><Bdi :value="manifest.concurrency.reason" /></span></dd>
            </div>
            <div class="fact"><dt>{{ t('manifest.generated') }}</dt><dd><Bdi :value="stamp(manifest.generatedAt)" /></dd></div>
          </dl>
          <p v-if="manifest.selections.length === 0" id="manifest-empty" class="empty">{{ t('manifest.empty') }}</p>
          <div id="manifest-selections">
            <ManifestSelection
              v-for="selection in manifest.selections"
              :key="`${selection.component}/${selection.agent}`"
              :selection="selection"
              :guidance="manifest.guidance"
            />
          </div>
        </section>
      </div>

      <aside class="panel-side">
        <section v-if="roster !== null" id="run-roster" class="block">
          <h2>{{ t('run.roster') }}</h2>
          <ul id="run-roster-agents" class="chips">
            <RosterAgentChip v-for="row in rosterRows" :key="row.agent" :agent="row.agent" :landed="row.landed" />
          </ul>
        </section>

        <section v-if="lastCycle !== null" id="run-last" class="block">
          <h2>{{ t('run.lastCycle') }}</h2>
          <p><span id="run-last-result">{{ t(`cycle.result.${lastCycle.result}`) }}</span></p>
          <ul id="run-last-agents" class="chips">
            <Chip v-for="agent in lastCycle.agents" :key="agent" :text="agent" />
          </ul>
        </section>

        <section v-if="guards !== null" id="run-guards" class="block">
          <h2>{{ t('run.guards') }}</h2>
          <!-- Two identifiers side by side, not a prose count: `1/2` must
               never become `١/٢`. -->
          <p id="run-strikes"><Bdi :value="strikesText" /></p>
          <ul id="run-cycle-errors" class="chips">
            <CycleErrorChip
              v-for="signature in guards.cycleErrors"
              :key="signature"
              :signature="signature"
              :armed="signature === guards.errorArmed"
            />
          </ul>
        </section>
      </aside>
    </div>
  </section>
</template>
