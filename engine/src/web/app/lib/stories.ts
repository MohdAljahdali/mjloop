/**
 * What a story is waiting on, and what that makes of the plan around it.
 *
 * The rule of record is the engine's. `ops/plan.ts`'s `storyNext` resolves
 * `--next` with it — a story can proceed while it is `todo` and every id in
 * `depends_on` is `done` — and it computes that done-set **inside one plan**.
 * This module says the same thing in the same scope, so the page cannot offer
 * a Run on a story `/mjloop:build --next` would never pick.
 *
 * The engine's own function is not imported instead, because it composes an
 * English sentence for its reason, and server-authored prose is the one thing
 * this page's i18n discipline rests on there being none of.
 *
 * A dependency reaching outside its plan cannot be written:
 * `assertDependenciesResolve` (`ops/plan.ts:239-250`) refuses one with "depends
 * on X, which does not exist in this plan". So the cross-plan case here is
 * defensive, and it resolves the honest way — an id this plan does not carry is
 * unmet, exactly as a typo is.
 *
 * DOM-free and node-testable, which is the reason it is in `lib/` rather than
 * on the panel that used to own it: two panels and the navigation badge now
 * read these numbers, and three copies of a readiness rule is three answers.
 */
import type { PlanView, StoryView } from '../types/protocol.js'
import type { StoryDetail } from '../../read.js'
import type { Track } from '../../../schemas/config.js'
import type { ProjectSkillAcceptance } from '../../../schemas/skill-acceptance.js'

/**
 * The story filters, in the order the picker offers them.
 *
 * The first four are the vocabulary the reader actually works in — everything,
 * what can start now, what is left, what is finished. `doing` and `blocked` stay
 * behind them as the two status cuts worth having: neither is derivable from the
 * other four, and both name a state somebody is about to ask about.
 *
 * Exported and asserted exhaustive against the locale family, because until now
 * nothing did: deleting a filter's key from both locale files left every test
 * green and shipped an option labelled with its own raw key.
 */
export const FILTERS = ['', 'ready', 'remaining', 'doing', 'blocked', 'done']

/**
 * The ids this story is still waiting on: dependencies the index does not
 * report as `done`.
 *
 * An id the index does not carry counts as unmet. Within a plan that is a typo,
 * and silently treating it as satisfied would turn one into a build; across
 * plans it is an edge the engine refuses to write, and the same answer is the
 * right one for a different reason.
 */
export function unmet(story: StoryView | StoryDetail, statuses: Map<string, string>): string[] {
  return story.depends_on.filter((id) => statuses.get(id) !== 'done')
}

/**
 * The stories in this plan whose `depends_on` names this one.
 *
 * The inverse edge is not stored anywhere on disk — `depends_on` only ever
 * points forward, from a story to what it needs — so this is a scan over the
 * plan's own stories rather than a lookup, computed fresh from the same
 * document `unmet` already reads. It is scoped to one plan for the same
 * reason `statusIndex` is: `assertDependenciesResolve` (`ops/plan.ts:239-250`)
 * refuses a cross-plan edge outright, so nothing outside this plan can ever
 * name `storyId` in its own `depends_on`.
 */
export function dependents(storyId: string, stories: readonly (StoryView | StoryDetail)[]): string[] {
  return stories.filter((story) => story.id !== storyId && story.depends_on.includes(storyId)).map((story) => story.id)
}

/**
 * One plan's stories, by id.
 *
 * Takes stories rather than plans deliberately: a project-wide index is what
 * made the page disagree with the engine, and a signature that cannot express
 * one makes the disagreement unwritable rather than merely fixed.
 */
export function statusIndex(stories: readonly (StoryView | StoryDetail)[]): Map<string, string> {
  const index = new Map<string, string>()
  for (const story of stories) index.set(story.id, story.status)
  return index
}

/**
 * Which plan each story belongs to, so a buildable story can say where it came
 * from without the reader going to find out.
 */
export function planIndex(plans: readonly PlanView[]): Map<string, string> {
  const index = new Map<string, string>()
  for (const plan of plans) {
    for (const story of plan.stories) index.set(story.id, plan.id)
  }
  return index
}

/**
 * A plan's derived state — a pure function over exactly the stories the
 * snapshot holds, so it never needs a field the engine does not already write.
 */
export function planStatus(plan: PlanView): 'empty' | 'done' | 'blocked' | 'doing' | 'todo' {
  if (plan.stories.length === 0) return 'empty'
  if (plan.stories.every((story) => story.status === 'done')) return 'done'
  if (plan.stories.some((story) => story.status === 'blocked')) return 'blocked'
  if (plan.stories.some((story) => story.status === 'doing')) return 'doing'
  return 'todo'
}

