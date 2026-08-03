<script setup lang="ts">
/**
 * Stories — what can start now, what is left, and what is finished, for the
 * plan the reader has open. `panels/stories.js`, ported.
 *
 * The split this tab exists for: a plan is read occasionally and a story is
 * watched while it runs, and one panel serving both meant the story list lived
 * three clicks inside a plan's detail. Nothing here edits a plan; nothing in
 * `Plans.vue` runs a story.
 *
 * The list rides the fetched plan document rather than the snapshot, because
 * `acceptance` and `evidence` live in story frontmatter and `StoryView`
 * deliberately does not carry them. That document is `lib/plandoc.ts`'s,
 * pumped from `App.vue` — this panel only `subscribe()`s and reads `value()`,
 * exactly as `Plans.vue` does and for the same reason (see `App.vue`'s own
 * comment): mounting the feed from here would race whichever panel mounts
 * second and silently freeze the first.
 *
 * Readiness is `lib/stories.ts`'s rule, which is the engine's: the same
 * function answers the filter, the ready block, the row's disabled state and
 * the count on the navigation, so the four cannot disagree.
 *
 * The work-tabs, the story filter and the active story all persist through
 * `useSelection()` — the only door onto that state.
 */
import { computed, nextTick, ref } from 'vue'
import { useI18n } from '../composables/useI18n.js'
import { useFeed } from '../composables/useFeed.js'
import { useSelection } from '../composables/useSelection.js'
import { usePane } from '../composables/usePane.js'
import { subscribe as subscribePlanDoc, value as planDocValue } from '../lib/plandoc.js'
import { stamp } from '../lib/fmt.js'
import { jobForStory } from '../lib/queue.js'
import {
  FILTERS,
  acceptancesFor,
  depTree,
  dependents,
  draftedAgents,
  planIndex,
  readyIn,
  relevantAcceptances,
  routableAgents,
  sift,
  skillWarnings,
  statusIndex,
  unmet,
} from '../lib/stories.js'
import { send, snapshot, submit } from '../stores/session.js'
import type { ConfigView, RunSummary, SkillManifest, SkillsView, StoryDetail, StoryView } from '../types/protocol.js'
import Bdi from '../components/Bdi.vue'
import FactRow from '../components/FactRow.vue'
import WorkTab from '../components/WorkTab.vue'
import ReadyRow from '../components/ReadyRow.vue'
import StoryDetailRow from '../components/StoryDetailRow.vue'
import StoryWaitRow from '../components/StoryWaitRow.vue'
import StoryDepRow from '../components/StoryDepRow.vue'
import StoryRunRow from '../components/StoryRunRow.vue'
import StorySkillAgentRow from '../components/StorySkillAgentRow.vue'
import StorySkillWarningRow from '../components/StorySkillWarningRow.vue'
import ManifestSelection from '../components/ManifestSelection.vue'

const { t, tn } = useI18n()
const pane = usePane()

/** `ui/list.js`'s own cap, carried across — a long list caps rather than virtualises. */
const CAP = 200
/** How many buildable stories the start block lists before it says "and n more". */
const READY_SHOWN = 6
/**
 * The one track a story ever runs against from this pane — the literal
 * `commands/build.md:6` names, and the same literal `story-open-command`
 * below previews character for character.
 */
const STORY_TRACK = 'build'

const {
  activePlan,
  activeStory,
  storyFilter,
  setStoryFilter,
  openStories,
  openStory,
  closeStory,
  pinStory,
  reopenStory,
  recentlyClosed,
} = useSelection()

/** Uncontrolled, like every other search box on this page: read on input, never persisted. */
const text = ref('')

// The document is fetched and ticked by `App.vue`; this panel only reads it.
const docTick = ref(0)
subscribePlanDoc(() => void docTick.value++)
const planDoc = computed(() => (docTick.value, planDocValue()))
/** The open plan's own stories, with `acceptance`/`evidence`/`body` — the fetched document, not the snapshot. */
const stories = computed(() => planDoc.value?.stories ?? [])

const plans = computed(() => snapshot.value?.plans ?? [])
const snapshotPlan = computed(() => plans.value.find((plan) => plan.id === activePlan.value) ?? null)
/** Every story in this plan that could be built right now — `lib/stories.ts`'s rule, uncapped. */
const buildable = computed(() => (snapshotPlan.value === null ? [] : readyIn(snapshotPlan.value)))
const shownReady = computed(() => buildable.value.slice(0, READY_SHOWN))
const plansOf = computed(() => planIndex(plans.value))
/** The story `--next` would pick. */
const first = computed(() => buildable.value[0]?.id ?? null)