/**
 * The stories of one plan that could be built right now.
 *
 * This is the rule; everything else counts what it returns.
 */
export function readyIn(plan: PlanView): StoryView[] {
  const statuses = statusIndex(plan.stories)
  return plan.stories.filter((story) => story.status === 'todo' && unmet(story, statuses).length === 0)
}

/**
 * Every story that could be built right now, across every plan.
 */
export function ready(plans: readonly PlanView[]): StoryView[] {
  return plans.flatMap(readyIn)
}

/**
 * The five numbers the tally shows. Counted over stories rather than plans:
 * "three plans" tells you nothing about how much is left.
 */
export function tally(plans: readonly PlanView[]): { plans: number; ready: number; doing: number; blocked: number; done: number } {
  const stories = plans.flatMap((plan) => plan.stories)
  const count = (status: string): number => stories.filter((story) => story.status === status).length
  return {
    plans: plans.length,
    ready: ready(plans).length,
    doing: count('doing'),
    blocked: count('blocked'),
    done: count('done'),
  }
}

/**
 * One plan's own story-status breakdown — completed, in progress, ready to
 * start, blocked, and what remains (not done).
 *
 * `tally([plan])` rather than a second sum over `plan.stories`: `tally()` is
 * what the project-wide tally and, through `ready()`, the navigation badge
 * already call, so a one-plan breakdown built any other way could report a
 * number either of those disagrees with. `remaining` is the one figure
 * `tally()` does not already carry — "not done", the same definition `sift`'s
 * `remaining` filter uses, computed here as `total - completed` rather than a
 * second `.filter()` so it cannot drift from what `completed` above it means.
 */
export function planProgress(
  plan: PlanView,
): { total: number; completed: number; doing: number; ready: number; blocked: number; remaining: number } {
  const counts = tally([plan])
  const total = plan.stories.length
  return {
    total,
    completed: counts.done,
    doing: counts.doing,
    ready: counts.ready,
    blocked: counts.blocked,
    remaining: total - counts.done,
  }
}

/**
 * How many `depends_on` hops `depTree` descends from the open story before it
 * stops, independently of whether it has hit a cycle. Exported so the view and
 * its test share one number rather than two.
 */
export const DEP_DEPTH_LIMIT = 5

/**
 * The dependency graph rooted at `story`, flattened depth-first into rows a
 * keyed list can reconcile.
 *
 * `ui/dom.js` has no element factory and no SVG helper and `innerHTML` is
 * banned, so a laid-out graph of boxes and edges was never on the table here.
 * A flat, indented list is `reconcile`'s native shape and mirrors under RTL
 * for free (indentation is a `padding-inline-start`, not a hardcoded side) —
 * but the parent/child shape it draws is presentation only, so
 * `panels/stories.js`'s `storyDepRow` carries the same shape as
 * `aria-level={depth + 1}` on a `role="treeitem"` row inside a `role="tree"`
 * list, the non-visual channel a screen reader actually reads the nesting
 * from.
 *
 * Every `depends_on` edge is walked, not only the unmet ones: this is the
 * story's whole dependency shape, where the readiness inspector (`unmet()`,
 * above) only cares what is currently blocking a build.
 *
 * Two independent guards keep the walk finite. `path` carries every id from
 * the root to the node currently being expanded; a `depends_on` entry already
 * in `path` is still pushed as a row — its status is real and worth showing —
 * but is never recursed into, which is what actually stops a cycle. A cycle
 * cannot be *written*: `assertDependenciesResolve` (`ops/plan.ts:239-250`)
 * refuses one with its own DFS at write time. But a hand-edited story file on
 * disk bypasses that check, same as the typo case `unmet()`'s own doc
 * describes, and a walk that trusted the engine here would hang the page.
 * `depth` is capped at `DEP_DEPTH_LIMIT` on top of that, for the case the
 * cycle guard does not cover: a long but genuinely acyclic chain, which is
 * not a hang but is still a list past the point an indented view stays
 * legible.
 *
 * A dependency id absent from `byId` is pushed as a row — same as an id the
 * readiness inspector cannot resolve — and never recursed into, because
 * `byId` only ever holds this plan's own stories: `assertDependenciesResolve`
 * refuses a cross-plan edge outright, so an unresolvable id here is a typo
 * within the plan, not a foreign story this walk merely declined to fetch.
 */