const statuses = computed(() => statusIndex(stories.value))
/** The stories a filter and the search box leave standing — uncapped. */
const siftedStories = computed(() => sift(stories.value, text.value, storyFilter.value, statuses.value))
const visibleStories = computed(() => siftedStories.value.slice(0, CAP))

/**
 * The tab strip's model, from the same document the list draws.
 *
 * A tab whose story the plan no longer carries is dropped rather than drawn
 * as a stub: a story can be renamed on disk, and a tab that outlives its
 * subject is a control that opens nothing.
 */
const tabs = computed(() => {
  const byId = new Map(stories.value.map((story) => [story.id, story]))
  return openStories.value
    .filter((tab) => byId.has(tab.id))
    .map((tab) => ({ id: tab.id, pinned: tab.pinned, state: byId.get(tab.id)?.status }))
})

const stripEl = ref<HTMLElement | null>(null)

/**
 * The strip's own keyboard navigation — `ui/worktabs.js`'s reason for being a
 * second module beside `ui/tabs.js`: a working set needs arrow keys that
 * honour text direction, read fresh on every keystroke rather than decided
 * once, so a reader who switches to Arabic without reloading still gets
 * `ArrowRight` meaning *previous*.
 */
function onStripKeydown(event: KeyboardEvent): void {
  const ids = tabs.value.map((tab) => tab.id)
  if (ids.length === 0) return
  const here = ids.indexOf(activeStory.value ?? '')
  const at = here === -1 ? 0 : here
  const rtl = document.documentElement.dir === 'rtl'
  const forward = rtl ? 'ArrowLeft' : 'ArrowRight'
  const back = rtl ? 'ArrowRight' : 'ArrowLeft'

  let next: string | undefined
  if (event.key === forward) next = ids[(at + 1) % ids.length]
  else if (event.key === back) next = ids[(at - 1 + ids.length) % ids.length]
  else if (event.key === 'Home') next = ids[0]
  else if (event.key === 'End') next = ids[ids.length - 1]
  else return

  event.preventDefault()
  if (next === undefined) return
  const target = next
  openStory(target)
  void nextTick(() => {
    const node = stripEl.value?.querySelector(`[data-tab="${CSS.escape(target)}"]`)
    if (node instanceof HTMLElement) node.focus()
  })
}

/** The command a press of Build sends — composed and enqueued, the one execution model this page has. */
function buildStory(id: string): void {
  send({ type: 'enqueue', command: `/mjloop:build ${id}`, story: id })
}

/**
 * A run cancelled mid-story leaves it `doing`, which makes it invisible to
 * `--next` forever. The documented repair was a text editor.
 */
function requeue(story: string, from: string): void {
  if (from !== 'doing' && from !== 'blocked') return
  submit(
    { kind: 'story.status', story, from: from as 'doing' | 'blocked', to: 'todo' },
    // Safe to offer precisely because the undo is conditional too: one
    // arriving after the leader moved on is refused rather than clobbering.
    { undo: { kind: 'story.status', story, from: 'todo', to: from as 'doing' | 'blocked' } },
  )
}

/** `Pane.vue`'s own `job-attach` handler, reused here for the story pane's identical control. */
function attach(jobId: string): void {
  send({ type: 'attach', jobId })
  pane.setView('session')
  pane.reveal()
}

/* ── the open tab ─────────────────────────────────────────────────────── */

const openStoryRecord = computed<StoryDetail | null>(() => {
  const id = activeStory.value
  if (id === null) return null
  return stories.value.find((entry) => entry.id === id) ?? null
})

/** The newest job the queue holds for this story that has actually started — `lib/queue.ts`'s `jobForStory`. */
const job = computed(() => (openStoryRecord.value === null ? null : jobForStory(snapshot.value?.queue ?? [], openStoryRecord.value.id)))

const waiting = computed(() => (openStoryRecord.value === null ? [] : unmet(openStoryRecord.value, statuses.value)))
const waitingOnDeps = computed(
  () => openStoryRecord.value !== null && openStoryRecord.value.status === 'todo' && waiting.value.length > 0,
)
/** Reconciled unconditionally, empty when there is nothing to wait on — never the previous story's rows left behind. */
const waitRows = computed(() => (waitingOnDeps.value ? waiting.value : []))

const metaKey = computed(() => {
  const story = openStoryRecord.value
  if (story === null) return ''
  if (waitingOnDeps.value) return 'story.waitsOn'
  if (story.status === 'todo') return 'story.open.clear'
  return `story.notBuildable.${story.status}`
})