export function depTree(
  story: StoryView | StoryDetail,
  byId: Map<string, StoryView | StoryDetail>,
): { key: string; id: string; depth: number }[] {
  const rows: { key: string; id: string; depth: number }[] = []

  function walk(id: string, depth: number, path: readonly string[]) {
    if (depth >= DEP_DEPTH_LIMIT) return
    const current = byId.get(id)
    if (current === undefined) return
    for (const depId of current.depends_on) {
      // The path-joined string, not `depId` alone: two different branches can
      // both depend on the same id (a diamond shape), and each occurrence is
      // its own row at its own depth, not a single node `reconcile` would
      // otherwise deduplicate onto one.
      rows.push({ key: `${path.join('>')}>${depId}`, id: depId, depth })
      if (!path.includes(depId)) walk(depId, depth + 1, [...path, depId])
    }
  }

  walk(story.id, 0, [story.id])
  return rows
}

/**
 * The agents a track's `required`/`available` say a working cycle may draft —
 * never `closing`, which runs once *after* the run passes and is never inside
 * a working cycle (`schemas/config.ts:71-80`, the same distinction
 * `draftable` draws at `schemas/config.ts:136` for `map.drafted_by`).
 * Deduplicated, required first: the two sets are disjoint by convention but
 * `TrackSchema` never asserts that, so a name in both would otherwise draw
 * its per-agent block twice. An absent track — deleted from `config.yaml`, or
 * the config document not yet fetched — drafts nobody rather than throwing.
 */
export function draftedAgents(track: Track | undefined): string[] {
  if (track === undefined) return []
  return [...new Set([...track.required, ...track.available])]
}

/**
 * The floor `routableAgents` falls back to when this project's `config.yaml`
 * names no tracks at all — the fixed four this whole thing used to be, before
 * a skill could be routed to any agent a track names.
 *
 * Mirrors `SKILL_ACCEPTANCE_AGENTS` in `schemas/skill-acceptance.ts:18-25`
 * exactly, and cannot import it: that file is parsed for both the CLI and
 * this browser bundle, but its own header already restates `ops/run.ts`'s
 * identical list rather than import across a layer boundary, and the browser
 * bundle draws the same line again rather than reach into `schemas/` for one
 * constant. If `SKILL_ACCEPTANCE_AGENTS` changes in
 * `schemas/skill-acceptance.ts`, this list must change with it.
 */
export const SKILL_ACCEPTANCE_AGENTS = ['planner', 'builder', 'critic', 'verifier']

/**
 * The drafted agents this page has any reason to draw a skills row for —
 * `draftedAgents` narrowed to the agents `acceptSkill`
 * (`store/skill-acceptance-store.ts`'s `routableAgents`) will ever let an
 * `agents` entry name today: whichever agents *any* track in this project's
 * `config.yaml` names, project-wide, falling back to the fixed four above
 * only when the config names no tracks at all. `tracks` is the whole
 * `config.tracks` map the config feed already carries — not `track` alone —
 * because the store's own rule is project-wide: an agent a *different* track
 * drafts is routable here even if this story's own track never drafts it,
 * exactly as `acceptSkill` would accept it.
 *
 * `acceptSkill` throws `UnknownAcceptanceAgentError` for anything outside that
 * set, so a drafted agent this filter drops can *never* hold an acceptance; a
 * row for one is not "nothing accepted yet", it is an impossibility the CLI
 * refuses, and inviting a reader to go accept a skill for it would be exactly
 * that lie.
 */
export function routableAgents(track: Track | undefined, tracks: Record<string, Track> | undefined): string[] {
  const routable = routableAgentSet(tracks)
  return draftedAgents(track).filter((agent) => routable.has(agent))
}

/**
 * The project-wide routable set on its own, split out of `routableAgents` so
 * a test can compare it directly against the identical rule restated in
 * `store/skill-acceptance-store.ts`'s `routableAgents` and `ops/run.ts`'s
 * `skillSelectionAgents` — this page's own copy of the same derivation,
 * unfiltered by any one track's drafted list.
 */
export function routableAgentSet(tracks: Record<string, Track> | undefined): Set<string> {
  const names = Object.values(tracks ?? {}).flatMap((entry) => [
    ...entry.required,
    ...(entry.available ?? []),
    ...(entry.closing ?? []),
  ])
  return new Set(names.length === 0 ? SKILL_ACCEPTANCE_AGENTS : names)
}