const facts = computed(() => {
  const story = openStoryRecord.value
  if (story === null) return []
  return [
    { key: 'story.fact.plan', value: story.id.slice(0, 4) },
    { key: 'story.fact.dependsOn', value: story.depends_on.join(', ') || '—' },
    { key: 'story.fact.dependents', value: dependents(story.id, stories.value).join(', ') || '—' },
    { key: 'story.fact.ui', value: story.ui ? 'yes' : 'no' },
    { key: 'story.fact.evidence', value: story.evidence ?? '—' },
  ]
})

const byId = computed(() => new Map(stories.value.map((entry) => [entry.id, entry])))
const depRows = computed(() => (openStoryRecord.value === null ? [] : depTree(openStoryRecord.value, byId.value)))
const shownDeps = computed(() => depRows.value.slice(0, CAP))

/** Every run on disk, filtered client-side to this story's own convention-named directory. */
const runsFeed = useFeed<RunSummary[]>({
  dep: (state) => `${state.revisions.runs}:${state.revisions.cycle}`,
  path: () => '/api/runs',
})
const storyRuns = computed(() => {
  const story = openStoryRecord.value
  return story === null ? [] : (runsFeed.value.value ?? []).filter((entry) => entry.story === story.id)
})

/** `config.tracks.build`, for the agents it drafts. */
const configFeed = useFeed<ConfigView>({
  dep: (state) => state.revisions.config,
  path: () => '/api/config',
})
/** This project's own skill acceptances, read-only. */
const skillsFeed = useFeed<SkillsView>({
  dep: (state) => state.revisions.skills,
  path: () => '/api/skills',
})

const track = computed(() => configFeed.value.value?.parsed?.tracks?.[STORY_TRACK])
const drafted = computed(() => draftedAgents(track.value))
const routable = computed(() => routableAgents(track.value))
const skillAcceptances = computed(() => relevantAcceptances(skillsFeed.value.value?.acceptances ?? [], routable.value))
const warned = computed(() =>
  skillAcceptances.value
    .map((acceptance) => ({ acceptance, warn: skillWarnings(acceptance) }))
    .filter(({ warn }) => warn.noAgents || warn.notActive || warn.notCompatible),
)

/**
 * The open tab's own pinned routing decision, or `null` while it has none.
 *
 * Two different nothings collapse into the same `null` — a story with no
 * evidence run yet (`openStoryEvidence` is `null`, so `dep` is too, no fetch
 * is even made) and an evidence run that pinned nothing, because
 * `resolveSkillManifest` only pins one when the caller named an approved
 * feature and `/mjloop:build <story>` never does. `hasEvidence` (below) tells
 * the two apart from `story.evidence` directly, never from this feed alone.
 */
const openStoryEvidence = computed(() => openStoryRecord.value?.evidence ?? null)
const skillManifestFeed = useFeed<SkillManifest | null>({
  dep: (state) => (openStoryEvidence.value === null ? null : `${openStoryEvidence.value}:${state.revisions.runs}`),
  path: () => `/api/runs/${encodeURIComponent(openStoryEvidence.value ?? '')}/skills`,
})
const hasEvidence = computed(() => openStoryRecord.value !== null && openStoryRecord.value.evidence !== null)
const pinnedManifest = computed(() => (hasEvidence.value ? skillManifestFeed.value.value : null))
</script>

<template>
  <section id="panel-stories" class="panel" aria-labelledby="panel-stories-title">
    <header class="panel-head">
      <div>
        <h1 id="panel-stories-title">{{ t('panel.stories.title') }}</h1>
        <p class="hint">{{ t('panel.stories.help') }}</p>
      </div>
      <p class="stories-plan" id="stories-plan" :hidden="activePlan === null">
        <span id="stories-plan-id"><Bdi :value="activePlan ?? ''" /></span>
        <a href="#plans">{{ t('story.toPlans') }}</a>
      </p>
    </header>

    <p class="empty" id="stories-none" :hidden="activePlan !== null && stories.length > 0">
      {{ t(activePlan === null ? 'story.noPlan' : 'story.planEmpty') }}
    </p>

    <div class="panel-grid">
      <div class="panel-main">
        <section class="block start" id="stories-ready" :hidden="buildable.length === 0">
          <h2>{{ t('story.next') }}</h2>
          <ul class="ready" id="stories-ready-list">
            <ReadyRow
              v-for="story in shownReady"
              :key="story.id"
              :story="story"
              :plan="plansOf.get(story.id) ?? ''"
              :next="story.id === first"
              @build="buildStory"
            />
          </ul>
          <p class="more" id="stories-ready-more" :hidden="buildable.length <= READY_SHOWN">
            {{ t('story.readyMore', { n: buildable.length - READY_SHOWN }) }}
          </p>
        </section>

        <div
          class="worktabs"
          id="story-tabs"
          ref="stripEl"
          role="tablist"
          :aria-label="t('story.tab.strip')"
          :hidden="tabs.length === 0"
          @keydown="onStripKeydown"
        >
          <WorkTab
            v-for="tab in tabs"
            :key="tab.id"
            :id="tab.id"
            :pinned="tab.pinned"
            :state="tab.state"
            :active="activeStory === tab.id"
            @select="openStory"
            @pin="pinStory"
            @close="closeStory"
          />
        </div>
        <p class="worktabs-reopen" id="story-tabs-reopen" :hidden="recentlyClosed.length === 0">
          <button type="button" @click="reopenStory()">{{ t('story.tab.reopen') }}</button>
        </p>

        <section class="block story-open" id="story-open" :hidden="openStoryRecord === null">
          <template v-if="openStoryRecord !== null">
            <header class="story-open-head">
              <h2 id="story-open-title" tabindex="-1"><Bdi :value="`${openStoryRecord.id} — ${openStoryRecord.title}`" /></h2>
              <span class="tag" id="story-open-status" :class="`status-${openStoryRecord.status}`">
                {{ t(`story.status.${openStoryRecord.status}`) }}
              </span>
              <button
                type="button"
                id="story-open-attach"
                :data-job="job?.id"
                :hidden="job === null"
                @click="job !== null && attach(job.id)"
              >{{ t('job.view') }}</button>
            </header>

            <p class="story-open-command">
              <span>{{ t('story.command.label') }}</span>
              <code id="story-open-command"><Bdi :value="`/mjloop:build ${openStoryRecord.id}`" /></code>
            </p>

            <p class="story-open-meta" id="story-open-meta">{{ t(metaKey) }}</p>
            <ul class="story-open-waits" id="story-open-waits" :hidden="!waitingOnDeps">
              <StoryWaitRow v-for="id in waitRows" :key="id" :id="id" :status="statuses.get(id)" />
            </ul>
            <dl class="facts" id="story-open-facts">
              <FactRow v-for="fact in facts" :key="fact.key" :label="fact.key" :value="fact.value" />
            </dl>

            <section class="story-open-deps">
              <h3>{{ t('story.deps.title') }}</h3>
              <p class="empty" id="story-open-deps-empty" :hidden="depRows.length > 0">{{ t('story.deps.empty') }}</p>
              <ul class="deps" id="story-open-deps-list" role="tree">
                <StoryDepRow v-for="row in shownDeps" :key="row.key" :id="row.id" :status="statuses.get(row.id)" :depth="row.depth" />
              </ul>
              <p class="more" id="story-open-deps-more" :hidden="shownDeps.length >= depRows.length">
                {{ tn('story.deps.more', depRows.length - shownDeps.length) }}
              </p>
            </section>

            <details id="story-open-accept-details" :hidden="openStoryRecord.acceptance.length === 0">
              <summary id="story-open-accept-summary">{{ t('story.acceptance', { n: openStoryRecord.acceptance.length }) }}</summary>
              <ul class="acceptance" id="story-open-acceptance">
                <li v-for="line in openStoryRecord.acceptance" :key="line"><Bdi :value="line" /></li>
              </ul>
            </details>
            <details id="story-open-body-details" :hidden="openStoryRecord.body.trim().length === 0">
              <summary>{{ t('story.readBody') }}</summary>
              <pre class="excerpt" id="story-open-body"><Bdi :value="openStoryRecord.body" /></pre>
            </details>

            <section class="story-open-runs">
              <h3>{{ t('story.runs.title') }}</h3>
              <p class="empty" id="story-open-runs-empty" :hidden="storyRuns.length > 0">{{ t('story.runs.empty') }}</p>
              <ul class="runs" id="story-open-runs">
                <StoryRunRow v-for="entry in storyRuns" :key="entry.id" :entry="entry" />
              </ul>
            </section>

            <section class="story-open-skills">
              <h3>{{ t('story.skills.title') }}</h3>
              <p class="hint">{{ t('story.skills.why') }}</p>
              <p class="empty" id="story-open-skills-agents-empty" :hidden="drafted.length > 0">{{ t('story.skills.noTrack') }}</p>
              <ul class="skill-agents" id="story-open-skills-agents">
                <StorySkillAgentRow v-for="agent in routable" :key="agent" :agent="agent" :matches="acceptancesFor(skillAcceptances, agent)" />
              </ul>

              <h4>{{ t('story.skills.warningsTitle') }}</h4>
              <p class="empty" id="story-open-skills-warnings-empty" :hidden="warned.length > 0">{{ t('story.skills.warningsNone') }}</p>
              <ul class="skill-warnings" id="story-open-skills-warnings">
                <StorySkillWarningRow v-for="entry in warned" :key="entry.acceptance.skillId" :acceptance="entry.acceptance" :warn="entry.warn" />
              </ul>

              <h3>{{ t('story.skills.pinnedTitle') }}</h3>
              <p class="hint" id="story-open-skills-hole">{{ t('story.skills.hole') }}</p>
              <p class="empty" id="story-open-skills-no-evidence" :hidden="hasEvidence">{{ t('story.skills.pinnedNoEvidence') }}</p>
              <p class="empty" id="story-open-skills-pinned-none" :hidden="!hasEvidence || pinnedManifest !== null">{{ t('story.skills.pinnedNone') }}</p>
              <div id="story-open-skills-pinned" :hidden="pinnedManifest === null">
                <template v-if="pinnedManifest !== null">
                  <dl class="facts">
                    <div class="fact">
                      <dt>{{ t('manifest.brief') }}</dt>
                      <dd><code id="story-open-skills-pinned-brief"><Bdi :value="`${pinnedManifest.sourceBrief.id}@${pinnedManifest.sourceBrief.revision}`" /></code></dd>
                    </div>
                    <div class="fact">
                      <dt>{{ t('manifest.profile') }}</dt>
                      <dd><code id="story-open-skills-pinned-profile"><Bdi :value="String(pinnedManifest.profileRevision)" /></code></dd>
                    </div>
                    <div class="fact">
                      <dt>{{ t('manifest.concurrency') }}</dt>
                      <dd>
                        <span id="story-open-skills-pinned-concurrency">{{ t(`manifest.mode.${pinnedManifest.concurrency.mode}`) }}</span>
                        <span class="hint" id="story-open-skills-pinned-reason"><Bdi :value="pinnedManifest.concurrency.reason" /></span>
                      </dd>
                    </div>
                    <div class="fact">
                      <dt>{{ t('manifest.generated') }}</dt>
                      <dd id="story-open-skills-pinned-generated"><Bdi :value="stamp(pinnedManifest.generatedAt)" /></dd>
                    </div>
                  </dl>
                  <p class="empty" id="story-open-skills-pinned-empty" :hidden="pinnedManifest.selections.length > 0">{{ t('manifest.empty') }}</p>
                  <div id="story-open-skills-pinned-selections">
                    <ManifestSelection
                      v-for="selection in pinnedManifest.selections"
                      :key="`${selection.component}/${selection.agent}`"
                      :selection="selection"
                      :guidance="pinnedManifest.guidance"
                    />
                  </div>
                </template>
              </div>
            </section>
          </template>
        </section>

        <section class="block">
          <h2>{{ t('story.listTitle') }}</h2>
          <div class="facets">
            <input
              id="story-query"
              name="story-q"
              dir="auto"
              autocomplete="off"
              v-model="text"
              :placeholder="t('story.searchHint')"
              :aria-label="t('story.searchLabel')"
            />
            <select
              id="story-filter"
              name="story-filter"
              :aria-label="t('story.filterLabel')"
              :value="storyFilter"
              @change="setStoryFilter(($event.target as HTMLSelectElement).value)"
            >
              <option v-for="value in FILTERS" :key="value" :value="value">{{ t(`story.filter.${value === '' ? 'all' : value}`) }}</option>
            </select>
          </div>
          <p class="empty" id="stories-empty" :hidden="siftedStories.length > 0">
            {{ t(stories.length === 0 ? 'story.listEmpty' : 'story.noMatch') }}
          </p>
          <ul class="stories detail" id="stories-list">
            <StoryDetailRow
              v-for="story in visibleStories"
              :key="`${activePlan}/${story.id}`"
              :story="story"
              :statuses="statuses"
              @open="openStory"
              @build="buildStory"
              @requeue="requeue"
            />
          </ul>
          <p class="more" id="stories-more" :hidden="visibleStories.length >= siftedStories.length">
            {{ t('story.listMore', { shown: visibleStories.length, total: siftedStories.length }) }}
          </p>
        </section>
      </div>
    </div>
  </section>
</template>