/**
 * This project's own skill acceptances that this story's track has any
 * reason to look at here: one naming at least one agent `drafted` actually
 * drafts, plus every acceptance whose `agents` is empty.
 *
 * An acceptance naming only agents outside `drafted` (`planner`, say, which
 * no track's `required`/`available` this page ever reads lists — dynamic
 * skill selection routes it from a feature brief, not from a track) can be
 * entirely correct on its own terms; it simply has nothing to do with this
 * story's track, and is left out rather than drawn as a warning about
 * nothing.
 *
 * An empty `agents` is a different case entirely, and not track-scoped: it
 * is not "nothing to do with this track", it is dead on every track at once.
 * `acceptSkill(dir, {agents: undefined, ...})` — the CLI's only caller,
 * `cli/index.ts:1070` — writes `agents: []`, and `selectSkills`
 * (`ops/skill-selection.ts:103`, `.filter((skill) => skill.agents.includes(agent))`)
 * then matches it to nothing, on every run, forever, exactly the failure
 * `store/skill-acceptance-store.ts:254-256`'s own comment names ("the record
 * would sit ... reading `status active` while routing nothing on every
 * run"). Dropping it here the way an off-track acceptance is dropped would
 * hide the one acceptance that is actually, provably inert; it is kept so
 * `skillWarnings`' `noAgents` flag below can say so.
 */
export function relevantAcceptances(
  acceptances: readonly ProjectSkillAcceptance[],
  drafted: readonly string[],
): ProjectSkillAcceptance[] {
  const draftedSet = new Set(drafted)
  return acceptances.filter(
    (acceptance) => acceptance.agents.length === 0 || acceptance.agents.some((agent) => draftedSet.has(agent)),
  )
}

/**
 * The accepted skills naming one drafted agent, in acceptance order.
 */
export function acceptancesFor(acceptances: readonly ProjectSkillAcceptance[], agent: string): ProjectSkillAcceptance[] {
  return acceptances.filter((acceptance) => acceptance.agents.includes(agent))
}

/**
 * The three pre-run facts one acceptance's own fields can support — never a
 * fourth invented one, and never a claim this project has no field for (there
 * is no permission model for an agent in this engine, so this deliberately
 * stops at exactly what `schemas/skill-acceptance.ts` records and
 * `ops/skill-selection.ts:100-103` actually acts on: `status`, `compatible`,
 * `agents`).
 *
 * There is deliberately no fourth, "off-track" flag naming an agent this
 * acceptance lists that the story's own track does not draft. Skill routing
 * (`resolveSkillManifest`, `ops/run.ts:210`, and `selectSkills`,
 * `ops/skill-selection.ts:103`) never reads `config.tracks` at all — it
 * flatMaps a hardcoded four-role list and filters only on
 * `skill.agents.includes(agent)` — so an acceptance naming an agent outside
 * this track behaves exactly as intended for whichever *other* track drafts
 * that agent. There is no join here the engine actually makes, so there is
 * nothing here to warn about.
 *
 * `noAgents` is the one warning this engine's own behaviour can support: an
 * acceptance with an empty `agents` matches `skill.agents.includes(agent)`
 * for no agent at all, ever — see `relevantAcceptances`, above, for why it is
 * still shown rather than dropped.
 */
export function skillWarnings(
  acceptance: ProjectSkillAcceptance,
): { noAgents: boolean; notActive: boolean; notCompatible: boolean } {
  return {
    noAgents: acceptance.agents.length === 0,
    notActive: acceptance.status !== 'active',
    notCompatible: !acceptance.compatible,
  }
}

/**
 * The stories a filter and a search box leave standing.
 *
 * `ready` is not a story status — it is a status *and* a dependency check, and
 * it is the filter people actually want. Pure and exported so it is tested
 * without a DOM.
 *
 * @param filter One of `FILTERS`.
 */
export function sift<T extends StoryView | StoryDetail>(
  stories: readonly T[],
  query: string,
  filter: string,
  statuses: Map<string, string>,
): T[] {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 0)
  return stories.filter((story) => {
    if (filter === 'ready' && !(story.status === 'todo' && unmet(story, statuses).length === 0)) return false
    // Remaining is "not done", once, here — so the filter, the tally and the
    // launcher's suggestions cannot each mean something slightly different by it.
    if (filter === 'remaining' && story.status === 'done') return false
    if (filter !== '' && filter !== 'ready' && filter !== 'remaining' && story.status !== filter) return false
    if (terms.length === 0) return true
    const haystack = `${story.id} ${story.title}`.toLowerCase()
    return terms.every((term) => haystack.includes(term))
  })
}
